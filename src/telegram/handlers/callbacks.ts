/**
 * Callback query handlers - routes button presses to appropriate handlers
 */

import { Context } from "grammy";
import { UserContext } from "../middleware/user.js";
import { showMainMenu, handleRefresh } from "../menus/main.js";
import { showBuyMenu, showBuyTokenInfo, showBuyConfirm, handleBuyConfirm, clearBuyFlowState, handleBuyCancel, showRecentTokens, showFavorites, handleToggleFavorite } from "../menus/buy.js";
import { showSellMenu, showSellToken, handleSellPercent, handleCloseAll, setCustomSellMode, clearSellFlowState } from "../menus/sell.js";
import { showTPSLMenu, showTPSLForPosition, showAddTP, showAddSL, showAddTrailingSL, handleClearRules, clearTPSLFlowState, showGlobalTPSLSettings, showGlobalTPInput, showGlobalSLInput, showGlobalTrailInput, handleClearGlobalDefaults } from "../menus/tpsl.js";
import { showPositions, showPositionDetail, handlePositionBuy, handlePositionSell, handleCopyCA, handleStopTracking, startCustomBuyFlow, startCustomSellFlow, clearPositionFlowState, cleanupPendingCAMessage } from "../menus/positions.js";
import { showHistory } from "../menus/history.js";
import {
    showWalletMenu, showWalletDetails, showDeposit, showWithdrawAddress,
    showExportKeyWarning, showImportWallet, generateNewWallet, activateWallet,
    showRenameWallet, showDeleteConfirm, executeDeleteWallet, executeWithdraw,
    clearWalletFlowState
} from "../menus/wallet.js";
import {
    showSettings, showSlippageEditor, showQuickBuyEditor, showQuickSellEditor,
    showAutoSellEditor, showInstantAmtEditor, updateSlippage, updateQuickBuy,
    updateQuickSell, updateAutoSell, updateInstantAmt, showSlippageCustomInput,
    clearSettingsFlowState
} from "../menus/settings.js";
import {
    showInstantBuyMenu, showEnableWarning, enableInstantBuy, disableInstantBuy,
    showAmountEditor, updateAmount, clearInstantFlowState
} from "../menus/instant.js";
import { CallbackPrefix } from "../keyboards/builders.js";

/**
 * Parse callback data into prefix and parts
 * Format: prefix:action:param1:param2...
 */
function parseCallback(data: string): { prefix: string; action: string; params: string[] } {
    const parts = data.split(":");
    return {
        prefix: parts[0] || "",
        action: parts[1] || "",
        params: parts.slice(2),
    };
}

/**
 * Clear all flow states for a user (called when returning to main menu)
 */
function clearAllFlowStates(telegramId: number): void {
    clearBuyFlowState(telegramId);
    clearSellFlowState(telegramId);
    clearTPSLFlowState(telegramId);
    clearPositionFlowState(telegramId);
    clearWalletFlowState(telegramId);
    clearSettingsFlowState(telegramId);
    clearInstantFlowState(telegramId);
}

/**
 * Handle menu navigation callbacks
 */
async function handleMenuCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "main":
            // Clear all pending flow states when returning to main menu
            clearAllFlowStates(ctx.user.telegram_id);
            await showMainMenu(ctx, true);
            break;

        case "refresh":
            await handleRefresh(ctx);
            break;

        case "buy":
            await ctx.answerCallbackQuery(); // Stop loading spinner
            await showBuyMenu(ctx);
            break;

        case "sell":
            await showSellMenu(ctx);
            break;

        case "positions":
            await showPositions(ctx);
            break;

        case "history":
            await showHistory(ctx);
            break;

        case "tpsl":
            await showTPSLMenu(ctx);
            break;

        case "instant":
            await showInstantBuyMenu(ctx);
            break;

        case "wallet":
            await showWalletMenu(ctx);
            break;

        case "settings":
            await showSettings(ctx);
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown action" });
    }
}

/**
 * Handle buy-related callbacks
 */
async function handleBuyCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "recent":
            await showRecentTokens(ctx);
            break;

        case "favorites":
            await showFavorites(ctx);
            break;

        case "info":
            // Show token info for buying
            const infoMint = params[0];
            if (infoMint) {
                await showBuyTokenInfo(ctx, infoMint);
            }
            break;

        case "quick":
            // Quick buy with preset amount
            const quickMint = params[0];
            const quickAmount = parseFloat(params[1]);
            if (quickMint && !isNaN(quickAmount)) {
                await showBuyConfirm(ctx, quickMint, quickAmount);
            }
            break;

        case "custom":
            // Custom amount - set waiting state and prompt user
            const customMint = params[0];
            if (customMint) {
                const { setWaitingForAmount } = await import("../menus/buy.js");
                setWaitingForAmount(ctx.user.telegram_id, customMint);
                await ctx.answerCallbackQuery();
                await ctx.reply("✏️ Enter the amount:\n• SOL: <code>0.5</code>\n• USD: <code>$20</code>", { parse_mode: "HTML" });
            }
            break;

        case "confirm":
            // Legacy confirm with amount in callback (for quick buy)
            const confirmMint = params[0];
            const confirmAmount = parseFloat(params[1]);
            if (confirmMint && !isNaN(confirmAmount)) {
                await handleBuyConfirm(ctx, confirmMint, confirmAmount);
            }
            break;

        case "exec":
            // Execute buy - amount stored in state (avoids 64 byte callback limit)
            const execMint = params[0];
            if (execMint) {
                const { getBuyAmount } = await import("../menus/buy.js");
                const amount = getBuyAmount(ctx.user.telegram_id);
                if (amount && amount > 0) {
                    await handleBuyConfirm(ctx, execMint, amount);
                } else {
                    // This happens if another user in a group tries to click the confirm button
                    await ctx.answerCallbackQuery({ text: "❌ This buy is not yours to confirm.", show_alert: true });
                }
            }
            break;

        case "cancel":
            // User clicked Back - clear state and delete message
            await handleBuyCancel(ctx);
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown buy action" });
    }
}

/**
 * Handle sell-related callbacks
 */
async function handleSellCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "token":
            // Show sell options for specific token
            const tokenMint = params[0];
            if (tokenMint) {
                await showSellToken(ctx, tokenMint);
            }
            break;

        case "pct":
            // Sell by percentage
            const pctMint = params[0];
            const percent = parseInt(params[1]);
            if (pctMint && !isNaN(percent)) {
                await handleSellPercent(ctx, pctMint, percent);
            }
            break;

        case "custompct":
            // Custom percentage - prompt user
            const customPctMint = params[0];
            if (customPctMint) {
                setCustomSellMode(ctx.user.telegram_id, customPctMint, "percent");
                await ctx.answerCallbackQuery();
                await ctx.reply("✏️ Enter the percentage to sell (1-100):");
            }
            break;

        case "customexact":
            // Custom exact amount - prompt user
            const customExactMint = params[0];
            if (customExactMint) {
                setCustomSellMode(ctx.user.telegram_id, customExactMint, "exact");
                await ctx.answerCallbackQuery();
                await ctx.reply("🔢 Enter the number of tokens to sell:");
            }
            break;

        case "closeall":
            // Close all positions
            await handleCloseAll(ctx);
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown sell action" });
    }
}

/**
 * Handle settings-related callbacks
 */
async function handleSettingsCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "slippage":
            if (params[0] === "custom") {
                await showSlippageCustomInput(ctx);
            } else if (params[0]) {
                await updateSlippage(ctx, parseInt(params[0]));
            } else {
                await showSlippageEditor(ctx);
            }
            break;

        case "quickbuy1":
            if (params[0]) {
                await updateQuickBuy(ctx, 1, parseFloat(params[0]));
            } else {
                await showQuickBuyEditor(ctx, 1);
            }
            break;

        case "quickbuy2":
            if (params[0]) {
                await updateQuickBuy(ctx, 2, parseFloat(params[0]));
            } else {
                await showQuickBuyEditor(ctx, 2);
            }
            break;

        case "quicksell1":
            if (params[0]) {
                await updateQuickSell(ctx, 1, parseInt(params[0]));
            } else {
                await showQuickSellEditor(ctx, 1);
            }
            break;

        case "quicksell2":
            if (params[0]) {
                await updateQuickSell(ctx, 2, parseInt(params[0]));
            } else {
                await showQuickSellEditor(ctx, 2);
            }
            break;

        case "autosell":
            if (params[0]) {
                await updateAutoSell(ctx, parseInt(params[0]));
            } else {
                await showAutoSellEditor(ctx);
            }
            break;

        case "instantamt":
            if (params[0]) {
                await updateInstantAmt(ctx, parseFloat(params[0]));
            } else {
                await showInstantAmtEditor(ctx);
            }
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown settings action" });
    }
}

/**
 * Handle wallet-related callbacks
 */
async function handleWalletCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "select":
            const walletId = parseInt(params[0]);
            if (!isNaN(walletId)) {
                await showWalletDetails(ctx, walletId);
            }
            break;

        case "deposit":
            const depositWalletId = parseInt(params[0]);
            if (!isNaN(depositWalletId)) {
                await showDeposit(ctx, depositWalletId);
            }
            break;

        case "withdraw":
            const withdrawWalletId = parseInt(params[0]);
            if (!isNaN(withdrawWalletId)) {
                await showWithdrawAddress(ctx, withdrawWalletId);
            }
            break;

        case "withdraw_exec":
            // Data is stored in wallet flow state (avoids 64 byte callback limit)
            const { getWalletFlowState, clearWalletFlowState, executeWithdraw: doWithdraw } = await import("../menus/wallet.js");
            const withdrawState = getWalletFlowState(ctx.user.telegram_id);
            if (withdrawState?.mode === "withdraw_confirm" && withdrawState.walletId && withdrawState.withdrawAddress && withdrawState.withdrawAmount) {
                await doWithdraw(ctx, withdrawState.walletId, withdrawState.withdrawAddress, withdrawState.withdrawAmount);
            } else {
                await ctx.answerCallbackQuery({ text: "❌ Session expired, try again" });
            }
            break;

        case "export":
            const exportWalletId = parseInt(params[0]);
            if (!isNaN(exportWalletId)) {
                await showExportKeyWarning(ctx, exportWalletId);
            }
            break;

        case "import":
            await showImportWallet(ctx);
            break;

        case "generate":
            await generateNewWallet(ctx);
            break;

        case "activate":
            const activateWalletId = parseInt(params[0]);
            if (!isNaN(activateWalletId)) {
                await activateWallet(ctx, activateWalletId);
            }
            break;

        case "rename":
            const renameWalletId = parseInt(params[0]);
            if (!isNaN(renameWalletId)) {
                await showRenameWallet(ctx, renameWalletId);
            }
            break;

        case "delete":
            const deleteWalletId = parseInt(params[0]);
            if (!isNaN(deleteWalletId)) {
                await showDeleteConfirm(ctx, deleteWalletId);
            }
            break;

        case "delete_confirm":
            const confirmDeleteId = parseInt(params[0]);
            if (!isNaN(confirmDeleteId)) {
                await executeDeleteWallet(ctx, confirmDeleteId);
            }
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown wallet action" });
    }
}

/**
 * Handle instant buy-related callbacks
 */
async function handleInstantCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "on":
            await showEnableWarning(ctx);
            break;

        case "confirm_on":
            await enableInstantBuy(ctx);
            break;

        case "off":
            await disableInstantBuy(ctx);
            break;

        case "amount":
            await showAmountEditor(ctx);
            break;

        case "setamt":
            const amt = parseFloat(params[0]);
            if (!isNaN(amt)) {
                await updateAmount(ctx, amt);
            }
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown instant action" });
    }
}

/**
 * Handle TP/SL-related callbacks
 */
async function handleTPSLCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "list":
            await showTPSLMenu(ctx);
            break;

        case "pos":
            // Show TP/SL for specific position
            const positionId = parseInt(params[0]);
            if (!isNaN(positionId)) {
                await showTPSLForPosition(ctx, positionId);
            }
            break;

        case "addtp":
            // Start add TP flow
            const tpPositionId = parseInt(params[0]);
            if (!isNaN(tpPositionId)) {
                await showAddTP(ctx, tpPositionId);
            }
            break;

        case "addsl":
            // Start add SL flow
            const slPositionId = parseInt(params[0]);
            if (!isNaN(slPositionId)) {
                await showAddSL(ctx, slPositionId);
            }
            break;

        case "trail":
            // Start trailing SL flow
            const trailPositionId = parseInt(params[0]);
            if (!isNaN(trailPositionId)) {
                await showAddTrailingSL(ctx, trailPositionId);
            }
            break;

        case "clear":
            // Clear all rules for position
            const clearPositionId = parseInt(params[0]);
            if (!isNaN(clearPositionId)) {
                await handleClearRules(ctx, clearPositionId);
            }
            break;

        case "globals":
            // Show global TP/SL settings
            await showGlobalTPSLSettings(ctx);
            break;

        case "gtp":
            // Edit global TP
            await showGlobalTPInput(ctx);
            break;

        case "gsl":
            // Edit global SL
            await showGlobalSLInput(ctx);
            break;

        case "gtrail":
            // Edit global trailing
            await showGlobalTrailInput(ctx);
            break;

        case "gclear":
            // Clear global defaults
            await handleClearGlobalDefaults(ctx);
            break;

        case "position":
            // Go to TP/SL for a position (from position detail view)
            const tpslPosId = parseInt(params[0]);
            if (!isNaN(tpslPosId)) {
                await showTPSLForPosition(ctx, tpslPosId);
            }
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown TP/SL action" });
    }
}

/**
 * Handle positions-related callbacks
 */
async function handlePositionsCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "page":
            // Pagination for positions list
            const page = parseInt(params[0]);
            if (!isNaN(page)) {
                await showPositions(ctx, page);
            }
            break;

        case "detail":
            // Show position detail
            const positionId = parseInt(params[0]);
            if (!isNaN(positionId)) {
                await showPositionDetail(ctx, positionId);
            }
            break;

        case "buy":
            // Quick buy from position detail
            const buyMint = params[0];
            const buyAmount = parseFloat(params[1]);
            if (buyMint && !isNaN(buyAmount)) {
                await handlePositionBuy(ctx, buyMint, buyAmount);
            }
            break;

        case "sell":
            // Quick sell from position detail
            const sellMint = params[0];
            const sellPercent = parseInt(params[1]);
            if (sellMint && !isNaN(sellPercent)) {
                await handlePositionSell(ctx, sellMint, sellPercent);
            }
            break;

        case "buycustom":
            // Custom buy flow
            const customBuyPosId = parseInt(params[0]);
            if (!isNaN(customBuyPosId)) {
                await startCustomBuyFlow(ctx, customBuyPosId);
            }
            break;

        case "sellcustom":
            // Custom sell flow
            const customSellPosId = parseInt(params[0]);
            if (!isNaN(customSellPosId)) {
                await startCustomSellFlow(ctx, customSellPosId);
            }
            break;

        case "copy":
            // Copy CA
            const copyMint = params[0];
            if (copyMint) {
                await handleCopyCA(ctx, copyMint);
            }
            break;

        case "stop":
            // Stop tracking (for rugged tokens)
            const stopPosId = parseInt(params[0]);
            if (!isNaN(stopPosId)) {
                await handleStopTracking(ctx, stopPosId);
            }
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown positions action" });
    }
}

/**
 * Handle history-related callbacks
 */
async function handleHistoryCallback(ctx: UserContext, action: string, params: string[]): Promise<void> {
    switch (action) {
        case "page":
            // Pagination for history
            const page = parseInt(params[0]);
            if (!isNaN(page)) {
                await showHistory(ctx, page);
            }
            break;

        default:
            await ctx.answerCallbackQuery({ text: "Unknown history action" });
    }
}

/**
 * Main callback router
 */
export async function handleCallback(ctx: UserContext): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    const { prefix, action, params } = parseCallback(data);

    // Auto-cleanup CA message when user presses any button (except copy itself)
    if (!(prefix === CallbackPrefix.POSITIONS && action === "copy")) {
        await cleanupPendingCAMessage(ctx);
    }

    console.log(`🔘 Callback: ${prefix}:${action} [${params.join(", ")}]`);

    try {
        switch (prefix) {
            case CallbackPrefix.MENU:
                await handleMenuCallback(ctx, action, params);
                break;

            case CallbackPrefix.BUY:
                await handleBuyCallback(ctx, action, params);
                break;

            case CallbackPrefix.SELL:
                await handleSellCallback(ctx, action, params);
                break;

            case CallbackPrefix.SETTINGS:
                await handleSettingsCallback(ctx, action, params);
                break;

            case CallbackPrefix.WALLET:
                await handleWalletCallback(ctx, action, params);
                break;

            case CallbackPrefix.TPSL:
                await handleTPSLCallback(ctx, action, params);
                break;

            case CallbackPrefix.POSITIONS:
                await handlePositionsCallback(ctx, action, params);
                break;

            case CallbackPrefix.HISTORY:
                await handleHistoryCallback(ctx, action, params);
                break;

            case CallbackPrefix.INSTANT:
                await handleInstantCallback(ctx, action, params);
                break;

            default:
                console.warn(`Unknown callback prefix: ${prefix}`);
                await ctx.answerCallbackQuery({ text: "Unknown action" });
        }
    } catch (error) {
        console.error("Callback error:", error);
        await ctx.answerCallbackQuery({ text: "❌ An error occurred" });
    }
}

