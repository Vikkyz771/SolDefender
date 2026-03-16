/**
 * Auto-Sell Monitor - Multi-User Edition
 * Monitors all registered users' wallets for bonding curve tokens
 * HTTP polling with per-user thresholds
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { getMonitoringHttpRpc, getMultipleAccountsInfoBatched } from "../utils/rpc.js";
import { getWalletTokenHoldings, TokenHolding, decryptWallet } from "../utils/wallet.js";
import { getAllUsers, User, getActiveWallet, Wallet } from "../database/users.js";
import { getSettings } from "../database/settings.js";
import { sendUserNotification } from "../telegram/notifications.js";
import {
    HTTP_FALLBACK_INTERVAL_MS,
    WS_STALE_THRESHOLD_MS,
} from "../config.js";
import { TrackedToken, Platform, BondingCurveData } from "./types.js";
import { executeSell } from "./executor.js";
import {
    detectPlatform,
    deriveCurveAccount,
    parseCurveData,
    getCurveProgress,
} from "./platforms/index.js";
import { shouldImmediatelySellMoonshot } from "./platforms/moonshot-sdk.js";
import { clearPoolCache } from "../cache/pools.js";

// =============================================================================
// Per-User State Management
// =============================================================================

/**
 * Per-user tracking state
 * Key: telegramId, Value: Map of mint -> TrackedToken
 */
const userTrackedTokens = new Map<number, Map<string, TrackedToken>>();

/**
 * Per-user wallet keypairs (decrypted on registration)
 * Key: telegramId, Value: { walletId, keypair }
 */
const userWallets = new Map<number, { walletId: number; keypair: Keypair }>();

/**
 * Per-user ignored mints (non-supported platforms)
 * Key: telegramId, Value: Set of mints
 */
const userIgnoredMints = new Map<number, Set<string>>();

/**
 * Per-user pending mints (being processed)
 * Key: telegramId, Value: Set of mints
 */
const userPendingMints = new Map<number, Set<string>>();

/**
 * Per-user selling mints (being sold)
 * Key: telegramId, Value: Set of mints
 */
const userSellingMints = new Map<number, Set<string>>();

/**
 * Interval IDs
 */
let fallbackIntervalId: NodeJS.Timeout | null = null;
let walletPollIntervalId: NodeJS.Timeout | null = null;
let userSyncIntervalId: NodeJS.Timeout | null = null;

// =============================================================================
// User Registration
// =============================================================================

/**
 * Register a user for autosell monitoring
 * Called on bot startup (for all users) and when new users join
 */
export async function registerUser(telegramId: number): Promise<boolean> {
    // Skip if already registered with same wallet
    const existingWallet = userWallets.get(telegramId);
    const activeWallet = getActiveWallet(telegramId);

    if (!activeWallet) {
        console.log(`⚠️ User ${telegramId} has no active wallet, skipping autosell`);
        return false;
    }

    // Check if wallet changed
    if (existingWallet && existingWallet.walletId === activeWallet.id) {
        return true; // Already registered with same wallet
    }

    // Decrypt wallet
    try {
        const keypair = decryptWallet(activeWallet.encrypted_private_key);
        userWallets.set(telegramId, { walletId: activeWallet.id, keypair });

        // Initialize per-user state if needed
        if (!userTrackedTokens.has(telegramId)) {
            userTrackedTokens.set(telegramId, new Map());
        }
        if (!userIgnoredMints.has(telegramId)) {
            userIgnoredMints.set(telegramId, new Set());
        }
        if (!userPendingMints.has(telegramId)) {
            userPendingMints.set(telegramId, new Set());
        }
        if (!userSellingMints.has(telegramId)) {
            userSellingMints.set(telegramId, new Set());
        }

        console.log(`✅ Registered user ${telegramId} for autosell (wallet: ${activeWallet.wallet_address.slice(0, 8)}...)`);

        // Immediately scan their wallet
        await scanUserWallet(telegramId);

        return true;
    } catch (error) {
        console.error(`❌ Failed to register user ${telegramId}:`, error);
        return false;
    }
}

/**
 * Unregister a user from autosell monitoring
 */
export function unregisterUser(telegramId: number): void {
    // Stop tracking all their tokens
    const tracked = userTrackedTokens.get(telegramId);
    if (tracked) {
        for (const mint of tracked.keys()) {
            console.log(`🔕 Stopped tracking ${mint.slice(0, 8)}... for user ${telegramId}`);
        }
    }

    // Clean up all user state
    userTrackedTokens.delete(telegramId);
    userWallets.delete(telegramId);
    userIgnoredMints.delete(telegramId);
    userPendingMints.delete(telegramId);
    userSellingMints.delete(telegramId);

    console.log(`🔕 Unregistered user ${telegramId} from autosell`);
}

/**
 * Refresh user's settings (threshold changed) or wallet (switched wallet)
 */
export async function refreshUser(telegramId: number): Promise<void> {
    const existingWallet = userWallets.get(telegramId);
    const activeWallet = getActiveWallet(telegramId);

    if (!activeWallet) {
        unregisterUser(telegramId);
        return;
    }

    // If wallet changed, re-register (clears old tracking)
    if (!existingWallet || existingWallet.walletId !== activeWallet.id) {
        // Clear old tracking since wallet changed
        userTrackedTokens.set(telegramId, new Map());
        userIgnoredMints.set(telegramId, new Set());
        await registerUser(telegramId);
    }
    // Threshold is read fresh each poll cycle, no need to cache
}

// =============================================================================
// Tracking Logic
// =============================================================================

/**
 * Start tracking a token for a specific user
 */
async function startTracking(
    telegramId: number,
    walletId: number,
    holding: TokenHolding
): Promise<boolean> {
    const mint = holding.mint.toBase58();

    const tracked = userTrackedTokens.get(telegramId);
    const ignored = userIgnoredMints.get(telegramId);
    const pending = userPendingMints.get(telegramId);
    const selling = userSellingMints.get(telegramId);

    if (!tracked || !ignored || !pending || !selling) return false;

    // Already tracking, pending, or being sold?
    if (tracked.has(mint) || pending.has(mint) || selling.has(mint)) {
        return false;
    }

    // Already ignored (not a bonding curve token)?
    if (ignored.has(mint)) {
        return false;
    }

    // Mark as pending to prevent race conditions
    pending.add(mint);

    // Detect platform
    const platform = await detectPlatform(mint);

    // Skip unsupported platforms
    if (platform === Platform.UNKNOWN) {
        console.log(`⏭️ [User ${telegramId}] Skipping ${mint.slice(0, 8)}... (not a bonding curve token)`);
        ignored.add(mint);
        pending.delete(mint);
        return false;
    }

    // MOONSHOT FLAT CURVE DETECTION
    if (platform === Platform.MOONSHOT) {
        try {
            const isFlatCurve = await shouldImmediatelySellMoonshot(mint);
            if (isFlatCurve) {
                console.log(`🚨 [User ${telegramId}] MOONSHOT FLAT CURVE DETECTED: ${mint.slice(0, 8)}...`);
                console.log(`   Flat curves have unpredictable graduation thresholds - SELLING IMMEDIATELY for safety`);

                const walletData = userWallets.get(telegramId);
                if (walletData) {
                    const tempTracked: TrackedToken = {
                        mint,
                        curveAccount: "",
                        platform,
                        subscriptionId: null,
                        lastUpdate: Date.now(),
                        currentProgress: 100,
                        balance: holding.balance,
                        telegramId,
                        walletId,
                    };

                    selling.add(mint);
                    const signature = await executeSell(tempTracked, walletData.keypair, telegramId, 1500);
                    selling.delete(mint);

                    if (signature) {
                        await sendUserNotification(
                            telegramId,
                            `🚨 <b>Auto-Sell: Moonshot Flat Curve</b>\n\n` +
                            `Token: <code>${mint}</code>\n` +
                            `Reason: Flat curves have unpredictable graduation\n\n` +
                            `✅ Sold for safety!\n` +
                            `🔗 <a href="https://solscan.io/tx/${signature}">View Transaction</a>`
                        );
                    }
                }

                ignored.add(mint);
                pending.delete(mint);
                return false;
            }
            console.log(`✅ [User ${telegramId}] Moonshot CLASSIC curve confirmed for ${mint.slice(0, 8)}...`);
        } catch (error) {
            console.warn(`⚠️ [User ${telegramId}] Could not verify Moonshot curve type for ${mint.slice(0, 8)}...`);
        }
    }

    // Derive curve account
    const curveAccount = await deriveCurveAccount(mint, platform);

    if (!curveAccount) {
        console.log(`⚠️ [User ${telegramId}] Could not derive curve for ${mint.slice(0, 8)}... (platform: ${platform})`);
        ignored.add(mint);
        pending.delete(mint);
        return false;
    }

    // Add to tracked tokens
    tracked.set(mint, {
        mint,
        curveAccount,
        platform,
        subscriptionId: null,
        lastUpdate: Date.now(),
        currentProgress: 0,
        balance: holding.balance,
        telegramId,
        walletId,
    });

    pending.delete(mint);
    console.log(`✅ [User ${telegramId}] Tracking ${mint.slice(0, 8)}... on ${platform}`);

    // IMMEDIATELY check bonding curve progress
    await checkProgressAndMaybeSell(telegramId, mint, curveAccount, platform, true);

    return true;
}

/**
 * Check progress for a token and trigger sell if threshold reached
 */
async function checkProgressAndMaybeSell(
    telegramId: number,
    mint: string,
    curveAccount: string,
    platform: Platform,
    isInitialCheck: boolean = false
): Promise<void> {
    const tracked = userTrackedTokens.get(telegramId);
    if (!tracked) return;

    const token = tracked.get(mint);
    if (!token) return;

    try {
        const accountInfo = await getMonitoringHttpRpc().getAccountInfo(
            new PublicKey(curveAccount)
        );

        if (!accountInfo?.data) return;

        const curveData = parseCurveData(accountInfo.data as Buffer, platform);
        token.currentProgress = curveData.progress;
        token.lastUpdate = Date.now();

        const prefix = isInitialCheck ? "[INIT]" : "[POLL]";
        console.log(`📊 ${prefix} [User ${telegramId}] ${mint.slice(0, 8)}... progress: ${curveData.progress.toFixed(2)}%`);

        // Get user's threshold
        const settings = getSettings(telegramId);
        const threshold = settings.autosell_threshold;

        if (curveData.progress >= threshold && !curveData.complete) {
            if (isInitialCheck) {
                console.log(`🚨 [INIT] Token already above threshold (${threshold}%)! Triggering sell...`);
            }
            await triggerSell(telegramId, token);
        }
    } catch (error) {
        if (isInitialCheck) {
            console.log(`⚠️ [User ${telegramId}] Could not check initial progress for ${mint.slice(0, 8)}...`);
        }
    }
}

/**
 * Trigger a sell for a tracked token
 */
async function triggerSell(telegramId: number, token: TrackedToken): Promise<void> {
    const selling = userSellingMints.get(telegramId);
    const tracked = userTrackedTokens.get(telegramId);
    const walletData = userWallets.get(telegramId);

    if (!selling || !tracked || !walletData) return;

    // Prevent duplicate sells
    if (selling.has(token.mint)) return;
    selling.add(token.mint);

    const settings = getSettings(telegramId);
    const threshold = settings.autosell_threshold;

    console.log(`🚨 [User ${telegramId}] THRESHOLD REACHED: ${token.mint.slice(0, 8)}... at ${token.currentProgress.toFixed(2)}% (threshold: ${threshold}%)`);

    // Remove from tracking immediately
    tracked.delete(token.mint);
    console.log(`🔕 Stopped tracking ${token.mint.slice(0, 8)}...`);

    // Get position data BEFORE clearing (for P&L calculation)
    const { getPosition, closePositionByMint: closePos } = await import("../database/positions.js");
    const { clearRulesForPosition } = await import("../database/tpsl.js");
    const position = getPosition(telegramId, token.mint);
    const entrySol = position?.entry_sol || 0;

    // Clear TP/SL rules BEFORE selling (prevents TP/SL from triggering during the sell)
    // But keep position data for P&L calculation
    if (position) {
        clearRulesForPosition(position.id);
        console.log(`📊 [Autosell] Cleared TP/SL rules for ${token.mint.slice(0, 8)}... (kept position for P&L)`);
    }
    clearPoolCache(token.mint);

    // Execute sell (position still exists for P&L calculation)
    const result = await executeSell(token, walletData.keypair, telegramId, settings.slippage_bps);

    // NOW close position after sell is complete
    if (position) {
        closePos(telegramId, token.mint);
        console.log(`📊 [Autosell] Closed position for ${token.mint.slice(0, 8)}...`);
    }

    // Send notification with P&L if available
    if (result.success && result.signature) {
        // Build P&L string
        let pnlStr = "";
        if (result.pnlPercent !== undefined) {
            const emoji = result.pnlPercent >= 0 ? "📈" : "📉";
            const sign = result.pnlPercent >= 0 ? "+" : "";
            pnlStr = `\n${emoji} <b>P&L:</b> ${sign}${result.pnlPercent.toFixed(1)}%`;

            if (result.entrySol && result.estimatedSOL) {
                pnlStr += ` (${result.entrySol.toFixed(4)} → ${result.estimatedSOL.toFixed(4)} SOL)`;
            }
        } else if (result.estimatedSOL) {
            pnlStr = `\n💰 Received: ~${result.estimatedSOL.toFixed(4)} SOL`;
        }

        // Add rent recovery info
        let rentStr = "";
        if (result.rentRecovered && result.rentRecovered > 0) {
            rentStr = `\n🧹 Rent recovered: +${result.rentRecovered.toFixed(4)} SOL`;
        }

        await sendUserNotification(
            telegramId,
            `🚨 <b>Auto-Sell Triggered!</b>\n\n` +
            `Token: <code>${token.mint}</code>\n` +
            `Progress: ${token.currentProgress.toFixed(1)}%\n` +
            `Threshold: ${threshold}%${pnlStr}${rentStr}\n\n` +
            `✅ Sold before graduation!\n` +
            `🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction</a>`
        );
    } else {
        await sendUserNotification(
            telegramId,
            `🚨 <b>Auto-Sell Failed!</b>\n\n` +
            `Token: <code>${token.mint}</code>\n` +
            `Progress: ${token.currentProgress.toFixed(1)}%\n\n` +
            `❌ ${result.error || "Unknown error"}\n\n` +
            `<i>Please sell manually if needed.</i>`
        );
    }

    // Add to ignored so it won't be re-tracked
    const ignored = userIgnoredMints.get(telegramId);
    if (ignored) ignored.add(token.mint);

    selling.delete(token.mint);
}

/**
 * Stop tracking a token for a user
 */
export function stopTracking(telegramId: number, mint: string): void {
    const tracked = userTrackedTokens.get(telegramId);
    if (!tracked) return;

    tracked.delete(mint);
    console.log(`🔕 [User ${telegramId}] Stopped tracking ${mint.slice(0, 8)}...`);
}

/**
 * Check if a token is currently being sold by autosell
 * Used by TP/SL to avoid duplicate sells
 */
export function isTokenBeingSold(telegramId: number, mint: string): boolean {
    const selling = userSellingMints.get(telegramId);
    return selling?.has(mint) || false;
}

// =============================================================================
// Polling Logic
// =============================================================================

/**
 * Poll all stale tokens for all users - BATCHED VERSION
 * Collects all curve accounts and fetches in a single RPC call
 */
async function pollAllStaleTokens(): Promise<void> {
    const now = Date.now();

    // Step 1: Collect all curve accounts that need updating
    const tokensToCheck: Array<{
        telegramId: number;
        mint: string;
        curveAccount: string;
        platform: Platform;
    }> = [];

    for (const [telegramId, tracked] of userTrackedTokens) {
        for (const [mint, token] of tracked) {
            // Skip if recently updated or no curve account
            if (now - token.lastUpdate < WS_STALE_THRESHOLD_MS) continue;
            if (!token.curveAccount) continue;

            tokensToCheck.push({
                telegramId,
                mint,
                curveAccount: token.curveAccount,
                platform: token.platform
            });
        }
    }

    if (tokensToCheck.length === 0) return;

    // Step 2: Batch fetch all curve accounts in ONE RPC call
    const curvePublicKeys = tokensToCheck.map(t => new PublicKey(t.curveAccount));
    const accountsMap = await getMultipleAccountsInfoBatched(curvePublicKeys);

    console.log(`📊 [BATCH] Fetched ${tokensToCheck.length} curve accounts in 1 RPC call`);

    // Step 3: Process each result
    for (const tokenInfo of tokensToCheck) {
        // Get the tracked token and update it
        const tracked = userTrackedTokens.get(tokenInfo.telegramId);
        if (!tracked) continue;

        const token = tracked.get(tokenInfo.mint);
        if (!token) continue;

        let curveData: BondingCurveData;

        // Meteora requires SDK for accurate progress (parseCurveData returns 0)
        if (tokenInfo.platform === Platform.METEORA_DBC) {
            curveData = await getCurveProgress(tokenInfo.curveAccount, tokenInfo.platform);
        } else {
            // For other platforms, use batch-fetched account data
            const accountData = accountsMap.get(tokenInfo.curveAccount);
            if (!accountData?.data) continue;
            curveData = parseCurveData(accountData.data, tokenInfo.platform);
        }

        token.currentProgress = curveData.progress;
        token.lastUpdate = Date.now();

        console.log(`📊 [POLL] [User ${tokenInfo.telegramId}] ${tokenInfo.mint.slice(0, 8)}... progress: ${curveData.progress.toFixed(2)}%`);

        // Check threshold
        const settings = getSettings(tokenInfo.telegramId);
        const threshold = settings.autosell_threshold;

        if (curveData.progress >= threshold && !curveData.complete) {
            await triggerSell(tokenInfo.telegramId, token);
        }
    }
}

/**
 * Scan a single user's wallet for new tokens
 */
async function scanUserWallet(telegramId: number): Promise<void> {
    const walletData = userWallets.get(telegramId);
    const tracked = userTrackedTokens.get(telegramId);
    const ignored = userIgnoredMints.get(telegramId);
    const selling = userSellingMints.get(telegramId);
    const pending = userPendingMints.get(telegramId);

    if (!walletData || !tracked || !ignored) return;

    try {
        const holdings = await getWalletTokenHoldings(walletData.keypair.publicKey);
        const currentMints = new Set(holdings.map(h => h.mint.toBase58()));

        // Add new tokens
        for (const holding of holdings) {
            const mint = holding.mint.toBase58();

            // Skip if already tracked, ignored, being sold, or pending
            const isTracked = tracked.has(mint);
            const isIgnored = ignored.has(mint);
            const isSelling = selling?.has(mint) || false;
            const isPending = pending?.has(mint) || false;

            if (!isTracked && !isIgnored && !isSelling && !isPending) {
                console.log(`🆕 [User ${telegramId}] New token detected: ${mint.slice(0, 8)}...`);
                await startTracking(telegramId, walletData.walletId, holding);
            } else if (isTracked) {
                // Update balance for existing tokens
                const token = tracked.get(mint)!;
                token.balance = holding.balance;
            }
        }

        // Remove tokens no longer in wallet
        for (const [mint] of tracked) {
            if (!currentMints.has(mint)) {
                console.log(`🗑️ [User ${telegramId}] Token removed from wallet: ${mint.slice(0, 8)}...`);
                tracked.delete(mint);
            }
        }
    } catch {
        // Silently ignore scan failures
    }
}

/**
 * Scan all registered users' wallets - STAGGERED VERSION
 * Spreads user scans across the interval to avoid burst requests
 */
async function scanAllUserWallets(): Promise<void> {
    const userIds = Array.from(userWallets.keys());
    const userCount = userIds.length;

    if (userCount === 0) return;

    // Calculate stagger delay: spread users across 600ms (leaving 100ms buffer)
    const staggerDelay = Math.floor(600 / userCount);

    for (let i = 0; i < userCount; i++) {
        const telegramId = userIds[i];

        // Stagger: wait before each scan (except first)
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, staggerDelay));
        }

        await scanUserWallet(telegramId);
    }
}

/**
 * Sync registered users with database (pick up new users, removed users)
 */
async function syncUsersWithDatabase(): Promise<void> {
    const dbUsers = getAllUsers();
    const registeredIds = new Set(userWallets.keys());

    // Register new users
    for (const user of dbUsers) {
        if (!registeredIds.has(user.telegram_id)) {
            await registerUser(user.telegram_id);
        }
    }

    // Note: We don't unregister users automatically - they stay monitored
    // until explicitly unregistered or bot restarts
}

// =============================================================================
// Monitor Lifecycle
// =============================================================================

/**
 * Start the multi-user auto-sell monitor
 * Called once on bot startup (after database init)
 */
export async function startMonitor(): Promise<void> {
    console.log("🤖 Starting multi-user auto-sell monitor...");

    // Register all existing users
    const users = getAllUsers();
    console.log(`📋 Found ${users.length} registered users`);

    for (const user of users) {
        await registerUser(user.telegram_id);
    }

    const POLL_INTERVAL = 700; // 700ms cycle

    // Start curve polling at 175ms offset
    setTimeout(() => {
        pollAllStaleTokens();
        fallbackIntervalId = setInterval(pollAllStaleTokens, POLL_INTERVAL);
        console.log(`🔄 Curve polling every ${POLL_INTERVAL}ms (offset: 175ms)`);
    }, 175);

    // Start wallet polling at 350ms offset
    setTimeout(() => {
        scanAllUserWallets();
        walletPollIntervalId = setInterval(scanAllUserWallets, POLL_INTERVAL);
        console.log(`👛 Wallet polling every ${POLL_INTERVAL}ms (offset: 350ms)`);
    }, 350);

    // Sync users with database every 60 seconds (pick up new registrations)
    userSyncIntervalId = setInterval(syncUsersWithDatabase, 60000);

    // Count total tracked tokens
    let totalTracked = 0;
    for (const tracked of userTrackedTokens.values()) {
        totalTracked += tracked.size;
    }

    console.log(`✅ Monitor started: ${userWallets.size} users, ${totalTracked} tracked tokens`);
}

/**
 * Stop the auto-sell monitor
 */
export async function stopMonitor(): Promise<void> {
    console.log("🛑 Stopping auto-sell monitor...");

    if (fallbackIntervalId) {
        clearInterval(fallbackIntervalId);
        fallbackIntervalId = null;
    }

    if (walletPollIntervalId) {
        clearInterval(walletPollIntervalId);
        walletPollIntervalId = null;
    }

    if (userSyncIntervalId) {
        clearInterval(userSyncIntervalId);
        userSyncIntervalId = null;
    }

    // Clear all user state
    userTrackedTokens.clear();
    userWallets.clear();
    userIgnoredMints.clear();
    userPendingMints.clear();
    userSellingMints.clear();

    console.log("✅ Monitor stopped");
}

/**
 * Get tracking status for a specific user
 */
export function getUserTrackingStatus(telegramId: number): Map<string, TrackedToken> | undefined {
    return userTrackedTokens.get(telegramId);
}

/**
 * Get global tracking status (all users)
 */
export function getTrackingStatus(): Map<string, TrackedToken> {
    // Legacy compatibility: flatten all user tokens into one map
    const all = new Map<string, TrackedToken>();
    for (const tracked of userTrackedTokens.values()) {
        for (const [mint, token] of tracked) {
            all.set(mint, token);
        }
    }
    return all;
}
