/**
 * History Menu - Transaction history view with daily grouping
 */

import { InlineKeyboard } from "grammy";
import { UserContext } from "../middleware/user.js";
import { CallbackPrefix } from "../keyboards/builders.js";
import { getTransactionsByWallet, Transaction } from "../../database/transactions.js";
import { getSOLPriceSync } from "../../utils/solPrice.js";

// Constants
const TRANSACTIONS_PER_PAGE = 10;
const MAX_TRANSACTIONS = 50;

/**
 * Group transactions by date
 */
interface DayGroup {
    dateLabel: string;
    transactions: Transaction[];
    netSOL: number;
}

function groupTransactionsByDay(transactions: Transaction[]): DayGroup[] {
    const groups = new Map<string, DayGroup>();

    for (const tx of transactions) {
        const date = new Date(tx.timestamp);
        const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD

        // Format date label
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        let dateLabel: string;
        if (dateKey === today.toISOString().split('T')[0]) {
            dateLabel = "Today";
        } else if (dateKey === yesterday.toISOString().split('T')[0]) {
            dateLabel = "Yesterday";
        } else {
            dateLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }

        if (!groups.has(dateKey)) {
            groups.set(dateKey, {
                dateLabel,
                transactions: [],
                netSOL: 0,
            });
        }

        const group = groups.get(dateKey)!;
        group.transactions.push(tx);

        // Calculate net SOL (sells add, buys subtract)
        if (tx.type === "SELL") {
            group.netSOL += tx.sol_amount;
        } else {
            group.netSOL -= tx.sol_amount;
        }
    }

    // Sort by date (newest first) and return as array
    return Array.from(groups.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([_, group]) => group);
}

/**
 * Format a single transaction for display
 */
function formatTransaction(tx: Transaction): string {
    const emoji = tx.type === "BUY" ? "🟢" : "🔴";
    const tokenName = tx.token_symbol || tx.token_mint.slice(0, 8) + "...";
    const time = new Date(tx.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    let line = `${emoji} ${tx.type} ${tokenName} | ${tx.sol_amount.toFixed(4)} SOL | ${time}`;

    // Add P&L for sells
    if (tx.type === "SELL" && tx.pnl_percent !== null) {
        const sign = tx.pnl_percent >= 0 ? "+" : "";
        line += ` | ${sign}${tx.pnl_percent.toFixed(1)}%`;
    }

    return line;
}

/**
 * Show transaction history
 */
export async function showHistory(ctx: UserContext, page: number = 0): Promise<void> {
    const walletId = ctx.user.active_wallet_id;
    const allTransactions = getTransactionsByWallet(walletId, MAX_TRANSACTIONS);

    // Pagination
    const totalTransactions = allTransactions.length;
    const totalPages = Math.ceil(totalTransactions / TRANSACTIONS_PER_PAGE);
    const startIdx = page * TRANSACTIONS_PER_PAGE;
    const endIdx = Math.min(startIdx + TRANSACTIONS_PER_PAGE, totalTransactions);
    const pageTransactions = allTransactions.slice(startIdx, endIdx);

    // Group by day
    const dayGroups = groupTransactionsByDay(pageTransactions);

    let text = `📜 <b>Transaction History</b>\n\n`;

    if (totalTransactions === 0) {
        text += `<i>No transactions yet. Make some trades to see history!</i>`;
    } else {
        for (const group of dayGroups) {
            const netSign = group.netSOL >= 0 ? "+" : "";
            text += `📅 <b>${group.dateLabel}</b> - Net: ${netSign}${group.netSOL.toFixed(4)} SOL\n`;
            text += `━━━━━━━━━━━━━━━━━━━━━━\n`;

            for (const tx of group.transactions) {
                text += formatTransaction(tx) + "\n";

                // Add Solscan link (subtle)
                if (tx.signature) {
                    text += `   <a href="https://solscan.io/tx/${tx.signature}">View ↗</a>\n`;
                }
            }
            text += "\n";
        }
    }

    // Build keyboard
    const keyboard = new InlineKeyboard();

    // Pagination buttons
    if (totalPages > 1) {
        if (page > 0) {
            keyboard.text("◀️ Prev", `${CallbackPrefix.HISTORY}:page:${page - 1}`);
        }
        keyboard.text(`${page + 1}/${totalPages}`, `${CallbackPrefix.HISTORY}:page:${page}`);
        if (page < totalPages - 1) {
            keyboard.text("Next ▶️", `${CallbackPrefix.HISTORY}:page:${page + 1}`);
        }
        keyboard.row();
    }

    // Main menu button
    keyboard.text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    if (ctx.callbackQuery?.message) {
        try {
            await ctx.editMessageText(text, {
                parse_mode: "HTML",
                reply_markup: keyboard,
                link_preview_options: { is_disabled: true },
            });
        } catch (e) {
            await ctx.reply(text, {
                parse_mode: "HTML",
                reply_markup: keyboard,
                link_preview_options: { is_disabled: true },
            });
        }
    } else {
        await ctx.reply(text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true },
        });
    }
}
