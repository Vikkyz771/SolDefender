import "dotenv/config";
import * as path from "path";

// Telegram
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

// Database
export const DATABASE_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "bot.db");

// Encryption (32-byte hex key for wallet encryption)
export const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "";

// Note: Priority fees are now handled automatically by Jupiter Ultra API

// Monitoring Intervals (global - system-level settings)
export const HTTP_FALLBACK_INTERVAL_MS = Number(process.env.HTTP_FALLBACK_INTERVAL_MS) || 300;
export const WS_STALE_THRESHOLD_MS = Number(process.env.WS_STALE_THRESHOLD_MS) || 500;
export const WALLET_POLL_INTERVAL_MS = Number(process.env.WALLET_POLL_INTERVAL_MS) || 700;

// Platform Program IDs
export const PROGRAM_IDS = {
    PUMPFUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    // Raydium LaunchLab - powers Bonk.fun and other partner launchpads
    RAYDIUM_LAUNCHLAB: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
    METEORA_DBC: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    MOONSHOT: "MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG",
} as const;

// Solana Constants
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const METAPLEX_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
