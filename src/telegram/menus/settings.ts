/**
 * Settings Menu - User configuration UI
 * Supports USD inputs for amounts (e.g., "$50")
 */

import { InlineKeyboard } from "grammy";
import { UserContext } from "../middleware/user.js";
import { CallbackPrefix } from "../keyboards/builders.js";
import { getSettings, updateSetting, UserSettings } from "../../database/settings.js";
import { parseAmountInput, formatSOLWithUSD, getSOLPriceSync } from "../../utils/solPrice.js";

// ============================================================================
// State Management
// ============================================================================

type SettingKey = "slippage" | "quickbuy1" | "quickbuy2" | "quicksell1" | "quicksell2" | "autosell" | "instantamt";

interface SettingsFlowState {
    editing: SettingKey;
    messageId?: number;  // Track the settings menu message to update it
    chatId?: number;
    promptMessageId?: number;  // Track the prompt message to delete it
}

const settingsFlowState = new Map<number, SettingsFlowState>();

// ============================================================================
// Main Settings Menu
// ============================================================================

/**
 * Show settings menu with current values
 */
export async function showSettings(ctx: UserContext): Promise<void> {
    const settings = ctx.settings;
    const solPrice = getSOLPriceSync();

    // Format values with USD equivalents for amounts (3 decimal places for display)
    const slippagePercent = (settings.slippage_bps / 100).toFixed(1);
    const quickBuy1Display = settings.quick_buy_1.toFixed(3);
    const quickBuy2Display = settings.quick_buy_2.toFixed(3);
    const instantAmtDisplay = settings.instant_buy_amount.toFixed(3);
    const quickBuy1USD = (settings.quick_buy_1 * solPrice).toFixed(0);
    const quickBuy2USD = (settings.quick_buy_2 * solPrice).toFixed(0);
    const instantAmtUSD = (settings.instant_buy_amount * solPrice).toFixed(0);

    const text = `⚙️ **Settings**\n\n` +
        `Configure your trading preferences below.\n` +
        `_Tap any setting to change it._\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `💧 **Slippage:** ${slippagePercent}%\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🛒 **Quick Buy Amounts:**\n` +
        `   • Button 1: ${quickBuy1Display} SOL (~$${quickBuy1USD})\n` +
        `   • Button 2: ${quickBuy2Display} SOL (~$${quickBuy2USD})\n\n` +
        `💸 **Quick Sell Percentages:**\n` +
        `   • Button 1: ${settings.quick_sell_1}%\n` +
        `   • Button 2: ${settings.quick_sell_2}%\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 **Auto-Sell Threshold:** ${settings.autosell_threshold}%\n` +
        `   _(Sell when bonding curve hits this %)_\n\n` +
        `⚡ **Instant Buy Amount:** ${instantAmtDisplay} SOL (~$${instantAmtUSD})`;

    const keyboard = new InlineKeyboard()
        .text(`💧 Slippage: ${slippagePercent}%`, `${CallbackPrefix.SETTINGS}:slippage`)
        .row()
        .text(`🛒 Buy 1: ${quickBuy1Display} SOL`, `${CallbackPrefix.SETTINGS}:quickbuy1`)
        .text(`🛒 Buy 2: ${quickBuy2Display} SOL`, `${CallbackPrefix.SETTINGS}:quickbuy2`)
        .row()
        .text(`💸 Sell 1: ${settings.quick_sell_1}%`, `${CallbackPrefix.SETTINGS}:quicksell1`)
        .text(`💸 Sell 2: ${settings.quick_sell_2}%`, `${CallbackPrefix.SETTINGS}:quicksell2`)
        .row()
        .text(`📈 Auto-Sell: ${settings.autosell_threshold}%`, `${CallbackPrefix.SETTINGS}:autosell`)
        .row()
        .text(`⚡ Instant Amt: ${instantAmtDisplay} SOL`, `${CallbackPrefix.SETTINGS}:instantamt`)
        .row()
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

// ============================================================================
// Setting Editors
// ============================================================================

/**
 * Show slippage editor with presets
 */
export async function showSlippageEditor(ctx: UserContext): Promise<void> {
    const currentSlippage = ctx.settings.slippage_bps / 100;

    const text = `💧 **Set Slippage**\n\n` +
        `Current: **${currentSlippage}%**\n\n` +
        `Select a preset or enter a custom value:\n` +
        `_Example: "15" for 15%_`;

    const keyboard = new InlineKeyboard()
        .text("0.5%", `${CallbackPrefix.SETTINGS}:slippage:50`)
        .text("1%", `${CallbackPrefix.SETTINGS}:slippage:100`)
        .text("5%", `${CallbackPrefix.SETTINGS}:slippage:500`)
        .row()
        .text("10%", `${CallbackPrefix.SETTINGS}:slippage:1000`)
        .text("15%", `${CallbackPrefix.SETTINGS}:slippage:1500`)
        .text("20%", `${CallbackPrefix.SETTINGS}:slippage:2000`)
        .row()
        .text("✏️ Custom", `${CallbackPrefix.SETTINGS}:slippage:custom`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:settings`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    const result = await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });

    // Store message ID for later updates
    if (result && typeof result !== 'boolean' && 'message_id' in result) {
        settingsFlowState.set(ctx.user.telegram_id, {
            editing: "slippage",
            messageId: result.message_id,
            chatId: result.chat.id,
        });
    }
}

/**
 * Show slippage custom input prompt
 */
export async function showSlippageCustomInput(ctx: UserContext): Promise<void> {
    // Get current message ID before prompting
    const messageId = ctx.callbackQuery?.message?.message_id;
    const chatId = ctx.chat?.id;

    settingsFlowState.set(ctx.user.telegram_id, {
        editing: "slippage",
        messageId: messageId,
        chatId: chatId,
    });

    await ctx.answerCallbackQuery();
    const prompt = await ctx.reply("✏️ Enter custom slippage (0.1-50%):\n_Example: 15 for 15%_", {
        parse_mode: "Markdown",
    });

    // Store the prompt message ID so we can delete it later
    const state = settingsFlowState.get(ctx.user.telegram_id);
    if (state && prompt) {
        state.promptMessageId = prompt.message_id;
    }
}

/**
 * Show quick buy amount editor (supports SOL and USD)
 */
export async function showQuickBuyEditor(ctx: UserContext, buttonNum: 1 | 2): Promise<void> {
    const currentValue = buttonNum === 1 ? ctx.settings.quick_buy_1 : ctx.settings.quick_buy_2;
    const solPrice = getSOLPriceSync();
    const currentUSD = (currentValue * solPrice).toFixed(0);

    settingsFlowState.set(ctx.user.telegram_id, {
        editing: buttonNum === 1 ? "quickbuy1" : "quickbuy2",
    });

    const text = `🛒 **Set Quick Buy ${buttonNum}**\n\n` +
        `Current: **${currentValue} SOL** (~$${currentUSD})\n\n` +
        `Enter a new amount:\n` +
        `• SOL: \`0.5\` or \`1\`\n` +
        `• USD: \`$50\` or \`$100\``;

    const keyboard = new InlineKeyboard()
        .text("0.1 SOL", `${CallbackPrefix.SETTINGS}:quickbuy${buttonNum}:0.1`)
        .text("0.25 SOL", `${CallbackPrefix.SETTINGS}:quickbuy${buttonNum}:0.25`)
        .text("0.5 SOL", `${CallbackPrefix.SETTINGS}:quickbuy${buttonNum}:0.5`)
        .row()
        .text("1 SOL", `${CallbackPrefix.SETTINGS}:quickbuy${buttonNum}:1`)
        .text("2 SOL", `${CallbackPrefix.SETTINGS}:quickbuy${buttonNum}:2`)
        .text("5 SOL", `${CallbackPrefix.SETTINGS}:quickbuy${buttonNum}:5`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:settings`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    const result = await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });

    // Store message ID for later updates
    if (result && typeof result !== 'boolean' && 'message_id' in result) {
        const state = settingsFlowState.get(ctx.user.telegram_id)!;
        state.messageId = result.message_id;
        state.chatId = result.chat.id;
    }
}

/**
 * Show quick sell percentage editor
 */
export async function showQuickSellEditor(ctx: UserContext, buttonNum: 1 | 2): Promise<void> {
    const currentValue = buttonNum === 1 ? ctx.settings.quick_sell_1 : ctx.settings.quick_sell_2;

    settingsFlowState.set(ctx.user.telegram_id, {
        editing: buttonNum === 1 ? "quicksell1" : "quicksell2",
    });

    const text = `💸 **Set Quick Sell ${buttonNum}**\n\n` +
        `Current: **${currentValue}%**\n\n` +
        `Select a percentage or enter a custom value:`;

    const keyboard = new InlineKeyboard()
        .text("10%", `${CallbackPrefix.SETTINGS}:quicksell${buttonNum}:10`)
        .text("25%", `${CallbackPrefix.SETTINGS}:quicksell${buttonNum}:25`)
        .text("33%", `${CallbackPrefix.SETTINGS}:quicksell${buttonNum}:33`)
        .row()
        .text("50%", `${CallbackPrefix.SETTINGS}:quicksell${buttonNum}:50`)
        .text("75%", `${CallbackPrefix.SETTINGS}:quicksell${buttonNum}:75`)
        .text("100%", `${CallbackPrefix.SETTINGS}:quicksell${buttonNum}:100`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:settings`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    const result = await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });

    if (result && typeof result !== 'boolean' && 'message_id' in result) {
        const state = settingsFlowState.get(ctx.user.telegram_id)!;
        state.messageId = result.message_id;
        state.chatId = result.chat.id;
    }
}

/**
 * Show auto-sell threshold editor
 */
export async function showAutoSellEditor(ctx: UserContext): Promise<void> {
    const currentValue = ctx.settings.autosell_threshold;

    settingsFlowState.set(ctx.user.telegram_id, {
        editing: "autosell",
    });

    const text = `📈 **Auto-Sell Threshold**\n\n` +
        `Current: **${currentValue}%**\n\n` +
        `When a token's bonding curve reaches this %,\n` +
        `it will be automatically sold to protect from\n` +
        `graduation rug-pulls.\n\n` +
        `_Higher = more risk, more potential gain_\n` +
        `_Lower = safer, may miss some gains_`;

    const keyboard = new InlineKeyboard()
        .text("75%", `${CallbackPrefix.SETTINGS}:autosell:75`)
        .text("80%", `${CallbackPrefix.SETTINGS}:autosell:80`)
        .text("85%", `${CallbackPrefix.SETTINGS}:autosell:85`)
        .row()
        .text("90%", `${CallbackPrefix.SETTINGS}:autosell:90`)
        .text("95%", `${CallbackPrefix.SETTINGS}:autosell:95`)
        .text("OFF", `${CallbackPrefix.SETTINGS}:autosell:100`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:settings`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    const result = await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });

    if (result && typeof result !== 'boolean' && 'message_id' in result) {
        const state = settingsFlowState.get(ctx.user.telegram_id)!;
        state.messageId = result.message_id;
        state.chatId = result.chat.id;
    }
}

/**
 * Show instant buy amount editor
 */
export async function showInstantAmtEditor(ctx: UserContext): Promise<void> {
    const currentValue = ctx.settings.instant_buy_amount;
    const solPrice = getSOLPriceSync();
    const currentUSD = (currentValue * solPrice).toFixed(0);

    settingsFlowState.set(ctx.user.telegram_id, {
        editing: "instantamt",
    });

    const text = `⚡ **Instant Buy Amount**\n\n` +
        `Current: **${currentValue} SOL** (~$${currentUSD})\n\n` +
        `This is the amount used when Instant Buy mode is ON\n` +
        `and you paste a contract address.\n\n` +
        `Enter a new amount:\n` +
        `• SOL: \`0.5\` or \`1\`\n` +
        `• USD: \`$50\` or \`$100\``;

    const keyboard = new InlineKeyboard()
        .text("0.1 SOL", `${CallbackPrefix.SETTINGS}:instantamt:0.1`)
        .text("0.25 SOL", `${CallbackPrefix.SETTINGS}:instantamt:0.25`)
        .text("0.5 SOL", `${CallbackPrefix.SETTINGS}:instantamt:0.5`)
        .row()
        .text("1 SOL", `${CallbackPrefix.SETTINGS}:instantamt:1`)
        .text("2 SOL", `${CallbackPrefix.SETTINGS}:instantamt:2`)
        .text("5 SOL", `${CallbackPrefix.SETTINGS}:instantamt:5`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:settings`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    const result = await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });

    if (result && typeof result !== 'boolean' && 'message_id' in result) {
        const state = settingsFlowState.get(ctx.user.telegram_id)!;
        state.messageId = result.message_id;
        state.chatId = result.chat.id;
    }
}

// ============================================================================
// Setting Updates
// ============================================================================

/**
 * Update slippage from preset or custom input
 */
export async function updateSlippage(ctx: UserContext, bps: number): Promise<void> {
    if (bps < 10 || bps > 5000) {
        await ctx.answerCallbackQuery("❌ Slippage must be between 0.1% and 50%");
        return;
    }

    updateSetting(ctx.user.telegram_id, "slippage_bps", bps);
    ctx.settings.slippage_bps = bps;

    await ctx.answerCallbackQuery(`✅ Slippage set to ${bps / 100}%`);
    await showSettings(ctx);
}

/**
 * Update quick buy amount
 */
export async function updateQuickBuy(ctx: UserContext, buttonNum: 1 | 2, amount: number): Promise<void> {
    if (amount <= 0 || amount > 100) {
        await ctx.answerCallbackQuery("❌ Amount must be between 0 and 100 SOL");
        return;
    }

    const key = buttonNum === 1 ? "quick_buy_1" : "quick_buy_2";
    updateSetting(ctx.user.telegram_id, key, amount);

    if (buttonNum === 1) {
        ctx.settings.quick_buy_1 = amount;
    } else {
        ctx.settings.quick_buy_2 = amount;
    }

    await ctx.answerCallbackQuery(`✅ Quick Buy ${buttonNum} set to ${amount} SOL`);
    clearSettingsFlowState(ctx.user.telegram_id);
    await showSettings(ctx);
}

/**
 * Update quick sell percentage
 */
export async function updateQuickSell(ctx: UserContext, buttonNum: 1 | 2, percent: number): Promise<void> {
    if (percent <= 0 || percent > 100) {
        await ctx.answerCallbackQuery("❌ Percentage must be between 1 and 100");
        return;
    }

    const key = buttonNum === 1 ? "quick_sell_1" : "quick_sell_2";
    updateSetting(ctx.user.telegram_id, key, percent);

    if (buttonNum === 1) {
        ctx.settings.quick_sell_1 = percent;
    } else {
        ctx.settings.quick_sell_2 = percent;
    }

    await ctx.answerCallbackQuery(`✅ Quick Sell ${buttonNum} set to ${percent}%`);
    clearSettingsFlowState(ctx.user.telegram_id);
    await showSettings(ctx);
}

/**
 * Update auto-sell threshold
 */
export async function updateAutoSell(ctx: UserContext, threshold: number): Promise<void> {
    if (threshold < 1 || threshold > 100) {
        await ctx.answerCallbackQuery("❌ Threshold must be between 1 and 100");
        return;
    }

    updateSetting(ctx.user.telegram_id, "autosell_threshold", threshold);
    ctx.settings.autosell_threshold = threshold;

    const msg = threshold === 100 ? "Auto-sell disabled" : `Auto-sell set to ${threshold}%`;
    await ctx.answerCallbackQuery(`✅ ${msg}`);
    clearSettingsFlowState(ctx.user.telegram_id);
    await showSettings(ctx);
}

/**
 * Update instant buy amount
 */
export async function updateInstantAmt(ctx: UserContext, amount: number): Promise<void> {
    if (amount <= 0 || amount > 100) {
        await ctx.answerCallbackQuery("❌ Amount must be between 0 and 100 SOL");
        return;
    }

    updateSetting(ctx.user.telegram_id, "instant_buy_amount", amount);
    ctx.settings.instant_buy_amount = amount;

    await ctx.answerCallbackQuery(`✅ Instant Buy amount set to ${amount} SOL`);
    clearSettingsFlowState(ctx.user.telegram_id);
    await showSettings(ctx);
}


/**
 * Handle custom text input for settings
 * Deletes user message and updates settings menu with holistic view
 */
export async function handleSettingsInput(ctx: UserContext, text: string): Promise<boolean> {
    const state = settingsFlowState.get(ctx.user.telegram_id);
    if (!state) return false;

    const input = text.trim();
    let success = false;
    let confirmText = "";

    // Try to delete the user's input message first
    try {
        await ctx.deleteMessage();
    } catch {
        // Message may already be deleted
    }

    // Also delete the prompt message if we stored it
    if (state.promptMessageId && ctx.chat?.id) {
        try {
            await ctx.api.deleteMessage(ctx.chat.id, state.promptMessageId);
        } catch {
            // Prompt may already be deleted
        }
    }

    switch (state.editing) {
        case "slippage": {
            const value = parseFloat(input);
            if (isNaN(value) || value < 0.1 || value > 50) {
                await sendAutoDeleteError(ctx, "❌ Invalid slippage. Enter 0.1-50%");
                return true;
            }
            const bps = Math.round(value * 100);
            updateSetting(ctx.user.telegram_id, "slippage_bps", bps);
            ctx.settings.slippage_bps = bps;
            confirmText = `✅ Slippage set to ${value}%`;
            success = true;
            break;
        }

        case "quickbuy1":
        case "quickbuy2": {
            const result = await parseAmountInput(input);
            if (!result || result.solAmount <= 0 || result.solAmount > 100) {
                await sendAutoDeleteError(ctx, "❌ Invalid amount. Enter SOL or $USD.");
                return true;
            }
            const amount = result.solAmount;
            const buttonNum = state.editing === "quickbuy1" ? 1 : 2;
            const key = buttonNum === 1 ? "quick_buy_1" : "quick_buy_2";
            updateSetting(ctx.user.telegram_id, key, amount);
            if (buttonNum === 1) {
                ctx.settings.quick_buy_1 = amount;
            } else {
                ctx.settings.quick_buy_2 = amount;
            }
            confirmText = `✅ Quick Buy ${buttonNum} → ${amount.toFixed(3)} SOL`;
            success = true;
            break;
        }

        case "quicksell1":
        case "quicksell2": {
            const value = parseFloat(input.replace("%", ""));
            if (isNaN(value) || value <= 0 || value > 100) {
                await sendAutoDeleteError(ctx, "❌ Invalid percentage. Enter 1-100.");
                return true;
            }
            const buttonNum = state.editing === "quicksell1" ? 1 : 2;
            const key = buttonNum === 1 ? "quick_sell_1" : "quick_sell_2";
            updateSetting(ctx.user.telegram_id, key, Math.round(value));
            if (buttonNum === 1) {
                ctx.settings.quick_sell_1 = Math.round(value);
            } else {
                ctx.settings.quick_sell_2 = Math.round(value);
            }
            confirmText = `✅ Quick Sell ${buttonNum} → ${Math.round(value)}%`;
            success = true;
            break;
        }

        case "autosell": {
            const value = parseFloat(input.replace("%", ""));
            if (isNaN(value) || value < 1 || value > 100) {
                await sendAutoDeleteError(ctx, "❌ Invalid threshold. Enter 1-100.");
                return true;
            }
            updateSetting(ctx.user.telegram_id, "autosell_threshold", Math.round(value));
            ctx.settings.autosell_threshold = Math.round(value);
            confirmText = `✅ Auto-sell → ${Math.round(value)}%`;
            success = true;
            break;
        }

        case "instantamt": {
            const result = await parseAmountInput(input);
            if (!result || result.solAmount <= 0 || result.solAmount > 100) {
                await sendAutoDeleteError(ctx, "❌ Invalid amount. Enter SOL or $USD.");
                return true;
            }
            const amount = result.solAmount;
            updateSetting(ctx.user.telegram_id, "instant_buy_amount", amount);
            ctx.settings.instant_buy_amount = amount;
            confirmText = `✅ Instant Buy → ${amount.toFixed(3)} SOL`;
            success = true;
            break;
        }

        default:
            return false;
    }

    if (success && state.messageId && state.chatId) {
        // Update the editor message to show full settings menu with confirmation
        await updateSettingsMenuAfterEdit(ctx, state.messageId, state.chatId, confirmText);
    }

    clearSettingsFlowState(ctx.user.telegram_id);
    return true;
}

/**
 * Update the settings menu after a successful edit
 */
async function updateSettingsMenuAfterEdit(
    ctx: UserContext,
    messageId: number,
    chatId: number,
    confirmText: string
): Promise<void> {
    const settings = ctx.settings;
    const solPrice = getSOLPriceSync();

    // Format display values (3 decimal places)
    const slippagePercent = (settings.slippage_bps / 100).toFixed(1);
    const quickBuy1Display = settings.quick_buy_1.toFixed(3);
    const quickBuy2Display = settings.quick_buy_2.toFixed(3);
    const instantAmtDisplay = settings.instant_buy_amount.toFixed(3);
    const quickBuy1USD = (settings.quick_buy_1 * solPrice).toFixed(0);
    const quickBuy2USD = (settings.quick_buy_2 * solPrice).toFixed(0);
    const instantAmtUSD = (settings.instant_buy_amount * solPrice).toFixed(0);

    const text = `⚙️ **Settings**\n\n` +
        `${confirmText}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `💧 **Slippage:** ${slippagePercent}%\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🛒 **Quick Buy Amounts:**\n` +
        `   • Button 1: ${quickBuy1Display} SOL (~$${quickBuy1USD})\n` +
        `   • Button 2: ${quickBuy2Display} SOL (~$${quickBuy2USD})\n\n` +
        `💸 **Quick Sell Percentages:**\n` +
        `   • Button 1: ${settings.quick_sell_1}%\n` +
        `   • Button 2: ${settings.quick_sell_2}%\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 **Auto-Sell Threshold:** ${settings.autosell_threshold}%\n\n` +
        `⚡ **Instant Buy Amount:** ${instantAmtDisplay} SOL (~$${instantAmtUSD})`;

    const keyboard = new InlineKeyboard()
        .text(`💧 Slippage: ${slippagePercent}%`, `${CallbackPrefix.SETTINGS}:slippage`)
        .row()
        .text(`🛒 Buy 1: ${quickBuy1Display} SOL`, `${CallbackPrefix.SETTINGS}:quickbuy1`)
        .text(`🛒 Buy 2: ${quickBuy2Display} SOL`, `${CallbackPrefix.SETTINGS}:quickbuy2`)
        .row()
        .text(`💸 Sell 1: ${settings.quick_sell_1}%`, `${CallbackPrefix.SETTINGS}:quicksell1`)
        .text(`💸 Sell 2: ${settings.quick_sell_2}%`, `${CallbackPrefix.SETTINGS}:quicksell2`)
        .row()
        .text(`📈 Auto-Sell: ${settings.autosell_threshold}%`, `${CallbackPrefix.SETTINGS}:autosell`)
        .row()
        .text(`⚡ Instant Amt: ${instantAmtDisplay} SOL`, `${CallbackPrefix.SETTINGS}:instantamt`)
        .row()
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    try {
        await ctx.api.editMessageText(chatId, messageId, text, {
            parse_mode: "Markdown",
            reply_markup: keyboard,
        });
    } catch {
        // If editing fails, just send fresh settings menu
        await ctx.reply(text, {
            parse_mode: "Markdown",
            reply_markup: keyboard,
        });
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if user is in settings flow
 */
export function isInSettingsFlow(telegramId: number): boolean {
    return settingsFlowState.has(telegramId);
}

/**
 * Clear settings flow state
 */
export function clearSettingsFlowState(telegramId: number): void {
    settingsFlowState.delete(telegramId);
}

/**
 * Send an error message that auto-deletes after 2 seconds
 */
async function sendAutoDeleteError(ctx: UserContext, message: string): Promise<void> {
    const errorMsg = await ctx.reply(message);

    // Auto-delete after 2 seconds
    setTimeout(async () => {
        try {
            await ctx.api.deleteMessage(errorMsg.chat.id, errorMsg.message_id);
        } catch {
            // Message may already be deleted
        }
    }, 2000);
}

