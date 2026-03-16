/**
 * User and Wallet database operations
 * Supports multi-wallet architecture where each user can have multiple wallets
 */

import { getDatabase } from "./index.js";

// ============================================================================
// Types
// ============================================================================

export interface Wallet {
    id: number;
    telegram_id: number;
    name: string;
    wallet_address: string;
    encrypted_private_key: string;
    is_active: boolean;
    created_at: number;
}

/**
 * User interface with active wallet data
 * Backward compatible: includes wallet_address and encrypted_private_key from active wallet
 */
export interface User {
    telegram_id: number;
    wallet_address: string;
    encrypted_private_key: string;
    created_at: number;
    // Multi-wallet fields
    active_wallet_id: number;
    active_wallet_name: string;
}

// ============================================================================
// User Operations
// ============================================================================

/**
 * Create a new user with their first wallet
 */
export function createUser(
    telegramId: number,
    walletAddress: string,
    encryptedPrivateKey: string
): User {
    const db = getDatabase();
    const now = Date.now();

    // Insert user record (wallet fields for backward compatibility)
    db.prepare(`
        INSERT INTO users (telegram_id, wallet_address, encrypted_private_key, created_at)
        VALUES (?, ?, ?, ?)
    `).run(telegramId, walletAddress, encryptedPrivateKey, now);

    // Create default settings for the user
    db.prepare(`
        INSERT INTO settings (telegram_id)
        VALUES (?)
    `).run(telegramId);

    // Create first wallet entry (active by default)
    const walletResult = db.prepare(`
        INSERT INTO wallets (telegram_id, name, wallet_address, encrypted_private_key, is_active, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
    `).run(telegramId, "Wallet 1", walletAddress, encryptedPrivateKey, now);

    console.log(`👤 Created user: ${telegramId} with wallet ${walletAddress.slice(0, 8)}...`);

    return {
        telegram_id: telegramId,
        wallet_address: walletAddress,
        encrypted_private_key: encryptedPrivateKey,
        created_at: now,
        active_wallet_id: walletResult.lastInsertRowid as number,
        active_wallet_name: "Wallet 1",
    };
}

/**
 * Get user by Telegram ID (includes active wallet data)
 */
export function getUser(telegramId: number): User | null {
    const db = getDatabase();

    // Join with wallets to get active wallet data
    const row = db.prepare(`
        SELECT 
            u.telegram_id, 
            u.created_at,
            COALESCE(w.wallet_address, u.wallet_address) as wallet_address,
            COALESCE(w.encrypted_private_key, u.encrypted_private_key) as encrypted_private_key,
            COALESCE(w.id, 0) as active_wallet_id,
            COALESCE(w.name, 'Main Wallet') as active_wallet_name
        FROM users u
        LEFT JOIN wallets w ON u.telegram_id = w.telegram_id AND w.is_active = 1
        WHERE u.telegram_id = ?
    `).get(telegramId) as {
        telegram_id: number;
        wallet_address: string;
        encrypted_private_key: string;
        created_at: number;
        active_wallet_id: number;
        active_wallet_name: string;
    } | undefined;

    if (!row) return null;

    return {
        telegram_id: row.telegram_id,
        wallet_address: row.wallet_address,
        encrypted_private_key: row.encrypted_private_key,
        created_at: row.created_at,
        active_wallet_id: row.active_wallet_id,
        active_wallet_name: row.active_wallet_name,
    };
}

/**
 * Check if user exists
 */
export function userExists(telegramId: number): boolean {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT 1 FROM users WHERE telegram_id = ?
    `).get(telegramId);

    return !!row;
}

/**
 * Get all users (for background monitoring)
 */
export function getAllUsers(): User[] {
    const db = getDatabase();

    const rows = db.prepare(`
        SELECT 
            u.telegram_id, 
            u.created_at,
            COALESCE(w.wallet_address, u.wallet_address) as wallet_address,
            COALESCE(w.encrypted_private_key, u.encrypted_private_key) as encrypted_private_key,
            COALESCE(w.id, 0) as active_wallet_id,
            COALESCE(w.name, 'Main Wallet') as active_wallet_name
        FROM users u
        LEFT JOIN wallets w ON u.telegram_id = w.telegram_id AND w.is_active = 1
    `).all() as {
        telegram_id: number;
        wallet_address: string;
        encrypted_private_key: string;
        created_at: number;
        active_wallet_id: number;
        active_wallet_name: string;
    }[];

    return rows.map(row => ({
        telegram_id: row.telegram_id,
        wallet_address: row.wallet_address,
        encrypted_private_key: row.encrypted_private_key,
        created_at: row.created_at,
        active_wallet_id: row.active_wallet_id,
        active_wallet_name: row.active_wallet_name,
    }));
}

/**
 * Get user by wallet address
 */
export function getUserByWallet(walletAddress: string): User | null {
    const db = getDatabase();

    // Check wallets table first (new architecture)
    const walletRow = db.prepare(`
        SELECT telegram_id FROM wallets WHERE wallet_address = ?
    `).get(walletAddress) as { telegram_id: number } | undefined;

    if (walletRow) {
        return getUser(walletRow.telegram_id);
    }

    // Fallback to legacy users table
    const userRow = db.prepare(`
        SELECT telegram_id FROM users WHERE wallet_address = ?
    `).get(walletAddress) as { telegram_id: number } | undefined;

    if (userRow) {
        return getUser(userRow.telegram_id);
    }

    return null;
}

// ============================================================================
// Wallet Operations
// ============================================================================

/**
 * Get all wallets for a user
 */
export function getWallets(telegramId: number): Wallet[] {
    const db = getDatabase();

    const rows = db.prepare(`
        SELECT id, telegram_id, name, wallet_address, encrypted_private_key, is_active, created_at
        FROM wallets
        WHERE telegram_id = ?
        ORDER BY created_at ASC
    `).all(telegramId) as {
        id: number;
        telegram_id: number;
        name: string;
        wallet_address: string;
        encrypted_private_key: string;
        is_active: number;
        created_at: number;
    }[];

    return rows.map(row => ({
        id: row.id,
        telegram_id: row.telegram_id,
        name: row.name,
        wallet_address: row.wallet_address,
        encrypted_private_key: row.encrypted_private_key,
        is_active: row.is_active === 1,
        created_at: row.created_at,
    }));
}

/**
 * Get a specific wallet by ID
 */
export function getWalletById(walletId: number): Wallet | null {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT id, telegram_id, name, wallet_address, encrypted_private_key, is_active, created_at
        FROM wallets
        WHERE id = ?
    `).get(walletId) as {
        id: number;
        telegram_id: number;
        name: string;
        wallet_address: string;
        encrypted_private_key: string;
        is_active: number;
        created_at: number;
    } | undefined;

    if (!row) return null;

    return {
        id: row.id,
        telegram_id: row.telegram_id,
        name: row.name,
        wallet_address: row.wallet_address,
        encrypted_private_key: row.encrypted_private_key,
        is_active: row.is_active === 1,
        created_at: row.created_at,
    };
}

/**
 * Get active wallet for a user
 */
export function getActiveWallet(telegramId: number): Wallet | null {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT id, telegram_id, name, wallet_address, encrypted_private_key, is_active, created_at
        FROM wallets
        WHERE telegram_id = ? AND is_active = 1
    `).get(telegramId) as {
        id: number;
        telegram_id: number;
        name: string;
        wallet_address: string;
        encrypted_private_key: string;
        is_active: number;
        created_at: number;
    } | undefined;

    if (!row) return null;

    return {
        id: row.id,
        telegram_id: row.telegram_id,
        name: row.name,
        wallet_address: row.wallet_address,
        encrypted_private_key: row.encrypted_private_key,
        is_active: true,
        created_at: row.created_at,
    };
}

/**
 * Add a new wallet for a user
 * Automatically names it "Wallet N" based on count
 */
export function addWallet(
    telegramId: number,
    walletAddress: string,
    encryptedPrivateKey: string,
    customName?: string
): Wallet {
    const db = getDatabase();
    const now = Date.now();

    // Determine wallet name
    const existingCount = db.prepare(`
        SELECT COUNT(*) as count FROM wallets WHERE telegram_id = ?
    `).get(telegramId) as { count: number };

    const name = customName || `Wallet ${existingCount.count + 1}`;

    // Insert new wallet (not active by default)
    const result = db.prepare(`
        INSERT INTO wallets (telegram_id, name, wallet_address, encrypted_private_key, is_active, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
    `).run(telegramId, name, walletAddress, encryptedPrivateKey, now);

    console.log(`💼 Added wallet "${name}" for user ${telegramId}`);

    return {
        id: result.lastInsertRowid as number,
        telegram_id: telegramId,
        name,
        wallet_address: walletAddress,
        encrypted_private_key: encryptedPrivateKey,
        is_active: false,
        created_at: now,
    };
}

/**
 * Switch active wallet for a user
 */
export function switchWallet(telegramId: number, walletId: number): boolean {
    const db = getDatabase();

    // Verify wallet belongs to user
    const wallet = db.prepare(`
        SELECT 1 FROM wallets WHERE id = ? AND telegram_id = ?
    `).get(walletId, telegramId);

    if (!wallet) {
        console.warn(`⚠️ Wallet ${walletId} not found for user ${telegramId}`);
        return false;
    }

    // Deactivate all wallets for user
    db.prepare(`
        UPDATE wallets SET is_active = 0 WHERE telegram_id = ?
    `).run(telegramId);

    // Activate the selected wallet
    db.prepare(`
        UPDATE wallets SET is_active = 1 WHERE id = ?
    `).run(walletId);

    // Also update the legacy users table for backward compatibility
    const walletData = getWalletById(walletId);
    if (walletData) {
        db.prepare(`
            UPDATE users SET wallet_address = ?, encrypted_private_key = ? WHERE telegram_id = ?
        `).run(walletData.wallet_address, walletData.encrypted_private_key, telegramId);
    }

    console.log(`🔄 Switched active wallet to ${walletId} for user ${telegramId}`);
    return true;
}

/**
 * Rename a wallet
 */
export function renameWallet(walletId: number, newName: string): boolean {
    const db = getDatabase();

    const result = db.prepare(`
        UPDATE wallets SET name = ? WHERE id = ?
    `).run(newName, walletId);

    if (result.changes > 0) {
        console.log(`✏️ Renamed wallet ${walletId} to "${newName}"`);
        return true;
    }
    return false;
}

/**
 * Delete a wallet (cannot delete active wallet or last wallet)
 */
export function deleteWallet(telegramId: number, walletId: number): { success: boolean; error?: string } {
    const db = getDatabase();

    // Check if wallet exists and belongs to user
    const wallet = getWalletById(walletId);
    if (!wallet || wallet.telegram_id !== telegramId) {
        return { success: false, error: "Wallet not found" };
    }

    // Cannot delete active wallet
    if (wallet.is_active) {
        return { success: false, error: "Cannot delete active wallet. Switch to another wallet first." };
    }

    // Count user's wallets
    const count = db.prepare(`
        SELECT COUNT(*) as count FROM wallets WHERE telegram_id = ?
    `).get(telegramId) as { count: number };

    if (count.count <= 1) {
        return { success: false, error: "Cannot delete last wallet" };
    }

    // Delete the wallet
    db.prepare(`DELETE FROM wallets WHERE id = ?`).run(walletId);

    console.log(`🗑️ Deleted wallet ${walletId} for user ${telegramId}`);
    return { success: true };
}

/**
 * Get wallet count for a user
 */
export function getWalletCount(telegramId: number): number {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT COUNT(*) as count FROM wallets WHERE telegram_id = ?
    `).get(telegramId) as { count: number };

    return row.count;
}

// ============================================================================
// Legacy Compatibility
// ============================================================================

/**
 * Update user's wallet (legacy function - now updates active wallet)
 * @deprecated Use addWallet or switchWallet instead
 */
export function updateWallet(
    telegramId: number,
    walletAddress: string,
    encryptedPrivateKey: string
): boolean {
    const db = getDatabase();

    // Update users table
    const result = db.prepare(`
        UPDATE users
        SET wallet_address = ?, encrypted_private_key = ?
        WHERE telegram_id = ?
    `).run(walletAddress, encryptedPrivateKey, telegramId);

    // Also update active wallet in wallets table
    db.prepare(`
        UPDATE wallets
        SET wallet_address = ?, encrypted_private_key = ?
        WHERE telegram_id = ? AND is_active = 1
    `).run(walletAddress, encryptedPrivateKey, telegramId);

    if (result.changes > 0) {
        console.log(`🔄 Updated wallet for user: ${telegramId}`);
        return true;
    }
    return false;
}
