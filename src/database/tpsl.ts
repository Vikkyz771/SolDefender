/**
 * TP/SL Rules database operations
 * Manages Take Profit, Stop Loss, and Trailing Stop Loss rules
 */

import { getDatabase } from "./index.js";
import { Position } from "./positions.js";

export type TPSLType = "TP" | "SL" | "TRAILING_SL";

export interface TPSLRule {
    id: number;
    position_id: number;
    type: TPSLType;
    trigger_percent: number;  // +100 for TP at +100% gain, -30 for SL at -30% loss
    sell_percent: number;     // % of position to sell when triggered
    trail_distance: number | null;  // For TRAILING_SL: distance from peak in %
    peak_price: number | null;      // For TRAILING_SL: highest price seen
    triggered: boolean;
    triggered_at: number | null;
}

export interface TPSLRuleWithPosition extends TPSLRule {
    telegram_id: number;
    wallet_id: number | null;
    token_mint: string;
    token_symbol: string | null;
    entry_price: number;
    entry_amount: string;
    entry_sol: number;  // SOL amount spent to buy (for SOL-based P&L)
}

/**
 * Add a Take Profit rule
 * @param positionId - Position to attach rule to
 * @param triggerPercent - Positive % gain to trigger (e.g., 100 for +100%)
 * @param sellPercent - % of position to sell (e.g., 50 for 50%)
 */
export function addTPRule(
    positionId: number,
    triggerPercent: number,
    sellPercent: number
): TPSLRule {
    const db = getDatabase();

    const result = db.prepare(`
        INSERT INTO tp_sl_rules (position_id, type, trigger_percent, sell_percent)
        VALUES (?, 'TP', ?, ?)
    `).run(positionId, Math.abs(triggerPercent), sellPercent);

    console.log(`🎯 Added TP rule: +${Math.abs(triggerPercent)}% → sell ${sellPercent}%`);

    return getRuleById(result.lastInsertRowid as number)!;
}

/**
 * Add a Stop Loss rule
 * @param positionId - Position to attach rule to
 * @param triggerPercent - Negative % loss to trigger (e.g., -30 for -30%)
 * @param sellPercent - % of position to sell (e.g., 100 for 100%)
 */
export function addSLRule(
    positionId: number,
    triggerPercent: number,
    sellPercent: number
): TPSLRule {
    const db = getDatabase();

    // Ensure trigger is negative for SL
    const trigger = triggerPercent > 0 ? -triggerPercent : triggerPercent;

    const result = db.prepare(`
        INSERT INTO tp_sl_rules (position_id, type, trigger_percent, sell_percent)
        VALUES (?, 'SL', ?, ?)
    `).run(positionId, trigger, sellPercent);

    console.log(`🛑 Added SL rule: ${trigger}% → sell ${sellPercent}%`);

    return getRuleById(result.lastInsertRowid as number)!;
}

/**
 * Add a Trailing Stop Loss rule
 * @param positionId - Position to attach rule to
 * @param trailDistance - Distance from peak in % (e.g., 20 for 20%)
 * @param initialPeakPrice - Starting peak price (usually current price)
 */
export function addTrailingSL(
    positionId: number,
    trailDistance: number,
    initialPeakPrice: number
): TPSLRule {
    const db = getDatabase();

    const result = db.prepare(`
        INSERT INTO tp_sl_rules (position_id, type, trigger_percent, sell_percent, trail_distance, peak_price)
        VALUES (?, 'TRAILING_SL', 0, 100, ?, ?)
    `).run(positionId, trailDistance, initialPeakPrice);

    console.log(`📉 Added Trailing SL: ${trailDistance}% trail from peak $${initialPeakPrice.toFixed(8)}`);

    return getRuleById(result.lastInsertRowid as number)!;
}

/**
 * Get a rule by ID
 */
export function getRuleById(ruleId: number): TPSLRule | null {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT id, position_id, type, trigger_percent, sell_percent, 
               trail_distance, peak_price, triggered, triggered_at
        FROM tp_sl_rules
        WHERE id = ?
    `).get(ruleId) as {
        id: number;
        position_id: number;
        type: TPSLType;
        trigger_percent: number;
        sell_percent: number;
        trail_distance: number | null;
        peak_price: number | null;
        triggered: number;
        triggered_at: number | null;
    } | undefined;

    if (!row) return null;

    return {
        ...row,
        triggered: row.triggered === 1,
    };
}

/**
 * Get all rules for a position
 */
export function getRulesForPosition(positionId: number): TPSLRule[] {
    const db = getDatabase();

    const rows = db.prepare(`
        SELECT id, position_id, type, trigger_percent, sell_percent, 
               trail_distance, peak_price, triggered, triggered_at
        FROM tp_sl_rules
        WHERE position_id = ?
        ORDER BY type, trigger_percent DESC
    `).all(positionId) as Array<{
        id: number;
        position_id: number;
        type: TPSLType;
        trigger_percent: number;
        sell_percent: number;
        trail_distance: number | null;
        peak_price: number | null;
        triggered: number;
        triggered_at: number | null;
    }>;

    return rows.map(row => ({
        ...row,
        triggered: row.triggered === 1,
    }));
}

/**
 * Get all active (untriggered) rules for monitoring
 * Includes position details for price checking
 * Only returns rules for positions older than 2 seconds (to let buy tx confirm)
 */
export function getAllActiveRules(): TPSLRuleWithPosition[] {
    const db = getDatabase();
    const minAge = Date.now() - 2000; // 2 second cooldown for new positions

    const rows = db.prepare(`
        SELECT r.id, r.position_id, r.type, r.trigger_percent, r.sell_percent,
               r.trail_distance, r.peak_price, r.triggered, r.triggered_at,
               p.telegram_id, p.wallet_id, p.token_mint, p.token_symbol, p.entry_price, p.entry_amount, p.entry_sol
        FROM tp_sl_rules r
        JOIN positions p ON r.position_id = p.id
        WHERE r.triggered = 0
          AND p.entry_time < ?
        ORDER BY r.position_id
    `).all(minAge) as Array<{
        id: number;
        position_id: number;
        type: TPSLType;
        trigger_percent: number;
        sell_percent: number;
        trail_distance: number | null;
        peak_price: number | null;
        triggered: number;
        triggered_at: number | null;
        telegram_id: number;
        wallet_id: number | null;
        token_mint: string;
        token_symbol: string | null;
        entry_price: number;
        entry_amount: string;
        entry_sol: number;
    }>;

    return rows.map(row => ({
        ...row,
        triggered: row.triggered === 1,
    }));
}

/**
 * Mark a rule as triggered
 */
export function markTriggered(ruleId: number): boolean {
    const db = getDatabase();
    const now = Date.now();

    const result = db.prepare(`
        UPDATE tp_sl_rules
        SET triggered = 1, triggered_at = ?
        WHERE id = ?
    `).run(now, ruleId);

    if (result.changes > 0) {
        console.log(`✅ Rule ${ruleId} marked as triggered`);
        return true;
    }
    return false;
}

/**
 * Update peak price for trailing stop loss
 */
export function updatePeakPrice(ruleId: number, newPeakPrice: number): boolean {
    const db = getDatabase();

    const result = db.prepare(`
        UPDATE tp_sl_rules
        SET peak_price = ?
        WHERE id = ? AND type = 'TRAILING_SL'
    `).run(newPeakPrice, ruleId);

    if (result.changes > 0) {
        console.log(`📈 Updated peak price for rule ${ruleId}: $${newPeakPrice.toFixed(8)}`);
        return true;
    }
    return false;
}

/**
 * Delete a specific rule
 */
export function deleteRule(ruleId: number): boolean {
    const db = getDatabase();

    const result = db.prepare(`
        DELETE FROM tp_sl_rules WHERE id = ?
    `).run(ruleId);

    if (result.changes > 0) {
        console.log(`🗑️ Deleted rule ${ruleId}`);
        return true;
    }
    return false;
}

/**
 * Clear all rules for a position
 */
export function clearRulesForPosition(positionId: number): number {
    const db = getDatabase();

    const result = db.prepare(`
        DELETE FROM tp_sl_rules WHERE position_id = ?
    `).run(positionId);

    console.log(`🗑️ Cleared ${result.changes} rules for position ${positionId}`);
    return result.changes;
}

/**
 * Format rules summary for display
 * Returns e.g., "TP: +100%/50%, SL: -30%/100%" or "No rules"
 */
export function formatRulesSummary(positionId: number): string {
    const rules = getRulesForPosition(positionId).filter(r => !r.triggered);

    if (rules.length === 0) return "No rules set";

    const parts: string[] = [];

    const tpRules = rules.filter(r => r.type === "TP");
    const slRules = rules.filter(r => r.type === "SL");
    const trailingRules = rules.filter(r => r.type === "TRAILING_SL");

    if (tpRules.length > 0) {
        const tpSummary = tpRules.map(r => `+${r.trigger_percent}%/${r.sell_percent}%`).join(", ");
        parts.push(`TP: ${tpSummary}`);
    }

    if (slRules.length > 0) {
        const slSummary = slRules.map(r => `${r.trigger_percent}%/${r.sell_percent}%`).join(", ");
        parts.push(`SL: ${slSummary}`);
    }

    if (trailingRules.length > 0) {
        const trailSummary = trailingRules.map(r => `${r.trail_distance}%`).join(", ");
        parts.push(`Trail: ${trailSummary}`);
    }

    return parts.join(" | ");
}

/**
 * Get count of active rules for a user
 */
export function getActiveRulesCount(telegramId: number): number {
    const db = getDatabase();

    const row = db.prepare(`
        SELECT COUNT(*) as count
        FROM tp_sl_rules r
        JOIN positions p ON r.position_id = p.id
        WHERE p.telegram_id = ? AND r.triggered = 0
    `).get(telegramId) as { count: number };

    return row.count;
}

/**
 * Clean up orphaned TP/SL rules (rules whose positions no longer exist)
 * Call this on startup to clean up any stale data
 */
export function cleanupOrphanedRules(): number {
    const db = getDatabase();

    const result = db.prepare(`
        DELETE FROM tp_sl_rules 
        WHERE position_id NOT IN (SELECT id FROM positions)
    `).run();

    if (result.changes > 0) {
        console.log(`🧹 Cleaned up ${result.changes} orphaned TP/SL rules`);
    }

    return result.changes;
}

/**
 * Clean up triggered rules (rules that have already executed)
 * These are kept for history but can be cleaned periodically
 */
export function cleanupTriggeredRules(olderThanDays: number = 7): number {
    const db = getDatabase();
    const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

    const result = db.prepare(`
        DELETE FROM tp_sl_rules 
        WHERE triggered = 1 AND triggered_at < ?
    `).run(cutoffTime);

    if (result.changes > 0) {
        console.log(`🧹 Cleaned up ${result.changes} old triggered rules`);
    }

    return result.changes;
}
