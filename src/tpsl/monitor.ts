/**
 * TP/SL Monitor - background loop that checks SOL value and triggers TP/SL
 * Uses Jupiter quotes for SOL-based P&L (not USD price)
 */

import { getAllActiveRules, TPSLRuleWithPosition, clearRulesForPosition } from "../database/tpsl.js";
import { closePosition, getPositionById } from "../database/positions.js";
import { getBatchSellQuotes } from "../utils/jupiterUltra.js";
import { checkTrailingSL } from "./trailing.js";
import { executeTPSL, formatTPSLNotification, formatTPSLRetryingNotification } from "./executor.js";
import { Bot, Context, Api, RawApi } from "grammy";
import { isTokenBeingSold } from "../autosell/index.js";

// Monitor state
let isRunning = false;
let isExecuting = false; // Prevent concurrent monitor cycles
let monitorInterval: NodeJS.Timeout | null = null;
let positionSyncInterval: NodeJS.Timeout | null = null; // Background position sync
let botInstance: Bot<Context, Api<RawApi>> | null = null;
const positionsBeingExecuted = new Set<number>(); // Track positions currently being executed
const failedRulesNotified = new Set<number>(); // Track rules that have already sent failure notification
const zeroBalancePositions = new Set<number>(); // Track positions already identified as zero-balance

// Monitor settings
const MONITOR_INTERVAL_MS = 700; // 700ms interval, 0ms offset in stagger scheme
const POSITION_SYNC_INTERVAL_MS = 30000; // 30 seconds for background position sync

/**
 * Start the TP/SL monitor
 * 
 * Runs at 0ms offset in the staggered polling schedule
 * (Curve polls at 175ms, Wallet at 350ms, Stale at 525ms)
 */
export function startTPSLMonitor<C extends Context>(bot?: Bot<C, Api<RawApi>>): void {
    if (isRunning) {
        console.log("⚠️ TP/SL Monitor already running");
        return;
    }

    botInstance = bot ? (bot as unknown as Bot<Context, Api<RawApi>>) : null;
    isRunning = true;

    console.log(`🎯 TP/SL Monitor started (700ms interval, 0ms offset)`);

    // Run immediately (0ms offset), then on interval
    runMonitorCycle();

    monitorInterval = setInterval(() => {
        runMonitorCycle();
    }, MONITOR_INTERVAL_MS);

    // Start background position sync (every 30 seconds)
    runPositionSync(); // Run immediately
    positionSyncInterval = setInterval(runPositionSync, POSITION_SYNC_INTERVAL_MS);
    console.log(`🔄 Position sync started (every ${POSITION_SYNC_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the TP/SL monitor
 */
export function stopTPSLMonitor(): void {
    isRunning = false;

    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }

    if (positionSyncInterval) {
        clearInterval(positionSyncInterval);
        positionSyncInterval = null;
    }

    // Clear tracking sets
    zeroBalancePositions.clear();
    failedRulesNotified.clear();

    console.log("🛑 TP/SL Monitor stopped");
}

/**
 * Background position sync - DISABLED
 * 
 * Previously checked RPC balances to detect empty positions, but this caused
 * race conditions because RPC has significant latency (sometimes 30+ seconds)
 * for new token balances, especially on Pump.fun.
 * 
 * Position cleanup now ONLY happens when:
 * 1. A sell succeeds (executor closes position after 100% sell)
 * 2. Jupiter returns "no tokens" error (executor detects and cleans up)
 * 
 * This is more reliable because Jupiter's routing accurately reflects on-chain state.
 */
async function runPositionSync(): Promise<void> {
    // No-op - position cleanup handled by executor
    return;
}

/**
 * Run a single monitoring cycle using SOL-based P&L
 */
async function runMonitorCycle(): Promise<void> {
    if (!isRunning) return;

    // Prevent concurrent execution of monitor cycles
    if (isExecuting) {
        return;
    }
    isExecuting = true;

    try {
        // Get all active rules with position details
        const rules = getAllActiveRules();

        if (rules.length === 0) {
            isExecuting = false;
            return; // No rules to check
        }

        // Group rules by position (token mint + amount)
        // We need unique positions with their current token amounts
        const positionsMap = new Map<string, {
            tokenMint: string;
            tokenAmount: bigint;
            rules: TPSLRuleWithPosition[];
        }>();

        for (const rule of rules) {
            const existing = positionsMap.get(rule.token_mint);
            if (existing) {
                existing.rules.push(rule);
            } else {
                positionsMap.set(rule.token_mint, {
                    tokenMint: rule.token_mint,
                    tokenAmount: BigInt(rule.entry_amount),
                    rules: [rule],
                });
            }
        }

        // Prepare positions for batch quote
        const positions = Array.from(positionsMap.values()).map(p => ({
            tokenMint: p.tokenMint,
            tokenAmount: p.tokenAmount,
        }));

        // Get all sell quotes in parallel (single batch request)
        const quotes = await getBatchSellQuotes(positions);

        // Check each rule against SOL-based P&L
        for (const [tokenMint, positionData] of positionsMap) {
            const quote = quotes.get(tokenMint);

            if (!quote || !quote.success || quote.solOutput === 0) {
                continue; // Can't check without valid quote
            }

            for (const rule of positionData.rules) {
                // Skip if this POSITION is already being executed (prevents TP+SL race condition)
                if (positionsBeingExecuted.has(rule.position_id)) {
                    continue;
                }

                // Skip if autosell is currently selling this token
                if (isTokenBeingSold(rule.telegram_id, rule.token_mint)) {
                    console.log(`⏸️ [TP/SL] Skipping ${rule.token_mint.slice(0, 8)}... - autosell in progress`);
                    continue;
                }

                // Calculate SOL-based P&L
                const entrySol = rule.entry_sol;
                const currentSolValue = quote.solOutput;

                if (entrySol <= 0) {
                    continue; // Invalid entry SOL
                }

                const pnlPercent = ((currentSolValue - entrySol) / entrySol) * 100;
                const shouldTrigger = checkShouldTriggerSOL(rule, pnlPercent, currentSolValue, entrySol);

                if (shouldTrigger) {
                    // Mark POSITION as being executed (blocks all rules for this position)
                    positionsBeingExecuted.add(rule.position_id);

                    const symbol = rule.token_symbol || rule.token_mint.slice(0, 8);

                    // NOTE: We intentionally do NOT pre-check wallet balance here.
                    // RPC balance queries have latency issues that cause race conditions
                    // (new buys show 0 balance before RPC catches up).
                    // Instead, we let the executor attempt the sell - if there are no tokens,
                    // Jupiter will fail with a clear error and the executor will clean up.

                    console.log(`🎯 TP/SL triggered for ${symbol}...`);
                    console.log(`   Entry: ${entrySol.toFixed(6)} SOL → Current: ${currentSolValue.toFixed(6)} SOL (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);

                    // Execute the trade
                    const result = await executeTPSL(rule);

                    // Smart notification logic:
                    // - On success: always notify + clear failure tracking
                    // - On first failure: notify with "retrying" message
                    // - On subsequent failures: silent (no notification)
                    if (result.success) {
                        // Success! Clear failure tracking and notify
                        failedRulesNotified.delete(rule.id);
                        await sendNotification(rule.telegram_id, formatTPSLNotification(rule, result, pnlPercent));
                    } else {
                        // Failure - only notify if this is the first failure for this rule
                        if (!failedRulesNotified.has(rule.id)) {
                            failedRulesNotified.add(rule.id);
                            await sendNotification(
                                rule.telegram_id,
                                formatTPSLRetryingNotification(rule, result.error || "Unknown error")
                            );
                        }
                        // Subsequent failures are silent - will keep retrying
                    }

                    // Remove from execution tracking
                    positionsBeingExecuted.delete(rule.position_id);
                }
            }
        }

    } catch (error) {
        console.error("❌ TP/SL Monitor error:", error);
    } finally {
        isExecuting = false;
    }
}

/**
 * Check if a rule should trigger based on SOL-based P&L
 */
function checkShouldTriggerSOL(
    rule: TPSLRuleWithPosition,
    pnlPercent: number,
    currentSolValue: number,
    entrySol: number
): boolean {
    switch (rule.type) {
        case "TP":
            // Take Profit: triggers when SOL gain >= trigger_percent
            // e.g., +10% TP triggers when pnl >= 10
            return pnlPercent >= rule.trigger_percent;

        case "SL":
            // Stop Loss: triggers when SOL loss <= trigger_percent (negative)
            // e.g., -30% SL triggers when pnl <= -30
            return pnlPercent <= rule.trigger_percent;

        case "TRAILING_SL":
            // Trailing SL: uses SOL value as price equivalent
            // checkTrailingSL handles peak updates internally
            const result = checkTrailingSL(rule, currentSolValue);
            return result.shouldTrigger;

        default:
            return false;
    }
}

/**
 * Send notification to user via Telegram
 */
async function sendNotification(telegramId: number, message: string): Promise<void> {
    if (!botInstance) {
        console.warn("⚠️ Cannot send notification: no bot instance");
        return;
    }

    try {
        // Send the notification (no main menu after - keeps the UI clean)
        await botInstance.api.sendMessage(telegramId, message, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
        });

    } catch (error) {
        console.error(`❌ Failed to send notification to ${telegramId}:`, error);
    }
}

/**
 * Get monitor status
 */
export function isMonitorRunning(): boolean {
    return isRunning;
}

/**
 * Get count of active rules being monitored
 */
export function getActiveRulesCount(): number {
    return getAllActiveRules().length;
}
