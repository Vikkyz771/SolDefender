/**
 * Unified Pool Discovery
 * 
 * Uses SDK-based discovery as primary (100% reliable, ~4 RPC calls)
 * Falls back to TX history scanning if SDK finds nothing
 */

import { PoolInfo, PoolDiscoveryOptions, DEFAULT_DISCOVERY_OPTIONS, DexType } from "../types.js";
import { discoverPoolsViaSdk } from "./sdk-discovery.js";
import { discoverPoolsViaTxHistory } from "./tx-history-discovery.js";
import { enrichPoolsWithLPData } from "./enrichment.js";

// =============================================================================
// Discovery Result
// =============================================================================

export interface DiscoveryResult {
    pools: PoolInfo[];
    timedOut: boolean;
    durationMs: number;
    errors: string[];
    source: "sdk" | "tx-history" | "both";
}

// =============================================================================
// Main Discovery Function
// =============================================================================

/**
 * Discover all liquidity pools for a token
 * 
 * Uses SDK-based discovery as primary:
 * - PumpSwap: Anchor SDK with memcmp filters (1 call)
 * - Meteora: PDA derivation (1 call)
 * - Raydium: getProgramAccounts with memcmp (2 calls)
 * 
 * Falls back to TX history if SDK finds nothing.
 */
export async function discoverAllPools(
    tokenMint: string,
    options: Partial<PoolDiscoveryOptions> = {}
): Promise<DiscoveryResult> {
    const opts = { ...DEFAULT_DISCOVERY_OPTIONS, ...options };
    const startTime = Date.now();
    const errors: string[] = [];
    let timedOut = false;
    let source: "sdk" | "tx-history" | "both" = "sdk";

    console.log(`🔍 [Discovery] Starting pool discovery for ${tokenMint.slice(0, 8)}...`);

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("TIMEOUT")), opts.timeoutMs);
    });

    let allPools: PoolInfo[] = [];

    try {
        // Step 1: Try SDK-based discovery (primary)
        console.log(`   [Discovery] Phase 1: SDK-based discovery...`);

        const sdkPools = await Promise.race([
            discoverPoolsViaSdk(tokenMint),
            timeoutPromise,
        ]);

        if (sdkPools.length > 0) {
            allPools = sdkPools;
            source = "sdk";
            console.log(`   [Discovery] SDK found ${sdkPools.length} pool(s)`);
        } else {
            // Step 2: Fall back to TX history scanning
            console.log(`   [Discovery] Phase 2: TX history scan (fallback)...`);

            const txPools = await Promise.race([
                discoverPoolsViaTxHistory(tokenMint),
                timeoutPromise,
            ]);

            allPools = txPools;
            source = "tx-history";
            console.log(`   [Discovery] TX history found ${txPools.length} pool(s)`);
        }

        // Step 3: Enrich pools with LP data
        if (allPools.length > 0) {
            console.log(`   [Discovery] Enriching ${allPools.length} pool(s) with LP data...`);
            allPools = await enrichPoolsWithLPData(allPools);
        }

    } catch (error) {
        if (error instanceof Error && error.message === "TIMEOUT") {
            timedOut = true;
            console.warn(`⚠️ [Discovery] Timeout reached (${opts.timeoutMs}ms)`);
        } else {
            const errMsg = error instanceof Error ? error.message : String(error);
            errors.push(errMsg);
            console.error(`❌ [Discovery] Error:`, errMsg);
        }
    }

    // Sort by liquidity (highest first)
    allPools.sort((a, b) => b.liquidityUSD - a.liquidityUSD);

    // Deduplicate by pool address
    const uniquePools = deduplicatePools(allPools);

    // Limit to top N pools
    const limitedPools = uniquePools.slice(0, opts.maxPools);

    const durationMs = Date.now() - startTime;

    console.log(`✅ [Discovery] Found ${limitedPools.length} pools via ${source} (${durationMs}ms)${timedOut ? " [TIMEOUT]" : ""}`);

    return {
        pools: limitedPools,
        timedOut,
        durationMs,
        errors,
        source,
    };
}

// =============================================================================
// Helper Functions
// =============================================================================

function deduplicatePools(pools: PoolInfo[]): PoolInfo[] {
    const seen = new Set<string>();
    return pools.filter(pool => {
        const key = pool.poolAddress.toLowerCase();
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

export function getTotalLiquidity(pools: PoolInfo[]): { usd: number; sol: number } {
    return pools.reduce(
        (acc, pool) => ({
            usd: acc.usd + pool.liquidityUSD,
            sol: acc.sol + pool.liquiditySol,
        }),
        { usd: 0, sol: 0 }
    );
}

export function groupPoolsByDex(pools: PoolInfo[]): Map<DexType, PoolInfo[]> {
    const grouped = new Map<DexType, PoolInfo[]>();
    for (const pool of pools) {
        const existing = grouped.get(pool.dex) || [];
        existing.push(pool);
        grouped.set(pool.dex, existing);
    }
    return grouped;
}
