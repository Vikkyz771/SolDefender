/**
 * Keyboard builders for Telegram inline keyboards
 */

import { InlineKeyboard } from "grammy";

/**
 * Callback data prefixes for routing
 */
export const CallbackPrefix = {
    MENU: "menu",
    BUY: "buy",
    SELL: "sell",
    POSITIONS: "pos",
    HISTORY: "hist",
    TPSL: "tpsl",
    INSTANT: "inst",
    WALLET: "wallet",
    SETTINGS: "set",
} as const;

/**
 * Build the main menu keyboard
 */
export function buildMainMenuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("🛒 Buy", `${CallbackPrefix.MENU}:buy`)
        .text("💸 Sell", `${CallbackPrefix.MENU}:sell`)
        .row()
        .text("📈 Positions", `${CallbackPrefix.MENU}:positions`)
        .text("📜 History", `${CallbackPrefix.MENU}:history`)
        .row()
        .text("🎯 TP/SL", `${CallbackPrefix.MENU}:tpsl`)
        .text("⚡ Instant", `${CallbackPrefix.MENU}:instant`)
        .row()
        .text("💼 Wallet", `${CallbackPrefix.MENU}:wallet`)
        .text("⚙️ Settings", `${CallbackPrefix.MENU}:settings`)
        .row()
        .text("🔄 Refresh", `${CallbackPrefix.MENU}:refresh`);
}

/**
 * Build navigation row (Back + Main Menu)
 */
export function buildNavigationRow(backCallback?: string): InlineKeyboard {
    const kb = new InlineKeyboard();
    if (backCallback) {
        kb.text("⬅️ Back", backCallback);
    }
    kb.text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);
    return kb;
}

/**
 * Build confirm/cancel row
 */
export function buildConfirmCancelRow(
    confirmCallback: string,
    cancelCallback: string = `${CallbackPrefix.MENU}:main`
): InlineKeyboard {
    return new InlineKeyboard()
        .text("✅ Confirm", confirmCallback)
        .text("❌ Cancel", cancelCallback);
}

/**
 * Build a grid of buttons from an array
 */
export function buildButtonGrid(
    buttons: Array<{ text: string; callback: string }>,
    columns: number = 2
): InlineKeyboard {
    const kb = new InlineKeyboard();

    buttons.forEach((btn, index) => {
        kb.text(btn.text, btn.callback);
        // Add row after every `columns` buttons, except at the end
        if ((index + 1) % columns === 0 && index < buttons.length - 1) {
            kb.row();
        }
    });

    return kb;
}

/**
 * Add navigation row to an existing keyboard
 */
export function addNavigation(
    keyboard: InlineKeyboard,
    backCallback?: string
): InlineKeyboard {
    keyboard.row();
    if (backCallback) {
        keyboard.text("⬅️ Back", backCallback);
    }
    keyboard.text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);
    return keyboard;
}

/**
 * Build quick buy amounts keyboard
 */
export function buildQuickBuyKeyboard(
    mint: string,
    quickBuy1: number,
    quickBuy2: number
): InlineKeyboard {
    return new InlineKeyboard()
        .text(`${quickBuy1} SOL`, `${CallbackPrefix.BUY}:quick:${mint}:${quickBuy1}`)
        .text(`${quickBuy2} SOL`, `${CallbackPrefix.BUY}:quick:${mint}:${quickBuy2}`)
        .row()
        .text("✏️ Custom Amount", `${CallbackPrefix.BUY}:custom:${mint}`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:buy`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);
}

/**
 * Build quick sell percentages keyboard
 */
export function buildQuickSellKeyboard(
    mint: string,
    quickSell1: number,
    quickSell2: number
): InlineKeyboard {
    return new InlineKeyboard()
        .text(`${quickSell1}%`, `${CallbackPrefix.SELL}:pct:${mint}:${quickSell1}`)
        .text(`${quickSell2}%`, `${CallbackPrefix.SELL}:pct:${mint}:${quickSell2}`)
        .text("75%", `${CallbackPrefix.SELL}:pct:${mint}:75`)
        .text("100%", `${CallbackPrefix.SELL}:pct:${mint}:100`)
        .row()
        .text("✏️ Custom %", `${CallbackPrefix.SELL}:custom:${mint}`)
        .text("🔢 Exact Amount", `${CallbackPrefix.SELL}:exact:${mint}`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.MENU}:sell`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);
}

/**
 * Build settings keyboard
 */
export function buildSettingsKeyboard(settings: {
    slippage_bps: number;
    quick_buy_1: number;
    quick_buy_2: number;
    quick_sell_1: number;
    quick_sell_2: number;
    autosell_threshold: number;
    instant_buy_amount: number;
}): InlineKeyboard {
    const slippagePercent = settings.slippage_bps / 100;

    return new InlineKeyboard()
        .text(`💧 Slippage: ${slippagePercent}%`, `${CallbackPrefix.SETTINGS}:slippage`)
        .row()
        .text(`🛒 Quick Buy 1: ${settings.quick_buy_1} SOL`, `${CallbackPrefix.SETTINGS}:quickbuy1`)
        .row()
        .text(`🛒 Quick Buy 2: ${settings.quick_buy_2} SOL`, `${CallbackPrefix.SETTINGS}:quickbuy2`)
        .row()
        .text(`💸 Quick Sell 1: ${settings.quick_sell_1}%`, `${CallbackPrefix.SETTINGS}:quicksell1`)
        .row()
        .text(`💸 Quick Sell 2: ${settings.quick_sell_2}%`, `${CallbackPrefix.SETTINGS}:quicksell2`)
        .row()
        .text(`📈 Auto-Sell Curve: ${settings.autosell_threshold}%`, `${CallbackPrefix.SETTINGS}:autosell`)
        .row()
        .text(`⚡ Instant Buy Amt: ${settings.instant_buy_amount} SOL`, `${CallbackPrefix.SETTINGS}:instantamt`)
        .row()
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);
}

/**
 * Build wallet menu keyboard
 */
export function buildWalletKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("📥 Deposit", `${CallbackPrefix.WALLET}:deposit`)
        .text("📤 Withdraw", `${CallbackPrefix.WALLET}:withdraw`)
        .row()
        .text("🔑 Export Key", `${CallbackPrefix.WALLET}:export`)
        .text("📋 Copy Addr", `${CallbackPrefix.WALLET}:copy`)
        .row()
        .text("🔄 Import Wallet", `${CallbackPrefix.WALLET}:import`)
        .row()
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);
}
