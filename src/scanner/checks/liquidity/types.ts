/**
 * Liquidity Risk Check Types
 * 
 * Core interfaces for multi-DEX pool discovery and LP holder analysis
 */

import { Platform } from "../../../autosell/types.js";

// =============================================================================
// DEX Types
// =============================================================================

export type DexType =
    | "raydium_amm"       // AMM v4 (Classic)
    | "raydium_clmm"      // Concentrated Liquidity
    | "raydium_cpmm"      // Constant Product
    | "orca_whirlpool"    // Orca CLMM
    | "orca_legacy"       // Orca Legacy
    | "meteora_dlmm"      // Meteora Dynamic Liquidity
    | "meteora_pools"     // Meteora Dynamic Pools
    | "pumpswap"          // Pump.fun AMM for graduated tokens
    | "lifinity"          // Lifinity V2
    | "unknown";

// =============================================================================
// Pool Information
// =============================================================================

export interface PoolInfo {
    dex: DexType;
    poolAddress: string;
    lpMint: string;              // LP token mint address
    tokenAMint: string;          // Usually SOL or USDC
    tokenBMint: string;          // The token being analyzed
    liquiditySol: number;        // SOL reserves
    liquidityUSD: number;        // USD value of total liquidity
    lpSupply: bigint;            // Total LP token supply
}

export interface PoolAnalysis extends PoolInfo {
    lpHolders: LPHolderInfo[];
    lockedPercent: number;       // 0-100
    burnedPercent: number;       // 0-100
    unlockablePercent: number;   // 0-100 (wallet + upgradable + expired)
    poolRiskLevel: RiskLevel;
}

// =============================================================================
// LP Holder Information
// =============================================================================

export type LPHolderType =
    | "burned"              // Sent to burn address (permanent)
    | "locked"              // In known locker with time-lock
    | "upgradable_program"  // Program with upgrade authority (risky)
    | "immutable_program"   // Program without upgrade authority
    | "wallet"              // Regular wallet (EOA) - high risk
    | "unknown";            // Needs manual review

export interface LPHolderInfo {
    address: string;
    balance: bigint;
    percentOfSupply: number;     // 0-100
    type: LPHolderType;
    riskLevel: RiskLevel;
    details?: LPHolderDetails;
}

export interface LPHolderDetails {
    // For locked holders
    lockerName?: string;         // e.g., "Streamflow", "Raydium Locker"
    daysToUnlock?: number;       // null if already unlocked or permanent
    unlockTimestamp?: number;    // Unix timestamp of unlock

    // For program holders
    programUpgradable?: boolean;
    upgradeAuthority?: string;
}

// =============================================================================
// Risk Assessment
// =============================================================================

export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";

export type LiquidityVerdict =
    | "safe"          // < 5% unlockable
    | "low_risk"      // 5-15% unlockable
    | "medium_risk"   // 15-30% unlockable
    | "high_risk"     // 30-50% unlockable
    | "critical";     // > 50% unlockable

export interface LiquidityRiskResult {
    // Bonding curve tokens
    isBondingCurve: boolean;
    platform?: Platform;
    curveProgress?: number;          // 0-100
    curvePoolAddress?: string;       // For caching

    // Graduated tokens (DEX pools)
    pools: PoolAnalysis[];
    totalLiquidityUSD: number;
    totalLiquiditySol: number;

    // Risk summary
    weightedLockedPercent: number;
    weightedBurnedPercent: number;
    weightedUnlockablePercent: number;
    liquidityAtRiskUSD: number;

    // Verdict
    verdict: LiquidityVerdict;
    riskScore: number;               // 0-100 contribution to overall score
    riskFactors: string[];           // Human-readable risk descriptions

    // Metadata
    poolCount: number;
    checkDurationMs: number;
    timedOut: boolean;               // True if 5s timeout hit
}

// =============================================================================
// Known Locker Configuration
// =============================================================================

export interface LockerConfig {
    name: string;
    programId: string;
    parseUnlockTime?: (accountData: Buffer) => number | null;
}

// =============================================================================
// Pool Cache (for buy flow optimization)
// =============================================================================

export interface CachedPool {
    tokenMint: string;
    poolAddress: string;
    platform: Platform;
    scannedAt: number;              // Unix timestamp
}

// =============================================================================
// Discovery Options
// =============================================================================

export interface PoolDiscoveryOptions {
    timeoutMs: number;              // Max time for discovery (default 7000)
    minLiquidityUSD: number;        // Skip pools below this (default 100)
    maxPools: number;               // Limit pools to analyze (default 3)
    includeDexes?: DexType[];       // Filter to specific DEXs (default all)
}

export const DEFAULT_DISCOVERY_OPTIONS: PoolDiscoveryOptions = {
    timeoutMs: 7000,
    minLiquidityUSD: 100,
    maxPools: 3,
};
