/**
 * Liquidity Check - Simplified for Bonding Curve Detection Only
 * 
 * Flow:
 * 1. Check if token is on a bonding curve (Pump.fun, Bonk.fun, Meteora, Moonshot, Raydium LaunchLab)
 * 2. If bonding curve: Return progress, cache pool for buy
 * 3. If graduated: Token is traded on DEX - no special checks needed
 */

import { Platform } from "../../../autosell/types.js";
import { detectPlatform, deriveCurveAccount, getCurveProgress } from "../../../autosell/platforms/index.js";
import { getSOLPriceSync } from "../../../utils/solPrice.js";
import { cachePool, getCachedPool } from "../../../cache/pools.js";
import { getMonitoringHttpRpc } from "../../../utils/rpc.js";

// =============================================================================
// Types
// =============================================================================

export interface LiquidityRiskResult {
    // Bonding curve info
    isBondingCurve: boolean;
    platform: Platform | null;
    curveProgress: number;
    curvePoolAddress: string | null;

    // Liquidity info
    totalLiquidityUSD: number;
    totalLiquiditySol: number;

    // Legacy fields (kept for compatibility)
    pools: any[];
    weightedLockedPercent: number;
    weightedBurnedPercent: number;
    weightedUnlockablePercent: number;
    liquidityAtRiskUSD: number;
    verdict: "safe" | "moderate" | "high" | "critical" | "unknown";
    riskScore: number;
    riskFactors: string[];
    poolCount: number;
    checkDurationMs: number;
    timedOut: boolean;
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Check liquidity for a token - focused on bonding curve detection
 * 
 * This is called on SCAN. For BUY, use the cached pool.
 * 
 * Key behavior:
 * - Uses cached pool ADDRESS if available
 * - Always REFRESHES bonding curve progress (allows monitoring)
 * - Caches pool for future buy operations
 */
export async function checkLiquidityRisk(tokenMint: string): Promise<LiquidityRiskResult> {
    const startTime = Date.now();

    console.log(`🔍 [Liquidity] Checking liquidity for ${tokenMint.slice(0, 8)}...`);

    try {
        // Check if we have a cached pool (for quick platform detection)
        const cachedPool = getCachedPool(tokenMint);

        let platform: Platform;
        let curveAddress: string | null;

        if (cachedPool) {
            // Use cached platform and pool address
            platform = cachedPool.platform;
            curveAddress = cachedPool.poolAddress;
            console.log(`   ✅ [Cache] Using cached ${platform} pool: ${curveAddress.slice(0, 8)}...`);
        } else {
            // Detect platform fresh
            platform = await detectPlatform(tokenMint);

            if (platform === Platform.UNKNOWN) {
                // Token is graduated / not on bonding curve
                return createGraduatedResult(startTime);
            }

            // Derive curve address
            curveAddress = await deriveCurveAccount(tokenMint, platform);

            if (!curveAddress) {
                console.log(`⚠️ [Liquidity] Could not derive curve address`);
                return createGraduatedResult(startTime);
            }

            // Cache for future use (buy flow)
            cachePool(tokenMint, curveAddress, platform);
        }

        // ALWAYS refresh progress (key feature for monitoring)
        console.log(`📊 [Liquidity] Refreshing bonding curve progress...`);
        const curveData = await getCurveProgress(curveAddress, platform);

        // Get liquidity value
        const liquidityUSD = await getCurveLiquidity(curveAddress, platform);
        const liquiditySol = liquidityUSD / (getSOLPriceSync() || 1);

        console.log(`📈 [${platform}] Progress: ${curveData.progress.toFixed(2)}%`);
        console.log(`💧 [Liquidity] ${liquiditySol.toFixed(4)} SOL ($${liquidityUSD.toFixed(2)})`);

        return {
            isBondingCurve: true,
            platform,
            curveProgress: curveData.progress,
            curvePoolAddress: curveAddress,

            totalLiquidityUSD: liquidityUSD,
            totalLiquiditySol: liquiditySol,

            // Legacy fields
            pools: [],
            weightedLockedPercent: 100,  // Bonding curve = locked
            weightedBurnedPercent: 0,
            weightedUnlockablePercent: 0,
            liquidityAtRiskUSD: 0,
            verdict: "safe",
            riskScore: 0,
            riskFactors: [],
            poolCount: 1,
            checkDurationMs: Date.now() - startTime,
            timedOut: false,
        };

    } catch (error) {
        console.error(`❌ [Liquidity] Error:`, error);
        return createErrorResult(startTime, error);
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get SOL reserve from bonding curve pool
 */
async function getCurveLiquidity(curveAddress: string, platform: Platform): Promise<number> {
    try {
        const connection = getMonitoringHttpRpc();
        const SOL_MINT = "So11111111111111111111111111111111111111112";

        // For most bonding curves, liquidity is the SOL held in the curve account
        const tokenAccounts = await connection.getTokenAccountsByOwner(
            new (await import("@solana/web3.js")).PublicKey(curveAddress),
            { mint: new (await import("@solana/web3.js")).PublicKey(SOL_MINT) }
        );

        if (tokenAccounts.value.length > 0) {
            const data = tokenAccounts.value[0].account.data as Buffer;
            const amount = data.readBigUInt64LE(64);
            const solBalance = Number(amount) / 1e9;
            const solPrice = getSOLPriceSync() || 1;

            console.log(`💧 [Liquidity] ${platform} pool SOL reserve: ${solBalance.toFixed(4)} SOL`);
            console.log(`💧 [Liquidity] Total: ${solBalance.toFixed(4)} SOL × $${solPrice.toFixed(2)} × 2 = $${(solBalance * solPrice * 2).toFixed(2)}`);

            return solBalance * solPrice * 2; // x2 for paired liquidity
        }

        return 0;
    } catch (error) {
        console.log(`⚠️ [Liquidity] Could not fetch SOL reserve`);
        return 0;
    }
}

/**
 * Result for graduated tokens (not on bonding curve)
 */
function createGraduatedResult(startTime: number): LiquidityRiskResult {
    console.log(`💱 [Liquidity] Token is graduated / not on bonding curve`);

    return {
        isBondingCurve: false,
        platform: null,
        curveProgress: 100,
        curvePoolAddress: null,

        totalLiquidityUSD: 0,
        totalLiquiditySol: 0,

        pools: [],
        weightedLockedPercent: 0,
        weightedBurnedPercent: 0,
        weightedUnlockablePercent: 0,
        liquidityAtRiskUSD: 0,
        verdict: "unknown",
        riskScore: 0,
        riskFactors: [],
        poolCount: 0,
        checkDurationMs: Date.now() - startTime,
        timedOut: false,
    };
}

/**
 * Result for errors
 */
function createErrorResult(startTime: number, error: unknown): LiquidityRiskResult {
    return {
        isBondingCurve: false,
        platform: null,
        curveProgress: 0,
        curvePoolAddress: null,

        totalLiquidityUSD: 0,
        totalLiquiditySol: 0,

        pools: [],
        weightedLockedPercent: 0,
        weightedBurnedPercent: 0,
        weightedUnlockablePercent: 0,
        liquidityAtRiskUSD: 0,
        verdict: "unknown",
        riskScore: 0,
        riskFactors: [error instanceof Error ? error.message : "Unknown error"],
        poolCount: 0,
        checkDurationMs: Date.now() - startTime,
        timedOut: false,
    };
}
