/**
 * Token Management - Recent tokens and favorites
 */

import { getDatabase } from "./index.js";

// ============================================================================
// Interfaces
// ============================================================================

export interface RecentToken {
    telegram_id: number;
    token_mint: string;
    token_symbol: string | null;
    accessed_at: number;
}

export interface FavoriteToken {
    telegram_id: number;
    token_mint: string;
    token_symbol: string | null;
    added_at: number;
}

// ============================================================================
// Recent Tokens
// ============================================================================

/**
 * Add or update a recent token access
 */
export function addRecentToken(
    telegramId: number,
    tokenMint: string,
    tokenSymbol?: string
): void {
    const db = getDatabase();
    const now = Date.now();

    // Use UPSERT (INSERT OR REPLACE) to update the access time
    db.prepare(`
        INSERT OR REPLACE INTO recent_tokens (telegram_id, token_mint, token_symbol, accessed_at)
        VALUES (?, ?, ?, ?)
    `).run(telegramId, tokenMint, tokenSymbol || null, now);

    // Keep only 20 most recent tokens per user
    db.prepare(`
        DELETE FROM recent_tokens
        WHERE telegram_id = ?
        AND token_mint NOT IN (
            SELECT token_mint FROM recent_tokens
            WHERE telegram_id = ?
            ORDER BY accessed_at DESC
            LIMIT 20
        )
    `).run(telegramId, telegramId);
}

/**
 * Get recent tokens for a user
 */
export function getRecentTokens(telegramId: number, limit: number = 10): RecentToken[] {
    const db = getDatabase();

    return db.prepare(`
        SELECT * FROM recent_tokens
        WHERE telegram_id = ?
        ORDER BY accessed_at DESC
        LIMIT ?
    `).all(telegramId, limit) as RecentToken[];
}

/**
 * Clear all recent tokens for a user
 */
export function clearRecentTokens(telegramId: number): void {
    const db = getDatabase();
    db.prepare("DELETE FROM recent_tokens WHERE telegram_id = ?").run(telegramId);
}

// ============================================================================
// Favorite Tokens
// ============================================================================

/**
 * Add a token to favorites
 */
export function addFavorite(
    telegramId: number,
    tokenMint: string,
    tokenSymbol?: string
): boolean {
    const db = getDatabase();
    const now = Date.now();

    try {
        db.prepare(`
            INSERT OR IGNORE INTO favorite_tokens (telegram_id, token_mint, token_symbol, added_at)
            VALUES (?, ?, ?, ?)
        `).run(telegramId, tokenMint, tokenSymbol || null, now);

        return true;
    } catch (error) {
        console.error("Error adding favorite:", error);
        return false;
    }
}

/**
 * Remove a token from favorites
 */
export function removeFavorite(telegramId: number, tokenMint: string): boolean {
    const db = getDatabase();

    const result = db.prepare(`
        DELETE FROM favorite_tokens
        WHERE telegram_id = ? AND token_mint = ?
    `).run(telegramId, tokenMint);

    return result.changes > 0;
}

/**
 * Get all favorites for a user
 */
export function getFavorites(telegramId: number): FavoriteToken[] {
    const db = getDatabase();

    return db.prepare(`
        SELECT * FROM favorite_tokens
        WHERE telegram_id = ?
        ORDER BY added_at DESC
    `).all(telegramId) as FavoriteToken[];
}

/**
 * Check if a token is a favorite
 */
export function isFavorite(telegramId: number, tokenMint: string): boolean {
    const db = getDatabase();

    const result = db.prepare(`
        SELECT 1 FROM favorite_tokens
        WHERE telegram_id = ? AND token_mint = ?
    `).get(telegramId, tokenMint);

    return !!result;
}

/**
 * Toggle favorite status for a token
 */
export function toggleFavorite(
    telegramId: number,
    tokenMint: string,
    tokenSymbol?: string
): boolean {
    if (isFavorite(telegramId, tokenMint)) {
        removeFavorite(telegramId, tokenMint);
        return false; // Now NOT a favorite
    } else {
        addFavorite(telegramId, tokenMint, tokenSymbol);
        return true; // Now IS a favorite
    }
}

/**
 * Get favorite count for a user
 */
export function getFavoriteCount(telegramId: number): number {
    const db = getDatabase();

    const result = db.prepare(`
        SELECT COUNT(*) as count FROM favorite_tokens
        WHERE telegram_id = ?
    `).get(telegramId) as { count: number };

    return result.count;
}
