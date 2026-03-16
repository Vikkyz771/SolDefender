import { startTradingBot } from "./telegram/bot.js";
import { initNotifications } from "./telegram/notifications.js";
import { startMonitor } from "./autosell/index.js";
import { closeDatabase } from "./database/index.js";
import { stopTPSLMonitor } from "./tpsl/monitor.js";
import { cleanupOrphanedRules, cleanupTriggeredRules } from "./database/tpsl.js";
import { initJupiterUltra } from "./utils/jupiterUltra.js";


// =============================================================================
// Suppress noisy rate limit warnings from @solana/web3.js (handled by retry)
// =============================================================================
const originalWarn = console.warn;
const originalLog = console.log;

console.warn = (...args: unknown[]) => {
    const msg = String(args[0] || "");
    if (msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("Server responded")) return;
    originalWarn.apply(console, args);
};

console.log = (...args: unknown[]) => {
    const msg = String(args[0] || "");
    if (msg.includes("429") || msg.includes("Retrying after") || msg.includes("Server responded")) return;
    originalLog.apply(console, args);
};

async function main() {
    console.log("🚀 SolDefender Trading Bot starting...");

    // Initialize Jupiter Ultra API keys
    initJupiterUltra();

    // Start the unified Telegram trading bot (initializes database)
    const bot = await startTradingBot();

    // Initialize notification system
    initNotifications(bot);

    // Clean up any orphaned TP/SL rules from past sessions
    cleanupOrphanedRules();
    cleanupTriggeredRules();

    // Start multi-user auto-sell monitor (monitors all registered users)
    await startMonitor();

    console.log("✅ Bot initialized successfully");

    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log("\n🛑 Shutting down...");
        stopTPSLMonitor();
        closeDatabase();
        process.exit(0);
    });

    process.on("SIGTERM", () => {
        console.log("\n🛑 Shutting down...");
        stopTPSLMonitor();
        closeDatabase();
        process.exit(0);
    });
}

main().catch(console.error);
