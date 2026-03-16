/**
 * Sell menu - UI flows for selling tokens
 */

import { InlineKeyboard } from "grammy";
import { UserContext } from "../middleware/user.js";
import { CallbackPrefix } from "../keyboards/builders.js";
import { showMainMenu } from "./main.js";
import { getPositionsByWallet, Position } from "../../database/positions.js";
import { getTokenPrice, getTokenPrices, getSellQuote } from "../../trading/quote.js";
import { executeSellPercent, executeSellExact, closeAllPositions } from "../../trading/sell.js";
import { decryptWallet, getWalletTokenHoldings } from "../../utils/wallet.js";
import { getSOLPriceSync, solToUSDSync, formatSOLWithUSD } from "../../utils/solPrice.js";
import { PublicKey } from "@solana/web3.js";
import { formatUserError } from "../../utils/errorMessages.js";

// Sell flow state with waiting flag
interface SellFlowState {
    mint: string;
    symbol: string | null;
    mode: "percent" | "exact";
    waitingForInput: boolean; // True only when expecting user text input
}

const sellFlowState = new Map<number, SellFlowState>();

/**
 * Show sell menu (list holdings)
 */
export async function showSellMenu(ctx: UserContext): Promise<void> {
    try {
        // Get user's token holdings
        const holdings = await getWalletTokenHoldings(new PublicKey(ctx.user.wallet_address));

        if (holdings.length === 0) {
            const keyboard = new InlineKeyboard()
                .text("🛒 Buy Tokens", `${CallbackPrefix.MENU}:buy`)
                .row()
                .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

            await ctx.editMessageText("💸 <b>Sell Token</b>\n\nYou don't have any tokens to sell.", {
                parse_mode: "HTML",
                reply_markup: keyboard,
            });
            return;
        }

        // Get positions for this wallet
        const positions = getPositionsByWallet(ctx.user.active_wallet_id);
        const positionMap = new Map(positions.map(p => [p.token_mint, p]));
        const mints = holdings.map(h => h.mint.toBase58());
        const prices = await getTokenPrices(mints);

        // Build holdings list
        let holdingsText = "";
        const keyboard = new InlineKeyboard();

        for (let i = 0; i < Math.min(holdings.length, 10); i++) {
            const holding = holdings[i];
            const mint = holding.mint.toBase58();
            const position = positionMap.get(mint);
            const price = prices.get(mint);

            const symbol = position?.token_symbol || mint.slice(0, 6) + "...";
            const balance = formatTokenAmount(holding.balance, holding.decimals);

            holdingsText += `${i + 1}️⃣ <b>${symbol}</b> — ${balance}\n`;
            keyboard.text(`${i + 1}️⃣ ${symbol}`, `${CallbackPrefix.SELL}:token:${mint}`);

            if ((i + 1) % 2 === 0) keyboard.row();
        }

        keyboard.row();
        keyboard.text("❌ Close All Positions", `${CallbackPrefix.SELL}:closeall`);
        keyboard.row();
        keyboard.text("⬅️ Back", `${CallbackPrefix.MENU}:main`);
        keyboard.text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        const text = `💸 <b>Sell Token</b>

Your Holdings:

${holdingsText}
Select a token to sell:`;

        if (ctx.callbackQuery?.message) {
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        } else {
            await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
        }

    } catch (error) {
        console.error("Error showing sell menu:", error);
        await ctx.reply("❌ Error loading holdings. Please try again.");
    }
}

/**
 * Show sell options for a specific token
 */
export async function showSellToken(ctx: UserContext, tokenMint: string): Promise<void> {
    try {
        // Get token balance
        const holdings = await getWalletTokenHoldings(new PublicKey(ctx.user.wallet_address));
        const holding = holdings.find(h => h.mint.toBase58() === tokenMint);

        if (!holding) {
            await ctx.answerCallbackQuery({ text: "Token not found in wallet" });
            return;
        }

        // Get position for this wallet
        const positions = getPositionsByWallet(ctx.user.active_wallet_id);
        const position = positions.find(p => p.token_mint === tokenMint);
        const price = await getTokenPrice(tokenMint);
        const solPrice = getSOLPriceSync();

        const symbol = position?.token_symbol || tokenMint.slice(0, 8) + "...";
        const balance = formatTokenAmount(holding.balance, holding.decimals);
        const valueSOL = price.priceSOL * Number(holding.balance) / Math.pow(10, holding.decimals);
        const valueUSD = solToUSDSync(valueSOL);

        // Store state (NOT waiting for input yet - only after clicking custom button)
        sellFlowState.set(ctx.user.telegram_id, { mint: tokenMint, symbol, mode: "percent", waitingForInput: false });

        const { quick_sell_1, quick_sell_2 } = ctx.settings;

        const keyboard = new InlineKeyboard()
            .text(`${quick_sell_1}%`, `${CallbackPrefix.SELL}:pct:${tokenMint}:${quick_sell_1}`)
            .text(`${quick_sell_2}%`, `${CallbackPrefix.SELL}:pct:${tokenMint}:${quick_sell_2}`)
            .text("75%", `${CallbackPrefix.SELL}:pct:${tokenMint}:75`)
            .text("100%", `${CallbackPrefix.SELL}:pct:${tokenMint}:100`)
            .row()
            .text("✏️ Custom %", `${CallbackPrefix.SELL}:custompct:${tokenMint}`)
            .text("🔢 Exact Amount", `${CallbackPrefix.SELL}:customexact:${tokenMint}`)
            .row()
            .text("⬅️ Back", `${CallbackPrefix.MENU}:sell`)
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        const text = `💸 <b>Sell ${symbol}</b>

Balance: <code>${balance}</code> tokens
Value: <code>~${valueSOL.toFixed(4)} SOL</code> (~$${valueUSD.toFixed(2)})

Select amount to sell:`;

        if (ctx.callbackQuery?.message) {
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
        } else {
            await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
        }

    } catch (error) {
        console.error("Error showing sell token:", error);
        await ctx.reply("❌ Error loading token info.");
    }
}

/**
 * Execute sell by percentage
 */
export async function handleSellPercent(ctx: UserContext, tokenMint: string, percent: number): Promise<void> {
    // Only answer callback if this was triggered by a callback (not text input)
    if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: `🔄 Selling ${percent}%...` });
    } else {
        await ctx.reply(`🔄 Selling ${percent}%...`);
    }

    try {
        const state = sellFlowState.get(ctx.user.telegram_id);
        const symbol = state?.symbol || null;

        const wallet = decryptWallet(ctx.user.encrypted_private_key);

        const result = await executeSellPercent(
            ctx.user.telegram_id,
            ctx.user.active_wallet_id,
            tokenMint,
            symbol,
            percent,
            wallet,
            ctx.settings.slippage_bps
        );

        if (result.success) {
            const pnlStr = result.pnlPercent !== undefined
                ? (result.pnlPercent >= 0 ? `+${result.pnlPercent.toFixed(1)}%` : `${result.pnlPercent.toFixed(1)}%`)
                : "";

            const solReceived = result.solReceived || 0;
            const text = `✅ <b>Sell Successful!</b>

Token: <code>${symbol || tokenMint.slice(0, 8)}...</code>
Sold: <code>${percent}%</code> of holdings
Received: <code>${formatSOLWithUSD(solReceived)}</code>
${pnlStr ? `P&L: <code>${pnlStr}</code>` : ""}

🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

            const keyboard = new InlineKeyboard()
                .text("💸 Sell More", `${CallbackPrefix.SELL}:token:${tokenMint}`)
                .text("🛒 Buy More", `${CallbackPrefix.BUY}:info:${tokenMint}`)
                .row()
                .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

            // Use reply for text input, editMessageText for callback
            if (ctx.callbackQuery?.message) {
                try {
                    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
                } catch {
                    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
                }
            } else {
                await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
            }

            // Send full main menu for quick navigation
            await showMainMenu(ctx);
        } else {
            // Show error - send as reply (don't edit the menu so user can retry)
            await ctx.reply(`❌ <b>Sell Failed</b>\n\n${formatUserError(result.error)}`, {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard()
                    .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`)
            });
        }

        sellFlowState.delete(ctx.user.telegram_id);

    } catch (error) {
        console.error("Sell execution error:", error);
        await ctx.reply(`❌ ${formatUserError(error)}`, {
            reply_markup: new InlineKeyboard().text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`)
        });
    }
}

/**
 * Handle close all positions
 */
export async function handleCloseAll(ctx: UserContext): Promise<void> {
    await ctx.answerCallbackQuery({ text: "🔄 Closing all positions..." });

    try {
        const wallet = decryptWallet(ctx.user.encrypted_private_key);
        const { successes, failures, rentRecovered } = await closeAllPositions(
            ctx.user.telegram_id,
            ctx.user.active_wallet_id,
            wallet,
            ctx.settings.slippage_bps
        );

        const rentText = rentRecovered > 0
            ? `\n💰 Rent Recovered: <code>${rentRecovered.toFixed(4)} SOL</code>`
            : "";

        const text = `✅ <b>Close All Complete</b>

Successfully sold: ${successes} tokens
Failed: ${failures} tokens${rentText}`;

        const keyboard = new InlineKeyboard()
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });

        // Send full main menu for quick navigation
        await showMainMenu(ctx);

    } catch (error) {
        console.error("Close all error:", error);
        await ctx.reply("❌ Error closing positions.");
        await showMainMenu(ctx);
    }
}

/**
 * Set custom sell mode
 */
export function setCustomSellMode(telegramId: number, mint: string, mode: "percent" | "exact"): void {
    const existing = sellFlowState.get(telegramId);
    sellFlowState.set(telegramId, { mint, symbol: existing?.symbol || null, mode, waitingForInput: true });
    console.log(`📝 Sell flow: waiting for ${mode} input for ${mint.slice(0, 8)}...`);
}

/**
 * Handle custom sell input
 */
export async function handleCustomSellInput(ctx: UserContext, inputText: string): Promise<boolean> {
    const state = sellFlowState.get(ctx.user.telegram_id);
    if (!state) return false;

    const value = parseFloat(inputText);
    if (isNaN(value) || value <= 0) {
        await ctx.reply("❌ Please enter a valid number");
        return true;
    }

    if (state.mode === "percent") {
        if (value > 100) {
            await ctx.reply("❌ Percentage cannot exceed 100%");
            return true;
        }
        await handleSellPercent(ctx, state.mint, value);
    } else {
        // Exact amount - convert to bigint and sell
        const wallet = decryptWallet(ctx.user.encrypted_private_key);
        const holdings = await getWalletTokenHoldings(wallet.publicKey);
        const holding = holdings.find(h => h.mint.toBase58() === state.mint);

        if (!holding) {
            await ctx.reply("❌ Token not found in wallet");
            return true;
        }

        const tokenAmount = BigInt(Math.floor(value * Math.pow(10, holding.decimals)));
        const result = await executeSellExact(
            ctx.user.telegram_id,
            ctx.user.active_wallet_id,
            state.mint,
            state.symbol,
            tokenAmount,
            wallet,
            ctx.settings.slippage_bps
        );

        if (result.success) {
            await ctx.reply(`✅ Sold ${value} tokens for ~${result.solReceived?.toFixed(4)} SOL`);
        } else {
            await ctx.reply(`❌ ${formatUserError(result.error)}`);
        }

        // Send full main menu for quick navigation
        await showMainMenu(ctx);
    }

    sellFlowState.delete(ctx.user.telegram_id);
    return true;
}

/**
 * Check if user is in sell flow waiting for input
 */
export function isInSellFlow(telegramId: number): boolean {
    const state = sellFlowState.get(telegramId);
    return state?.waitingForInput === true;
}

/**
 * Clear sell flow state for a user (called when returning to main menu)
 */
export function clearSellFlowState(telegramId: number): void {
    sellFlowState.delete(telegramId);
}

/**
 * Format token amount with decimals
 */
function formatTokenAmount(amount: bigint, decimals: number): string {
    const divisor = Math.pow(10, decimals);
    const value = Number(amount) / divisor;

    if (value >= 1e12) return (value / 1e12).toFixed(2) + "T";
    if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
    if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
    if (value >= 1e3) return (value / 1e3).toFixed(2) + "K";
    return value.toFixed(2);
}
