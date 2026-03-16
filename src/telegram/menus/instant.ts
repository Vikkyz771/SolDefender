/**
 * Instant Buy Menu - Toggle instant buy mode with strict warnings
 * When ON, pasting a CA will immediately execute a buy
 */

import { InlineKeyboard } from "grammy";
import { UserContext } from "../middleware/user.js";
import { CallbackPrefix } from "../keyboards/builders.js";
import { updateSetting } from "../../database/settings.js";
import { parseAmountInput, formatSOLWithUSD, getSOLPriceSync } from "../../utils/solPrice.js";

// ============================================================================
// State Management
// ============================================================================

interface InstantFlowState {
    mode: "set_amount";
}

const instantFlowState = new Map<number, InstantFlowState>();

// ============================================================================
// Main Instant Buy Menu
// ============================================================================

/**
 * Show instant buy menu with status and toggle
 */
export async function showInstantBuyMenu(ctx: UserContext): Promise<void> {
    const settings = ctx.settings;
    const isEnabled = settings.instant_buy_enabled;
    const solPrice = getSOLPriceSync();
    const amountUSD = (settings.instant_buy_amount * solPrice).toFixed(0);

    const statusEmoji = isEnabled ? "🟢" : "🔴";
    const statusText = isEnabled ? "**ON**" : "**OFF**";

    let text = `⚡ **Instant Buy Mode**\n\n` +
        `Status: ${statusEmoji} ${statusText}\n` +
        `Amount: **${settings.instant_buy_amount} SOL** (~$${amountUSD})\n\n`;

    if (isEnabled) {
        text += `━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ **ACTIVE**\n\n` +
            `When you paste a contract address,\n` +
            `it will **immediately buy** with the\n` +
            `configured amount. No confirmation!\n` +
            `━━━━━━━━━━━━━━━━━━━━━`;
    } else {
        text += `When enabled, pasting a contract address\n` +
            `will immediately execute a buy with\n` +
            `the configured amount.`;
    }

    const keyboard = new InlineKeyboard();

    if (isEnabled) {
        keyboard.text("🔴 Turn OFF", `${CallbackPrefix.INSTANT}:off`);
    } else {
        keyboard.text("🟢 Turn ON", `${CallbackPrefix.INSTANT}:on`);
    }

    keyboard
        .row()
        .text(`✏️ Set Amount (${settings.instant_buy_amount} SOL)`, `${CallbackPrefix.INSTANT}:amount`)
        .row()
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

// ============================================================================
// Toggle Handlers
// ============================================================================

/**
 * Show strict warning before enabling instant buy
 */
export async function showEnableWarning(ctx: UserContext): Promise<void> {
    const settings = ctx.settings;
    const solPrice = getSOLPriceSync();
    const amountUSD = (settings.instant_buy_amount * solPrice).toFixed(0);

    const text = `⚠️ **DANGER: Enable Instant Buy?**\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `🚨 **READ CAREFULLY** 🚨\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `When Instant Buy is **ON**:\n\n` +
        `• Pasting ANY contract address will\n` +
        `  **IMMEDIATELY** buy tokens\n\n` +
        `• **NO confirmation** will be shown\n\n` +
        `• You will spend **${settings.instant_buy_amount} SOL** (~$${amountUSD})\n` +
        `  per transaction\n\n` +
        `• Scam tokens could drain your wallet\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ **Only enable if you understand the risks**`;

    const keyboard = new InlineKeyboard()
        .text("⚠️ I Understand, Enable", `${CallbackPrefix.INSTANT}:confirm_on`)
        .row()
        .text("❌ Cancel", `${CallbackPrefix.MENU}:instant`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Enable instant buy mode
 */
export async function enableInstantBuy(ctx: UserContext): Promise<void> {
    updateSetting(ctx.user.telegram_id, "instant_buy_enabled", true);
    ctx.settings.instant_buy_enabled = true;

    await ctx.answerCallbackQuery("⚡ Instant Buy ENABLED!");
    await showInstantBuyMenu(ctx);
}

/**
 * Disable instant buy mode
 */
export async function disableInstantBuy(ctx: UserContext): Promise<void> {
    updateSetting(ctx.user.telegram_id, "instant_buy_enabled", false);
    ctx.settings.instant_buy_enabled = false;

    await ctx.answerCallbackQuery("✅ Instant Buy disabled");
    await showInstantBuyMenu(ctx);
}

// ============================================================================
// Amount Editor
// ============================================================================

/**
 * Show amount editor for instant buy
 */
export async function showAmountEditor(ctx: UserContext): Promise<void> {
    const settings = ctx.settings;
    const solPrice = getSOLPriceSync();
    const currentUSD = (settings.instant_buy_amount * solPrice).toFixed(0);

    instantFlowState.set(ctx.user.telegram_id, {
        mode: "set_amount",
    });

    const text = `⚡ **Instant Buy Amount**\n\n` +
        `Current: **${settings.instant_buy_amount} SOL** (~$${currentUSD})\n\n` +
        `This is the amount used when you paste\n` +
        `a contract address with Instant Buy ON.\n\n` +
        `Enter a new amount:\n` +
        `• SOL: \`0.5\` or \`1\`\n` +
        `• USD: \`$50\` or \`$100\``;

    const keyboard = new InlineKeyboard()
        .text("0.1 SOL", `${CallbackPrefix.INSTANT}:setamt:0.1`)
        .text("0.25 SOL", `${CallbackPrefix.INSTANT}:setamt:0.25`)
        .text("0.5 SOL", `${CallbackPrefix.INSTANT}:setamt:0.5`)
        .row()
        .text("1 SOL", `${CallbackPrefix.INSTANT}:setamt:1`)
        .text("2 SOL", `${CallbackPrefix.INSTANT}:setamt:2`)
        .text("5 SOL", `${CallbackPrefix.INSTANT}:setamt:5`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:instant`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Update instant buy amount from preset
 */
export async function updateAmount(ctx: UserContext, amount: number): Promise<void> {
    if (amount <= 0 || amount > 100) {
        await ctx.answerCallbackQuery("❌ Amount must be between 0 and 100 SOL");
        return;
    }

    updateSetting(ctx.user.telegram_id, "instant_buy_amount", amount);
    ctx.settings.instant_buy_amount = amount;

    await ctx.answerCallbackQuery(`✅ Instant Buy amount set to ${amount} SOL`);
    clearInstantFlowState(ctx.user.telegram_id);
    await showInstantBuyMenu(ctx);
}

/**
 * Handle custom text input for instant buy amount
 */
export async function handleInstantInput(ctx: UserContext, text: string): Promise<boolean> {
    const state = instantFlowState.get(ctx.user.telegram_id);
    if (!state) return false;

    if (state.mode === "set_amount") {
        const result = await parseAmountInput(text.trim());

        if (!result || result.solAmount <= 0 || result.solAmount > 100) {
            await ctx.reply("❌ Invalid amount. Enter SOL (0.5) or USD ($50).");
            return true;
        }

        const amount = result.solAmount;
        updateSetting(ctx.user.telegram_id, "instant_buy_amount", amount);
        ctx.settings.instant_buy_amount = amount;

        await ctx.reply(`✅ Instant Buy amount set to ${amount.toFixed(3)} SOL`);
        clearInstantFlowState(ctx.user.telegram_id);
        return true;
    }

    return false;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if user is in instant buy flow
 */
export function isInInstantFlow(telegramId: number): boolean {
    return instantFlowState.has(telegramId);
}

/**
 * Clear instant flow state
 */
export function clearInstantFlowState(telegramId: number): void {
    instantFlowState.delete(telegramId);
}

/**
 * Check if instant buy is enabled for user
 */
export function isInstantBuyEnabled(ctx: UserContext): boolean {
    return ctx.settings.instant_buy_enabled;
}
