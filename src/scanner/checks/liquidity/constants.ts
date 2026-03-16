/**
 * DEX Program IDs Registry
 * 
 * Used for hybrid pool discovery - identifying pool accounts by their owner program.
 */

import { DexType } from "./types.js";

export interface DexProgramInfo {
    name: DexType;
    hasLpToken: boolean;
    label: string;
}

/**
 * Map of DEX program IDs to their info
 * Used to identify which DEX a pool belongs to when checking account owners
 */
export const DEX_POOL_PROGRAMS: Record<string, DexProgramInfo> = {
    // ========== Standard AMMs (Have LP tokens -> Analyze holders) ==========

    // Raydium AMM v4 (Legacy)
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
        name: "raydium_amm",
        hasLpToken: true,
        label: "Raydium AMM v4"
    },

    // PumpSwap (Pump.fun graduated tokens)
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": {
        name: "pumpswap",
        hasLpToken: true,
        label: "PumpSwap"
    },

    // Meteora Dynamic AMM v1 (Legacy graduated tokens)
    "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": {
        name: "meteora_pools",
        hasLpToken: true,
        label: "Meteora DAMM v1"
    },

    // Meteora Dynamic AMM v2 (Current graduated tokens)
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": {
        name: "meteora_pools",
        hasLpToken: true,
        label: "Meteora DAMM v2"
    },

    // Lifinity v1
    "EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S": {
        name: "lifinity",
        hasLpToken: true,
        label: "Lifinity v1"
    },

    // Lifinity v2
    "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c": {
        name: "lifinity",
        hasLpToken: true,
        label: "Lifinity v2"
    },

    // ========== Concentrated Liquidity (NFT Positions -> Skip LP analysis) ==========

    // Raydium CLMM
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": {
        name: "raydium_clmm",
        hasLpToken: false,
        label: "Raydium CLMM"
    },

    // Orca Whirlpool
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": {
        name: "orca_whirlpool",
        hasLpToken: false,
        label: "Orca Whirlpool"
    },

    // Meteora DLMM (Bin-based concentrated liquidity)
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": {
        name: "meteora_dlmm",
        hasLpToken: false,
        label: "Meteora DLMM"
    },
};

/**
 * Check if a program ID is a known DEX pool program
 */
export function isDexPoolProgram(programId: string): boolean {
    return programId in DEX_POOL_PROGRAMS;
}

/**
 * Get DEX info for a program ID
 */
export function getDexInfo(programId: string): DexProgramInfo | undefined {
    return DEX_POOL_PROGRAMS[programId];
}

/**
 * Get all DEX program IDs that have LP tokens (for filtering)
 */
export function getLpTokenDexPrograms(): string[] {
    return Object.entries(DEX_POOL_PROGRAMS)
        .filter(([, info]) => info.hasLpToken)
        .map(([id]) => id);
}
