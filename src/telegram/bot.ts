/**
 * Main Telegram bot initialization
 * Unified bot for trading + scanning
 */

import { Bot, InlineKeyboard } from "grammy";
import { TELEGRAM_BOT_TOKEN } from "../config.js";
import { initDatabase } from "../database/index.js";
import { userMiddleware, UserContext } from "./middleware/user.js";
import { handleCallback } from "./handlers/callbacks.js";
import { showMainMenu, showMainMenuFast, handleStart } from "./menus/main.js";
import { showBuyTokenInfo, handleCustomBuyAmount, isInBuyFlow } from "./menus/buy.js";
import { handleCustomSellInput, isInSellFlow } from "./menus/sell.js";
import { handleTPSLInput, isInTPSLFlow } from "./menus/tpsl.js";
import { handlePositionInput, isInPositionFlow } from "./menus/positions.js";
import { handleWalletInput, isInWalletFlow } from "./menus/wallet.js";
import { handleSettingsInput, isInSettingsFlow } from "./menus/settings.js";
import { handleInstantInput, isInInstantFlow } from "./menus/instant.js";
import { detectContractAddress } from "../scanner/detector.js";
import { runSecurityChecks } from "../scanner/checks/index.js";
import { formatSecurityReport } from "../scanner/formatter.js";
import { CallbackPrefix } from "./keyboards/builders.js";
import { startPriceRefresh, solToUSDSync } from "../utils/solPrice.js";
import { startTPSLMonitor } from "../tpsl/monitor.js";

/**
 * Create and configure the trading bot
 */
export function createTradingBot(): Bot<UserContext> {
    // Initialize database first
    initDatabase();

    // Start real-time SOL price tracking
    startPriceRefresh();

    // Create bot instance
    const bot = new Bot<UserContext>(TELEGRAM_BOT_TOKEN);

    // Apply user middleware (auto-creates users with wallets)
    bot.use(userMiddleware());

    // Handle /start command
    bot.command("start", async (ctx) => {
        await handleStart(ctx);
    });

    // Handle /menu command (show main menu)
    bot.command("menu", async (ctx) => {
        await showMainMenu(ctx);
    });

    // Handle /clear command (clear ALL bot messages and send fresh main menu)
    bot.command("clear", async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const currentMsgId = ctx.message?.message_id || 0;
        const userId = ctx.user.telegram_id;

        // Delete the /clear command message immediately
        ctx.deleteMessage().catch(() => { });

        // Send fresh main menu with full data (balance, positions)
        await showMainMenu(ctx);

        // Fire all delete requests in background (don't await - fire and forget)
        // This ensures the menu appears instantly while cleanup happens async
        (async () => {
            let deletedCount = 0;
            // Delete in batches to avoid overwhelming the API
            for (let i = currentMsgId - 1; i > 0; i--) {
                ctx.api.deleteMessage(chatId, i).then(() => deletedCount++).catch(() => { });
            }
            // Log after a delay to show rough count
            setTimeout(() => {
                console.log(`🧹 /clear: Cleaned up ~${deletedCount} messages for user ${userId}`);
            }, 2000);
        })();
    });

    // Handle all callback queries (button presses)
    bot.on("callback_query:data", async (ctx) => {
        await handleCallback(ctx);
    });

    // Handle text messages (CA detection + custom inputs)
    bot.on("message:text", async (ctx) => {
        const text = ctx.message?.text?.trim();
        if (!text) return;

        // Skip commands
        if (text.startsWith("/")) return;

        // Check if user is in a buy flow waiting for custom amount
        if (isInBuyFlow(ctx.user.telegram_id)) {
            const handled = await handleCustomBuyAmount(ctx, text);
            if (handled) return;
        }

        // Check if user is in a sell flow waiting for custom input
        if (isInSellFlow(ctx.user.telegram_id)) {
            const handled = await handleCustomSellInput(ctx, text);
            if (handled) return;
        }

        // Check if user is in a TP/SL flow waiting for input
        if (isInTPSLFlow(ctx.user.telegram_id)) {
            const handled = await handleTPSLInput(ctx, text);
            if (handled) return;
        }

        // Check if user is in a position flow waiting for input
        if (isInPositionFlow(ctx.user.telegram_id)) {
            const handled = await handlePositionInput(ctx, text);
            if (handled) return;
        }

        // Check if user is in a wallet flow waiting for input
        if (isInWalletFlow(ctx.user.telegram_id)) {
            const handled = await handleWalletInput(ctx, text);
            if (handled) return;
        }

        // Check if user is in a settings flow waiting for input
        if (isInSettingsFlow(ctx.user.telegram_id)) {
            const handled = await handleSettingsInput(ctx, text);
            if (handled) return;
        }

        // Check if user is in an instant buy flow waiting for input
        if (isInInstantFlow(ctx.user.telegram_id)) {
            const handled = await handleInstantInput(ctx, text);
            if (handled) return;
        }

        // Detect Solana contract addresses
        const addresses = detectContractAddress(text);
        if (addresses.length === 0) return;

        console.log(`🔍 Detected ${addresses.length} CA(s) in message from user ${ctx.user.telegram_id}`);

        // Check if instant buy is enabled
        const instantBuyEnabled = ctx.settings.instant_buy_enabled;

        for (const ca of addresses) {
            try {
                console.log(`📋 Analyzing: ${ca}`);

                // Run security checks
                const result = await runSecurityChecks(ca);

                // Format security report
                const report = await formatSecurityReport(ca, result);

                // Build keyboard with buy buttons and navigation
                const { quick_buy_1, quick_buy_2 } = ctx.settings;
                const usd1 = solToUSDSync(quick_buy_1);
                const usd2 = solToUSDSync(quick_buy_2);

                const keyboard = new InlineKeyboard()
                    .text(`🛒 ${quick_buy_1.toFixed(3)} SOL (~$${usd1.toFixed(0)})`, `${CallbackPrefix.BUY}:quick:${ca}:${quick_buy_1.toFixed(4)}`)
                    .text(`🛒 ${quick_buy_2.toFixed(3)} SOL (~$${usd2.toFixed(0)})`, `${CallbackPrefix.BUY}:quick:${ca}:${quick_buy_2.toFixed(4)}`)
                    .row()
                    .text("🛒 Custom Buy", `${CallbackPrefix.BUY}:info:${ca}`)
                    .row()
                    .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

                await ctx.reply(report, {
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });

                // If instant buy enabled, show confirmation instead
                if (instantBuyEnabled) {
                    console.log(`⚡ Instant buy mode for user ${ctx.user.telegram_id}`);
                    // Show buy confirmation with instant buy amount
                    const { showBuyConfirm } = await import("./menus/buy.js");
                    await showBuyConfirm(ctx, ca, ctx.settings.instant_buy_amount);
                }

            } catch (error) {
                console.error(`❌ Error analyzing ${ca}:`, error);

                // Even on error, show navigation buttons
                const keyboard = new InlineKeyboard()
                    .text("🛒 Try Buy Anyway", `${CallbackPrefix.BUY}:info:${ca}`)
                    .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

                await ctx.reply(`❌ Error analyzing ${ca.slice(0, 8)}...`, {
                    reply_markup: keyboard
                });
            }
        }
    });

    // Error handler
    bot.catch((err) => {
        console.error("Bot error:", err);
    });

    return bot;
}

/**
 * Bot username for deeplinks (set on startup)
 */
let botUsername: string = "";

/**
 * Get bot username for deeplink URLs
 */
export function getBotUsername(): string {
    return botUsername;
}

/**
 * Start the trading bot
 */
export async function startTradingBot(): Promise<Bot<UserContext>> {
    const bot = createTradingBot();

    // Get bot info for deeplinks
    const me = await bot.api.getMe();
    botUsername = me.username || "";
    console.log(`🤖 Bot username: @${botUsername}`);

    // Register bot commands with Telegram (shows in auto-suggest menu when typing /)
    await bot.api.setMyCommands([
        { command: "start", description: "Start the bot" },
        { command: "menu", description: "Show main menu" },
        { command: "clear", description: "Clear chat and start fresh" },
    ]);

    console.log("🤖 Trading bot starting...");
    bot.start();

    // Start TP/SL monitor with bot instance for notifications
    startTPSLMonitor(bot);

    return bot;
}

