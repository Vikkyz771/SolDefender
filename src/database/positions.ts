/**
 * Positions database operations - track active trades
 */

import { getDatabase } from "./index.js";
import { clearRulesForPosition } from "./tpsl.js";

export interface Position {
    id: number;
    telegram_id: number;
    wallet_id: number | null;
    token_mint: string;
    token_symbol: string | null;
    entry_price: number;
    entry_amount: string;  // Token amount as string (bigint precision)
    entry_sol: number;
    entry_time: number;
    entry_market_cap: number | null;
}

/**
 * Create a new position (or update if exists)
 */
export function createPosition(
    telegramId: number,
    walletId: number,
    tokenMint: string,
    tokenSymbol: string | null,
    entryPrice: number,
    entryAmount: string,
    entrySol: number,
    entryMarketCap: number | null = null
): Position {
    const db = getDatabase();
    const now = Date.now();

    // Use INSERT OR REPLACE to handle re-buys into same token
    // Unique on wallet_id + token_mint for per-wallet positions
    db.prepare(`
        INSERT INTO positions (telegram_id, wallet_id, token_mint, token_symbol, entry_price, entry_amount, entry_sol, entry_time, entry_market_cap)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wallet_id, token_mint) DO UPDATE SET
            entry_price = (entry_price * CAST(entry_amount AS REAL) + ? * CAST(? AS REAL)) / (CAST(entry_amount AS REAL) + CAST(? AS REAL)),
            entry_amount = CAST((CAST(entry_amount AS INTEGER) + CAST(? AS INTEGER)) AS TEXT),
            entry_sol = entry_sol + ?,
            entry_time = ?,
            entry_market_cap = COALESCE(entry_market_cap, ?)
    `).run(
        telegramId, walletId, tokenMint, tokenSymbol, entryPrice, entryAmount, entrySol, now, entryMarketCap,
        entryPrice, entryAmount, entryAmount, // For averaging entry price
        entryAmount, // Add to existing amount
        entrySol, // Add to total SOL invested
        now, // Update entry_time on re-buy
        entryMarketCap // Keep entry market cap if exists, otherwise use new one
    );

    console.log(`📊 Created/updated position: ${tokenMint.slice(0, 8)}... for wallet ${walletId}`);

    return getPositionByWallet(walletId, tokenMint)!;
}

/**
 * Get a specific position by wallet and token
 */
export function getPositionByWallet(walletId: number, tokenMint: string): Position | null {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT id, telegram_id, wallet_id, token_mint, token_symbol, entry_price, entry_amount, entry_sol, entry_time, entry_market_cap
        FROM positions
        WHERE wallet_id = ? AND token_mint = ?
    `).get(walletId, tokenMint) as Position | undefined;

    return row || null;
}

/**
 * Get a specific position (legacy - for backward compatibility)
 */
export function getPosition(telegramId: number, tokenMint: string): Position | null {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT id, telegram_id, wallet_id, token_mint, token_symbol, entry_price, entry_amount, entry_sol, entry_time, entry_market_cap
        FROM positions
        WHERE telegram_id = ? AND token_mint = ?
    `).get(telegramId, tokenMint) as Position | undefined;

    return row || null;
}

/**
 * Get all positions for a wallet
 */
export function getPositionsByWallet(walletId: number): Position[] {
    const db = getDatabase();

    return db.prepare(`
        SELECT id, telegram_id, wallet_id, token_mint, token_symbol, entry_price, entry_amount, entry_sol, entry_time, entry_market_cap
        FROM positions
        WHERE wallet_id = ?
        ORDER BY entry_time DESC
    `).all(walletId) as Position[];
}

/**
 * Get all positions for a user (across all wallets - for backward compatibility)
 */
export function getPositionsByUser(telegramId: number): Position[] {
    const db = getDatabase();

    return db.prepare(`
        SELECT id, telegram_id, wallet_id, token_mint, token_symbol, entry_price, entry_amount, entry_sol, entry_time, entry_market_cap
        FROM positions
        WHERE telegram_id = ?
        ORDER BY entry_time DESC
    `).all(telegramId) as Position[];
}

/**
 * Get position by ID
 */
export function getPositionById(positionId: number): Position | null {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT id, telegram_id, wallet_id, token_mint, token_symbol, entry_price, entry_amount, entry_sol, entry_time, entry_market_cap
        FROM positions
        WHERE id = ?
    `).get(positionId) as Position | undefined;

    return row || null;
}

/**
 * Update position amount (after partial sell)
 */
export function updatePositionAmount(positionId: number, newAmount: string): boolean {
    const db = getDatabase();

    const result = db.prepare(`
        UPDATE positions
        SET entry_amount = ?
        WHERE id = ?
    `).run(newAmount, positionId);

    return result.changes > 0;
}

/**
 * Close position (delete after 100% sell)
 * Also clears any TP/SL rules attached to this position
 */
export function closePosition(positionId: number): boolean {
    const db = getDatabase();

    // First, clear any TP/SL rules for this position
    clearRulesForPosition(positionId);

    const result = db.prepare(`
        DELETE FROM positions WHERE id = ?
    `).run(positionId);

    if (result.changes > 0) {
        console.log(`📊 Closed position: ${positionId} (TP/SL rules cleared)`);
        return true;
    }
    return false;
}

/**
 * Close position by token mint (also clears TP/SL rules)
 */
export function closePositionByMint(telegramId: number, tokenMint: string): boolean {
    const db = getDatabase();

    // First, get the position to find its ID
    const position = getPosition(telegramId, tokenMint);
    if (position) {
        // Clear TP/SL rules for this position
        clearRulesForPosition(position.id);
    }

    const result = db.prepare(`
        DELETE FROM positions WHERE telegram_id = ? AND token_mint = ?
    `).run(telegramId, tokenMint);

    if (result.changes > 0) {
        console.log(`📊 Closed position by mint: ${tokenMint.slice(0, 8)}... (TP/SL rules cleared)`);
    }
    return result.changes > 0;
}

/**
 * Get position count for a user
 */
export function getPositionCount(telegramId: number): number {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT COUNT(*) as count FROM positions WHERE telegram_id = ?
    `).get(telegramId) as { count: number };

    return row.count;
}
/**
 * Sync positions with actual wallet holdings
 * - Removes positions for tokens no longer in wallet
 * - Creates positions for tokens in wallet but not in database
 */
export interface WalletHolding {
    mint: string;
    balance: bigint;
    decimals: number;
}

export async function syncPositionsWithWallet(
    telegramId: number,
    walletId: number,
    walletHoldings: WalletHolding[]
): Promise<{ added: number; removed: number }> {
    // Get positions for this specific wallet
    const positions = getPositionsByWallet(walletId);
    const positionMints = new Set(positions.map(p => p.token_mint));
    const walletMints = new Set(walletHoldings.map(h => h.mint));

    let addedCount = 0;
    let removedCount = 0;

    // Protection: don't delete positions created within last 60 seconds
    // (RPC may not have caught up with new tokens yet, especially after graduation)
    const minAge = Date.now() - 60000;

    // Remove positions for tokens no longer in wallet
    for (const position of positions) {
        if (!walletMints.has(position.token_mint)) {
            // Skip if position was just created (within last 10 seconds)
            if (position.entry_time > minAge) {
                console.log(`⏳ Skipping new position: ${position.token_symbol || position.token_mint.slice(0, 8)}... (waiting for RPC)`);
                continue;
            }
            closePosition(position.id);
            removedCount++;
            console.log(`🧹 Cleaned up stale position: ${position.token_symbol || position.token_mint.slice(0, 8)}...`);
        }
    }

    // Create positions for tokens in wallet but not in database
    for (const holding of walletHoldings) {
        if (!positionMints.has(holding.mint)) {
            // Create position with 0 entry price/sol - will use current value for TP/SL
            // This is for externally acquired tokens
            createPosition(
                telegramId,
                walletId,
                holding.mint,
                null, // No symbol known
                0, // Entry price unknown
                holding.balance.toString(),
                0 // Entry SOL unknown
            );
            addedCount++;
            console.log(`📥 Created position for wallet token: ${holding.mint.slice(0, 8)}...`);
        }
    }

    return { added: addedCount, removed: removedCount };
}
