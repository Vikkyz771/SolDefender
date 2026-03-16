/**
 * User settings database operations
 */

import { getDatabase } from "./index.js";

export interface UserSettings {
    telegram_id: number;
    slippage_bps: number;          // Slippage in basis points (1500 = 15%)
    quick_buy_1: number;           // First quick buy amount in SOL
    quick_buy_2: number;           // Second quick buy amount in SOL
    quick_sell_1: number;          // First quick sell percentage
    quick_sell_2: number;          // Second quick sell percentage
    instant_buy_enabled: boolean;  // Instant buy mode on/off
    instant_buy_amount: number;    // Instant buy amount in SOL
    autosell_threshold: number;    // Auto-sell at bonding curve %
}

export interface GlobalTPSLSettings {
    default_tp_enabled: boolean;
    default_tp_percent: number;
    default_tp_sell_percent: number;
    default_sl_enabled: boolean;
    default_sl_percent: number;
    default_sl_sell_percent: number;
    default_trail_enabled: boolean;
    default_trail_percent: number;
}

// Default settings values
export const DEFAULT_SETTINGS: Omit<UserSettings, "telegram_id"> = {
    slippage_bps: 1500,
    quick_buy_1: 0.1,
    quick_buy_2: 0.5,
    quick_sell_1: 25,
    quick_sell_2: 50,
    instant_buy_enabled: false,
    instant_buy_amount: 0.1,
    autosell_threshold: 85,
};

export const DEFAULT_TPSL_SETTINGS: GlobalTPSLSettings = {
    default_tp_enabled: false,
    default_tp_percent: 100,
    default_tp_sell_percent: 50,
    default_sl_enabled: false,
    default_sl_percent: 30,
    default_sl_sell_percent: 100,
    default_trail_enabled: false,
    default_trail_percent: 20,
};

/**
 * Get user settings (returns defaults if not found)
 */
export function getSettings(telegramId: number): UserSettings {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT telegram_id, slippage_bps, quick_buy_1, quick_buy_2, 
               quick_sell_1, quick_sell_2, instant_buy_enabled, 
               instant_buy_amount, autosell_threshold
        FROM settings
        WHERE telegram_id = ?
    `).get(telegramId) as {
        telegram_id: number;
        slippage_bps: number;
        quick_buy_1: number;
        quick_buy_2: number;
        quick_sell_1: number;
        quick_sell_2: number;
        instant_buy_enabled: number;
        instant_buy_amount: number;
        autosell_threshold: number;
    } | undefined;

    if (!row) {
        // Return defaults for non-existent user
        return {
            telegram_id: telegramId,
            ...DEFAULT_SETTINGS,
        };
    }

    return {
        telegram_id: row.telegram_id,
        slippage_bps: row.slippage_bps,
        quick_buy_1: row.quick_buy_1,
        quick_buy_2: row.quick_buy_2,
        quick_sell_1: row.quick_sell_1,
        quick_sell_2: row.quick_sell_2,
        instant_buy_enabled: row.instant_buy_enabled === 1,
        instant_buy_amount: row.instant_buy_amount,
        autosell_threshold: row.autosell_threshold,
    };
}

/**
 * Get global TP/SL default settings for a user
 */
export function getGlobalTPSL(telegramId: number): GlobalTPSLSettings {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT default_tp_enabled, default_tp_percent, default_tp_sell_percent,
               default_sl_enabled, default_sl_percent, default_sl_sell_percent,
               default_trail_enabled, default_trail_percent
        FROM settings
        WHERE telegram_id = ?
    `).get(telegramId) as {
        default_tp_enabled: number;
        default_tp_percent: number;
        default_tp_sell_percent: number;
        default_sl_enabled: number;
        default_sl_percent: number;
        default_sl_sell_percent: number;
        default_trail_enabled: number;
        default_trail_percent: number;
    } | undefined;

    if (!row) {
        return { ...DEFAULT_TPSL_SETTINGS };
    }

    return {
        default_tp_enabled: row.default_tp_enabled === 1,
        default_tp_percent: row.default_tp_percent,
        default_tp_sell_percent: row.default_tp_sell_percent,
        default_sl_enabled: row.default_sl_enabled === 1,
        default_sl_percent: row.default_sl_percent,
        default_sl_sell_percent: row.default_sl_sell_percent,
        default_trail_enabled: row.default_trail_enabled === 1,
        default_trail_percent: row.default_trail_percent,
    };
}

/**
 * Update global TP/SL default settings
 */
export function updateGlobalTPSL(
    telegramId: number,
    updates: Partial<GlobalTPSLSettings>
): boolean {
    const db = getDatabase();

    const keys = Object.keys(updates) as (keyof GlobalTPSLSettings)[];
    if (keys.length === 0) return false;

    const setClauses: string[] = [];
    const values: (number | string)[] = [];

    for (const key of keys) {
        const value = updates[key];
        if (value !== undefined) {
            setClauses.push(`${key} = ?`);
            values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
        }
    }

    values.push(telegramId);

    const result = db.prepare(`
        UPDATE settings
        SET ${setClauses.join(", ")}
        WHERE telegram_id = ?
    `).run(...values);

    return result.changes > 0;
}

/**
 * Update a single setting value
 */
export function updateSetting<K extends keyof Omit<UserSettings, "telegram_id">>(
    telegramId: number,
    key: K,
    value: UserSettings[K]
): boolean {
    const db = getDatabase();

    // Validate key to prevent SQL injection
    const allowedKeys = [
        "slippage_bps",
        "quick_buy_1",
        "quick_buy_2",
        "quick_sell_1",
        "quick_sell_2",
        "instant_buy_enabled",
        "instant_buy_amount",
        "autosell_threshold",
    ];

    if (!allowedKeys.includes(key)) {
        throw new Error(`Invalid settings key: ${key}`);
    }

    // Convert boolean to integer for SQLite
    const dbValue = typeof value === "boolean" ? (value ? 1 : 0) : value;

    const result = db.prepare(`
        UPDATE settings
        SET ${key} = ?
        WHERE telegram_id = ?
    `).run(dbValue, telegramId);

    return result.changes > 0;
}

/**
 * Update multiple settings at once
 */
export function updateSettings(
    telegramId: number,
    updates: Partial<Omit<UserSettings, "telegram_id">>
): boolean {
    const db = getDatabase();

    const keys = Object.keys(updates) as (keyof Omit<UserSettings, "telegram_id">)[];
    if (keys.length === 0) return false;

    // Build SET clause
    const setClauses: string[] = [];
    const values: (number | string)[] = [];

    for (const key of keys) {
        const value = updates[key];
        if (value !== undefined) {
            setClauses.push(`${key} = ?`);
            values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
        }
    }

    values.push(telegramId);

    const result = db.prepare(`
        UPDATE settings
        SET ${setClauses.join(", ")}
        WHERE telegram_id = ?
    `).run(...values);

    return result.changes > 0;
}

/**
 * Initialize settings for a new user (called from createUser)
 */
export function initializeSettings(telegramId: number): void {
    const db = getDatabase();

    db.prepare(`
        INSERT OR IGNORE INTO settings (telegram_id)
        VALUES (?)
    `).run(telegramId);
}

