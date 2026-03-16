/**
 * Pump.fun Platform Adapter
 * 
 * Program ID: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 * PDA Seeds: ["bonding-curve", mint.toBytes()]
 */

import { PublicKey } from "@solana/web3.js";
import { BondingCurveData, PlatformAdapter } from "../types.js";
import { PROGRAM_IDS } from "../../config.js";

// Pump.fun bonding curve data layout offsets
// Layout: discriminator(8) + virtualTokenReserves(8) + virtualSolReserves(8) + 
//         realTokenReserves(8) + realSolReserves(8) + tokenTotalSupply(8) + complete(1)
const LAYOUT = {
    DISCRIMINATOR: 0,
    VIRTUAL_TOKEN_RESERVES: 8,
    VIRTUAL_SOL_RESERVES: 16,
    REAL_TOKEN_RESERVES: 24,
    REAL_SOL_RESERVES: 32,
    TOKEN_TOTAL_SUPPLY: 40,
    COMPLETE: 48,
};

// Pump.fun tokenomics constants (with 6 decimals)
// Initial virtual token reserves when bonding curve starts
const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;  // 1,073,000,000 * 10^6
// Tokens to be sold on the bonding curve (total - reserved)
const TOKENS_TO_COLLECT = 793_100_000_000_000n;                  // 793,100,000 * 10^6

/**
 * Derive the bonding curve PDA for a Pump.fun token
 */
export function derivePumpfunCurvePDA(mint: string): [PublicKey, number] {
    const mintPubkey = new PublicKey(mint);
    const programId = new PublicKey(PROGRAM_IDS.PUMPFUN);

    return PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
        programId
    );
}

/**
 * Parse Pump.fun bonding curve account data
 * 
 * CORRECT FORMULA (from Binance/StackExchange research):
 * Progress = ((initialVirtualTokenReserves - currentVirtualTokenReserves) * 100) / tokensToCollect
 */
export function parsePumpfunCurveData(data: Buffer): BondingCurveData {
    if (data.length < 49) {
        console.warn("⚠️ Pump.fun curve data too short");
        return { progress: 0, complete: false };
    }

    // Read u64 values (little-endian)
    const virtualTokenReserves = data.readBigUInt64LE(LAYOUT.VIRTUAL_TOKEN_RESERVES);
    const virtualSolReserves = data.readBigUInt64LE(LAYOUT.VIRTUAL_SOL_RESERVES);
    const realTokenReserves = data.readBigUInt64LE(LAYOUT.REAL_TOKEN_RESERVES);
    const realSolReserves = data.readBigUInt64LE(LAYOUT.REAL_SOL_RESERVES);
    const complete = data.readUInt8(LAYOUT.COMPLETE) === 1;

    // Calculate tokens sold from initial virtual reserves
    const tokensSold = INITIAL_VIRTUAL_TOKEN_RESERVES - virtualTokenReserves;

    // Calculate progress as percentage of tokens sold vs tokens to collect
    let progress: number;
    if (TOKENS_TO_COLLECT > 0n) {
        progress = Number((tokensSold * 100n) / TOKENS_TO_COLLECT);
    } else {
        progress = 0;
    }

    // Clamp to 0-100 range
    progress = Math.max(0, Math.min(100, progress));

    return {
        progress,
        virtualSolReserves,
        virtualTokenReserves,
        realSolReserves,
        realTokenReserves,
        complete,
    };
}

/**
 * Pump.fun adapter implementation
 */
export const pumpfunAdapter: PlatformAdapter = {
    programId: PROGRAM_IDS.PUMPFUN,

    async deriveCurveAccount(mint: string): Promise<string> {
        const [pda] = derivePumpfunCurvePDA(mint);
        return pda.toBase58();
    },

    parseCurveData(data: Buffer): BondingCurveData {
        return parsePumpfunCurveData(data);
    },
};
