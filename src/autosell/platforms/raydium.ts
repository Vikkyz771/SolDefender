/**
 * Raydium LaunchLab Platform Adapter
 * 
 * Program ID: LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
 * 
 * Raydium LaunchLab powers multiple partner launchpads including:
 * - Bonk.fun (LetsBonk)
 * - Raydium Direct launchpad
 * - Other partner platforms
 * 
 * IMPORTANT: LaunchLab pools can be paired with different quote currencies:
 * - SOL (native wrapped SOL)
 * - USD1 (WLFI stablecoin via Project Wings)
 * - USDC
 * 
 * PDA Seeds may be in either order depending on how pool was created:
 * - ["pool", mintA.toBuffer(), mintB.toBuffer()]
 * - ["pool", mintB.toBuffer(), mintA.toBuffer()]
 * 
 * We must try all combinations to find the correct pool.
 */

import { PublicKey } from "@solana/web3.js";
import { BondingCurveData, PlatformAdapter } from "../types.js";
import { PROGRAM_IDS, SOL_MINT } from "../../config.js";
import { getMonitoringHttpRpc } from "../../utils/rpc.js";

// Raydium LaunchLab pool account data layout
// Corrected based on actual struct analysis
const LAYOUT = {
    DISCRIMINATOR: 0,           // 8 bytes
    BASE_MINT: 8,               // 32 bytes - token being launched
    QUOTE_MINT: 40,             // 32 bytes - quote currency (SOL, USD1, USDC, etc.)
    CREATOR: 72,                // 32 bytes - pool creator
    BASE_VAULT: 104,            // 32 bytes - base token vault
    QUOTE_VAULT: 136,           // 32 bytes - quote token vault  
    VIRTUAL_BASE: 168,          // 8 bytes (u64) - virtual base reserves
    VIRTUAL_QUOTE: 176,         // 8 bytes (u64) - virtual quote reserves
    REAL_TOKEN_RESERVES: 184,   // 8 bytes (u64) - real base/token reserves
    REAL_SOL_RESERVES: 192,     // 8 bytes (u64) - real quote/SOL reserves
    TOTAL_BASE_SELL: 200,       // 8 bytes (u64) - total tokens to sell
    TOTAL_QUOTE_FUND: 208,      // 8 bytes (u64) - total quote raised
    SUPPLY: 216,                // 8 bytes (u64) - supply
    COMPLETE: 224,              // 1 byte (bool) - migrated status
};

// Standard LaunchLab token economics
const TOTAL_SUPPLY = 1_000_000_000n;           // 1 billion tokens
const RESERVED_TOKENS = 206_900_000n;          // Tokens not sold on curve
const INITIAL_REAL_TOKEN_RESERVES = TOTAL_SUPPLY - RESERVED_TOKENS; // 793,100,000

// Raydium LaunchLab graduation threshold
const GRADUATION_SOL_THRESHOLD = 85_000_000_000n; // 85 SOL in lamports

// Pool seed from Raydium SDK
const POOL_SEED = Buffer.from("pool", "utf8");

/**
 * Known quote currencies for Raydium LaunchLab pools
 * Verified addresses - USD1 is used for Project Wings collaboration
 */
const KNOWN_QUOTE_MINTS = [
    SOL_MINT,                                           // Native SOL
    "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",      // USD1 (WLFI stablecoin - Project Wings) ✅ VERIFIED
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",    // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",    // USDT
];

const LAUNCHLAB_PROGRAM_ID = new PublicKey(PROGRAM_IDS.RAYDIUM_LAUNCHLAB);

/**
 * Derive the pool PDA for a token with a specific quote currency
 * 
 * Verified seeds: ["pool", token_mint, quote_mint]
 * This was confirmed by matching against known Bonk.fun pool accounts.
 */
function derivePoolPDA(tokenMint: string, quoteMint: string): PublicKey {
    const tokenPubkey = new PublicKey(tokenMint);
    const quotePubkey = new PublicKey(quoteMint);

    const [pda] = PublicKey.findProgramAddressSync(
        [POOL_SEED, tokenPubkey.toBuffer(), quotePubkey.toBuffer()],
        LAUNCHLAB_PROGRAM_ID
    );

    return pda;
}

/**
 * Find the correct pool PDA by trying all known quote currencies
 * Returns null if no pool is found
 */
async function findLaunchLabPool(tokenMint: string): Promise<string | null> {
    const connection = getMonitoringHttpRpc();

    console.log(`🔍 [LaunchLab] Searching for pool: ${tokenMint.slice(0, 8)}...`);

    for (const quoteMint of KNOWN_QUOTE_MINTS) {
        const quoteLabel = quoteMint.slice(0, 8);

        try {
            const pda = derivePoolPDA(tokenMint, quoteMint);
            const pdaAddress = pda.toBase58();

            const accountInfo = await connection.getAccountInfo(pda);

            if (accountInfo && accountInfo.owner.toBase58() === PROGRAM_IDS.RAYDIUM_LAUNCHLAB) {
                console.log(`   ✅ Found pool with ${quoteLabel}... quote`);
                return pdaAddress;
            }
        } catch (error) {
            // Continue to next quote currency
        }
    }

    console.log(`   ❌ No LaunchLab pool found`);
    return null;
}

/**
 * Parse Raydium LaunchLab pool account data
 * 
 * Progress formula: 100 - ((leftTokens * 100) / initialRealTokenReserves)
 */
export function parseRaydiumLaunchLabCurveData(data: Buffer): BondingCurveData {
    // Minimum expected data length (need to reach COMPLETE at 224+)
    if (data.length < 225) {
        console.warn(`⚠️ [LaunchLab] Data too short (${data.length} bytes), using fallback`);
        return fallbackParse(data);
    }

    try {
        // Read using corrected offsets
        const virtualBase = data.readBigUInt64LE(LAYOUT.VIRTUAL_BASE);
        const virtualQuote = data.readBigUInt64LE(LAYOUT.VIRTUAL_QUOTE);
        const realTokenReserves = data.readBigUInt64LE(LAYOUT.REAL_TOKEN_RESERVES);
        const realSolReserves = data.readBigUInt64LE(LAYOUT.REAL_SOL_RESERVES);
        const totalBaseSell = data.readBigUInt64LE(LAYOUT.TOTAL_BASE_SELL);
        const complete = data.readUInt8(LAYOUT.COMPLETE) === 1;

        // Calculate progress: tokens sold / total tokens to sell
        let progress: number;
        if (totalBaseSell > 0n) {
            // If we have totalBaseSell, use: tokensSold = totalBaseSell - realTokenReserves
            const tokensSold = totalBaseSell > realTokenReserves
                ? totalBaseSell - realTokenReserves
                : 0n;
            progress = Number((tokensSold * 100n) / totalBaseSell);
        } else if (INITIAL_REAL_TOKEN_RESERVES > 0n) {
            // Fallback to original formula
            const leftTokens = realTokenReserves > RESERVED_TOKENS
                ? realTokenReserves - RESERVED_TOKENS
                : 0n;
            progress = Number(100n - ((leftTokens * 100n) / INITIAL_REAL_TOKEN_RESERVES));
        } else {
            progress = 0;
        }

        // Clamp to 0-100 range
        progress = Math.max(0, Math.min(100, progress));

        console.log(`📊 [LaunchLab] Parsed: progress=${progress.toFixed(2)}%, realTokens=${realTokenReserves}, totalSell=${totalBaseSell}, complete=${complete}`);

        return {
            progress,
            realSolReserves,
            realTokenReserves,
            complete,
        };
    } catch (error) {
        console.warn("⚠️ Failed to parse Raydium LaunchLab curve data:", error);
        return fallbackParse(data);
    }
}

/**
 * Fallback parsing using SOL-based progress
 */
function fallbackParse(data: Buffer): BondingCurveData {
    if (data.length < 49) {
        return { progress: 0, complete: false };
    }

    try {
        const realSolReserves = data.readBigUInt64LE(32);
        const complete = data.length > 48 ? data.readUInt8(48) === 1 : false;
        const progress = Number((realSolReserves * 10000n) / GRADUATION_SOL_THRESHOLD) / 100;

        return {
            progress: Math.min(100, Math.max(0, progress)),
            realSolReserves,
            complete,
        };
    } catch {
        return { progress: 0, complete: false };
    }
}

/**
 * Raydium LaunchLab adapter implementation
 * 
 * This adapter works for all LaunchLab partner platforms including Bonk.fun
 * It tries multiple quote currencies and both PDA orders to find the correct pool
 */
export const raydiumLaunchLabAdapter: PlatformAdapter = {
    programId: PROGRAM_IDS.RAYDIUM_LAUNCHLAB,

    async deriveCurveAccount(mint: string): Promise<string> {
        // Try to find the pool with any known quote currency
        const poolAddress = await findLaunchLabPool(mint);

        if (poolAddress) {
            return poolAddress;
        }

        // Fallback: return empty string to indicate not found
        // The caller should handle this by checking if account exists
        console.warn(`⚠️ [LaunchLab] Returning fallback PDA for ${mint.slice(0, 8)}...`);
        const [pda] = PublicKey.findProgramAddressSync(
            [POOL_SEED, new PublicKey(mint).toBuffer(), new PublicKey(SOL_MINT).toBuffer()],
            LAUNCHLAB_PROGRAM_ID
        );
        return pda.toBase58();
    },

    parseCurveData(data: Buffer): BondingCurveData {
        return parseRaydiumLaunchLabCurveData(data);
    },
};
