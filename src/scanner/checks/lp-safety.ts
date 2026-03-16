/**
 * LP Safety Checker
 * 
 * Analyzes LP token distribution to detect:
 * - Burned LP (permanent, safest)
 * - Locked LP (in lock programs, with unlock time if available)
 * - Withdrawable LP (held in regular wallets, risky)
 * 
 * Also provides holder analysis:
 * - Total unique holders
 * - Top 3 concentration
 */

import { PublicKey } from "@solana/web3.js";
import { getMonitoringHttpRpc } from "../../utils/rpc.js";
import { getMainPool, DexScreenerPool } from "./dexscreener.js";
import { isLockProgram, isBurnAddress, getLockProgramName, STREAMFLOW_PROGRAMS } from "./lock-programs/index.js";
import { getStreamFlowLockInfo, formatLockDuration, getLockRiskLevel } from "./lock-programs/streamflow.js";

/**
 * LP holder classification
 */
export interface LPHolder {
    address: string;       // Token account address
    owner: string;         // Owner of the token account
    amount: bigint;
    percentage: number;
    status: "burned" | "locked" | "withdrawable";
    lockerName?: string;   // Name of lock program if locked
    unlockTime?: number;   // Unix timestamp if available
    daysUntilUnlock?: number;  // Days until unlock
    unlockDateStr?: string;    // Human-readable unlock date
}

/**
 * LP Safety Analysis Result
 */
export interface LPSafetyResult {
    // Pool info
    dex: string;
    poolAddress: string;
    lpMint: string | null;
    liquidityUsd: number;

    // LP Distribution
    burnedPercent: number;
    lockedPercent: number;
    withdrawablePercent: number;

    // Lock details
    lockDetails: Array<{
        lockerName: string;
        percent: number;
        daysUntilUnlock?: number;  // Shortest lock time for this locker
        unlockDateStr?: string;
    }>;

    // Holder analysis
    totalHolders: number;
    top3Percent: number;

    // Top LP holders (for detailed view)
    topHolders: LPHolder[];

    // Overall risk assessment
    riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    riskReasons: string[];

    // Human-readable lines
    safetyLines: string[];
}

/**
 * Meteora DAMM V2 API response
 */
interface MeteoraPoolData {
    pool_address: string;
    liquidity: string;
    permanent_lock_liquidity: string;
    tvl: number;
    creator: string;
    launchpad?: string;
    token_a_mint: string;
    token_b_mint: string;
    token_a_symbol?: string;
    token_b_symbol?: string;
}

interface MeteoraApiResponse {
    data: MeteoraPoolData | null;
    error?: { message: string };
    status: number;
}

/**
 * Fetch Meteora DAMM V2 pool info from their API
 * Returns lock percentage and other useful data
 */
async function getMeteoraDAMMv2Lock(poolAddress: string): Promise<{
    lockPercent: number;
    lockedUsd: number;
    totalLiquidityUsd: number;
    creator: string | null;
    isFromDBC: boolean;
} | null> {
    try {
        const response = await fetch(`https://dammv2-api.meteora.ag/pools/${poolAddress}`);
        if (!response.ok) {
            return null;
        }

        const data = await response.json() as MeteoraApiResponse;
        if (!data.data) {
            return null;
        }

        const pool = data.data;
        const totalLiquidity = parseFloat(pool.liquidity) || 0;
        const permanentLock = parseFloat(pool.permanent_lock_liquidity) || 0;

        // Calculate lock percentage
        const lockPercent = totalLiquidity > 0
            ? (permanentLock / totalLiquidity) * 100
            : 0;

        return {
            lockPercent,
            lockedUsd: pool.tvl * (lockPercent / 100), // Estimate locked USD
            totalLiquidityUsd: pool.tvl,
            creator: pool.creator || null,
            isFromDBC: pool.launchpad === "met-dbc",
        };
    } catch (error) {
        console.error(`❌ [Meteora API] Failed to fetch DAMM V2 pool ${poolAddress.slice(0, 8)}...:`, error);
        return null;
    }
}

/**
 * Meteora DAMM V1 API response
 */
interface MeteoraV1PoolData {
    pool_address: string;
    lp_mint: string;
    pool_tvl: string;
    pool_name: string;
    is_meme: boolean;
}

interface MeteoraV1ApiResponse {
    data: MeteoraV1PoolData[] | null;
    page: number;
    total_count: number;
}

/**
 * Fetch Meteora DAMM V1 pool info (fallback for older pools)
 * Returns LP mint which we can then analyze for lock status
 */
async function getMeteoraDAMMv1Pool(poolAddress: string): Promise<{
    lpMint: string;
    tvlUsd: number;
    poolName: string;
} | null> {
    try {
        const response = await fetch(`https://damm-api.meteora.ag/pools/search?pool_address=${poolAddress}&page=0&size=1`);
        if (!response.ok) {
            return null;
        }

        const data = await response.json() as MeteoraV1ApiResponse;
        if (!data.data || data.data.length === 0) {
            return null;
        }

        const pool = data.data[0];
        return {
            lpMint: pool.lp_mint,
            tvlUsd: parseFloat(pool.pool_tvl) || 0,
            poolName: pool.pool_name,
        };
    } catch (error) {
        console.error(`❌ [Meteora V1 API] Failed to fetch pool ${poolAddress.slice(0, 8)}...:`, error);
        return null;
    }
}

/**
 * Derive LP mint from pool address (DEX-specific logic)
 * For Raydium AMM V4, LP mint is derived from pool address
 * For Meteora, it's stored in pool account
 */
async function getLPMint(poolAddress: string, dex: string): Promise<string | null> {
    try {
        const connection = getMonitoringHttpRpc();
        const poolPubkey = new PublicKey(poolAddress);
        const poolAccount = await connection.getAccountInfo(poolPubkey);

        if (!poolAccount?.data) {
            return null;
        }

        // Normalize DEX name for matching
        const dexLower = dex.toLowerCase();

        // Different DEXes have different data layouts
        // Raydium variants
        if (dexLower.includes("raydium")) {
            // Raydium AMM V4: LP mint is at offset 72-104 (32 bytes)
            // This may vary by version
            const lpMintBytes = poolAccount.data.slice(72, 104);
            return new PublicKey(lpMintBytes).toBase58();
        }

        // Meteora variants (meteora, meteoradbc, meteora_dlmm, etc.)
        if (dexLower.includes("meteora")) {
            // Meteora DAMM: LP mint at offset 40-72
            // Try multiple offsets as different Meteora pool types have different layouts
            const offsets = [40, 32, 48, 64]; // Try common offsets

            for (const offset of offsets) {
                try {
                    if (offset + 32 <= poolAccount.data.length) {
                        const lpMintBytes = poolAccount.data.slice(offset, offset + 32);
                        const candidate = new PublicKey(lpMintBytes).toBase58();

                        // Verify this looks like a valid mint by checking it's not all zeros
                        // and not the system program
                        if (candidate !== "11111111111111111111111111111111" &&
                            candidate !== "So11111111111111111111111111111111111111112") {
                            // Do a quick check if this mint exists
                            const mintInfo = await connection.getAccountInfo(new PublicKey(candidate));
                            if (mintInfo && mintInfo.data.length > 0) {
                                return candidate;
                            }
                        }
                    }
                } catch {
                    continue; // Try next offset
                }
            }
            return null;
        }

        // PumpSwap (pump.fun's new AMM)
        if (dexLower.includes("pump")) {
            // PumpSwap pools may have different layout
            // Try common offsets
            const offsets = [32, 40, 64, 72];

            for (const offset of offsets) {
                try {
                    if (offset + 32 <= poolAccount.data.length) {
                        const lpMintBytes = poolAccount.data.slice(offset, offset + 32);
                        const candidate = new PublicKey(lpMintBytes).toBase58();

                        if (candidate !== "11111111111111111111111111111111" &&
                            candidate !== "So11111111111111111111111111111111111111112") {
                            const mintInfo = await connection.getAccountInfo(new PublicKey(candidate));
                            if (mintInfo && mintInfo.data.length > 0) {
                                return candidate;
                            }
                        }
                    }
                } catch {
                    continue;
                }
            }
            return null;
        }

        // Orca variants
        if (dexLower.includes("orca")) {
            // Orca whirlpools have a different structure
            const lpMintBytes = poolAccount.data.slice(32, 64);
            return new PublicKey(lpMintBytes).toBase58();
        }

        // For other DEXes, try common offsets
        const commonOffsets = [32, 40, 64, 72];
        for (const offset of commonOffsets) {
            try {
                if (offset + 32 <= poolAccount.data.length) {
                    const lpMintBytes = poolAccount.data.slice(offset, offset + 32);
                    const candidate = new PublicKey(lpMintBytes).toBase58();

                    if (candidate !== "11111111111111111111111111111111" &&
                        candidate !== "So11111111111111111111111111111111111111112") {
                        const mintInfo = await connection.getAccountInfo(new PublicKey(candidate));
                        if (mintInfo && mintInfo.data.length > 0) {
                            return candidate;
                        }
                    }
                }
            } catch {
                continue;
            }
        }

        return null;
    } catch (error) {
        console.error(`❌ [LP Safety] Failed to get LP mint for ${poolAddress.slice(0, 8)}...:`, error);
        return null;
    }
}

/**
 * Analyze LP token distribution
 */
async function analyzeLPDistribution(lpMint: string): Promise<{
    holders: LPHolder[];
    burnedPercent: number;
    lockedPercent: number;
    withdrawablePercent: number;
    lockDetails: Map<string, { percent: number; daysUntilUnlock?: number; unlockDateStr?: string }>;
    totalHolders: number;
    top3Percent: number;
}> {
    const connection = getMonitoringHttpRpc();
    const mintPubkey = new PublicKey(lpMint);

    // Get total supply
    const supplyInfo = await connection.getTokenSupply(mintPubkey);
    const totalSupply = BigInt(supplyInfo.value.amount);

    if (totalSupply === 0n) {
        return {
            holders: [],
            burnedPercent: 100,  // All burned
            lockedPercent: 0,
            withdrawablePercent: 0,
            lockDetails: new Map(),
            totalHolders: 0,
            top3Percent: 0,
        };
    }

    // Get largest LP token holders
    const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);

    // Get owner info for top 10 accounts
    const holders: LPHolder[] = [];
    let burnedAmount = 0n;
    let lockedAmount = 0n;
    let withdrawableAmount = 0n;
    const lockDetails = new Map<string, { percent: number; daysUntilUnlock?: number; unlockDateStr?: string }>();

    for (const account of largestAccounts.value.slice(0, 10)) {
        try {
            const accountInfo = await connection.getParsedAccountInfo(account.address);
            const parsedData = accountInfo.value?.data as any;
            const owner = parsedData?.parsed?.info?.owner || "unknown";
            const amount = BigInt(account.amount);
            const percentage = Number(amount * 10000n / totalSupply) / 100;  // 2 decimal precision

            let status: "burned" | "locked" | "withdrawable";
            let lockerName: string | undefined;

            if (isBurnAddress(owner)) {
                status = "burned";
                burnedAmount += amount;
            } else if (isLockProgram(owner)) {
                status = "locked";
                lockedAmount += amount;
                lockerName = getLockProgramName(owner);

                // Try to get unlock time for StreamFlow locks
                let daysUntilUnlock: number | undefined;
                let unlockDateStr: string | undefined;

                if (owner === STREAMFLOW_PROGRAMS.COMMUNITY || owner === STREAMFLOW_PROGRAMS.COMMERCIAL) {
                    try {
                        const lockInfo = await getStreamFlowLockInfo(account.address.toBase58());
                        if (lockInfo) {
                            daysUntilUnlock = lockInfo.daysUntilUnlock;
                            unlockDateStr = lockInfo.unlockDateStr;
                        }
                    } catch {
                        // Continue without unlock time
                    }
                }

                // Track lock program distribution (keep shortest lock time)
                const existing = lockDetails.get(lockerName);
                if (!existing) {
                    lockDetails.set(lockerName, { percent: percentage, daysUntilUnlock, unlockDateStr });
                } else {
                    existing.percent += percentage;
                    // Keep the shortest lock time
                    if (daysUntilUnlock !== undefined &&
                        (existing.daysUntilUnlock === undefined || daysUntilUnlock < existing.daysUntilUnlock)) {
                        existing.daysUntilUnlock = daysUntilUnlock;
                        existing.unlockDateStr = unlockDateStr;
                    }
                }

                // Add to holder with unlock info
                holders.push({
                    address: account.address.toBase58(),
                    owner,
                    amount,
                    percentage,
                    status,
                    lockerName,
                    daysUntilUnlock,
                    unlockDateStr,
                });
                continue; // Skip the push below
            } else {
                status = "withdrawable";
                withdrawableAmount += amount;
            }

            holders.push({
                address: account.address.toBase58(),
                owner,
                amount,
                percentage,
                status,
                lockerName,
            });
        } catch (error) {
            // Skip accounts we can't parse
            continue;
        }
    }

    // Calculate percentages from total supply
    const burnedPercent = Number(burnedAmount * 10000n / totalSupply) / 100;
    const lockedPercent = Number(lockedAmount * 10000n / totalSupply) / 100;
    const withdrawablePercent = Number(withdrawableAmount * 10000n / totalSupply) / 100;

    // Calculate top 3 concentration
    const top3 = holders.slice(0, 3);
    const top3Percent = top3.reduce((sum, h) => sum + h.percentage, 0);

    return {
        holders,
        burnedPercent,
        lockedPercent,
        withdrawablePercent,
        lockDetails,
        totalHolders: largestAccounts.value.length,  // Approximate
        top3Percent,
    };
}

/**
 * Calculate risk level based on LP distribution
 */
function calculateRiskLevel(
    burnedPercent: number,
    lockedPercent: number,
    withdrawablePercent: number
): { level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; reasons: string[] } {
    const reasons: string[] = [];

    const safePercent = burnedPercent + lockedPercent;

    if (safePercent >= 90) {
        return { level: "LOW", reasons: ["90%+ LP burned/locked"] };
    }

    if (safePercent >= 70) {
        if (withdrawablePercent > 20) {
            reasons.push(`${withdrawablePercent.toFixed(1)}% LP withdrawable`);
        }
        return { level: "MEDIUM", reasons };
    }

    if (safePercent >= 50) {
        reasons.push(`Only ${safePercent.toFixed(1)}% LP secured`);
        if (withdrawablePercent > 30) {
            reasons.push(`${withdrawablePercent.toFixed(1)}% LP can be rugged`);
        }
        return { level: "HIGH", reasons };
    }

    reasons.push(`Only ${safePercent.toFixed(1)}% LP secured`);
    reasons.push(`${withdrawablePercent.toFixed(1)}% LP can be rugged immediately`);
    return { level: "CRITICAL", reasons };
}

/**
 * Main LP safety check function
 */
export async function checkLPSafety(tokenMint: string): Promise<LPSafetyResult | null> {
    console.log(`\n🔒 [LP Safety] Checking ${tokenMint.slice(0, 8)}...`);

    // 1. Get pool info from DexScreener
    const pool = await getMainPool(tokenMint);

    if (!pool) {
        console.log(`   No DEX pool found (token may not be graduated)`);
        return null;
    }

    console.log(`   Found ${pool.dexId} pool: ${pool.pairAddress.slice(0, 8)}...`);

    // 2. Get LP mint
    const lpMint = await getLPMint(pool.pairAddress, pool.dexId);

    if (!lpMint) {
        console.log(`   Could not determine LP mint (DEX: ${pool.dexId})`);

        // Check if this is a Meteora pool - we can use their API directly!
        const isMeteora = pool.dexId.toLowerCase().includes("meteora");
        const dexName = pool.dexId.charAt(0).toUpperCase() + pool.dexId.slice(1);

        const safetyLines: string[] = [];
        let riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "HIGH";
        let riskReasons: string[] = [];
        let lockedPercent = 0;

        if (isMeteora) {
            // Try to get lock info from Meteora's own API
            console.log(`   Fetching lock status from Meteora API...`);
            const meteoraLock = await getMeteoraDAMMv2Lock(pool.pairAddress);

            if (meteoraLock) {
                lockedPercent = meteoraLock.lockPercent;
                const totalLiq = meteoraLock.totalLiquidityUsd;

                // Format liquidity display
                const liqStr = totalLiq >= 1000
                    ? `$${(totalLiq / 1000).toFixed(1)}K`
                    : `$${totalLiq.toFixed(0)}`;

                safetyLines.push(`\u003cb\u003eℹ️ ${dexName} DAMM V2 Pool\u003c/b\u003e`);

                if (lockedPercent >= 99) {
                    safetyLines.push(`✅ ${lockedPercent.toFixed(0)}% LP Permanently Locked`);
                    riskLevel = "LOW";
                    riskReasons = ["99%+ LP permanently locked"];
                } else if (lockedPercent >= 80) {
                    safetyLines.push(`✅ ${lockedPercent.toFixed(1)}% LP Permanently Locked`);
                    riskLevel = "LOW";
                    riskReasons = [`${lockedPercent.toFixed(0)}% LP locked`];
                } else if (lockedPercent >= 50) {
                    safetyLines.push(`⚠️ ${lockedPercent.toFixed(1)}% LP Permanently Locked`);
                    safetyLines.push(`   └─ ${(100 - lockedPercent).toFixed(1)}% can be withdrawn`);
                    riskLevel = "MEDIUM";
                    riskReasons = [`Only ${lockedPercent.toFixed(0)}% LP locked`];
                } else if (lockedPercent > 0) {
                    safetyLines.push(`🚨 Only ${lockedPercent.toFixed(1)}% LP Locked!`);
                    safetyLines.push(`   └─ ${(100 - lockedPercent).toFixed(1)}% can be rugged`);
                    riskLevel = "HIGH";
                    riskReasons = [`Only ${lockedPercent.toFixed(0)}% LP locked`, `${(100 - lockedPercent).toFixed(0)}% at risk`];
                } else {
                    safetyLines.push(`💀 0% LP Locked - EXTREME RISK!`);
                    safetyLines.push(`   └─ All liquidity can be withdrawn`);
                    riskLevel = "CRITICAL";
                    riskReasons = ["No LP is locked", "100% rug risk"];
                }

                safetyLines.push(`💰 Liquidity: ${liqStr}`);

                if (meteoraLock.isFromDBC) {
                    safetyLines.push(`📦 Source: Meteora DBC (Bonding Curve)`);
                }

                console.log(`   Meteora API: ${lockedPercent.toFixed(1)}% locked, TVL: $${totalLiq.toFixed(2)}`);
            } else {
                // DAMM V2 API failed, try DAMM V1 as fallback
                console.log(`   DAMM V2 not found, trying DAMM V1...`);
                const v1Pool = await getMeteoraDAMMv1Pool(pool.pairAddress);

                if (v1Pool && v1Pool.lpMint) {
                    // Found in V1! Analyze LP token distribution
                    console.log(`   Found in DAMM V1: ${v1Pool.poolName}, LP: ${v1Pool.lpMint.slice(0, 8)}...`);

                    // We have the LP mint now - analyze its distribution
                    // (This will return and use the normal LP analysis flow below)
                    const liqStr = v1Pool.tvlUsd >= 1000
                        ? `$${(v1Pool.tvlUsd / 1000).toFixed(1)}K`
                        : `$${v1Pool.tvlUsd.toFixed(0)}`;

                    safetyLines.push(`<b>ℹ️ ${dexName} DAMM V1 Pool</b>`);
                    safetyLines.push(`📊 ${v1Pool.poolName}`);
                    safetyLines.push(`💰 TVL: ${liqStr}`);
                    safetyLines.push(`🔑 LP Token: ${v1Pool.lpMint.slice(0, 8)}...`);
                    safetyLines.push(`\n⚠️ V1 pools use fungible LP - check LP token holders`);

                    riskLevel = "MEDIUM";
                    riskReasons = ["DAMM V1 pool - check LP token distribution"];

                    // Return the lpMint so it can be analyzed
                    return {
                        dex: pool.dexId,
                        poolAddress: pool.pairAddress,
                        lpMint: v1Pool.lpMint,
                        liquidityUsd: v1Pool.tvlUsd,
                        burnedPercent: 0,
                        lockedPercent: 0,
                        withdrawablePercent: 0,
                        lockDetails: [],
                        totalHolders: 0,
                        top3Percent: 0,
                        topHolders: [],
                        riskLevel,
                        riskReasons,
                        safetyLines,
                    };
                } else {
                    // Both APIs failed, show fallback message
                    safetyLines.push(`ℹ️ ${dexName} Pool`);
                    if (pool.liquidity?.usd) {
                        const liqStr = pool.liquidity.usd >= 1000
                            ? `$${(pool.liquidity.usd / 1000).toFixed(1)}K`
                            : `$${pool.liquidity.usd.toFixed(0)}`;
                        safetyLines.push(`💰 Liquidity: ${liqStr}`);
                    }
                    safetyLines.push(`\n⚠️ Could not fetch lock status from Meteora API`);
                    riskLevel = "MEDIUM";
                    riskReasons = ["Could not verify LP lock status"];
                }
            }
        } else {
            safetyLines.push(`⚠️ Could not analyze LP for ${dexName} pool`);
            if (pool.liquidity?.usd) {
                safetyLines.push(`💰 Liquidity: $${pool.liquidity.usd.toLocaleString()}`);
            }
            riskReasons = ["Could not analyze LP distribution"];
        }

        return {
            dex: pool.dexId,
            poolAddress: pool.pairAddress,
            lpMint: null,
            liquidityUsd: pool.liquidity?.usd || 0,
            burnedPercent: 0,
            lockedPercent,
            withdrawablePercent: 100 - lockedPercent,
            lockDetails: lockedPercent > 0 ? [{ lockerName: "Meteora Permanent Lock", percent: lockedPercent }] : [],
            totalHolders: 0,
            top3Percent: 0,
            topHolders: [],
            riskLevel,
            riskReasons,
            safetyLines,
        };
    }

    console.log(`   LP Mint: ${lpMint.slice(0, 8)}...`);

    // 3. Analyze LP distribution
    const analysis = await analyzeLPDistribution(lpMint);

    // 4. Calculate risk
    const risk = calculateRiskLevel(
        analysis.burnedPercent,
        analysis.lockedPercent,
        analysis.withdrawablePercent
    );

    // 5. Build safety lines for display
    const safetyLines: string[] = [];
    const dexName = pool.dexId.charAt(0).toUpperCase() + pool.dexId.slice(1);

    if (analysis.burnedPercent > 0) {
        const emoji = analysis.burnedPercent >= 80 ? "✅" : "⚠️";
        safetyLines.push(`${emoji} ${analysis.burnedPercent.toFixed(1)}% LP Burned (permanent)`);
    }

    if (analysis.lockedPercent > 0) {
        for (const [lockerName, details] of analysis.lockDetails) {
            let lockLine = `🔒 ${details.percent.toFixed(1)}% LP Locked (${lockerName})`;

            // Add unlock time if available
            if (details.daysUntilUnlock !== undefined && details.unlockDateStr) {
                const timeStr = details.daysUntilUnlock <= 0
                    ? "🔓 UNLOCKED"
                    : `${details.unlockDateStr} (${details.daysUntilUnlock} days)`;
                lockLine += `\n   └─ Unlocks: ${timeStr}`;

                // Add warning for short locks
                if (details.daysUntilUnlock > 0 && details.daysUntilUnlock <= 30) {
                    lockLine += ` ⚠️`;
                }
            }

            safetyLines.push(lockLine);
        }
    }

    if (analysis.withdrawablePercent > 5) {
        const emoji = analysis.withdrawablePercent > 20 ? "🚨" : "⚠️";
        safetyLines.push(`${emoji} ${analysis.withdrawablePercent.toFixed(1)}% LP Withdrawable`);
    }

    // Risk indicator
    const riskEmoji = {
        LOW: "✅",
        MEDIUM: "⚠️",
        HIGH: "🚨",
        CRITICAL: "💀",
    }[risk.level];

    safetyLines.push(`\n${riskEmoji} Risk: ${risk.level}`);

    // Convert lock details map to array
    const lockDetailsArray = Array.from(analysis.lockDetails.entries()).map(
        ([lockerName, details]) => ({
            lockerName,
            percent: details.percent,
            daysUntilUnlock: details.daysUntilUnlock,
            unlockDateStr: details.unlockDateStr,
        })
    );

    return {
        dex: pool.dexId,
        poolAddress: pool.pairAddress,
        lpMint,
        liquidityUsd: pool.liquidity?.usd || 0,
        burnedPercent: analysis.burnedPercent,
        lockedPercent: analysis.lockedPercent,
        withdrawablePercent: analysis.withdrawablePercent,
        lockDetails: lockDetailsArray,
        totalHolders: analysis.totalHolders,
        top3Percent: analysis.top3Percent,
        topHolders: analysis.holders,
        riskLevel: risk.level,
        riskReasons: risk.reasons,
        safetyLines,
    };
}

/**
 * Format LP safety for Telegram display
 */
export function formatLPSafetyReport(result: LPSafetyResult): string {
    const dexName = result.dex.charAt(0).toUpperCase() + result.dex.slice(1);

    let report = `<b>🔒 LP Safety (${dexName})</b>\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    for (const line of result.safetyLines) {
        report += `${line}\n`;
    }

    if (result.totalHolders > 0) {
        report += `\n📊 Holders: ~${result.totalHolders}`;
        if (result.top3Percent > 0) {
            report += ` | Top 3: ${result.top3Percent.toFixed(1)}%`;
        }
    }

    return report;
}
