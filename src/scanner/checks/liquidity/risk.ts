/**
 * Liquidity Risk Calculator
 * 
 * Calculates weighted risk score based on LP holder distribution
 * across all pools for a token
 */

import {
    PoolAnalysis,
    LiquidityVerdict,
    RiskLevel,
    LPHolderInfo
} from "./types.js";

// =============================================================================
// Risk Thresholds
// =============================================================================

const RISK_THRESHOLDS = {
    SAFE: 5,           // < 5% unlockable
    LOW_RISK: 15,      // 5-15% unlockable
    MEDIUM_RISK: 30,   // 15-30% unlockable
    HIGH_RISK: 50,     // 30-50% unlockable
    // > 50% = CRITICAL
};

// Special case thresholds
const SINGLE_POOL_RISK = {
    HIGH_RISK_HOLDER: 25,  // Any wallet/upgradable holding >25% of ANY pool = flag
    EXPIRING_SOON_DAYS: 7, // Lock expiring in <7 days = upgrade risk
};

// =============================================================================
// Main Risk Calculation
// =============================================================================

export interface RiskCalculation {
    weightedLockedPercent: number;
    weightedBurnedPercent: number;
    weightedUnlockablePercent: number;
    liquidityAtRiskUSD: number;
    verdict: LiquidityVerdict;
    riskScore: number;        // 0-100 contribution to overall scan score
    riskFactors: string[];
}

/**
 * Calculate overall liquidity risk from analyzed pools
 */
export function calculateLiquidityRisk(
    pools: PoolAnalysis[],
    totalLiquidityUSD: number
): RiskCalculation {
    const riskFactors: string[] = [];

    if (pools.length === 0) {
        return {
            weightedLockedPercent: 0,
            weightedBurnedPercent: 0,
            weightedUnlockablePercent: 0,
            liquidityAtRiskUSD: 0,
            verdict: "safe",
            riskScore: 0,
            riskFactors: ["No liquidity pools found"],
        };
    }

    // Calculate weighted percentages based on pool liquidity
    let weightedLocked = 0;
    let weightedBurned = 0;
    let weightedUnlockable = 0;
    let liquidityAtRisk = 0;

    for (const pool of pools) {
        const poolWeight = totalLiquidityUSD > 0
            ? pool.liquidityUSD / totalLiquidityUSD
            : 1 / pools.length;

        weightedLocked += pool.lockedPercent * poolWeight;
        weightedBurned += pool.burnedPercent * poolWeight;
        weightedUnlockable += pool.unlockablePercent * poolWeight;

        // Calculate USD at risk for this pool
        const poolAtRisk = pool.liquidityUSD * (pool.unlockablePercent / 100);
        liquidityAtRisk += poolAtRisk;

        // Check for high-risk individual holders
        checkPoolForRiskyHolders(pool, riskFactors);
    }

    // Determine verdict based on weighted unlockable percentage
    const verdict = getVerdict(weightedUnlockable);

    // Calculate risk score (0-100 for liquidity component)
    // Max 30 points for liquidity risk in overall scan
    let riskScore = 0;
    if (weightedUnlockable > RISK_THRESHOLDS.HIGH_RISK) {
        riskScore = 30;
        riskFactors.push(`${weightedUnlockable.toFixed(1)}% of liquidity is unlockable`);
    } else if (weightedUnlockable > RISK_THRESHOLDS.MEDIUM_RISK) {
        riskScore = 20;
        riskFactors.push(`${weightedUnlockable.toFixed(1)}% of liquidity can be removed`);
    } else if (weightedUnlockable > RISK_THRESHOLDS.LOW_RISK) {
        riskScore = 10;
    } else if (weightedUnlockable > RISK_THRESHOLDS.SAFE) {
        riskScore = 5;
    }

    // Add summary risk factor
    if (liquidityAtRisk > 0 && riskScore > 0) {
        riskFactors.push(`$${formatNumber(liquidityAtRisk)} in unlockable liquidity`);
    }

    return {
        weightedLockedPercent: Math.min(100, weightedLocked),
        weightedBurnedPercent: Math.min(100, weightedBurned),
        weightedUnlockablePercent: Math.min(100, weightedUnlockable),
        liquidityAtRiskUSD: liquidityAtRisk,
        verdict,
        riskScore,
        riskFactors,
    };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Determine risk verdict from unlockable percentage
 */
function getVerdict(unlockablePercent: number): LiquidityVerdict {
    if (unlockablePercent < RISK_THRESHOLDS.SAFE) return "safe";
    if (unlockablePercent < RISK_THRESHOLDS.LOW_RISK) return "low_risk";
    if (unlockablePercent < RISK_THRESHOLDS.MEDIUM_RISK) return "medium_risk";
    if (unlockablePercent < RISK_THRESHOLDS.HIGH_RISK) return "high_risk";
    return "critical";
}

/**
 * Check a pool for individual high-risk holders
 */
function checkPoolForRiskyHolders(pool: PoolAnalysis, riskFactors: string[]): void {
    for (const holder of pool.lpHolders) {
        // Check for wallet holding significant LP
        if (
            holder.type === "wallet" &&
            holder.percentOfSupply >= SINGLE_POOL_RISK.HIGH_RISK_HOLDER
        ) {
            riskFactors.push(
                `Wallet ${holder.address.slice(0, 8)}... holds ${holder.percentOfSupply.toFixed(1)}% of ${getDexName(pool.dex)} LP`
            );
        }

        // Check for upgradable program
        if (
            holder.type === "upgradable_program" &&
            holder.percentOfSupply >= SINGLE_POOL_RISK.HIGH_RISK_HOLDER
        ) {
            riskFactors.push(
                `Upgradable program holds ${holder.percentOfSupply.toFixed(1)}% of ${getDexName(pool.dex)} LP`
            );
        }

        // Check for locks expiring soon
        if (
            holder.type === "locked" &&
            holder.details?.daysToUnlock !== undefined &&
            holder.details.daysToUnlock <= SINGLE_POOL_RISK.EXPIRING_SOON_DAYS &&
            holder.percentOfSupply >= 10
        ) {
            if (holder.details.daysToUnlock <= 0) {
                riskFactors.push(
                    `${holder.percentOfSupply.toFixed(1)}% of ${getDexName(pool.dex)} LP lock has EXPIRED`
                );
            } else {
                riskFactors.push(
                    `${holder.percentOfSupply.toFixed(1)}% of ${getDexName(pool.dex)} LP unlocks in ${holder.details.daysToUnlock} days`
                );
            }
        }
    }
}

/**
 * Get human-readable DEX name
 */
function getDexName(dex: string): string {
    const names: Record<string, string> = {
        "raydium_amm": "Raydium AMM",
        "raydium_clmm": "Raydium CLMM",
        "raydium_cpmm": "Raydium CPMM",
        "orca_whirlpool": "Orca",
        "orca_legacy": "Orca Legacy",
        "meteora_dlmm": "Meteora DLMM",
        "meteora_pools": "Meteora",
        "lifinity": "Lifinity",
    };
    return names[dex] || dex;
}

/**
 * Format large numbers with K/M suffixes
 */
function formatNumber(num: number): string {
    if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(2) + "M";
    }
    if (num >= 1_000) {
        return (num / 1_000).toFixed(1) + "K";
    }
    return num.toFixed(0);
}

/**
 * Get pool risk level from its holders
 */
export function getPoolRiskLevel(pool: PoolAnalysis): RiskLevel {
    if (pool.unlockablePercent < 5) return "safe";
    if (pool.unlockablePercent < 20) return "low";
    if (pool.unlockablePercent < 40) return "medium";
    if (pool.unlockablePercent < 70) return "high";
    return "critical";
}

/**
 * Get verdict display properties
 */
export function getVerdictDisplay(verdict: LiquidityVerdict): {
    emoji: string;
    label: string;
    color: string;
} {
    switch (verdict) {
        case "safe":
            return { emoji: "✅", label: "SAFE", color: "green" };
        case "low_risk":
            return { emoji: "🟡", label: "LOW RISK", color: "yellow" };
        case "medium_risk":
            return { emoji: "🟠", label: "MEDIUM RISK", color: "orange" };
        case "high_risk":
            return { emoji: "🔴", label: "HIGH RISK", color: "red" };
        case "critical":
            return { emoji: "⛔", label: "CRITICAL", color: "red" };
    }
}
