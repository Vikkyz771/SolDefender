/**
 * Positions Menu - Portfolio overview and position details
 */

import { InlineKeyboard } from "grammy";
import { UserContext } from "../middleware/user.js";
import { CallbackPrefix } from "../keyboards/builders.js";
import { showMainMenu } from "./main.js";
import { getPositionsByWallet, getPositionById, Position, closePosition } from "../../database/positions.js";
import { getTransactionsByWallet } from "../../database/transactions.js";
import { getRulesForPosition, formatRulesSummary, clearRulesForPosition } from "../../database/tpsl.js";
import { stopTracking } from "../../autosell/index.js";
import { getSettings } from "../../database/settings.js";
import { getTokenPrice, getTokenMarketCap } from "../../trading/quote.js";
import { getSellQuote } from "../../trading/quote.js";
import { calculatePnL, formatPnL, formatPnLFull, formatMarketCap, formatDuration, getPortfolioStats } from "../../trading/pnl.js";
import { getSOLPriceSync, formatSOLWithUSD } from "../../utils/solPrice.js";
import { decryptWallet, getWalletTokenHoldings } from "../../utils/wallet.js";
import { executeBuy } from "../../trading/buy.js";
import { executeSellPercent } from "../../trading/sell.js";
import { PublicKey } from "@solana/web3.js";

// Constants
const POSITIONS_PER_PAGE = 5;

// State for tracking custom input flows
interface PositionFlowState {
    positionId: number;
    tokenMint: string;
    tokenSymbol: string | null;
    mode: "buy_custom" | "sell_custom";
}

const positionFlowState = new Map<number, PositionFlowState>();

/**
 * Show positions overview (portfolio summary + paginated positions list)
 */
export async function showPositions(ctx: UserContext, page: number = 0): Promise<void> {
    const walletId = ctx.user.active_wallet_id;
    const positions = getPositionsByWallet(walletId);
    const transactions = getTransactionsByWallet(walletId, 100); // Get more for win rate calc

    // Fetch current SOL values for all positions
    const currentValuesSOL = new Map<string, number>();
    const walletPubkey = new PublicKey(ctx.user.wallet_address);

    // Only fetch holdings and quotes if there are positions (skip RPC for empty wallets)
    if (positions.length > 0) {
        try {
            const holdings = await getWalletTokenHoldings(walletPubkey);
            const holdingsMap = new Map(holdings.map(h => [h.mint.toBase58(), h]));

            // Get sell quotes for all positions to calculate current SOL value
            for (const position of positions) {
                const holding = holdingsMap.get(position.token_mint);
                if (holding && holding.balance > 0n) {
                    try {
                        const { estimatedSOL } = await getSellQuote(position.token_mint, holding.balance, 1500);
                        currentValuesSOL.set(position.token_mint, estimatedSOL);
                    } catch (e: unknown) {
                        // HTTP 400 means no route - use entry as fallback, don't crash
                        const errorMessage = e instanceof Error ? e.message : String(e);
                        if (!errorMessage.includes('400')) {
                            console.warn(`[Positions] Quote failed for ${position.token_symbol || position.token_mint.slice(0, 8)}: ${errorMessage}`);
                        }
                        currentValuesSOL.set(position.token_mint, position.entry_sol);
                    }
                }
            }
        } catch (error) {
            console.error("Error fetching holdings:", error);
        }
    }

    // Calculate portfolio stats
    const stats = getPortfolioStats(positions, currentValuesSOL, transactions);

    // Build portfolio summary
    const solPrice = getSOLPriceSync();
    const totalValueUSD = stats.totalValueSOL * solPrice;
    const realizedUSD = stats.realizedPnLSOL * solPrice;
    const realizedSign = stats.realizedPnLSOL >= 0 ? "+" : "";

    let text = `📊 <b>Portfolio Overview</b>\n\n`;
    text += `💰 Total Value: <code>${stats.totalValueSOL.toFixed(4)} SOL (~$${totalValueUSD.toFixed(2)})</code>\n`;
    text += `🏆 Win Rate: ${stats.winRate.toFixed(0)}% (${stats.winCount}/${stats.winCount + stats.lossCount} trades)\n`;
    text += `💵 Realized P&L: <code>${realizedSign}${stats.realizedPnLSOL.toFixed(4)} SOL (~$${Math.abs(realizedUSD).toFixed(2)})</code>\n`;
    text += `\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Pagination
    const totalPositions = positions.length;
    const totalPages = Math.ceil(totalPositions / POSITIONS_PER_PAGE);
    const startIdx = page * POSITIONS_PER_PAGE;
    const endIdx = Math.min(startIdx + POSITIONS_PER_PAGE, totalPositions);
    const pagePositions = positions.slice(startIdx, endIdx);

    text += `📍 <b>Active Positions (${totalPositions}):</b>\n\n`;

    if (totalPositions === 0) {
        text += `<i>No active positions. Buy some tokens to get started!</i>`;
    }

    // Build keyboard
    const keyboard = new InlineKeyboard();

    // Add position buttons
    for (let i = 0; i < pagePositions.length; i++) {
        const position = pagePositions[i];
        const currentSOL = currentValuesSOL.get(position.token_mint) || position.entry_sol;
        const pnl = calculatePnL(position.entry_sol, currentSOL);

        // Check if TP/SL rules are set
        const rules = getRulesForPosition(position.id);
        const hasRules = rules.length > 0;
        const rulesIndicator = hasRules ? "🎯" : "⚠️ no TP/SL";

        const tokenName = position.token_symbol || position.token_mint.slice(0, 8) + "...";
        const pnlStr = position.entry_sol > 0 ? formatPnL(pnl.pnlPercent) : "N/A";

        text += `<b>${startIdx + i + 1}. ${tokenName}</b> ${rulesIndicator}\n`;
        text += `   📊 ${pnlStr} | ${position.entry_sol.toFixed(4)} → ${currentSOL.toFixed(4)} SOL\n\n`;

        // Add button for this position
        keyboard.text(`${tokenName}`, `${CallbackPrefix.POSITIONS}:detail:${position.id}`).row();
    }

    // Pagination buttons
    if (totalPages > 1) {
        if (page > 0) {
            keyboard.text("◀️ Prev", `${CallbackPrefix.POSITIONS}:page:${page - 1}`);
        }
        keyboard.text(`${page + 1}/${totalPages}`, `${CallbackPrefix.POSITIONS}:page:${page}`);
        if (page < totalPages - 1) {
            keyboard.text("Next ▶️", `${CallbackPrefix.POSITIONS}:page:${page + 1}`);
        }
        keyboard.row();
    }

    // Refresh and Main menu buttons side by side
    keyboard.text("🔄 Refresh", `${CallbackPrefix.POSITIONS}:page:${page}`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    if (ctx.callbackQuery?.message) {
        try {
            await ctx.editMessageText(text, {
                parse_mode: "HTML",
                reply_markup: keyboard,
            });
        } catch {
            // Edit failed (e.g., same content) - silently ignore, no message spam
        }
    } else {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
}

/**
 * Show detailed view for a specific position
 */
export async function showPositionDetail(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);
    if (!position || position.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery({ text: "Position not found", show_alert: true });
        return;
    }

    const walletPubkey = new PublicKey(ctx.user.wallet_address);
    const settings = getSettings(ctx.user.telegram_id);

    // Get current token holding
    let currentBalance = 0n;
    let decimals = 9;
    try {
        const holdings = await getWalletTokenHoldings(walletPubkey);
        const holding = holdings.find(h => h.mint.toBase58() === position.token_mint);
        if (holding) {
            currentBalance = holding.balance;
            decimals = holding.decimals;
        }
    } catch (e) {
        console.error("Error fetching holdings:", e);
    }

    // Get current value and price
    let currentSOL = position.entry_sol;
    let currentPrice = position.entry_price;
    let noLiquidity = false;
    let priceError: string | null = null;

    // Try to get current sell quote for accurate SOL value
    if (currentBalance > 0n) {
        try {
            const { estimatedSOL } = await getSellQuote(position.token_mint, currentBalance, 1500);
            currentSOL = estimatedSOL;
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            // HTTP 400 = no route/liquidity - expected for some tokens
            if (errorMessage.includes('400')) {
                noLiquidity = true;
                priceError = "No trading route available";
                console.warn(`[Position ${positionId}] No liquidity/route for ${position.token_symbol || position.token_mint.slice(0, 8)}: ${errorMessage}`);
            } else {
                priceError = errorMessage;
                console.error(`[Position ${positionId}] Quote error: ${errorMessage}`);
            }
            // Use entry SOL as fallback (already set)
        }
    }

    // Try to get current price
    try {
        const priceData = await getTokenPrice(position.token_mint);
        if (priceData.priceUSD > 0) {
            currentPrice = priceData.priceUSD;
        }
    } catch (e) {
        // Use entry price as fallback (already set)
    }

    // Get current market cap
    let currentMarketCap: number | null = null;
    try {
        currentMarketCap = await getTokenMarketCap(position.token_mint);
    } catch (e) {
        // Silently fail - market cap is optional
    }

    // Calculate P&L
    const pnl = calculatePnL(position.entry_sol, currentSOL);
    const solPrice = getSOLPriceSync();
    const currentValueUSD = currentSOL * solPrice;

    // Time held
    const heldFor = Date.now() - position.entry_time;
    const heldForStr = formatDuration(heldFor);

    // TP/SL rules
    const rulesSummary = formatRulesSummary(position.id);

    // Token name
    const tokenName = position.token_symbol || position.token_mint.slice(0, 8) + "...";
    const shortMint = position.token_mint.slice(0, 4) + "..." + position.token_mint.slice(-4);

    // Build message
    let text = `🪙 <b>${tokenName} Position Details</b>\n\n`;

    // Show warning banner if there's a liquidity/pricing issue
    if (noLiquidity) {
        text += `⚠️ <b>Warning: Cannot fetch live price</b>\n`;
        text += `<i>Possible causes:</i>\n`;
        text += `• Token graduated but not yet on DEX\n`;
        text += `• Extremely low/no liquidity\n`;
        text += `• Token rugged or migrated\n`;
        text += `• Balance too small to quote\n`;
        text += `\n<i>Showing entry values as fallback.</i>\n\n`;
    }

    text += `📊 <b>Performance</b>\n`;
    text += `├ Entry: $${position.entry_price.toExponential(4)}\n`;
    text += `├ Now: $${currentPrice.toExponential(4)}\n`;
    if (position.entry_sol > 0) {
        text += `├ P&L: ${formatPnLFull(pnl.pnlPercent, pnl.pnlSOL, pnl.pnlUSD)}\n`;
    } else {
        text += `├ P&L: N/A (external token)\n`;
    }
    text += `└ Held for: ${heldForStr}\n\n`;

    text += `📈 <b>Market Cap</b>\n`;
    text += `├ Entry: ${formatMarketCap(position.entry_market_cap)}\n`;
    text += `└ Now: ${formatMarketCap(currentMarketCap)}\n\n`;

    text += `🎯 <b>TP/SL Rules</b>\n`;
    text += `└ ${rulesSummary}\n\n`;

    text += `💰 <b>Value:</b> <code>${currentSOL.toFixed(4)} SOL (~$${currentValueUSD.toFixed(2)})</code>\n`;
    text += `📝 <b>CA:</b> <code>${shortMint}</code>\n\n`;

    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    // Build keyboard
    const keyboard = new InlineKeyboard();

    // Buy buttons - format amounts to 4 decimals to keep callback data under 64 bytes
    keyboard.text(`🛒 ${settings.quick_buy_1.toFixed(3)} SOL`, `${CallbackPrefix.POSITIONS}:buy:${position.token_mint}:${settings.quick_buy_1.toFixed(4)}`)
        .text(`🛒 ${settings.quick_buy_2.toFixed(3)} SOL`, `${CallbackPrefix.POSITIONS}:buy:${position.token_mint}:${settings.quick_buy_2.toFixed(4)}`)
        .row();
    keyboard.text("✏️ Custom Buy", `${CallbackPrefix.POSITIONS}:buycustom:${positionId}`)
        .row();

    // Sell buttons
    keyboard.text("💸 50%", `${CallbackPrefix.POSITIONS}:sell:${position.token_mint}:50`)
        .text("💸 100%", `${CallbackPrefix.POSITIONS}:sell:${position.token_mint}:100`)
        .row();
    keyboard.text("✏️ Custom Sell", `${CallbackPrefix.POSITIONS}:sellcustom:${positionId}`)
        .row();

    // Copy CA button + TP/SL settings
    keyboard.text("📋 Copy CA", `${CallbackPrefix.POSITIONS}:copy:${position.token_mint}`)
        .text("🎯 TP/SL", `${CallbackPrefix.TPSL}:position:${positionId}`)
        .row();

    // Stop tracking button (for rugged tokens)
    keyboard.text("🛑 Stop Tracking", `${CallbackPrefix.POSITIONS}:stop:${positionId}`)
        .row();

    // Navigation
    keyboard.text("⬅️ Positions", `${CallbackPrefix.MENU}:positions`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    if (ctx.callbackQuery?.message) {
        try {
            await ctx.editMessageText(text, {
                parse_mode: "HTML",
                reply_markup: keyboard,
            });
        } catch (e) {
            await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
        }
    } else {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
}

/**
 * Handle quick buy from position detail
 */
export async function handlePositionBuy(ctx: UserContext, tokenMint: string, solAmount: number): Promise<void> {
    await ctx.answerCallbackQuery({ text: `🛒 Buying ${solAmount} SOL...` });

    const position = getPositionsByWallet(ctx.user.active_wallet_id).find(p => p.token_mint === tokenMint);
    const tokenSymbol = position?.token_symbol || null;

    const wallet = decryptWallet(ctx.user.encrypted_private_key);
    const settings = getSettings(ctx.user.telegram_id);

    const result = await executeBuy(
        ctx.user.telegram_id,
        ctx.user.active_wallet_id,
        tokenMint,
        tokenSymbol,
        solAmount,
        wallet,
        settings.slippage_bps
    );

    if (result.success) {
        await ctx.reply(`✅ <b>Buy Successful!</b>\n\n🪙 Received: ${result.tokenAmount} tokens\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction</a>`, {
            parse_mode: "HTML",
        });
    } else {
        await ctx.reply(`❌ <b>Buy Failed</b>\n\n${result.error}`, { parse_mode: "HTML" });
    }

    // Show updated position detail
    if (position) {
        await showPositionDetail(ctx, position.id);
    }
}

/**
 * Handle quick sell from position detail
 */
export async function handlePositionSell(ctx: UserContext, tokenMint: string, percent: number): Promise<void> {
    await ctx.answerCallbackQuery({ text: `💸 Selling ${percent}%...` });

    const position = getPositionsByWallet(ctx.user.active_wallet_id).find(p => p.token_mint === tokenMint);
    const tokenSymbol = position?.token_symbol || null;

    const wallet = decryptWallet(ctx.user.encrypted_private_key);
    const settings = getSettings(ctx.user.telegram_id);

    const result = await executeSellPercent(
        ctx.user.telegram_id,
        ctx.user.active_wallet_id,
        tokenMint,
        tokenSymbol,
        percent,
        wallet,
        settings.slippage_bps
    );

    if (result.success) {
        const pnlStr = result.pnlPercent !== undefined
            ? `\n📊 P&L: ${result.pnlPercent >= 0 ? '+' : ''}${result.pnlPercent.toFixed(2)}%`
            : '';
        await ctx.reply(`✅ <b>Sell Successful!</b>\n\n💵 Received: ${result.solReceived?.toFixed(4)} SOL${pnlStr}\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction</a>`, {
            parse_mode: "HTML",
        });
    } else {
        await ctx.reply(`❌ <b>Sell Failed</b>\n\n${result.error}`, { parse_mode: "HTML" });
    }

    // Return to positions list if 100% sell, otherwise show updated detail
    if (percent === 100) {
        await showPositions(ctx);
    } else if (position) {
        await showPositionDetail(ctx, position.id);
    }
}

/**
 * Handle stop tracking button - abandons a position without selling
 * Useful for rugged tokens where liquidity is gone
 */
export async function handleStopTracking(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);
    if (!position || position.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery({ text: "Position not found", show_alert: true });
        return;
    }

    const tokenName = position.token_symbol || position.token_mint.slice(0, 8) + "...";

    // Clear all TP/SL rules for this position
    clearRulesForPosition(positionId);
    console.log(`🛑 [StopTracking] Cleared TP/SL rules for ${tokenName}`);

    // Stop autosell monitoring for this token
    stopTracking(ctx.user.telegram_id, position.token_mint);
    console.log(`🛑 [StopTracking] Stopped autosell monitoring for ${tokenName}`);

    // Close the position in the database
    closePosition(positionId);
    console.log(`🛑 [StopTracking] Closed position for ${tokenName}`);

    await ctx.answerCallbackQuery({ text: `🛑 Stopped tracking ${tokenName}` });

    // Show confirmation and return to positions
    await ctx.reply(
        `🛑 <b>Stopped Tracking: ${tokenName}</b>\n\n` +
        `✅ All TP/SL rules cleared\n` +
        `✅ Autosell monitoring stopped\n` +
        `✅ Position removed from portfolio\n\n` +
        `<i>The token will no longer be monitored or appear in your positions.</i>`,
        { parse_mode: "HTML" }
    );

    await showPositions(ctx);
}

// Track pending CA messages for cleanup
const pendingCAMessages = new Map<number, number>(); // telegramId -> messageId

/**
 * Handle copy CA button - sends CA as a copyable message
 * In Telegram, tapping on <code> text copies it to clipboard
 */
export async function handleCopyCA(ctx: UserContext, tokenMint: string): Promise<void> {
    await ctx.answerCallbackQuery({ text: "📋 Tap the address below to copy" });

    // Send the full CA as a message with code formatting
    // Users can tap on the code text to copy it to clipboard
    const sent = await ctx.reply(
        `📋 <b>Contract Address</b>\n\n<code>${tokenMint}</code>\n\n<i>👆 Tap the address above to copy</i>`,
        { parse_mode: "HTML" }
    );

    // Track this message for cleanup on next interaction
    pendingCAMessages.set(ctx.user.telegram_id, sent.message_id);
}

/**
 * Cleanup pending CA message for a user (called before processing other callbacks)
 */
export async function cleanupPendingCAMessage(ctx: UserContext): Promise<void> {
    const messageId = pendingCAMessages.get(ctx.user.telegram_id);
    if (messageId) {
        pendingCAMessages.delete(ctx.user.telegram_id);
        try {
            await ctx.api.deleteMessage(ctx.chat!.id, messageId);
        } catch (e) {
            // Message may already be deleted
        }
    }
}

/**
 * Start custom buy flow
 */
export async function startCustomBuyFlow(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);
    if (!position) return;

    positionFlowState.set(ctx.user.telegram_id, {
        positionId,
        tokenMint: position.token_mint,
        tokenSymbol: position.token_symbol,
        mode: "buy_custom",
    });

    const tokenName = position.token_symbol || position.token_mint.slice(0, 8) + "...";

    await ctx.editMessageText(
        `🛒 <b>Custom Buy: ${tokenName}</b>\n\nEnter the amount of SOL you want to spend:\n\n<i>Example: 0.5</i>`,
        {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("❌ Cancel", `${CallbackPrefix.POSITIONS}:detail:${positionId}`),
        }
    );
}

/**
 * Start custom sell flow
 */
export async function startCustomSellFlow(ctx: UserContext, positionId: number): Promise<void> {
    const position = getPositionById(positionId);
    if (!position) return;

    positionFlowState.set(ctx.user.telegram_id, {
        positionId,
        tokenMint: position.token_mint,
        tokenSymbol: position.token_symbol,
        mode: "sell_custom",
    });

    const tokenName = position.token_symbol || position.token_mint.slice(0, 8) + "...";

    await ctx.editMessageText(
        `💸 <b>Custom Sell: ${tokenName}</b>\n\nEnter the percentage to sell (1-100):\n\n<i>Example: 25</i>`,
        {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("❌ Cancel", `${CallbackPrefix.POSITIONS}:detail:${positionId}`),
        }
    );
}

/**
 * Handle custom input for position flows
 */
export async function handlePositionInput(ctx: UserContext, inputText: string): Promise<boolean> {
    const state = positionFlowState.get(ctx.user.telegram_id);
    if (!state) return false;

    const value = parseFloat(inputText.trim());
    if (isNaN(value) || value <= 0) {
        await ctx.reply("❌ Invalid number. Please enter a positive value.");
        return true;
    }

    positionFlowState.delete(ctx.user.telegram_id);

    if (state.mode === "buy_custom") {
        await ctx.reply(`🛒 Buying ${value} SOL of ${state.tokenSymbol || state.tokenMint.slice(0, 8)}...`);

        const wallet = decryptWallet(ctx.user.encrypted_private_key);
        const settings = getSettings(ctx.user.telegram_id);

        const result = await executeBuy(
            ctx.user.telegram_id,
            ctx.user.active_wallet_id,
            state.tokenMint,
            state.tokenSymbol,
            value,
            wallet,
            settings.slippage_bps
        );

        if (result.success) {
            await ctx.reply(`✅ <b>Buy Successful!</b>\n\n🪙 Received: ${result.tokenAmount} tokens\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction</a>`, {
                parse_mode: "HTML",
            });
        } else {
            await ctx.reply(`❌ <b>Buy Failed</b>\n\n${result.error}`, { parse_mode: "HTML" });
        }

    } else if (state.mode === "sell_custom") {
        if (value > 100) {
            await ctx.reply("❌ Percentage cannot exceed 100%");
            return true;
        }

        await ctx.reply(`💸 Selling ${value}% of ${state.tokenSymbol || state.tokenMint.slice(0, 8)}...`);

        const wallet = decryptWallet(ctx.user.encrypted_private_key);
        const settings = getSettings(ctx.user.telegram_id);

        const result = await executeSellPercent(
            ctx.user.telegram_id,
            ctx.user.active_wallet_id,
            state.tokenMint,
            state.tokenSymbol,
            value,
            wallet,
            settings.slippage_bps
        );

        if (result.success) {
            const pnlStr = result.pnlPercent !== undefined
                ? `\n📊 P&L: ${result.pnlPercent >= 0 ? '+' : ''}${result.pnlPercent.toFixed(2)}%`
                : '';
            await ctx.reply(`✅ <b>Sell Successful!</b>\n\n💵 Received: ${result.solReceived?.toFixed(4)} SOL${pnlStr}\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction</a>`, {
                parse_mode: "HTML",
            });
        } else {
            await ctx.reply(`❌ <b>Sell Failed</b>\n\n${result.error}`, { parse_mode: "HTML" });
        }
    }

    // Show position detail after action
    await showPositionDetail(ctx, state.positionId);
    return true;
}

/**
 * Check if user is in position input flow
 */
export function isInPositionFlow(telegramId: number): boolean {
    return positionFlowState.has(telegramId);
}

/**
 * Clear position flow state
 */
export function clearPositionFlowState(telegramId: number): void {
    positionFlowState.delete(telegramId);
}
