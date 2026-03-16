/**
 * TP/SL Menu - UI for managing Take Profit / Stop Loss rules
 * Includes global defaults and per-position overrides
 */

import { InlineKeyboard } from "grammy";
import { UserContext } from "../middleware/user.js";
import { CallbackPrefix } from "../keyboards/builders.js";
import { getPositionsByWallet, getPositionById, Position } from "../../database/positions.js";
import {
    getRulesForPosition,
    addTPRule,
    addSLRule,
    addTrailingSL,
    deleteRule,
    clearRulesForPosition,
    formatRulesSummary,
    TPSLRule
} from "../../database/tpsl.js";
import { getGlobalTPSL, updateGlobalTPSL, GlobalTPSLSettings } from "../../database/settings.js";
import { getTokenPrice } from "../../trading/quote.js";

// State for tracking user input flows
interface TPSLFlowState {
    positionId?: number;  // Optional - if not set, we're editing global defaults
    mode: "add_tp" | "add_sl" | "add_trail" | "global_tp" | "global_sl" | "global_trail";
}

const tpslFlowState = new Map<number, TPSLFlowState>();

/**
 * Show main TP/SL menu - global defaults + list of positions
 */
export async function showTPSLMenu(ctx: UserContext): Promise<void> {
    const walletId = ctx.user.active_wallet_id;
    const globalSettings = getGlobalTPSL(ctx.user.telegram_id);
    const positions = getPositionsByWallet(walletId);

    // Format global defaults
    let globalText = "<b>🌐 Global Defaults:</b>\n";
    if (!globalSettings.default_tp_enabled && !globalSettings.default_sl_enabled && !globalSettings.default_trail_enabled) {
        globalText += "<i>No global defaults set</i>\n";
    } else {
        if (globalSettings.default_tp_enabled) {
            globalText += `• 🎯 TP: +${globalSettings.default_tp_percent}% → ${globalSettings.default_tp_sell_percent}%\n`;
        }
        if (globalSettings.default_sl_enabled) {
            globalText += `• 🛑 SL: -${globalSettings.default_sl_percent}% → ${globalSettings.default_sl_sell_percent}%\n`;
        }
        if (globalSettings.default_trail_enabled) {
            globalText += `• 📉 Trail: ${globalSettings.default_trail_percent}%\n`;
        }
    }

    // Build keyboard
    const kb = new InlineKeyboard()
        .text("⚙️ Edit Global TP/SL", `${CallbackPrefix.TPSL}:globals`)
        .row();

    if (positions.length === 0) {
        kb.text("🛒 Buy Token", `${CallbackPrefix.MENU}:buy`)
            .row()
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        await ctx.editMessageText(
            `🎯 <b>Take Profit / Stop Loss</b>\n\n` +
            globalText +
            `\n━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📭 <b>Positions:</b> None\n\n` +
            `Buy a token to set up per-position TP/SL.`,
            { parse_mode: "HTML", reply_markup: kb }
        );
        return;
    }

    // Build position list with TP/SL summaries
    let positionList = "";
    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        const symbol = pos.token_symbol || pos.token_mint.slice(0, 6) + "...";
        const summary = formatRulesSummary(pos.id);
        positionList += `${i + 1}️⃣ <b>${symbol}</b> — ${summary}\n`;

        kb.text(`${symbol}`, `${CallbackPrefix.TPSL}:pos:${pos.id}`);
        if ((i + 1) % 2 === 0) kb.row();
    }

    if (positions.length % 2 !== 0) kb.row();
    kb.text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(
        `🎯 <b>Take Profit / Stop Loss</b>\n\n` +
        globalText +
        `\n━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<b>📈 Positions:</b>\n` +
        positionList,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Show global TP/SL settings editor
 */
export async function showGlobalTPSLSettings(ctx: UserContext): Promise<void> {
    const globalSettings = getGlobalTPSL(ctx.user.telegram_id);

    const tpStatus = globalSettings.default_tp_enabled
        ? `✅ +${globalSettings.default_tp_percent}% → ${globalSettings.default_tp_sell_percent}%`
        : "❌ Off";
    const slStatus = globalSettings.default_sl_enabled
        ? `✅ -${globalSettings.default_sl_percent}% → ${globalSettings.default_sl_sell_percent}%`
        : "❌ Off";
    const trailStatus = globalSettings.default_trail_enabled
        ? `✅ ${globalSettings.default_trail_percent}%`
        : "❌ Off";

    const kb = new InlineKeyboard()
        .text(`${globalSettings.default_tp_enabled ? "✏️" : "➕"} Take Profit: ${tpStatus}`, `${CallbackPrefix.TPSL}:gtp`)
        .row()
        .text(`${globalSettings.default_sl_enabled ? "✏️" : "➕"} Stop Loss: ${slStatus}`, `${CallbackPrefix.TPSL}:gsl`)
        .row()
        .text(`${globalSettings.default_trail_enabled ? "✏️" : "➕"} Trailing: ${trailStatus}`, `${CallbackPrefix.TPSL}:gtrail`)
        .row()
        .text("🗑️ Clear All Defaults", `${CallbackPrefix.TPSL}:gclear`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:tpsl`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(
        `⚙️ <b>Global TP/SL Defaults</b>\n\n` +
        `These settings apply automatically to all NEW positions.\n` +
        `You can override them for individual tokens.\n\n` +
        `<b>Current Settings:</b>\n` +
        `• 🎯 Take Profit: ${tpStatus}\n` +
        `• 🛑 Stop Loss: ${slStatus}\n` +
        `• 📉 Trailing SL: ${trailStatus}`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Prompt for global TP settings
 */
export async function showGlobalTPInput(ctx: UserContext): Promise<void> {
    tpslFlowState.set(ctx.user.telegram_id, { mode: "global_tp" });

    const kb = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.TPSL}:globals`);

    await ctx.editMessageText(
        `🎯 <b>Set Global Take Profit</b>\n\n` +
        `Enter: <code>GAIN% SELL%</code>\n\n` +
        `<b>Examples:</b>\n` +
        `• <code>100 50</code> — Sell 50% at +100% gain\n` +
        `• <code>200 100</code> — Sell 100% at +200% gain\n` +
        `• <code>off</code> — Disable global TP`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Prompt for global SL settings
 */
export async function showGlobalSLInput(ctx: UserContext): Promise<void> {
    tpslFlowState.set(ctx.user.telegram_id, { mode: "global_sl" });

    const kb = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.TPSL}:globals`);

    await ctx.editMessageText(
        `🛑 <b>Set Global Stop Loss</b>\n\n` +
        `Enter: <code>LOSS% SELL%</code>\n\n` +
        `<b>Examples:</b>\n` +
        `• <code>30 100</code> — Sell 100% at -30% loss\n` +
        `• <code>20 50</code> — Sell 50% at -20% loss\n` +
        `• <code>off</code> — Disable global SL`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Prompt for global Trailing SL settings
 */
export async function showGlobalTrailInput(ctx: UserContext): Promise<void> {
    tpslFlowState.set(ctx.user.telegram_id, { mode: "global_trail" });

    const kb = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.TPSL}:globals`);

    await ctx.editMessageText(
        `📉 <b>Set Global Trailing SL</b>\n\n` +
        `Enter the trail distance %:\n\n` +
        `<b>Examples:</b>\n` +
        `• <code>20</code> — Trail 20% from peak\n` +
        `• <code>15</code> — Trail 15% from peak\n` +
        `• <code>off</code> — Disable global trailing`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Clear all global TP/SL defaults
 */
export async function handleClearGlobalDefaults(ctx: UserContext): Promise<void> {
    updateGlobalTPSL(ctx.user.telegram_id, {
        default_tp_enabled: false,
        default_sl_enabled: false,
        default_trail_enabled: false,
    });
    await ctx.answerCallbackQuery({ text: "🗑️ Global defaults cleared" });
    await showGlobalTPSLSettings(ctx);
}

/**
 * Show TP/SL settings for a specific position
 */
export async function showTPSLForPosition(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);

    if (!position || position.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery({ text: "Position not found" });
        return showTPSLMenu(ctx);
    }

    const rules = getRulesForPosition(positionId);
    const symbol = position.token_symbol || position.token_mint.slice(0, 8) + "...";

    // Format current rules
    let rulesText = "";
    const activeRules = rules.filter(r => !r.triggered);
    if (activeRules.length === 0) {
        rulesText = "<i>No rules set — using global defaults</i>";
    } else {
        for (const rule of activeRules) {
            rulesText += formatRuleDisplay(rule) + "\n";
        }
    }

    const kb = new InlineKeyboard()
        .text("➕ Add TP", `${CallbackPrefix.TPSL}:addtp:${positionId}`)
        .text("➕ Add SL", `${CallbackPrefix.TPSL}:addsl:${positionId}`)
        .row()
        .text("📉 Trailing SL", `${CallbackPrefix.TPSL}:trail:${positionId}`)
        .text("🗑️ Clear All", `${CallbackPrefix.TPSL}:clear:${positionId}`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:tpsl`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(
        `🎯 <b>TP/SL for ${symbol}</b>\n\n` +
        `<b>Current Rules:</b>\n${rulesText}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Entry: $${position.entry_price.toFixed(8)}`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Send TP/SL settings as a new message (for use after text input)
 */
async function sendTPSLForPositionMessage(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);

    if (!position) return;

    const rules = getRulesForPosition(positionId);
    const symbol = position.token_symbol || position.token_mint.slice(0, 8) + "...";

    // Format current rules
    let rulesText = "";
    const activeRules = rules.filter(r => !r.triggered);
    if (activeRules.length === 0) {
        rulesText = "<i>No rules set — using global defaults</i>";
    } else {
        for (const rule of activeRules) {
            rulesText += formatRuleDisplay(rule) + "\n";
        }
    }

    const kb = new InlineKeyboard()
        .text("➕ Add TP", `${CallbackPrefix.TPSL}:addtp:${positionId}`)
        .text("➕ Add SL", `${CallbackPrefix.TPSL}:addsl:${positionId}`)
        .row()
        .text("📉 Trailing SL", `${CallbackPrefix.TPSL}:trail:${positionId}`)
        .text("🗑️ Clear All", `${CallbackPrefix.TPSL}:clear:${positionId}`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:tpsl`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.reply(
        `🎯 <b>TP/SL for ${symbol}</b>\n\n` +
        `<b>Current Rules:</b>\n${rulesText}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Entry: $${position.entry_price.toFixed(8)}`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Prompt user to add a Take Profit rule
 */
export async function showAddTP(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);
    if (!position) return;

    const symbol = position.token_symbol || position.token_mint.slice(0, 8) + "...";
    tpslFlowState.set(ctx.user.telegram_id, { positionId, mode: "add_tp" });

    const kb = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.TPSL}:pos:${positionId}`);

    await ctx.editMessageText(
        `🎯 <b>Add Take Profit for ${symbol}</b>\n\n` +
        `Enter: <code>GAIN% SELL%</code>\n\n` +
        `<b>Examples:</b>\n` +
        `• <code>100 50</code> — Sell 50% at +100% gain\n` +
        `• <code>200 100</code> — Sell 100% at +200% gain`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Prompt user to add a Stop Loss rule
 */
export async function showAddSL(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);
    if (!position) return;

    const symbol = position.token_symbol || position.token_mint.slice(0, 8) + "...";
    tpslFlowState.set(ctx.user.telegram_id, { positionId, mode: "add_sl" });

    const kb = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.TPSL}:pos:${positionId}`);

    await ctx.editMessageText(
        `🛑 <b>Add Stop Loss for ${symbol}</b>\n\n` +
        `Enter: <code>LOSS% SELL%</code>\n\n` +
        `<b>Examples:</b>\n` +
        `• <code>30 100</code> — Sell 100% at -30% loss\n` +
        `• <code>20 50</code> — Sell 50% at -20% loss`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Prompt user to add a Trailing Stop Loss
 */
export async function showAddTrailingSL(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);
    if (!position) return;

    const symbol = position.token_symbol || position.token_mint.slice(0, 8) + "...";
    tpslFlowState.set(ctx.user.telegram_id, { positionId, mode: "add_trail" });

    const kb = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.TPSL}:pos:${positionId}`);

    await ctx.editMessageText(
        `📉 <b>Add Trailing SL for ${symbol}</b>\n\n` +
        `Enter trail distance %:\n\n` +
        `<b>Examples:</b>\n` +
        `• <code>20</code> — Sell if drops 20% from peak\n` +
        `• <code>15</code> — Sell if drops 15% from peak`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Handle user input for TP/SL rules (both global and per-position)
 */
export async function handleTPSLInput(ctx: UserContext, inputText: string): Promise<boolean> {
    const state = tpslFlowState.get(ctx.user.telegram_id);
    if (!state) return false;

    const text = inputText.trim().toLowerCase();

    try {
        // Handle global settings
        if (state.mode.startsWith("global_")) {
            return await handleGlobalInput(ctx, state.mode, text);
        }

        // Handle per-position settings
        if (!state.positionId) {
            tpslFlowState.delete(ctx.user.telegram_id);
            return false;
        }

        const positionId = state.positionId; // Store for later use
        const position = getPositionById(positionId);
        if (!position) {
            tpslFlowState.delete(ctx.user.telegram_id);
            return false;
        }

        let confirmMessage: Awaited<ReturnType<typeof ctx.reply>> | null = null;

        switch (state.mode) {
            case "add_tp": {
                const [gainStr, sellStr] = text.split(/\s+/);
                const gain = parseFloat(gainStr);
                const sell = parseFloat(sellStr);

                if (isNaN(gain) || isNaN(sell) || gain <= 0 || sell <= 0 || sell > 100) {
                    await ctx.reply("❌ Invalid format. Use: <code>GAIN% SELL%</code>\nExample: <code>100 50</code>", { parse_mode: "HTML" });
                    return true;
                }

                addTPRule(positionId, gain, sell);
                confirmMessage = await ctx.reply(`✅ Take Profit added: +${gain}% → sell ${sell}%`);
                break;
            }

            case "add_sl": {
                const [lossStr, sellStr] = text.split(/\s+/);
                const loss = parseFloat(lossStr);
                const sell = parseFloat(sellStr);

                if (isNaN(loss) || isNaN(sell) || loss <= 0 || sell <= 0 || sell > 100) {
                    await ctx.reply("❌ Invalid format. Use: <code>LOSS% SELL%</code>\nExample: <code>30 100</code>", { parse_mode: "HTML" });
                    return true;
                }

                addSLRule(positionId, -loss, sell);
                confirmMessage = await ctx.reply(`✅ Stop Loss added: -${loss}% → sell ${sell}%`);
                break;
            }

            case "add_trail": {
                const trail = parseFloat(text);

                if (isNaN(trail) || trail <= 0 || trail > 100) {
                    await ctx.reply("❌ Enter a number 1-100.\nExample: <code>20</code>", { parse_mode: "HTML" });
                    return true;
                }

                const price = await getTokenPrice(position.token_mint);
                const peakPrice = price.priceUSD > 0 ? price.priceUSD : position.entry_price;

                addTrailingSL(positionId, trail, peakPrice);
                confirmMessage = await ctx.reply(`✅ Trailing SL added: ${trail}% trail (peak: $${peakPrice.toFixed(8)})`);
                break;
            }
        }

        // Delete user's input message to keep chat clean
        try {
            await ctx.deleteMessage();
        } catch {
            // Ignore if message can't be deleted
        }

        tpslFlowState.delete(ctx.user.telegram_id);

        // Delete confirmation after 1.5s and show position's TP/SL page
        if (confirmMessage) {
            setTimeout(async () => {
                try {
                    await ctx.api.deleteMessage(ctx.chat!.id, confirmMessage!.message_id);
                } catch {
                    // Message may already be deleted
                }
                // Send updated TP/SL settings for the position
                await sendTPSLForPositionMessage(ctx, positionId);
            }, 1500);
        }

    } catch (error) {
        console.error("Error adding TP/SL rule:", error);
        await ctx.reply("❌ Error adding rule. Please try again.");
    }

    return true;
}

/**
 * Handle global TP/SL input
 */
async function handleGlobalInput(ctx: UserContext, mode: string, text: string): Promise<boolean> {
    const telegramId = ctx.user.telegram_id;
    let successMessage = "";

    if (text === "off" || text === "disable" || text === "0") {
        switch (mode) {
            case "global_tp":
                updateGlobalTPSL(telegramId, { default_tp_enabled: false });
                successMessage = "✅ Global Take Profit disabled";
                break;
            case "global_sl":
                updateGlobalTPSL(telegramId, { default_sl_enabled: false });
                successMessage = "✅ Global Stop Loss disabled";
                break;
            case "global_trail":
                updateGlobalTPSL(telegramId, { default_trail_enabled: false });
                successMessage = "✅ Global Trailing SL disabled";
                break;
        }
    } else {
        switch (mode) {
            case "global_tp": {
                const [gainStr, sellStr] = text.split(/\s+/);
                const gain = parseFloat(gainStr);
                const sell = parseFloat(sellStr);

                if (isNaN(gain) || isNaN(sell) || gain <= 0 || sell <= 0 || sell > 100) {
                    await ctx.reply("❌ Invalid. Use: <code>GAIN% SELL%</code> or <code>off</code>", { parse_mode: "HTML" });
                    return true;
                }

                updateGlobalTPSL(telegramId, {
                    default_tp_enabled: true,
                    default_tp_percent: gain,
                    default_tp_sell_percent: sell,
                });
                successMessage = `✅ Global TP set: +${gain}% → sell ${sell}%`;
                break;
            }

            case "global_sl": {
                const [lossStr, sellStr] = text.split(/\s+/);
                const loss = parseFloat(lossStr);
                const sell = parseFloat(sellStr);

                if (isNaN(loss) || isNaN(sell) || loss <= 0 || sell <= 0 || sell > 100) {
                    await ctx.reply("❌ Invalid. Use: <code>LOSS% SELL%</code> or <code>off</code>", { parse_mode: "HTML" });
                    return true;
                }

                updateGlobalTPSL(telegramId, {
                    default_sl_enabled: true,
                    default_sl_percent: loss,
                    default_sl_sell_percent: sell,
                });
                successMessage = `✅ Global SL set: -${loss}% → sell ${sell}%`;
                break;
            }

            case "global_trail": {
                const trail = parseFloat(text);

                if (isNaN(trail) || trail <= 0 || trail > 100) {
                    await ctx.reply("❌ Enter 1-100 or <code>off</code>", { parse_mode: "HTML" });
                    return true;
                }

                updateGlobalTPSL(telegramId, {
                    default_trail_enabled: true,
                    default_trail_percent: trail,
                });
                successMessage = `✅ Global Trailing SL set: ${trail}%`;
                break;
            }
        }
    }

    tpslFlowState.delete(telegramId);

    // Delete the user's input message
    try {
        await ctx.deleteMessage();
    } catch (e) {
        // May fail if message is too old or bot lacks permissions
    }

    // Send confirmation and delete after 2 seconds, then show settings page
    const confirmMsg = await ctx.reply(successMessage);

    // Small delay then delete confirmation and show settings
    setTimeout(async () => {
        try {
            await ctx.api.deleteMessage(ctx.chat!.id, confirmMsg.message_id);
        } catch (e) {
            // Ignore deletion errors
        }
    }, 1500);

    // Send a new message with the global settings menu (since we can't edit the old prompt)
    await sendGlobalTPSLSettingsMessage(ctx);

    return true;
}

/**
 * Send a fresh global TP/SL settings message (for use after text input)
 */
async function sendGlobalTPSLSettingsMessage(ctx: UserContext): Promise<void> {
    const globalSettings = getGlobalTPSL(ctx.user.telegram_id);

    const tpStatus = globalSettings.default_tp_enabled
        ? `✅ +${globalSettings.default_tp_percent}% → ${globalSettings.default_tp_sell_percent}%`
        : "❌ Off";
    const slStatus = globalSettings.default_sl_enabled
        ? `✅ -${globalSettings.default_sl_percent}% → ${globalSettings.default_sl_sell_percent}%`
        : "❌ Off";
    const trailStatus = globalSettings.default_trail_enabled
        ? `✅ ${globalSettings.default_trail_percent}%`
        : "❌ Off";

    const kb = new InlineKeyboard()
        .text(`${globalSettings.default_tp_enabled ? "✏️" : "➕"} Take Profit: ${tpStatus}`, `${CallbackPrefix.TPSL}:gtp`)
        .row()
        .text(`${globalSettings.default_sl_enabled ? "✏️" : "➕"} Stop Loss: ${slStatus}`, `${CallbackPrefix.TPSL}:gsl`)
        .row()
        .text(`${globalSettings.default_trail_enabled ? "✏️" : "➕"} Trailing: ${trailStatus}`, `${CallbackPrefix.TPSL}:gtrail`)
        .row()
        .text("🗑️ Clear All Defaults", `${CallbackPrefix.TPSL}:gclear`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:tpsl`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.reply(
        `⚙️ <b>Global TP/SL Defaults</b>\n\n` +
        `These settings apply automatically to all NEW positions.\n` +
        `You can override them for individual tokens.\n\n` +
        `<b>Current Settings:</b>\n` +
        `• 🎯 Take Profit: ${tpStatus}\n` +
        `• 🛑 Stop Loss: ${slStatus}\n` +
        `• 📉 Trailing SL: ${trailStatus}`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

/**
 * Handle clearing all rules for a position
 */
export async function handleClearRules(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);

    if (!position || position.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery({ text: "Position not found" });
        return;
    }

    const count = clearRulesForPosition(positionId);
    await ctx.answerCallbackQuery({ text: `🗑️ Cleared ${count} rules` });
    await showTPSLForPosition(ctx, positionId);
}

/**
 * Check if user is in TP/SL input flow
 */
export function isInTPSLFlow(telegramId: number): boolean {
    return tpslFlowState.has(telegramId);
}

/**
 * Clear TP/SL flow state
 */
export function clearTPSLFlowState(telegramId: number): void {
    tpslFlowState.delete(telegramId);
}

/**
 * Format a rule for display
 */
function formatRuleDisplay(rule: TPSLRule): string {
    switch (rule.type) {
        case "TP":
            return `• 🎯 TP: +${rule.trigger_percent}% → Sell ${rule.sell_percent}%`;
        case "SL":
            return `• 🛑 SL: ${rule.trigger_percent}% → Sell ${rule.sell_percent}%`;
        case "TRAILING_SL":
            return `• 📉 Trail: ${rule.trail_distance}% from peak`;
        default:
            return "";
    }
}
