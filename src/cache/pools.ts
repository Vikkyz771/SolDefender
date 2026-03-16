/**
 * Bonding Curve Pool Cache
 * 
 * Caches pool addresses from scan to avoid re-detection on buy.
 * Cache is cleared on 100% sell.
 */

import { Platform } from "../autosell/types.js";
import { CachedPool } from "../scanner/checks/liquidity/types.js";

// =============================================================================
// In-Memory Cache
// =============================================================================

const poolCache = new Map<string, CachedPool>();

// Cache TTL (24 hours) - pool addresses don't change, but good to refresh
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// Cache Operations
// =============================================================================

/**
 * Cache a bonding curve pool for later use in buy flow
 */
export function cachePool(
    tokenMint: string,
    poolAddress: string,
    platform: Platform
): void {
    const cached: CachedPool = {
        tokenMint,
        poolAddress,
        platform,
        scannedAt: Date.now(),
    };

    poolCache.set(tokenMint, cached);
    console.log(`📦 [Cache] Stored pool for ${tokenMint.slice(0, 8)}... (${platform})`);
}

/**
 * Get cached pool for a token
 * Returns null if not cached or expired
 */
export function getCachedPool(tokenMint: string): CachedPool | null {
    const cached = poolCache.get(tokenMint);

    if (!cached) {
        return null;
    }

    // Check TTL
    if (Date.now() - cached.scannedAt > CACHE_TTL_MS) {
        poolCache.delete(tokenMint);
        console.log(`📦 [Cache] Expired pool for ${tokenMint.slice(0, 8)}...`);
        return null;
    }

    console.log(`📦 [Cache] Hit for ${tokenMint.slice(0, 8)}... (${cached.platform})`);
    return cached;
}

/**
 * Clear cached pool for a token (call on 100% sell)
 */
export function clearPoolCache(tokenMint: string): void {
    if (poolCache.has(tokenMint)) {
        poolCache.delete(tokenMint);
        console.log(`📦 [Cache] Cleared pool for ${tokenMint.slice(0, 8)}...`);
    }
}

/**
 * Check if a pool is cached for a token
 */
export function hasPoolCached(tokenMint: string): boolean {
    const cached = getCachedPool(tokenMint);
    return cached !== null;
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; tokens: string[] } {
    return {
        size: poolCache.size,
        tokens: Array.from(poolCache.keys()).map(k => k.slice(0, 8) + "..."),
    };
}

/**
 * Clear entire cache (for debugging/testing)
 */
export function clearAllPoolCache(): void {
    const count = poolCache.size;
    poolCache.clear();
    console.log(`📦 [Cache] Cleared all ${count} cached pools`);
}
