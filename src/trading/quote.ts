/**
 * Price and quote fetching utilities
 * Uses robust HTTP client with connection pooling and retries
 * Includes DexScreener fallback for new tokens
 * 
 * NOTE: Swap quotes now use Jupiter Ultra API (jupiterUltra.ts)
 * This file is for price lookups only
 */

import { SOL_MINT } from "../config.js";
import { fetchJSON } from "../utils/http.js";
import { getSOLPriceSync } from "../utils/solPrice.js";
import { getBuyQuote as getUltraBuyQuote, getSellQuote as getUltraSellQuote } from "../utils/jupiterUltra.js";

// Jupiter API endpoints (for price lookups only)
const JUPITER_PRICE_API = "https://api.jup.ag/price/v2";

// DexScreener API (free, fast, indexes new pools quickly)
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";

export interface TokenPrice {
    mint: string;
    priceUSD: number;
    priceSOL: number;
    source: "jupiter" | "dexscreener" | "none";
}

export interface SwapQuote {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct: number;
    routePlan: unknown[];
}

interface JupiterPriceResponse {
    data: Record<string, { price: string } | undefined>;
}

interface JupiterQuoteResponse {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct?: string;
    routePlan?: unknown[];
}

interface DexScreenerResponse {
    pairs: Array<{
        chainId: string;
        priceUsd: string;
        priceNative: string;
        baseToken: { address: string };
        marketCap?: number;
        fdv?: number;
    }> | null;
}

/**
 * Get SOL price in USD (uses unified solPrice.ts)
 * @deprecated Use getSOLPriceSync() or getSOLPriceCached() from solPrice.ts instead
 */
export async function getSOLPrice(): Promise<number> {
    return getSOLPriceSync();
}

/**
 * Get token price from DexScreener (fallback for new tokens)
 */
async function getDexScreenerPrice(tokenMint: string): Promise<TokenPrice | null> {
    try {
        const data = await fetchJSON<DexScreenerResponse>(`${DEXSCREENER_API}/${tokenMint}`);

        if (!data.pairs || data.pairs.length === 0) {
            return null;
        }

        // Find Solana pair
        const solanaPair = data.pairs.find(p => p.chainId === "solana");
        if (!solanaPair) return null;

        const priceUSD = parseFloat(solanaPair.priceUsd || "0");
        const priceSOL = parseFloat(solanaPair.priceNative || "0");

        return {
            mint: tokenMint,
            priceUSD,
            priceSOL,
            source: "dexscreener",
        };
    } catch (error) {
        return null;
    }
}

/**
 * Get token price in USD and SOL (DexScreener first, Jupiter fallback)
 */
export async function getTokenPrice(tokenMint: string): Promise<TokenPrice> {
    // Try DexScreener first (more reliable for new tokens)
    const dexPrice = await getDexScreenerPrice(tokenMint);
    if (dexPrice && dexPrice.priceUSD > 0) {
        return dexPrice;
    }

    // Fallback to Jupiter for established tokens
    try {
        const data = await fetchJSON<JupiterPriceResponse>(
            `${JUPITER_PRICE_API}?ids=${tokenMint}`
        );

        const tokenPriceUSD = parseFloat(data.data[tokenMint]?.price || "0");
        const solPriceUSD = getSOLPriceSync();

        if (tokenPriceUSD > 0) {
            const tokenPriceSOL = solPriceUSD > 0 ? tokenPriceUSD / solPriceUSD : 0;
            return {
                mint: tokenMint,
                priceUSD: tokenPriceUSD,
                priceSOL: tokenPriceSOL,
                source: "jupiter",
            };
        }
    } catch (error) {
        // Silently fail - DexScreener already tried
    }

    // No price available
    return { mint: tokenMint, priceUSD: 0, priceSOL: 0, source: "none" };
}

/**
 * Get multiple token prices at once (parallel DexScreener calls)
 */
export async function getTokenPrices(tokenMints: string[]): Promise<Map<string, TokenPrice>> {
    const prices = new Map<string, TokenPrice>();
    if (tokenMints.length === 0) return prices;

    // Fetch all prices in parallel using DexScreener
    const pricePromises = tokenMints.map(async (mint) => {
        const price = await getTokenPrice(mint);
        return { mint, price };
    });

    const results = await Promise.allSettled(pricePromises);

    for (const result of results) {
        if (result.status === "fulfilled") {
            prices.set(result.value.mint, result.value.price);
        }
    }

    return prices;
}

/**
 * Get a swap quote - now uses Ultra API
 * @deprecated Use getBuyQuote or getSellQuote which use Ultra API
 */
export async function getSwapQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    slippageBps: number = 1500
): Promise<SwapQuote> {
    // Use legacy implementation for backwards compatibility
    // New code should use Ultra API directly
    const JUPITER_QUOTE_API = "https://public.jupiterapi.com/quote";
    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("slippageBps", slippageBps.toString());

    const data = await fetchJSON<JupiterQuoteResponse>(url.toString());

    return {
        inputMint: data.inputMint,
        outputMint: data.outputMint,
        inAmount: data.inAmount,
        outAmount: data.outAmount,
        priceImpactPct: parseFloat(data.priceImpactPct || "0"),
        routePlan: data.routePlan || [],
    };
}

/**
 * Get buy quote (SOL → Token) using Ultra API
 */
export async function getBuyQuote(
    tokenMint: string,
    solAmount: number,
    slippageBps: number = 1500,
    taker?: string
): Promise<{ quote?: SwapQuote; estimatedTokens: bigint }> {
    // Ultra API requires a taker address
    const takerAddress = taker || "11111111111111111111111111111111"; // Dummy for quote-only

    try {
        const ultraQuote = await getUltraBuyQuote(tokenMint, solAmount, takerAddress);
        return {
            estimatedTokens: BigInt(ultraQuote.estimatedTokens),
        };
    } catch (error) {
        throw error;
    }
}

/**
 * Get sell quote (Token → SOL) using Ultra API
 */
export async function getSellQuote(
    tokenMint: string,
    tokenAmount: bigint,
    slippageBps: number = 1500,
    taker?: string
): Promise<{ quote?: SwapQuote; estimatedSOL: number }> {
    // Ultra API requires a taker address
    const takerAddress = taker || "11111111111111111111111111111111"; // Dummy for quote-only

    try {
        const ultraQuote = await getUltraSellQuote(tokenMint, tokenAmount, takerAddress);
        return {
            estimatedSOL: ultraQuote.estimatedSOL,
        };
    } catch (error) {
        throw error;
    }
}


/**
 * Get token market cap using on-chain data
 * Market Cap = Price × Total Supply
 * - Price: from getTokenPrice (DexScreener/Jupiter)
 * - Total Supply: from on-chain mint account
 * Returns null if market cap cannot be calculated
 */
export async function getTokenMarketCap(tokenMint: string): Promise<number | null> {
    try {
        // Import RPC connection
        const { getMonitoringHttpRpc } = await import("../utils/rpc.js");
        const { PublicKey } = await import("@solana/web3.js");

        // Get token price
        const priceData = await getTokenPrice(tokenMint);
        if (priceData.priceUSD <= 0) {
            return null;
        }

        // Get token supply from mint account
        const mintPubkey = new PublicKey(tokenMint);
        const mintInfo = await getMonitoringHttpRpc().getParsedAccountInfo(mintPubkey);

        if (!mintInfo.value) {
            return null;
        }

        // Parse mint data
        const parsedData = mintInfo.value.data as {
            parsed?: {
                info?: {
                    supply?: string;
                    decimals?: number;
                };
            };
        };

        const supplyRaw = parsedData.parsed?.info?.supply;
        const decimals = parsedData.parsed?.info?.decimals;

        if (!supplyRaw || decimals === undefined) {
            return null;
        }

        // Calculate actual supply (divide by 10^decimals)
        const totalSupply = Number(BigInt(supplyRaw)) / Math.pow(10, decimals);

        // Market Cap = Price × Total Supply
        const marketCap = priceData.priceUSD * totalSupply;

        return marketCap;
    } catch (error) {
        console.error("Error calculating market cap:", error);
        return null;
    }
}
