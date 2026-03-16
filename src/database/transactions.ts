/**
 * Transaction history database operations
 */

import { getDatabase } from "./index.js";

export interface Transaction {
    id: number;
    telegram_id: number;
    wallet_id: number | null;
    token_mint: string;
    token_symbol: string | null;
    type: "BUY" | "SELL";
    token_amount: string;
    sol_amount: number;
    price: number;
    signature: string | null;
    pnl_percent: number | null;
    timestamp: number;
}

/**
 * Record a buy transaction
 */
export function recordBuy(
    telegramId: number,
    walletId: number,
    tokenMint: string,
    tokenSymbol: string | null,
    tokenAmount: string,
    solAmount: number,
    price: number,
    signature: string | null
): Transaction {
    const db = getDatabase();
    const now = Date.now();

    const result = db.prepare(`
        INSERT INTO transactions (telegram_id, wallet_id, token_mint, token_symbol, type, token_amount, sol_amount, price, signature, timestamp)
        VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?, ?, ?)
    `).run(telegramId, walletId, tokenMint, tokenSymbol, tokenAmount, solAmount, price, signature, now);

    console.log(`📝 Recorded BUY: ${tokenAmount} ${tokenSymbol || tokenMint.slice(0, 8)} for ${solAmount} SOL`);

    return {
        id: result.lastInsertRowid as number,
        telegram_id: telegramId,
        wallet_id: walletId,
        token_mint: tokenMint,
        token_symbol: tokenSymbol,
        type: "BUY",
        token_amount: tokenAmount,
        sol_amount: solAmount,
        price,
        signature,
        pnl_percent: null,
        timestamp: now,
    };
}

/**
 * Record a sell transaction
 */
export function recordSell(
    telegramId: number,
    walletId: number,
    tokenMint: string,
    tokenSymbol: string | null,
    tokenAmount: string,
    solAmount: number,
    price: number,
    signature: string | null,
    pnlPercent: number | null
): Transaction {
    const db = getDatabase();
    const now = Date.now();

    const result = db.prepare(`
        INSERT INTO transactions (telegram_id, wallet_id, token_mint, token_symbol, type, token_amount, sol_amount, price, signature, pnl_percent, timestamp)
        VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?)
    `).run(telegramId, walletId, tokenMint, tokenSymbol, tokenAmount, solAmount, price, signature, pnlPercent, now);

    const pnlStr = pnlPercent !== null ? ` (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)` : '';
    console.log(`📝 Recorded SELL: ${tokenAmount} ${tokenSymbol || tokenMint.slice(0, 8)} for ${solAmount} SOL${pnlStr}`);

    return {
        id: result.lastInsertRowid as number,
        telegram_id: telegramId,
        wallet_id: walletId,
        token_mint: tokenMint,
        token_symbol: tokenSymbol,
        type: "SELL",
        token_amount: tokenAmount,
        sol_amount: solAmount,
        price,
        signature,
        pnl_percent: pnlPercent,
        timestamp: now,
    };
}

/**
 * Get transactions for a user (all wallets - for backward compatibility)
 */
export function getTransactionsByUser(telegramId: number, limit: number = 20): Transaction[] {
    const db = getDatabase();

    return db.prepare(`
        SELECT id, telegram_id, wallet_id, token_mint, token_symbol, type, token_amount, sol_amount, price, signature, pnl_percent, timestamp
        FROM transactions
        WHERE telegram_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
    `).all(telegramId, limit) as Transaction[];
}

/**
 * Get transactions for a specific wallet
 */
export function getTransactionsByWallet(walletId: number, limit: number = 20): Transaction[] {
    const db = getDatabase();

    return db.prepare(`
        SELECT id, telegram_id, wallet_id, token_mint, token_symbol, type, token_amount, sol_amount, price, signature, pnl_percent, timestamp
        FROM transactions
        WHERE wallet_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
    `).all(walletId, limit) as Transaction[];
}

/**
 * Get transactions for a specific token
 */
export function getTransactionsByToken(telegramId: number, tokenMint: string): Transaction[] {
    const db = getDatabase();

    return db.prepare(`
        SELECT id, telegram_id, wallet_id, token_mint, token_symbol, type, token_amount, sol_amount, price, signature, pnl_percent, timestamp
        FROM transactions
        WHERE telegram_id = ? AND token_mint = ?
        ORDER BY timestamp DESC
    `).all(telegramId, tokenMint) as Transaction[];
}
