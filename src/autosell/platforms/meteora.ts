/**
 * Meteora Dynamic Bonding Curve (DBC) Adapter
 * 
 * Program ID: dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
 * 
 * DETECTION STRATEGY:
 * Uses Transaction Parsing because getProgramAccounts is unreliable (500 errors on most RPCs).
 * 1. Fetch recent transactions for the token mint
 * 2. Scan for Meteora program interactions (top-level and inner instructions)
 * 3. Extract pool account from instruction accounts
 * 4. Validate: owner=Meteora, size=424, baseMint matches
 * 
 * PROGRESS CALCULATION:
 * Uses official SDK's getPoolCurveProgress() once pool address is known.
 */

import { PublicKey, Connection, VersionedTransactionResponse } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BondingCurveData, PlatformAdapter } from "../types.js";
import { PROGRAM_IDS } from "../../config.js";
import { getMonitoringHttpRpc } from "../../utils/rpc.js";
import { getSOLPriceSync } from "../../utils/solPrice.js";

const METEORA_PROGRAM_ID_STR = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const METEORA_PROGRAM_ID = new PublicKey(METEORA_PROGRAM_ID_STR);
const POOL_SIZE = 424;
const BASE_MINT_OFFSET = 136;

// Known system accounts to filter out
const SYSTEM_ACCOUNTS = new Set([
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "ComputeBudget111111111111111111111111111111",
    METEORA_PROGRAM_ID_STR,
]);

// Pool address cache to avoid re-scanning
const poolCache = new Map<string, string>();

// Lazy-load SDK client
let clientInstance: DynamicBondingCurveClient | null = null;
function getClient(): DynamicBondingCurveClient {
    if (!clientInstance) {
        clientInstance = DynamicBondingCurveClient.create(getMonitoringHttpRpc());
    }
    return clientInstance;
}

/**
 * Find Meteora Pool by scanning recent transactions for the token
 * This bypasses unreliable getProgramAccounts RPC calls
 */
async function findMeteoraPoolViaTransactions(tokenMint: string): Promise<string | null> {
    // Check cache first
    if (poolCache.has(tokenMint)) {
        const cached = poolCache.get(tokenMint)!;
        console.log(`   ✅ [Meteora] Using cached pool: ${cached.slice(0, 12)}...`);
        return cached;
    }

    console.log(`🔍 [Meteora] Searching via TX history: ${tokenMint.slice(0, 8)}...`);
    const connection = getMonitoringHttpRpc();
    const mintPubkey = new PublicKey(tokenMint);

    try {
        // 1. Get recent signatures (5 is enough to find a swap, reduces RPC usage significantly)
        const signatures = await connection.getSignaturesForAddress(mintPubkey, { limit: 5 });

        if (signatures.length === 0) {
            console.log("   ❌ No transactions found for token");
            return null;
        }

        console.log(`   Found ${signatures.length} transactions, scanning...`);

        // 2. Iterate through transactions to find Meteora interaction
        for (const sigInfo of signatures) {
            try {
                const tx = await connection.getTransaction(sigInfo.signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });

                if (!tx || !tx.meta) continue;

                // 3. Get all candidate accounts from transaction with Meteora ix
                const candidates = findMeteoraAccountInTx(tx, tokenMint);

                if (candidates.length === 0) continue;

                // 4. BATCH validate all candidates in ONE RPC call
                const candidatePubkeys = candidates.map(c => new PublicKey(c));
                const accountInfos = await connection.getMultipleAccountsInfo(candidatePubkeys);

                for (let i = 0; i < candidates.length; i++) {
                    const info = accountInfos[i];
                    if (!info) continue;

                    // Validate: owner=Meteora, size=424, baseMint matches
                    if (!info.owner.equals(METEORA_PROGRAM_ID)) continue;
                    if (info.data.length !== POOL_SIZE) continue;

                    const baseMintInPool = new PublicKey(info.data.subarray(BASE_MINT_OFFSET, BASE_MINT_OFFSET + 32));
                    if (baseMintInPool.toBase58() !== tokenMint) continue;

                    // Found valid pool!
                    const poolAddress = candidates[i];
                    console.log(`   ✅ Found Meteora pool: ${poolAddress.slice(0, 12)}...`);
                    poolCache.set(tokenMint, poolAddress);
                    return poolAddress;
                }
            } catch (txError) {
                // Skip malformed transactions and continue
                continue;
            }
        }

        console.log("   ❌ No Meteora pool found in transactions");
    } catch (error) {
        console.log(`   ⚠️ TX search error: ${(error as Error).message.slice(0, 50)}`);
    }

    return null;
}

/**
 * Analyze a transaction to find Meteora Pool account
 * 
 * Strategy: If transaction contains ANY Meteora instruction, scan ALL accounts
 * in the transaction for one that validates as a pool (owner=Meteora, size=424).
 * This handles cases where the pool is passed via Jupiter/aggregators.
 */
function findMeteoraAccountInTx(tx: VersionedTransactionResponse, tokenMint: string): string[] {
    const accountKeys = tx.transaction.message.getAccountKeys();

    // First check if this transaction has ANY Meteora instruction
    let hasMeteoraIx = false;

    // Check top-level
    for (const ix of tx.transaction.message.compiledInstructions) {
        if (accountKeys.get(ix.programIdIndex)?.toBase58() === METEORA_PROGRAM_ID_STR) {
            hasMeteoraIx = true;
            break;
        }
    }

    // Check inner instructions
    if (!hasMeteoraIx && tx.meta?.innerInstructions) {
        for (const inner of tx.meta.innerInstructions) {
            for (const ix of inner.instructions) {
                if (accountKeys.get(ix.programIdIndex)?.toBase58() === METEORA_PROGRAM_ID_STR) {
                    hasMeteoraIx = true;
                    break;
                }
            }
            if (hasMeteoraIx) break;
        }
    }

    if (!hasMeteoraIx) return [];

    // TX has Meteora - return ALL accounts as candidates for validation
    // The caller will validate each one to find the actual pool
    const candidates: string[] = [];
    for (let i = 0; i < accountKeys.length; i++) {
        const acc = accountKeys.get(i)?.toBase58();
        if (acc && !SYSTEM_ACCOUNTS.has(acc) && acc !== tokenMint) {
            candidates.push(acc);
        }
    }

    return candidates;
}

/**
 * Validate that an account is a Meteora Pool for the given token
 */
async function validatePoolAccount(connection: Connection, address: string, tokenMint: string): Promise<boolean> {
    try {
        const info = await connection.getAccountInfo(new PublicKey(address));
        if (!info) return false;

        // Check 1: Owned by Meteora Program
        if (!info.owner.equals(METEORA_PROGRAM_ID)) return false;

        // Check 2: Size is 424 bytes (fixed pool size)
        if (info.data.length !== POOL_SIZE) return false;

        // Check 3: Base Mint at offset 136 matches target token
        const baseMintInPool = new PublicKey(info.data.subarray(BASE_MINT_OFFSET, BASE_MINT_OFFSET + 32));
        if (baseMintInPool.toBase58() !== tokenMint) return false;

        return true;
    } catch {
        return false;
    }
}

/**
 * Meteora DBC Platform Adapter
 */
export const meteoraAdapter: PlatformAdapter = {
    programId: PROGRAM_IDS.METEORA_DBC,

    async deriveCurveAccount(mint: string): Promise<string> {
        // Use transaction parsing to find pool
        const poolAddress = await findMeteoraPoolViaTransactions(mint);

        if (poolAddress) {
            return poolAddress;
        }

        throw new Error("Meteora pool not found");
    },

    parseCurveData(data: Buffer): BondingCurveData {
        // Progress should come from getMeteoraPoolStatus for accuracy
        // This is placeholder for the interface
        return {
            progress: 0,
            complete: false
        };
    }
};

/**
 * Get full Meteora pool status including accurate progress
 */
export async function getMeteoraPoolStatus(poolAddress: string): Promise<{
    progress: number;
    migrated: boolean;
    threshold: bigint | null;
}> {
    try {
        const client = getClient();

        // Get accurate progress (0-1) from SDK
        const progress = await client.state.getPoolCurveProgress(poolAddress);

        // Check migration status
        const pool = await client.state.getPool(poolAddress);
        const migrated = Boolean((pool as any)?.migrated);

        // Get threshold
        let threshold: bigint | null = null;
        try {
            const t = await client.state.getPoolMigrationQuoteThreshold(poolAddress);
            threshold = BigInt(t.toString());
        } catch { /* ignore */ }

        console.log(`📊 [Meteora] Progress: ${(progress * 100).toFixed(2)}%, Migrated: ${migrated}`);

        return {
            progress: progress * 100,
            migrated,
            threshold
        };
    } catch (error) {
        console.warn("⚠️ Meteora status error:", (error as Error).message);
        return { progress: 0, migrated: false, threshold: null };
    }
}

/**
 * Meteora Pool Safety Configuration
 * Fetches the full DBC config to assess rug risk
 */
export interface MeteoraPoolSafety {
    // Pool identification
    poolAddress: string;
    migrated: boolean;
    progress: number;

    // LP Lock Safety (higher = safer)
    creatorLockedLpPercentage: number;
    partnerLockedLpPercentage: number;
    totalLockedLpPercentage: number;

    // Claimable LP (lower = safer, 0 = best)
    creatorLpPercentage: number;
    partnerLpPercentage: number;
    totalClaimableLpPercentage: number;

    // Token Authority Control (1 = immutable = safest)
    tokenUpdateAuthority: number;
    tokenUpdateAuthorityDescription: string;

    // Vesting (true = safer if there's claimable LP)
    hasVesting: boolean;

    // Migration details
    migrationQuoteThreshold: string;
    migrationOption: 'DAMM_V1' | 'DAMM_V2' | 'UNKNOWN';

    // Quote reserve tracking (for migration keeper threshold check)
    quoteReserve: string;           // Current quote token reserve in pool
    quoteReserveUsd: number;        // Estimated USD value (approximate)
    migrationAtRisk: boolean;       // True if quoteReserve < $750 USD
}

/**
 * Get token authority description
 */
function getTokenAuthorityDescription(authorityType: number): string {
    const descriptions: Record<number, string> = {
        0: 'Creator can update metadata',
        1: 'Immutable (no one can update)',
        2: 'Partner can update metadata',
        3: 'Creator can update + mint',
        4: 'Partner can update + mint',
    };
    return descriptions[authorityType] || 'Unknown';
}

/**
 * Get full Meteora pool safety configuration
 * Fetches config key and returns all safety-relevant parameters
 */
export async function getMeteoraPoolSafety(poolAddress: string): Promise<MeteoraPoolSafety | null> {
    try {
        const client = getClient();

        // Get pool state
        const pool = await client.state.getPool(poolAddress);
        if (!pool) {
            console.warn(`⚠️ [Meteora Safety] Pool not found: ${poolAddress}`);
            return null;
        }

        // Get progress
        const progress = await client.state.getPoolCurveProgress(poolAddress);
        const migrated = Boolean((pool as any)?.migrated);

        // Get config
        const configKey = (pool as any).config;
        if (!configKey) {
            console.warn(`⚠️ [Meteora Safety] No config key found for pool`);
            return null;
        }

        const config = await client.state.getPoolConfig(configKey.toString());
        if (!config) {
            console.warn(`⚠️ [Meteora Safety] Config not found`);
            return null;
        }

        // Extract safety parameters from config
        // Config fields are BPS (basis points) - divide by 100 to get percentage
        const configData = config as any;

        // LP percentages (convert from BPS if needed, or use as-is if already percentage)
        const creatorLockedLpPct = Number(configData.creatorLockedLpPercentage || configData.creatorPostMigrationLpPercentage || 0);
        const partnerLockedLpPct = Number(configData.partnerLockedLpPercentage || configData.partnerPostMigrationLpPercentage || 0);
        const creatorClaimablePct = Number(configData.creatorLpPercentage || configData.creatorTradingFeePercentage || 0);
        const partnerClaimablePct = Number(configData.partnerLpPercentage || configData.partnerTradingFeePercentage || 0);

        // Token authority (0-4)
        const tokenUpdateAuthority = Number(configData.tokenUpdateAuthority?.type ?? configData.tokenUpdateAuthority ?? 0);

        // Vesting
        const hasVesting = Boolean(configData.lockedVesting || configData.vestingConfig);

        // Migration threshold and option
        let migrationThreshold = '0';
        try {
            const t = await client.state.getPoolMigrationQuoteThreshold(poolAddress);
            migrationThreshold = t.toString();
        } catch { /* ignore */ }

        const migrationOption = configData.migrationOption === 0 ? 'DAMM_V1' :
            configData.migrationOption === 1 ? 'DAMM_V2' : 'UNKNOWN';

        // Quote reserve tracking for migration keeper threshold  
        // Migration keepers require >= $750 USD worth of quoteReserve
        const poolData = pool as any;
        const quoteReserve = poolData.quoteReserve?.toString() || '0';

        // Use live SOL price for accurate USD conversion
        // quoteReserve is in lamports (9 decimals for SOL)
        const quoteReserveLamports = BigInt(quoteReserve);
        const quoteReserveSol = Number(quoteReserveLamports) / 1e9;
        const solPrice = getSOLPriceSync();
        const quoteReserveUsd = quoteReserveSol * solPrice;

        // Migration is at risk if quoteReserve < $750 USD
        const migrationAtRisk = quoteReserveUsd < 750;

        const result: MeteoraPoolSafety = {
            poolAddress,
            migrated,
            progress: progress * 100,

            creatorLockedLpPercentage: creatorLockedLpPct,
            partnerLockedLpPercentage: partnerLockedLpPct,
            totalLockedLpPercentage: creatorLockedLpPct + partnerLockedLpPct,

            creatorLpPercentage: creatorClaimablePct,
            partnerLpPercentage: partnerClaimablePct,
            totalClaimableLpPercentage: creatorClaimablePct + partnerClaimablePct,

            tokenUpdateAuthority,
            tokenUpdateAuthorityDescription: getTokenAuthorityDescription(tokenUpdateAuthority),

            hasVesting,

            migrationQuoteThreshold: migrationThreshold,
            migrationOption,

            // Quote reserve fields
            quoteReserve,
            quoteReserveUsd,
            migrationAtRisk,
        };

        console.log(`📊 [Meteora Safety] Pool ${poolAddress.slice(0, 8)}...`);
        console.log(`   Locked LP: ${result.totalLockedLpPercentage}%, Claimable: ${result.totalClaimableLpPercentage}%`);
        console.log(`   Authority: ${result.tokenUpdateAuthorityDescription}, Vesting: ${result.hasVesting}`);
        console.log(`   Quote Reserve: ~$${quoteReserveUsd.toFixed(0)} USD, Migration Risk: ${migrationAtRisk ? 'YES' : 'NO'}`);

        return result;

    } catch (error) {
        console.error(`❌ [Meteora Safety] Error:`, (error as Error).message);
        return null;
    }
}
