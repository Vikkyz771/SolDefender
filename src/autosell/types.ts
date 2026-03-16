/**
 * Autosell Types and Interfaces
 */

/**
 * Supported bonding curve platforms
 */
export enum Platform {
    PUMPFUN = "PUMPFUN",
    RAYDIUM_LAUNCHLAB = "RAYDIUM_LAUNCHLAB", // Powers Bonk.fun and other partners
    METEORA_DBC = "METEORA_DBC",
    MOONSHOT = "MOONSHOT",
    UNKNOWN = "UNKNOWN",
}

/**
 * Token being tracked for auto-sell
 */
export interface TrackedToken {
    mint: string;                   // Token mint address
    curveAccount: string;           // Bonding curve PDA
    platform: Platform;             // Which platform
    subscriptionId: number | null;  // WebSocket subscription ID (null if not subscribed)
    lastUpdate: number;             // Timestamp of last data update
    currentProgress: number;        // Bonding curve progress 0-100%
    balance: bigint;                // Token balance in wallet
    telegramId: number;             // Owner's Telegram ID (for multi-user support)
    walletId: number;               // Owner's wallet ID (for multi-wallet support)
}

/**
 * Parsed bonding curve data
 * Phase 4 adapters will populate this
 */
export interface BondingCurveData {
    progress: number;               // 0-100%
    virtualSolReserves?: bigint;    // SOL in curve
    virtualTokenReserves?: bigint;  // Tokens in curve
    realSolReserves?: bigint;       // Real SOL (for graduation)
    realTokenReserves?: bigint;     // Real tokens
    complete?: boolean;             // Already graduated
}

/**
 * Platform adapter interface (Phase 4 will implement)
 */
export interface PlatformAdapter {
    programId: string;
    deriveCurveAccount(mint: string): Promise<string>;
    parseCurveData(data: Buffer): BondingCurveData;
}
