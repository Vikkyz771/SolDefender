/**
 * DexScreener API Integration
 * 
 * Universal pool discovery for ANY DEX (Raydium, Meteora, Orca, etc.)
 * Used for post-graduation LP safety checks.
 */

import { fetchJSON } from "../../utils/http.js";

// DexScreener API endpoint
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";

/**
 * Pool information from DexScreener
 */
export interface DexScreenerPool {
    chainId: string;
    dexId: string;           // "raydium", "meteora", "orca", etc.
    pairAddress: string;      // The pool address
    baseToken: {
        address: string;
        symbol: string;
        name: string;
    };
    quoteToken: {
        address: string;
        symbol: string;
        name: string;
    };
    liquidity?: {
        usd: number;
        base: number;
        quote: number;
    };
    fdv?: number;
    marketCap?: number;
    pairCreatedAt?: number;   // Unix timestamp
    url: string;              // DexScreener URL
}

/**
 * API response structure
 */
interface DexScreenerResponse {
    schemaVersion: string;
    pairs: DexScreenerPool[] | null;
}

/**
 * Get all DEX pools for a token
 * Returns pools sorted by liquidity (highest first)
 * Prefers graduated pools (DAMM) over bonding curve pools
 */
export async function getTokenPools(tokenMint: string): Promise<DexScreenerPool[]> {
    try {
        const url = `${DEXSCREENER_API}/tokens/${tokenMint}`;
        console.log(`   [DexScreener] Fetching: ${url}`);

        const response = await fetchJSON<DexScreenerResponse>(url);

        // Debug: log raw response structure
        console.log(`   [DexScreener] Response keys: ${Object.keys(response).join(', ')}`);
        console.log(`   [DexScreener] Pairs type: ${typeof response.pairs}, isArray: ${Array.isArray(response.pairs)}, length: ${response.pairs?.length ?? 'null'}`);

        if (!response.pairs || response.pairs.length === 0) {
            console.log(`   [DexScreener] No pairs returned for ${tokenMint.slice(0, 8)}...`);
            return [];
        }

        console.log(`   [DexScreener] Found ${response.pairs.length} total pairs`);

        // Filter to Solana only
        let solanaPools = response.pairs.filter(p => p.chainId === "solana");
        console.log(`   [DexScreener] ${solanaPools.length} Solana pools after filter`);

        // Separate graduated pools from bonding curve pools
        const graduatedPools = solanaPools.filter(p =>
            !p.dexId.toLowerCase().includes("dbc") && // Not a DBC (bonding curve)
            p.liquidity?.usd !== null &&
            p.liquidity?.usd !== undefined
        );

        const bondingCurvePools = solanaPools.filter(p =>
            p.dexId.toLowerCase().includes("dbc") ||
            p.liquidity?.usd === null ||
            p.liquidity?.usd === undefined
        );

        console.log(`   [DexScreener] ${graduatedPools.length} graduated, ${bondingCurvePools.length} bonding curve`);

        // Sort graduated pools by liquidity (highest first)
        graduatedPools.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

        // Return graduated pools first, then bonding curve pools
        const result = [...graduatedPools, ...bondingCurvePools];
        if (result.length > 0) {
            console.log(`   [DexScreener] Main pool: ${result[0].dexId} - ${result[0].pairAddress.slice(0, 8)}...`);
        }
        return result;
    } catch (error) {
        console.error(`❌ [DexScreener] Failed to get pools for ${tokenMint.slice(0, 8)}...:`, error);
        return [];
    }
}

/**
 * Get the main pool for a token (highest liquidity)
 */
export async function getMainPool(tokenMint: string): Promise<DexScreenerPool | null> {
    const pools = await getTokenPools(tokenMint);
    return pools.length > 0 ? pools[0] : null;
}

/**
 * Check if a token has graduated (has DEX pools)
 */
export async function hasGraduated(tokenMint: string): Promise<boolean> {
    const pools = await getTokenPools(tokenMint);
    return pools.length > 0;
}

/**
 * Get pool summary for display
 */
export function formatPoolSummary(pool: DexScreenerPool): string {
    const dexName = pool.dexId.charAt(0).toUpperCase() + pool.dexId.slice(1);
    const liquidity = pool.liquidity?.usd
        ? `$${pool.liquidity.usd.toLocaleString()}`
        : "Unknown";

    return `${dexName} | Liquidity: ${liquidity}`;
}
