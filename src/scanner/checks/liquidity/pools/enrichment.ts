/**
 * LP Mint Enrichment
 * 
 * Extracts LP mint addresses and supply from pool accounts.
 * Uses direct data parsing and SDK fallbacks.
 * 
 * SDKs Used:
 * - PumpSwap: @pump-fun/pump-swap-sdk for lpMintPda
 * - Raydium: Direct offset parsing
 * - Meteora: Direct offset parsing (DAMM v1/v2)
 */

import { PublicKey, Connection } from "@solana/web3.js";
import { getMonitoringHttpRpc } from "../../../../utils/rpc.js";
import { PoolInfo, DexType } from "../types.js";
import { getSOLPriceSync } from "../../../../utils/solPrice.js";

// =============================================================================
// Layout Offsets
// =============================================================================

// Raydium AMM v4 layout
const RAYDIUM_LP_MINT_OFFSET = 432;

// Meteora DAMM v1/v2 layout (approximate - need to verify)
// DAMM pools typically have: bump, config, creator, baseMint, quoteMint, lpMint...
const METEORA_DAMM_LP_MINT_OFFSET = 137; // After discriminator + various fields

// =============================================================================
// Main Enrichment Function
// =============================================================================

export async function enrichPoolWithLPData(pool: PoolInfo): Promise<PoolInfo> {
    // Skip concentrated liquidity / NFT position pools
    // These don't have traditional LP tokens - liquidity is managed via positions
    const positionBasedDexes: DexType[] = [
        "raydium_clmm",
        "orca_whirlpool",
        "meteora_dlmm",
        "meteora_pools",  // DAMM v2 uses Position NFTs, not LP tokens
    ];

    if (positionBasedDexes.includes(pool.dex)) {
        console.log(`ℹ️ [Enrich] ${pool.dex} uses NFT positions - inherently safer (no single LP to rug)`);
        return pool;
    }

    try {
        const connection = getMonitoringHttpRpc();

        switch (pool.dex) {
            case "raydium_amm":
                return await enrichRaydiumPool(pool, connection);

            case "meteora_pools":
                return await enrichMeteoraPool(pool, connection);

            case "pumpswap":
                return await enrichPumpSwapPool(pool, connection);

            default:
                console.log(`ℹ️ [Enrich] No enrichment for ${pool.dex}`);
                return pool;
        }

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️ [Enrich] ${pool.dex} failed: ${errMsg.slice(0, 50)}`);
        return pool;
    }
}

// =============================================================================
// DEX-Specific Enrichment
// =============================================================================

/**
 * Raydium AMM v4 - LP mint at offset 432
 */
async function enrichRaydiumPool(pool: PoolInfo, connection: Connection): Promise<PoolInfo> {
    const poolAccount = await connection.getAccountInfo(new PublicKey(pool.poolAddress));

    if (!poolAccount?.data || poolAccount.data.length < RAYDIUM_LP_MINT_OFFSET + 32) {
        console.warn(`⚠️ [Enrich] Raydium pool data too short`);
        return pool;
    }

    const data = poolAccount.data as Buffer;
    const lpMintBytes = data.subarray(RAYDIUM_LP_MINT_OFFSET, RAYDIUM_LP_MINT_OFFSET + 32);
    const lpMint = new PublicKey(lpMintBytes).toBase58();

    const supplyInfo = await connection.getTokenSupply(new PublicKey(lpMint));
    const lpSupply = BigInt(supplyInfo.value.amount);

    console.log(`✅ [Enrich] raydium_amm: LP=${lpMint.slice(0, 8)}..., Supply=${lpSupply.toLocaleString()}`);

    return { ...pool, lpMint, lpSupply };
}

/**
 * Meteora DAMM v1/v2 - Parse pool data or derive LP mint via PDA
 */
async function enrichMeteoraPool(pool: PoolInfo, connection: Connection): Promise<PoolInfo> {
    const poolPubkey = new PublicKey(pool.poolAddress);

    // Meteora DAMM pools derive LP mint as PDA: ["lp_mint", pool_address]
    try {
        // Try deriving LP mint PDA for DAMM pools
        const METEORA_DAMM_V1 = new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");
        const METEORA_DAMM_V2 = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

        // Try both program IDs
        for (const programId of [METEORA_DAMM_V2, METEORA_DAMM_V1]) {
            try {
                const [lpMintPda] = PublicKey.findProgramAddressSync(
                    [Buffer.from("lp_mint"), poolPubkey.toBuffer()],
                    programId
                );

                // Check if this mint exists
                const supplyInfo = await connection.getTokenSupply(lpMintPda);
                const lpSupply = BigInt(supplyInfo.value.amount);

                console.log(`✅ [Enrich] meteora_pools: LP=${lpMintPda.toBase58().slice(0, 8)}..., Supply=${lpSupply.toLocaleString()}`);

                return { ...pool, lpMint: lpMintPda.toBase58(), lpSupply };

            } catch {
                // This program ID didn't work, try next
                continue;
            }
        }

        // If PDA derivation failed, try parsing pool data directly
        const poolAccount = await connection.getAccountInfo(poolPubkey);
        if (poolAccount?.data && poolAccount.data.length > METEORA_DAMM_LP_MINT_OFFSET + 32) {
            const data = poolAccount.data as Buffer;
            const lpMintBytes = data.subarray(METEORA_DAMM_LP_MINT_OFFSET, METEORA_DAMM_LP_MINT_OFFSET + 32);
            const lpMint = new PublicKey(lpMintBytes).toBase58();

            try {
                const supplyInfo = await connection.getTokenSupply(new PublicKey(lpMint));
                const lpSupply = BigInt(supplyInfo.value.amount);

                console.log(`✅ [Enrich] meteora_pools: LP=${lpMint.slice(0, 8)}..., Supply=${lpSupply.toLocaleString()}`);
                return { ...pool, lpMint, lpSupply };
            } catch {
                // Not a valid mint at this offset
            }
        }

        console.log(`ℹ️ [Enrich] Meteora: Could not find LP mint`);
        return pool;

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`ℹ️ [Enrich] Meteora: ${errMsg.slice(0, 50)}`);
        return pool;
    }
}

/**
 * PumpSwap - Derive LP mint via SDK's lpMintPda
 */
async function enrichPumpSwapPool(pool: PoolInfo, connection: Connection): Promise<PoolInfo> {
    try {
        const { lpMintPda } = await import("@pump-fun/pump-swap-sdk");

        const poolPubkey = new PublicKey(pool.poolAddress);
        const lpMintResult = lpMintPda(poolPubkey);
        const lpMintAddress = Array.isArray(lpMintResult) ? lpMintResult[0] : lpMintResult;
        const lpMint = lpMintAddress.toBase58();

        const supplyInfo = await connection.getTokenSupply(lpMintAddress);
        const lpSupply = BigInt(supplyInfo.value.amount);

        console.log(`✅ [Enrich] pumpswap: LP=${lpMint.slice(0, 8)}..., Supply=${lpSupply.toLocaleString()}`);

        return { ...pool, lpMint, lpSupply };

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`ℹ️ [Enrich] PumpSwap: ${errMsg.slice(0, 50)}`);
        return pool;
    }
}

// =============================================================================
// Batch Enrichment
// =============================================================================

export async function enrichPoolsWithLPData(pools: PoolInfo[]): Promise<PoolInfo[]> {
    const enriched: PoolInfo[] = [];

    for (const pool of pools) {
        const enrichedPool = await enrichPoolWithLPData(pool);
        enriched.push(enrichedPool);
    }

    return enriched;
}
