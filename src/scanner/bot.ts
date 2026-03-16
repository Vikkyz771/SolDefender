import { Bot, Context } from "grammy";
import { TELEGRAM_BOT_TOKEN } from "../config.js";
import { detectContractAddress } from "./detector.js";
import { runSecurityChecks } from "./checks/index.js";
import { formatSecurityReport } from "./formatter.js";

/**
 * Init and start the Telegram scanner bot
 */
export async function startTelegramScanner(): Promise<Bot> {
    const bot = new Bot(TELEGRAM_BOT_TOKEN);

    // Handle all text messages
    bot.on("message:text", async (ctx: Context) => {
        const text = ctx.message?.text;
        if (!text) return;

        // Detect Solana contract addresses
        const addresses = detectContractAddress(text);
        if (addresses.length === 0) return;

        console.log(`🔍 Detected ${addresses.length} CA(s) in message`);

        for (const ca of addresses) {
            try {
                console.log(`📋 Analyzing: ${ca}`);

                // Run security checks
                const result = await runSecurityChecks(ca);

                // Format and send report
                const report = await formatSecurityReport(ca, result);
                await ctx.reply(report, { parse_mode: "HTML" });

            } catch (error) {
                console.error(`❌ Error analyzing ${ca}:`, error);
                await ctx.reply(`❌ Error analyzing ${ca.slice(0, 8)}...`);
            }
        }
    });

    // Start bot
    console.log("🤖 Telegram scanner starting...");
    bot.start();

    return bot;
}
