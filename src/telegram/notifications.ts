/**
 * Telegram Notifications - Send messages to users about trading events
 */

import { Bot } from "grammy";
import { formatSOLWithUSD, solToUSDSync } from "../utils/solPrice.js";
import { UserContext } from "./middleware/user.js";

// Store bot instance for sending notifications
let botInstance: Bot<UserContext> | null = null;

/**
 * Initialize notifications with bot instance
 */
export function initNotifications(bot: Bot<UserContext>): void {
    botInstance = bot;
    console.log("📢 Notification system initialized");
}

/**
 * Send a notification message to a user
 * Exported as sendUserNotification for external modules (autosell monitor, etc.)
 */
export async function sendUserNotification(telegramId: number, message: string): Promise<boolean> {
    if (!botInstance) {
        console.error("❌ Notification system not initialized");
        return false;
    }

    try {
        await botInstance.api.sendMessage(telegramId, message, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
        });
        return true;
    } catch (error) {
        console.error(`❌ Failed to send notification to ${telegramId}:`, error);
        return false;
    }
}

// Alias for internal use
const sendNotification = sendUserNotification;

// ============================================================================
// Trading Notifications
// ============================================================================

/**
 * Notify user of completed buy
 */
export async function notifyBuyComplete(
    telegramId: number,
    tokenSymbol: string,
    tokenMint: string,
    solAmount: number,
    tokenAmount: string,
    signature: string
): Promise<void> {
    const shortMint = `${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)}`;
    const solanaFmLink = `https://solana.fm/tx/${signature}`;

    const message = `✅ <b>Buy Completed</b>

🪙 Token: <b>${tokenSymbol || "Unknown"}</b>
📍 Address: <code>${shortMint}</code>

💰 Spent: <b>${formatSOLWithUSD(solAmount)}</b>
📊 Received: <code>${tokenAmount}</code> tokens

<a href="${solanaFmLink}">View on Solana.fm</a>`;

    await sendNotification(telegramId, message);
}

/**
 * Notify user of completed sell
 */
export async function notifySellComplete(
    telegramId: number,
    tokenSymbol: string,
    tokenMint: string,
    solReceived: number,
    pnlPercent: number | null,
    signature: string
): Promise<void> {
    const shortMint = `${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)}`;
    const solanaFmLink = `https://solana.fm/tx/${signature}`;

    let pnlEmoji = "📊";
    let pnlText = "";
    if (pnlPercent !== null) {
        if (pnlPercent > 0) {
            pnlEmoji = "📈";
            pnlText = `\n🎯 P&L: <b>+${pnlPercent.toFixed(1)}%</b> ✅`;
        } else {
            pnlEmoji = "📉";
            pnlText = `\n🎯 P&L: <b>${pnlPercent.toFixed(1)}%</b> ❌`;
        }
    }

    const message = `${pnlEmoji} <b>Sell Completed</b>

🪙 Token: <b>${tokenSymbol || "Unknown"}</b>
📍 Address: <code>${shortMint}</code>

💰 Received: <b>${formatSOLWithUSD(solReceived)}</b>${pnlText}

<a href="${solanaFmLink}">View on Solana.fm</a>`;

    await sendNotification(telegramId, message);
}

/**
 * Notify user of TP/SL trigger
 */
export async function notifyTPSLTriggered(
    telegramId: number,
    tokenSymbol: string,
    tokenMint: string,
    type: "TP" | "SL" | "TRAILING_SL",
    pnlPercent: number,
    solReceived: number,
    signature: string
): Promise<void> {
    const shortMint = `${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)}`;
    const solanaFmLink = `https://solana.fm/tx/${signature}`;

    let emoji = "";
    let typeName = "";
    switch (type) {
        case "TP":
            emoji = "🎯";
            typeName = "Take Profit";
            break;
        case "SL":
            emoji = "🛑";
            typeName = "Stop Loss";
            break;
        case "TRAILING_SL":
            emoji = "⏸️";
            typeName = "Trailing Stop";
            break;
    }

    const pnlEmoji = pnlPercent >= 0 ? "✅" : "❌";
    const pnlSign = pnlPercent >= 0 ? "+" : "";

    const message = `${emoji} <b>${typeName} Triggered!</b>

🪙 Token: <b>${tokenSymbol || "Unknown"}</b>
📍 Address: <code>${shortMint}</code>

💰 Received: <b>${formatSOLWithUSD(solReceived)}</b>
🎯 P&L: <b>${pnlSign}${pnlPercent.toFixed(1)}%</b> ${pnlEmoji}

<a href="${solanaFmLink}">View on Solana.fm</a>`;

    await sendNotification(telegramId, message);
}

/**
 * Notify user of auto-sell (bonding curve protection)
 */
export async function notifyAutoSell(
    telegramId: number,
    tokenSymbol: string,
    tokenMint: string,
    bondingProgress: number,
    solReceived: number,
    signature: string
): Promise<void> {
    const shortMint = `${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)}`;
    const solanaFmLink = `https://solana.fm/tx/${signature}`;

    const message = `⚠️ <b>Auto-Sell Triggered!</b>

🪙 Token: <b>${tokenSymbol || "Unknown"}</b>
📍 Address: <code>${shortMint}</code>

📊 Bonding curve reached <b>${bondingProgress.toFixed(0)}%</b>
🛡️ <i>Graduated rug protection activated</i>

💰 Received: <b>${formatSOLWithUSD(solReceived)}</b>

<a href="${solanaFmLink}">View on Solana.fm</a>`;

    await sendNotification(telegramId, message);
}

/**
 * Notify user of an error
 */
export async function notifyError(
    telegramId: number,
    action: string,
    errorMessage: string
): Promise<void> {
    const message = `❌ <b>Error: ${action}</b>

${errorMessage}

<i>Please try again or contact support.</i>`;

    await sendNotification(telegramId, message);
}

/**
 * Notify user of instant buy execution
 */
export async function notifyInstantBuy(
    telegramId: number,
    tokenSymbol: string,
    tokenMint: string,
    solAmount: number,
    status: "pending" | "success" | "failed",
    signature?: string,
    error?: string
): Promise<void> {
    const shortMint = `${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)}`;

    if (status === "pending") {
        const message = `⚡ <b>Instant Buy Initiated</b>

🪙 Token: <code>${shortMint}</code>
💰 Amount: <b>${formatSOLWithUSD(solAmount)}</b>

⏳ <i>Processing...</i>`;

        await sendNotification(telegramId, message);
    } else if (status === "success" && signature) {
        await notifyBuyComplete(telegramId, tokenSymbol, tokenMint, solAmount, "...", signature);
    } else if (status === "failed") {
        const message = `❌ <b>Instant Buy Failed</b>

🪙 Token: <code>${shortMint}</code>
💰 Amount: <b>${formatSOLWithUSD(solAmount)}</b>

Error: ${error || "Unknown error"}`;

        await sendNotification(telegramId, message);
    }
}
