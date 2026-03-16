/**
 * LP Holder Classifier
 * 
 * Classifies LP token holders into categories:
 * - Burned (permanent safe)
 * - Locked (time-based safe)
 * - Upgradable Program (risky)
 * - Wallet (high risk)
 */

import { PublicKey } from "@solana/web3.js";
import { getMonitoringHttpRpc } from "../../../../utils/rpc.js";
import { LPHolderInfo, LPHolderType, RiskLevel, PoolInfo } from "../types.js";
import {
    isBurnAddress,
    isKnownLocker,
    getLockerUnlockTime,
    getLockerDaysRemaining
} from "./lockers.js";

// BPF Loader programs (for upgradability check)
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const BPF_LOADER = new PublicKey("BPFLoader2111111111111111111111111111111111");

// =============================================================================
// Main Classification Function
// =============================================================================

/**
 * Get and classify all LP token holders for a pool
 */
export async function classifyLPHolders(pool: PoolInfo): Promise<LPHolderInfo[]> {
    const holders: LPHolderInfo[] = [];

    // Concentrated liquidity pools use positions, not LP tokens
    const isConcentratedLiquidity = pool.dex === "raydium_clmm" || pool.dex === "orca_whirlpool" || pool.dex === "meteora_dlmm";

    if (isConcentratedLiquidity) {
        console.log(`ℹ️ [Classifier] ${pool.dex} uses positions - treating as position-based`);
        return [{
            address: pool.poolAddress,
            balance: BigInt(0),
            percentOfSupply: 100,
            type: "immutable_program",
            riskLevel: "low",  // Position-based pools have moderate risk
            details: {
                lockerName: `${pool.dex} positions`,
            },
        }];
    }

    // For traditional AMM pools, we need LP supply to analyze holders
    if (pool.lpSupply === BigInt(0)) {
        console.warn(`⚠️ [Classifier] No LP supply for ${pool.dex} pool ${pool.poolAddress.slice(0, 8)}... - cannot analyze holders`);
        // Return as wallet-held (risky) since we can't verify
        return [{
            address: pool.poolAddress,
            balance: BigInt(0),
            percentOfSupply: 100,
            type: "wallet",
            riskLevel: "high",
            details: {
                lockerName: "Unknown (LP supply unavailable)",
            },
        }];
    }

    try {
        const connection = getMonitoringHttpRpc();

        // Get largest LP token holders
        const largestAccounts = await connection.getTokenLargestAccounts(new PublicKey(pool.lpMint));

        if (!largestAccounts.value || largestAccounts.value.length === 0) {
            console.log(`⚠️ [Classifier] No LP holders found for ${pool.poolAddress.slice(0, 8)}...`);
            return [];
        }

        const totalSupply = Number(pool.lpSupply);

        // Process each holder
        for (const account of largestAccounts.value) {
            const balance = BigInt(account.amount);
            const percentOfSupply = totalSupply > 0 ? (Number(balance) / totalSupply) * 100 : 0;

            // Skip tiny holders (<0.1%)
            if (percentOfSupply < 0.1) {
                continue;
            }

            // Get the token account to find the owner
            const tokenAccountInfo = await connection.getParsedAccountInfo(account.address);

            if (!tokenAccountInfo.value?.data || typeof tokenAccountInfo.value.data !== "object") {
                continue;
            }

            const parsedData = tokenAccountInfo.value.data as { parsed?: { info?: { owner?: string } } };
            const owner = parsedData.parsed?.info?.owner;

            if (!owner) {
                continue;
            }

            // Classify the owner
            const holderInfo = await classifyHolder(owner, balance, percentOfSupply);
            holders.push(holderInfo);
        }

        // Sort by percentage (highest first)
        holders.sort((a, b) => b.percentOfSupply - a.percentOfSupply);

        console.log(`✅ [Classifier] Classified ${holders.length} LP holders for ${pool.poolAddress.slice(0, 8)}...`);

    } catch (error) {
        console.error(`❌ [Classifier] Error classifying LP holders:`, error);
    }

    return holders;
}

/**
 * Classify a single LP holder
 */
async function classifyHolder(
    ownerAddress: string,
    balance: bigint,
    percentOfSupply: number
): Promise<LPHolderInfo> {
    console.log(`   🔍 [Classifier] Analyzing holder: ${ownerAddress.slice(0, 12)}... (${percentOfSupply.toFixed(2)}%)`);

    // Check if burned
    if (isBurnAddress(ownerAddress)) {
        console.log(`      → 🔥 BURNED (permanent, safe)`);
        return {
            address: ownerAddress,
            balance,
            percentOfSupply,
            type: "burned",
            riskLevel: "safe",
        };
    }

    // Check if known locker program directly
    const locker = isKnownLocker(ownerAddress);
    if (locker) {
        console.log(`      → 🔒 KNOWN LOCKER: ${locker.name}`);
        return {
            address: ownerAddress,
            balance,
            percentOfSupply,
            type: "locked",
            riskLevel: "safe",
            details: {
                lockerName: locker.name,
            },
        };
    }

    // Get account info to determine type
    const connection = getMonitoringHttpRpc();
    const accountInfo = await connection.getAccountInfo(new PublicKey(ownerAddress));

    if (!accountInfo) {
        console.log(`      → ⚠️ NO ACCOUNT INFO - treating as WALLET (high risk)`);
        return {
            address: ownerAddress,
            balance,
            percentOfSupply,
            type: "wallet",
            riskLevel: "high",
        };
    }

    console.log(`      → Account owner: ${accountInfo.owner.toBase58().slice(0, 12)}...`);
    console.log(`      → Executable: ${accountInfo.executable}`);
    console.log(`      → Data length: ${accountInfo.data.length} bytes`);

    // Check if the owner is a program (executable)
    if (accountInfo.executable) {
        console.log(`      → Is PROGRAM, checking upgradability...`);
        const isUpgradable = await isProgramUpgradable(ownerAddress);

        if (isUpgradable) {
            console.log(`      → 🚨 UPGRADABLE PROGRAM (HIGH RISK)`);
        } else {
            console.log(`      → ✅ IMMUTABLE PROGRAM (low risk)`);
        }

        return {
            address: ownerAddress,
            balance,
            percentOfSupply,
            type: isUpgradable ? "upgradable_program" : "immutable_program",
            riskLevel: isUpgradable ? "high" : "low",
            details: {
                programUpgradable: isUpgradable,
            },
        };
    }

    // Check if the owner is an escrow account owned by a known locker program
    const ownerProgram = accountInfo.owner.toBase58();
    const lockerProgram = isKnownLocker(ownerProgram);

    if (lockerProgram) {
        console.log(`      → 🔒 ESCROW owned by ${lockerProgram.name}`);

        // Try to get unlock time from the escrow account
        const unlockTime = await getLockerUnlockTime(ownerAddress, ownerProgram);
        const daysRemaining = unlockTime ? getLockerDaysRemaining(unlockTime) : null;

        if (daysRemaining !== null) {
            console.log(`      → Unlock in ${daysRemaining} days`);
        } else {
            console.log(`      → Unlock time unknown`);
        }

        // Determine risk based on days remaining
        let riskLevel: RiskLevel = "safe";
        if (daysRemaining !== null) {
            if (daysRemaining <= 0) {
                riskLevel = "high";
                console.log(`      → ⚠️ ALREADY UNLOCKED (high risk)`);
            } else if (daysRemaining <= 7) {
                riskLevel = "medium";
                console.log(`      → ⚠️ Unlocking soon (medium risk)`);
            } else if (daysRemaining <= 30) {
                riskLevel = "low";
                console.log(`      → Unlocking in <30 days (low risk)`);
            }
        }

        return {
            address: ownerAddress,
            balance,
            percentOfSupply,
            type: "locked",
            riskLevel,
            details: {
                lockerName: lockerProgram.name,
                daysToUnlock: daysRemaining ?? undefined,
                unlockTimestamp: unlockTime ?? undefined,
            },
        };
    }

    // Default: Regular wallet (highest risk)
    console.log(`      → 💼 WALLET (HIGH RISK - can withdraw anytime)`);
    return {
        address: ownerAddress,
        balance,
        percentOfSupply,
        type: "wallet",
        riskLevel: "high",
    };
}

// =============================================================================
// Program Upgradability Check
// =============================================================================

/**
 * Check if a program is upgradable (has upgrade authority)
 */
export async function isProgramUpgradable(programId: string): Promise<boolean> {
    try {
        const connection = getMonitoringHttpRpc();
        const programPubkey = new PublicKey(programId);

        // Get the program account
        const programAccount = await connection.getAccountInfo(programPubkey);

        if (!programAccount) {
            return false;
        }

        // Check if owned by upgradable loader
        if (!programAccount.owner.equals(BPF_LOADER_UPGRADEABLE)) {
            return false;  // Not upgradable (either BPF Loader or native)
        }

        // For upgradable programs, we need to check the ProgramData account
        // The program account data contains a pointer to ProgramData
        if (programAccount.data.length < 36) {
            return false;
        }

        // First 4 bytes are account type discriminator
        // Next 32 bytes are ProgramData address
        const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36));

        const programDataAccount = await connection.getAccountInfo(programDataAddress);

        if (!programDataAccount) {
            return false;
        }

        // ProgramData layout:
        // 0-3: slot (u32)
        // 4: Option<Pubkey> for upgrade authority
        //    - 0 = None (upgrade authority removed)
        //    - 1 = Some, followed by 32-byte pubkey

        if (programDataAccount.data.length < 45) {
            return false;
        }

        // Check if upgrade authority exists
        const hasUpgradeAuthority = programDataAccount.data[4] === 1;

        return hasUpgradeAuthority;

    } catch (error) {
        console.warn(`⚠️ [Upgradability] Failed to check ${programId.slice(0, 8)}...:`, error);
        return false;  // Assume not upgradable on error
    }
}

// =============================================================================
// Aggregation Functions
// =============================================================================

/**
 * Calculate aggregate percentages for a pool's LP holders
 */
export function aggregateHolderStats(holders: LPHolderInfo[]): {
    burnedPercent: number;
    lockedPercent: number;
    unlockablePercent: number;
} {
    let burnedPercent = 0;
    let lockedPercent = 0;
    let unlockablePercent = 0;

    for (const holder of holders) {
        switch (holder.type) {
            case "burned":
                burnedPercent += holder.percentOfSupply;
                break;
            case "locked":
                if (holder.riskLevel === "safe" || holder.riskLevel === "low") {
                    lockedPercent += holder.percentOfSupply;
                } else {
                    // Lock expired or expiring soon
                    unlockablePercent += holder.percentOfSupply;
                }
                break;
            case "immutable_program":
                lockedPercent += holder.percentOfSupply;
                break;
            case "upgradable_program":
            case "wallet":
            case "unknown":
                unlockablePercent += holder.percentOfSupply;
                break;
        }
    }

    return {
        burnedPercent: Math.min(100, burnedPercent),
        lockedPercent: Math.min(100, lockedPercent),
        unlockablePercent: Math.min(100, unlockablePercent),
    };
}
