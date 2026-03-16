/**
 * Main menu display and handling
 */

import { Context } from "grammy";
import { UserContext } from "../middleware/user.js";
import { buildMainMenuKeyboard } from "../keyboards/builders.js";
import { getWalletSOLBalance } from "../../utils/wallet.js";
import { formatSOLWithUSD } from "../../utils/solPrice.js";
import { PublicKey } from "@solana/web3.js";

// Track last main menu message ID per user for cleanup
const lastMainMenuMessageId = new Map<number, number>();

/**
 * Get last main menu message ID for a user
 */
export function getLastMainMenuMessageId(telegramId: number): number | undefined {
    return lastMainMenuMessageId.get(telegramId);
}

/**
 * Clear tracked main menu message ID
 */
export function clearLastMainMenuMessageId(telegramId: number): void {
    lastMainMenuMessageId.delete(telegramId);
}


/**
 * Build main menu message text
 * @param skipRpc - If true, skip RPC calls for instant response
 */
async function buildMainMenuText(ctx: UserContext, skipRpc: boolean = false): Promise<string> {
    let solBalance = 0;
    let positionCount = 0;

    // If skipRpc, just get cached/fast data
    if (!skipRpc) {
        try {
            const walletPubkey = new PublicKey(ctx.user.wallet_address);

            // Get SOL balance and token holdings
            const { getWalletTokenHoldings } = await import("../../utils/wallet.js");
            const [balance, holdings] = await Promise.all([
                getWalletSOLBalance(walletPubkey),
                getWalletTokenHoldings(walletPubkey),
            ]);
            solBalance = balance;

            // Sync positions with actual wallet holdings (cleanup stale + add missing)
            const { syncPositionsWithWallet, getPositionsByWallet } = await import("../../database/positions.js");

            // Convert holdings to the expected format
            const walletHoldings = holdings.map(h => ({
                mint: h.mint.toBase58(),
                balance: h.balance,
                decimals: h.decimals,
            }));
            await syncPositionsWithWallet(ctx.user.telegram_id, ctx.user.active_wallet_id, walletHoldings);

            // Get accurate position count for this wallet after sync
            const positions = getPositionsByWallet(ctx.user.active_wallet_id);
            positionCount = positions.length;
        } catch (error) {
            console.error("Error fetching balance:", error);
        }
    } else {
        // Fast mode - just get position count from DB (no RPC)
        const { getPositionsByWallet } = await import("../../database/positions.js");
        positionCount = getPositionsByWallet(ctx.user.active_wallet_id).length;
    }

    // Build status indicators
    const walletName = ctx.user.active_wallet_name || "Main Wallet";
    const instantBuyOn = ctx.settings.instant_buy_enabled;

    let statusLine = `💳 Active: <b>${walletName}</b> ✅`;
    if (instantBuyOn) {
        statusLine += `\n⚡ <b>INSTANT BUY ON</b>`;
    }

    return `🚀 <b>SolDefender Bot</b>

${statusLine}

💰 Balance: <code>${formatSOLWithUSD(solBalance)}</code>
📊 Active Positions: ${positionCount}

━━━━━━━━━━━━━━━━━━━━━━━

Select an option below:`;
}

/**
 * Show main menu (edit existing message or send new)
 */
export async function showMainMenu(ctx: UserContext, editMessage: boolean = false): Promise<void> {
    const text = await buildMainMenuText(ctx);
    const keyboard = buildMainMenuKeyboard();

    if (editMessage && ctx.callbackQuery?.message) {
        try {
            await ctx.editMessageText(text, {
                parse_mode: "HTML",
                reply_markup: keyboard,
            });
            // Track this message as the main menu
            lastMainMenuMessageId.set(ctx.user.telegram_id, ctx.callbackQuery.message.message_id);
        } catch (error) {
            // Message might not have changed, ignore
        }
    } else {
        const sent = await ctx.reply(text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
        });
        // Track this message as the main menu
        lastMainMenuMessageId.set(ctx.user.telegram_id, sent.message_id);
    }
}

/**
 * Show main menu FAST (skips RPC calls for instant response)
 * Use this when you need to show the menu immediately (e.g., after /clear)
 */
export async function showMainMenuFast(ctx: UserContext): Promise<void> {
    const text = await buildMainMenuText(ctx, true); // skipRpc = true
    const keyboard = buildMainMenuKeyboard();

    const sent = await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
    });
    lastMainMenuMessageId.set(ctx.user.telegram_id, sent.message_id);
}

/**
 * Handle /start command
 * Supports deeplinks: /start buy_MINT, /start sell_MINT, /start menu
 */
export async function handleStart(ctx: UserContext): Promise<void> {
    // Check for deeplink parameters (from group URL buttons)
    const startPayload = ctx.message?.text?.split(" ")[1];

    if (startPayload) {
        // Handle deeplink routing
        if (startPayload === "menu") {
            await showMainMenu(ctx);
            return;
        }

        if (startPayload.startsWith("buy_")) {
            const tokenMint = startPayload.replace("buy_", "");
            if (tokenMint) {
                const { showBuyTokenInfo } = await import("./buy.js");
                await showBuyTokenInfo(ctx, tokenMint);
                return;
            }
        }

        if (startPayload.startsWith("sell_")) {
            const tokenMint = startPayload.replace("sell_", "");
            if (tokenMint) {
                const { showSellToken } = await import("./sell.js");
                await showSellToken(ctx, tokenMint);
                return;
            }
        }
    }

    // Regular /start - check if new user
    const isNewUser = Date.now() - ctx.user.created_at < 5000; // Created within last 5 seconds

    if (isNewUser) {
        const welcomeText = `🎉 <b>Welcome to SolDefender Bot!</b>

A new wallet has been created for you:
<code>${ctx.user.wallet_address}</code>

📥 <b>To get started:</b>
1. Deposit SOL to your wallet address above
2. Use the menu below to start trading

⚠️ <b>Important:</b> This is a hot wallet. Only deposit what you're willing to trade with.`;

        await ctx.reply(welcomeText, { parse_mode: "HTML" });
    }

    // Show main menu
    await showMainMenu(ctx);
}

/**
 * Handle main menu refresh
 */
export async function handleRefresh(ctx: UserContext): Promise<void> {
    await ctx.answerCallbackQuery({ text: "🔄 Refreshing..." });
    await showMainMenu(ctx, true);
}
