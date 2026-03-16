/**
 * TP/SL Executor - executes trades when TP/SL rules trigger
 */

import { TPSLRuleWithPosition, markTriggered, deleteRule, clearRulesForPosition } from "../database/tpsl.js";
import { getUser } from "../database/users.js";
import { decryptWallet } from "../utils/wallet.js";
import { executeSellPercent } from "../trading/sell.js";
import { getSettings } from "../database/settings.js";
import { closePosition } from "../database/positions.js";

export interface TPSLExecutionResult {
    success: boolean;
    signature?: string;
    solReceived?: number;
    error?: string;
}

/**
 * Execute a triggered TP/SL rule
 * Sells the specified percentage of the position
 */
export async function executeTPSL(
    rule: TPSLRuleWithPosition
): Promise<TPSLExecutionResult> {
    try {
        const typeLabel = rule.type === "TP" ? "Take Profit" :
            rule.type === "SL" ? "Stop Loss" : "Trailing SL";

        console.log(`🎯 Executing ${typeLabel} for ${rule.token_symbol || rule.token_mint.slice(0, 8)}...`);
        console.log(`   Selling ${rule.sell_percent}% of position`);

        // Get user and decrypt wallet
        const user = getUser(rule.telegram_id);
        if (!user) {
            // User not found - delete the rule to prevent retries
            deleteRule(rule.id);
            return { success: false, error: "User not found" };
        }

        const wallet = decryptWallet(user.encrypted_private_key);
        const settings = getSettings(rule.telegram_id);

        // Execute the sell
        const result = await executeSellPercent(
            rule.telegram_id,
            rule.wallet_id || user.active_wallet_id,
            rule.token_mint,
            rule.token_symbol,
            rule.sell_percent,
            wallet,
            settings.slippage_bps
        );

        if (result.success) {
            // Mark rule as triggered
            markTriggered(rule.id);

            console.log(`✅ ${typeLabel} executed: ${result.solReceived?.toFixed(4)} SOL received`);

            return {
                success: true,
                signature: result.signature,
                solReceived: result.solReceived,
            };
        } else {
            // Check if the failure indicates the position is effectively closed
            // These patterns indicate the position has no tokens to sell
            const noTokensPatterns = [
                "No tokens to sell",
                "Sell amount too small",
                "insufficient",
                "0 balance",
                "zero balance",
                "No route found",       // Jupiter can't route because no tokens
                "No liquidity",         // Similar - can't swap with 0 tokens
                "amount too small",     // Token amount rounds to 0
                "Token account not found", // ATA doesn't exist
            ];

            const shouldAutoClose = noTokensPatterns.some(pattern =>
                result.error?.toLowerCase().includes(pattern.toLowerCase())
            );

            if (shouldAutoClose) {
                // Position is effectively closed - clear all rules for this position
                console.log(`🧹 Position appears empty - auto-closing position ${rule.position_id}`);
                clearRulesForPosition(rule.position_id);
                closePosition(rule.position_id);

                // Return a special "success" state so we don't keep retrying
                return {
                    success: true, // Treat as success to prevent retry notifications
                    error: result.error,
                    solReceived: 0,
                };
            }

            console.error(`❌ ${typeLabel} failed: ${result.error}`);
            return {
                success: false,
                error: result.error,
            };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`❌ TP/SL execution failed:`, error);
        return { success: false, error: errorMessage };
    }
}

/**
 * Format TP/SL trigger notification message
 */
export function formatTPSLNotification(
    rule: TPSLRuleWithPosition,
    result: TPSLExecutionResult,
    pnlPercent?: number
): string {
    const emoji = rule.type === "TP" ? "🎯" : rule.type === "SL" ? "🛑" : "📉";
    const typeLabel = rule.type === "TP" ? "Take Profit" :
        rule.type === "SL" ? "Stop Loss" : "Trailing Stop";

    const tokenName = rule.token_symbol || rule.token_mint.slice(0, 8) + "...";

    if (result.success) {
        // Check if this was an auto-close (no actual transaction)
        if (!result.signature && result.solReceived === 0) {
            return `${emoji} <b>${typeLabel} - Position Closed</b>

🪙 Token: <code>${tokenName}</code>
ℹ️ Position was already empty (no tokens remaining).

<i>Position and rules have been automatically cleaned up.</i>`;
        }

        const sol = result.solReceived?.toFixed(4) || "0";
        const pnlStr = pnlPercent !== undefined
            ? `\n📊 P&L: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`
            : "";

        return `${emoji} <b>${typeLabel} Triggered!</b>

🪙 Token: <code>${tokenName}</code>
💰 Sold: ${rule.sell_percent}% of position
💵 Received: ${sol} SOL${pnlStr}

🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction</a>`;
    } else {
        return `${emoji} <b>${typeLabel} Failed</b>

🪙 Token: <code>${tokenName}</code>
❌ Error: ${result.error}

Please check your position manually.`;
    }
}

/**
 * Format notification for first failure with retry message
 * Only sent once - subsequent retries are silent until success
 */
export function formatTPSLRetryingNotification(
    rule: TPSLRuleWithPosition,
    errorMessage: string
): string {
    const emoji = rule.type === "TP" ? "🎯" : rule.type === "SL" ? "🛑" : "📉";
    const typeLabel = rule.type === "TP" ? "Take Profit" :
        rule.type === "SL" ? "Stop Loss" : "Trailing Stop";

    const tokenName = rule.token_symbol || rule.token_mint.slice(0, 8) + "...";

    return `${emoji} <b>${typeLabel} Triggered - Execution Failed</b>

🪙 Token: <code>${tokenName}</code>
❌ Error: ${errorMessage.slice(0, 100)}${errorMessage.length > 100 ? "..." : ""}

⏳ <b><i>Retrying in the background...</i></b>

You will be notified when the transaction succeeds.`;
}
