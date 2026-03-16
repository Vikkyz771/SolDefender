/**
 * Buy menu - UI flows for buying tokens
 */

import { InlineKeyboard } from "grammy";
import { UserContext } from "../middleware/user.js";
import { CallbackPrefix, addNavigation } from "../keyboards/builders.js";
import { showMainMenu } from "./main.js";
import { getBuyQuote, getTokenPrice } from "../../trading/quote.js";
import { executeBuy } from "../../trading/buy.js";
import { decryptWallet, getWalletSOLBalance } from "../../utils/wallet.js";
import { getSOLPriceCached, solToUSDSync, parseAmountInput, formatSOLWithUSD } from "../../utils/solPrice.js";
import { PublicKey } from "@solana/web3.js";
import { getRecentTokens, getFavorites, toggleFavorite } from "../../database/tokens.js";
import { formatUserError } from "../../utils/errorMessages.js";
import { getBotUsername } from "../bot.js";

// State includes amount for confirm step (avoids callback data length limit)
interface BuyFlowState {
    mint: string;
    symbol: string | null;
    waitingForAmount: boolean;
    amount?: number; // SOL amount for confirmation
}

const buyFlowState = new Map<number, BuyFlowState>();

/**
 * Show buy menu (initial screen) - always as new message to preserve main menu
 */
export async function showBuyMenu(ctx: UserContext): Promise<void> {
    const keyboard = new InlineKeyboard()
        .text("⭐ Recent", `${CallbackPrefix.BUY}:recent`)
        .text("❤️ Favorites", `${CallbackPrefix.BUY}:favorites`)
        .row()
        .text("⬅️ Back", `${CallbackPrefix.BUY}:cancel`);

    const text = `🛒 <b>Buy Token</b>

Paste a contract address to buy, or choose from:`;

    // Always send as new message to keep main menu visible
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

/**
 * Show recent tokens list
 */
export async function showRecentTokens(ctx: UserContext): Promise<void> {
    const recentTokens = getRecentTokens(ctx.user.telegram_id, 10);

    if (recentTokens.length === 0) {
        const keyboard = new InlineKeyboard()
            .text("⬅️ Back", `${CallbackPrefix.MENU}:buy`)
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        await ctx.editMessageText("⭐ <b>Recent Tokens</b>\n\nNo recent tokens yet.\nPaste a CA to buy your first token!", {
            parse_mode: "HTML",
            reply_markup: keyboard,
        });
        return;
    }

    const keyboard = new InlineKeyboard();
    for (const token of recentTokens) {
        const label = token.token_symbol || `${token.token_mint.slice(0, 6)}...${token.token_mint.slice(-4)}`;
        keyboard.text(label, `${CallbackPrefix.BUY}:info:${token.token_mint}`).row();
    }
    keyboard.text("⬅️ Back", `${CallbackPrefix.MENU}:buy`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText("⭐ <b>Recent Tokens</b>\n\nTap a token to buy:", {
        parse_mode: "HTML",
        reply_markup: keyboard,
    });
}

/**
 * Show favorites list
 */
export async function showFavorites(ctx: UserContext): Promise<void> {
    const favorites = getFavorites(ctx.user.telegram_id);

    if (favorites.length === 0) {
        const keyboard = new InlineKeyboard()
            .text("⬅️ Back", `${CallbackPrefix.MENU}:buy`)
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        await ctx.editMessageText("❤️ <b>Favorites</b>\n\nNo favorite tokens yet.\nAdd tokens to favorites from the token info screen!", {
            parse_mode: "HTML",
            reply_markup: keyboard,
        });
        return;
    }

    const keyboard = new InlineKeyboard();
    for (const token of favorites) {
        const label = token.token_symbol || `${token.token_mint.slice(0, 6)}...${token.token_mint.slice(-4)}`;
        keyboard.text(`❤️ ${label}`, `${CallbackPrefix.BUY}:info:${token.token_mint}`).row();
    }
    keyboard.text("⬅️ Back", `${CallbackPrefix.MENU}:buy`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText("❤️ <b>Favorites</b>\n\nTap a token to buy:", {
        parse_mode: "HTML",
        reply_markup: keyboard,
    });
}

/**
 * Toggle favorite status for a token
 */
export async function handleToggleFavorite(ctx: UserContext, tokenMint: string, tokenSymbol?: string): Promise<void> {
    const isFav = toggleFavorite(ctx.user.telegram_id, tokenMint, tokenSymbol);
    await ctx.answerCallbackQuery(isFav ? "❤️ Added to favorites!" : "💔 Removed from favorites");
}

/**
 * Show token info with buy options
 */
export async function showBuyTokenInfo(ctx: UserContext, tokenMint: string, tokenSymbol: string | null = null): Promise<void> {
    try {
        // Store state for this user (not waiting for amount yet)
        buyFlowState.set(ctx.user.telegram_id, { mint: tokenMint, symbol: tokenSymbol, waitingForAmount: false });

        // Get user's SOL balance
        const [solBalance, solPrice] = await Promise.all([
            getWalletSOLBalance(new PublicKey(ctx.user.wallet_address)),
            getSOLPriceCached(),
        ]);

        const { quick_buy_1, quick_buy_2 } = ctx.settings;

        // Show dollar equivalents on quick buy buttons
        const usd1 = solToUSDSync(quick_buy_1);
        const usd2 = solToUSDSync(quick_buy_2);

        const keyboard = new InlineKeyboard()
            .text(`${quick_buy_1.toFixed(3)} SOL (~$${usd1.toFixed(0)})`, `${CallbackPrefix.BUY}:quick:${tokenMint}:${quick_buy_1.toFixed(4)}`)
            .text(`${quick_buy_2.toFixed(3)} SOL (~$${usd2.toFixed(0)})`, `${CallbackPrefix.BUY}:quick:${tokenMint}:${quick_buy_2.toFixed(4)}`)
            .row()
            .text("✏️ Custom Amount", `${CallbackPrefix.BUY}:custom:${tokenMint}`)
            .row()
            .text("⬅️ Back", `${CallbackPrefix.MENU}:buy`)
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        const symbol = tokenSymbol || tokenMint.slice(0, 8) + "...";
        const text = `🪙 <b>Buy ${symbol}</b>

💼 Your Balance: <code>${solBalance.toFixed(4)} SOL</code> (~$${(solBalance * solPrice).toFixed(2)})

How much SOL to spend?`;

        if (ctx.callbackQuery?.message) {
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        } else {
            await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
        }

    } catch (error) {
        console.error("Error showing token info:", error);
        await ctx.reply("❌ Error fetching token info. Please try again.");
    }
}

/**
 * Set waiting for custom amount input
 */
export function setWaitingForAmount(telegramId: number, tokenMint: string): void {
    const existing = buyFlowState.get(telegramId);
    buyFlowState.set(telegramId, {
        mint: tokenMint,
        symbol: existing?.symbol || null,
        waitingForAmount: true,
    });
}

/**
 * Show buy confirmation
 */
export async function showBuyConfirm(ctx: UserContext, tokenMint: string, solAmount: number): Promise<void> {
    try {
        const state = buyFlowState.get(ctx.user.telegram_id);
        const symbol = state?.symbol || tokenMint.slice(0, 8) + "...";

        // Store amount in state (NOT in callback - avoids 64 byte limit)
        buyFlowState.set(ctx.user.telegram_id, {
            mint: tokenMint,
            symbol: state?.symbol || null,
            waitingForAmount: false,
            amount: solAmount,
        });

        // Get quote
        const { estimatedTokens } = await getBuyQuote(tokenMint, solAmount, ctx.settings.slippage_bps);
        const solPrice = await getSOLPriceCached();

        // NOTE: Confirm callback only has mint - amount is read from state
        const keyboard = new InlineKeyboard()
            .text("✅ Confirm Buy", `${CallbackPrefix.BUY}:exec:${tokenMint}`)
            .text("❌ Cancel", `${CallbackPrefix.MENU}:main`)
            .row()
            .text("⬅️ Back", `${CallbackPrefix.BUY}:info:${tokenMint}`)
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        const text = `⚠️ <b>Confirm Buy</b>

Token: <b>${symbol}</b>
Amount: <code>${solAmount.toFixed(4)} SOL</code> (~$${(solAmount * solPrice).toFixed(2)})
Slippage: <code>${ctx.settings.slippage_bps / 100}%</code>

Estimated tokens: <code>${formatNumber(Number(estimatedTokens))}</code>

Press Confirm to execute the trade.`;

        if (ctx.callbackQuery?.message) {
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        } else {
            await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
        }

    } catch (error) {
        console.error("Error showing buy confirm:", error);
        await ctx.reply(`❌ ${formatUserError(error)}`);
    }
}

/**
 * Execute the buy
 */
export async function handleBuyConfirm(ctx: UserContext, tokenMint: string, solAmount: number): Promise<void> {
    await ctx.answerCallbackQuery({ text: "🔄 Executing buy..." });

    // Check if we're in a private chat (only show main menu in private chats)
    const isPrivateChat = ctx.chat?.type === "private";

    try {
        const state = buyFlowState.get(ctx.user.telegram_id);
        const symbol = state?.symbol || null;

        // Decrypt wallet
        const wallet = decryptWallet(ctx.user.encrypted_private_key);

        // Execute buy
        const result = await executeBuy(
            ctx.user.telegram_id,
            ctx.user.active_wallet_id,
            tokenMint,
            symbol,
            solAmount,
            wallet,
            ctx.settings.slippage_bps
        );

        if (result.success) {
            const text = `✅ <b>Buy Successful!</b>

Token: <code>${symbol || tokenMint.slice(0, 8)}...</code>
Bought: <code>${formatNumber(Number(result.tokenAmount))}</code> tokens
Spent: <code>${formatSOLWithUSD(solAmount)}</code>

🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

            // In groups, use URL buttons to redirect to bot DM
            // In private chats, use regular callback buttons
            let keyboard: InlineKeyboard;
            if (isPrivateChat) {
                keyboard = new InlineKeyboard()
                    .text("🛒 Buy More", `${CallbackPrefix.BUY}:info:${tokenMint}`)
                    .text("💸 Sell", `${CallbackPrefix.SELL}:token:${tokenMint}`)
                    .row()
                    .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);
            } else {
                // URL deeplinks for groups - redirects to bot DM
                const botName = getBotUsername();
                keyboard = new InlineKeyboard()
                    .url("🛒 Buy More", `https://t.me/${botName}?start=buy_${tokenMint}`)
                    .url("💸 Sell", `https://t.me/${botName}?start=sell_${tokenMint}`)
                    .row()
                    .url("🏠 Open Bot", `https://t.me/${botName}?start=menu`);
            }

            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });

            // Only show main menu in private chats (not in groups)
            if (isPrivateChat) {
                await showMainMenu(ctx);
            }
        } else {
            // In groups, use URL buttons for retry
            let failKeyboard: InlineKeyboard;
            if (isPrivateChat) {
                failKeyboard = new InlineKeyboard()
                    .text("🔄 Retry", `${CallbackPrefix.BUY}:info:${tokenMint}`)
                    .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);
            } else {
                const botName = getBotUsername();
                failKeyboard = new InlineKeyboard()
                    .url("🔄 Retry", `https://t.me/${botName}?start=buy_${tokenMint}`)
                    .url("🏠 Open Bot", `https://t.me/${botName}?start=menu`);
            }

            await ctx.editMessageText(`❌ <b>Buy Failed</b>\n\n${formatUserError(result.error)}`, {
                parse_mode: "HTML",
                reply_markup: failKeyboard,
            });

            // Only show main menu in private chats (not in groups)
            if (isPrivateChat) {
                await showMainMenu(ctx);
            }
        }

        // Clear state
        buyFlowState.delete(ctx.user.telegram_id);

    } catch (error) {
        console.error("Buy execution error:", error);
        await ctx.reply(`❌ ${formatUserError(error)}`);
        // Only show main menu in private chats
        if (isPrivateChat) {
            await showMainMenu(ctx);
        }
    }
}

/**
 * Handle custom amount input (called from message handler)
 * Supports both SOL amounts (0.5) and USD amounts ($20)
 */
export async function handleCustomBuyAmount(ctx: UserContext, amountText: string): Promise<boolean> {
    const state = buyFlowState.get(ctx.user.telegram_id);
    if (!state || !state.waitingForAmount) return false;

    // Parse input - handles both SOL and $USD
    const parsed = await parseAmountInput(amountText);

    if (!parsed) {
        await ctx.reply("❌ Please enter a valid amount:\n• SOL: <code>0.5</code>\n• USD: <code>$20</code>", { parse_mode: "HTML" });
        return true;
    }

    // If USD, show what it converts to
    if (parsed.isUSD) {
        await ctx.reply(`💱 $${amountText.replace("$", "")} → ${parsed.solAmount.toFixed(4)} SOL`);
    }

    await showBuyConfirm(ctx, state.mint, parsed.solAmount);
    return true;
}

/**
 * Check if user is in buy flow (waiting for amount)
 */
export function isInBuyFlow(telegramId: number): boolean {
    const state = buyFlowState.get(telegramId);
    return state?.waitingForAmount === true;
}

/**
 * Get pending buy amount from state
 */
export function getBuyAmount(telegramId: number): number | undefined {
    return buyFlowState.get(telegramId)?.amount;
}

/**
 * Clear buy flow state for a user (called when returning to main menu)
 */
export function clearBuyFlowState(telegramId: number): void {
    buyFlowState.delete(telegramId);
}

/**
 * Handle cancel/back from buy menu - clears state and deletes the message
 */
export async function handleBuyCancel(ctx: UserContext): Promise<void> {
    // Clear the buy flow state so next message isn't read as CA
    clearBuyFlowState(ctx.user.telegram_id);

    // Answer callback FIRST to stop the loading spinner
    await ctx.answerCallbackQuery({ text: "Buy cancelled" });

    // Then delete the buy menu message
    if (ctx.callbackQuery?.message) {
        try {
            await ctx.deleteMessage();
        } catch {
            // Message may already be deleted
        }
    }
}

/**
 * Format large numbers
 */
function formatNumber(n: number): string {
    if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return n.toFixed(2);
}


