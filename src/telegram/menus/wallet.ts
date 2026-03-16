/**
 * Wallet Menu - Multi-wallet management UI
 * Supports multiple wallets per user with switching, deposit, withdraw, import, export
 */

import { InlineKeyboard } from "grammy";
import { UserContext } from "../middleware/user.js";
import { CallbackPrefix, addNavigation } from "../keyboards/builders.js";
import {
    getWallets,
    getWalletById,
    addWallet,
    switchWallet,
    renameWallet,
    deleteWallet,
    Wallet,
} from "../../database/users.js";
import {
    generateWallet,
    importWallet,
    decryptWallet,
    getWalletSOLBalance,
} from "../../utils/wallet.js";
import { PublicKey, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { getMonitoringConnection } from "../../utils/rpc.js";
import bs58 from "bs58";
import { formatSOLWithUSD } from "../../utils/solPrice.js";
import { refreshUser } from "../../autosell/index.js";

// ============================================================================
// State Management
// ============================================================================

interface WalletFlowState {
    mode: "import" | "withdraw_address" | "withdraw_amount" | "withdraw_confirm" | "export_confirm" | "rename";
    walletId?: number;
    withdrawAddress?: string;
    withdrawAmount?: number;
}

const walletFlowState = new Map<number, WalletFlowState>();

// ============================================================================
// Main Wallet Menu
// ============================================================================

/**
 * Show wallet list with active indicator
 */
export async function showWalletMenu(ctx: UserContext): Promise<void> {
    const telegramId = ctx.user.telegram_id;
    const wallets = getWallets(telegramId);

    let text = "💼 **Your Wallets**\n\n";

    if (wallets.length === 0) {
        text += "_No wallets found. This shouldn't happen!_\n";
    } else {
        for (const wallet of wallets) {
            const activeIndicator = wallet.is_active ? " ✅" : "";
            const shortAddr = `${wallet.wallet_address.slice(0, 4)}...${wallet.wallet_address.slice(-4)}`;

            // Get balance for active wallet
            let balanceStr = "";
            if (wallet.is_active) {
                try {
                    const balance = await getWalletSOLBalance(new PublicKey(wallet.wallet_address));
                    balanceStr = ` — ${formatSOLWithUSD(balance)}`;
                } catch {
                    balanceStr = " — (error)";
                }
            }

            text += `${wallet.is_active ? "📍" : "💳"} **${wallet.name}**${activeIndicator}\n`;
            text += `   \`${shortAddr}\`${balanceStr}\n\n`;
        }
    }

    text += "_Tap a wallet to manage it_";

    // Build wallet list buttons
    const keyboard = new InlineKeyboard();

    for (const wallet of wallets) {
        const activeIcon = wallet.is_active ? "✅ " : "";
        keyboard.text(`${activeIcon}${wallet.name}`, `${CallbackPrefix.WALLET}:select:${wallet.id}`).row();
    }

    keyboard
        .text("➕ Import Wallet", `${CallbackPrefix.WALLET}:import`)
        .text("🆕 Generate New", `${CallbackPrefix.WALLET}:generate`)
        .row()
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

// ============================================================================
// Wallet Details
// ============================================================================

/**
 * Show details and actions for a specific wallet
 */
export async function showWalletDetails(ctx: UserContext, walletId: number): Promise<void> {
    const wallet = getWalletById(walletId);

    if (!wallet || wallet.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery("Wallet not found");
        return;
    }

    // Get balance
    let balanceStr = "Loading...";
    try {
        const balance = await getWalletSOLBalance(new PublicKey(wallet.wallet_address));
        balanceStr = formatSOLWithUSD(balance);
    } catch {
        balanceStr = "Error fetching balance";
    }

    const activeStatus = wallet.is_active ? "✅ **ACTIVE**" : "⚪ Inactive";

    const text = `💳 **${wallet.name}**\n\n` +
        `Status: ${activeStatus}\n` +
        `Balance: ${balanceStr}\n\n` +
        `**Address:**\n\`${wallet.wallet_address}\`\n\n` +
        `_Created: ${new Date(wallet.created_at).toLocaleDateString()}_`;

    const keyboard = new InlineKeyboard();

    // Show "Set Active" only if not already active
    if (!wallet.is_active) {
        keyboard.text("✅ Set Active", `${CallbackPrefix.WALLET}:activate:${walletId}`).row();
    }

    keyboard
        .text("📥 Deposit", `${CallbackPrefix.WALLET}:deposit:${walletId}`)
        .text("📤 Withdraw", `${CallbackPrefix.WALLET}:withdraw:${walletId}`)
        .row()
        .text("🔑 Export Key", `${CallbackPrefix.WALLET}:export:${walletId}`)
        .text("✏️ Rename", `${CallbackPrefix.WALLET}:rename:${walletId}`)
        .row();

    // Only show delete if not active
    if (!wallet.is_active) {
        keyboard.text("🗑️ Delete", `${CallbackPrefix.WALLET}:delete:${walletId}`).row();
    }

    keyboard
        .text("⬅️ Back", `${CallbackPrefix.MENU}:wallet`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    try {
        await ctx.editMessageText(text, {
            parse_mode: "Markdown",
            reply_markup: keyboard,
        });
    } catch {
        // Ignore "message not modified" errors
    }
}

// ============================================================================
// Deposit
// ============================================================================

/**
 * Show deposit address (plain text, no QR)
 */
export async function showDeposit(ctx: UserContext, walletId: number): Promise<void> {
    const wallet = getWalletById(walletId);

    if (!wallet || wallet.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery("Wallet not found");
        return;
    }

    const text = `📥 **Deposit to ${wallet.name}**\n\n` +
        `Send SOL to this address:\n\n` +
        `\`${wallet.wallet_address}\`\n\n` +
        `_Tap the address to copy_`;

    const keyboard = new InlineKeyboard()
        .text("⬅️ Back", `${CallbackPrefix.WALLET}:select:${walletId}`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

// ============================================================================
// Withdraw
// ============================================================================

/**
 * Start withdraw flow - ask for destination address
 */
export async function showWithdrawAddress(ctx: UserContext, walletId: number): Promise<void> {
    const wallet = getWalletById(walletId);

    if (!wallet || wallet.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery("Wallet not found");
        return;
    }

    // Get balance
    let balance = 0;
    try {
        balance = await getWalletSOLBalance(new PublicKey(wallet.wallet_address));
    } catch {
        await ctx.answerCallbackQuery("Error fetching balance");
        return;
    }

    if (balance < 0.001) {
        await ctx.answerCallbackQuery("Insufficient balance for withdrawal");
        return;
    }

    walletFlowState.set(ctx.user.telegram_id, {
        mode: "withdraw_address",
        walletId,
    });

    const text = `📤 **Withdraw from ${wallet.name}**\n\n` +
        `Balance: ${formatSOLWithUSD(balance)}\n\n` +
        `**Step 1/3:** Enter the destination wallet address:`;

    const keyboard = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.WALLET}:select:${walletId}`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Ask for withdraw amount after address is provided
 */
export async function showWithdrawAmount(ctx: UserContext, destinationAddress: string): Promise<void> {
    const state = walletFlowState.get(ctx.user.telegram_id);
    if (!state || state.mode !== "withdraw_address" || !state.walletId) {
        return;
    }

    // Validate address
    try {
        new PublicKey(destinationAddress);
    } catch {
        await ctx.reply("❌ Invalid Solana address. Please try again.");
        return;
    }

    const wallet = getWalletById(state.walletId);
    if (!wallet) return;

    // Get balance
    let balance = 0;
    try {
        balance = await getWalletSOLBalance(new PublicKey(wallet.wallet_address));
    } catch {
        await ctx.reply("❌ Error fetching balance");
        return;
    }

    // Update state
    walletFlowState.set(ctx.user.telegram_id, {
        mode: "withdraw_amount",
        walletId: state.walletId,
        withdrawAddress: destinationAddress,
    });

    const text = `📤 **Withdraw from ${wallet.name}**\n\n` +
        `To: \`${destinationAddress.slice(0, 8)}...${destinationAddress.slice(-8)}\`\n` +
        `Balance: ${formatSOLWithUSD(balance)}\n\n` +
        `**Step 2/3:** Enter amount to withdraw:\n` +
        `_Example: "0.5" or "max"_`;

    const keyboard = new InlineKeyboard()
        .text("💰 Max", `${CallbackPrefix.WALLET}:withdraw_max`)
        .row()
        .text("❌ Cancel", `${CallbackPrefix.WALLET}:select:${state.walletId}`);

    await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Show withdrawal confirmation
 */
export async function showWithdrawConfirm(
    ctx: UserContext,
    walletId: number,
    destinationAddress: string,
    amount: number
): Promise<void> {
    const wallet = getWalletById(walletId);
    if (!wallet) return;

    // Store withdrawal data in state (avoids 64 byte callback limit)
    walletFlowState.set(ctx.user.telegram_id, {
        mode: "withdraw_confirm",
        walletId: walletId,
        withdrawAddress: destinationAddress,
        withdrawAmount: amount,
    });

    const text = `📤 **Confirm Withdrawal**\n\n` +
        `From: **${wallet.name}**\n` +
        `To: \`${destinationAddress.slice(0, 8)}...${destinationAddress.slice(-8)}\`\n` +
        `Amount: **${formatSOLWithUSD(amount)}**\n\n` +
        `⚠️ **This action cannot be undone!**`;

    // Use simple callback - data is in state
    const keyboard = new InlineKeyboard()
        .text("✅ Confirm", `${CallbackPrefix.WALLET}:withdraw_exec`)
        .text("❌ Cancel", `${CallbackPrefix.WALLET}:select:${walletId}`);

    await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Execute the withdrawal
 */
export async function executeWithdraw(
    ctx: UserContext,
    walletId: number,
    destinationAddress: string,
    amount: number
): Promise<void> {
    const wallet = getWalletById(walletId);
    if (!wallet || wallet.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery("Wallet not found");
        return;
    }

    await ctx.editMessageText("⏳ Processing withdrawal...", { parse_mode: "Markdown" });

    try {
        const keypair = decryptWallet(wallet.encrypted_private_key);
        const connection = getMonitoringConnection();
        const destination = new PublicKey(destinationAddress);

        const lamports = Math.floor(amount * 1e9);

        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: destination,
                lamports,
            })
        );
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = keypair.publicKey;

        // Sign the transaction
        transaction.sign(keypair);

        // Send raw transaction (doesn't use WebSocket subscriptions)
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
        });

        // Poll for confirmation instead of using WebSocket subscriptions
        const confirmed = await pollForConfirmation(connection, signature, lastValidBlockHeight);

        if (!confirmed) {
            throw new Error("Transaction confirmation timeout");
        }

        const text = `✅ **Withdrawal Successful!**\n\n` +
            `Amount: ${formatSOLWithUSD(amount)}\n` +
            `To: \`${destinationAddress.slice(0, 8)}...${destinationAddress.slice(-8)}\`\n\n` +
            `[View on Solscan](https://solscan.io/tx/${signature})`;

        const keyboard = new InlineKeyboard()
            .text("⬅️ Back to Wallet", `${CallbackPrefix.WALLET}:select:${walletId}`)
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        await ctx.editMessageText(text, {
            parse_mode: "Markdown",
            reply_markup: keyboard,
        });

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";

        const text = `❌ **Withdrawal Failed**\n\n` +
            `Error: ${errorMsg}`;

        const keyboard = new InlineKeyboard()
            .text("🔄 Try Again", `${CallbackPrefix.WALLET}:withdraw:${walletId}`)
            .text("⬅️ Back", `${CallbackPrefix.WALLET}:select:${walletId}`);

        await ctx.editMessageText(text, {
            parse_mode: "Markdown",
            reply_markup: keyboard,
        });
    }

    clearWalletFlowState(ctx.user.telegram_id);
}

/**
 * Poll for transaction confirmation (avoids WebSocket subscriptions)
 */
async function pollForConfirmation(
    connection: import("@solana/web3.js").Connection,
    signature: string,
    lastValidBlockHeight: number,
    maxRetries = 30
): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between polls

        try {
            const status = await connection.getSignatureStatus(signature);

            if (status?.value?.confirmationStatus === "confirmed" ||
                status?.value?.confirmationStatus === "finalized") {
                return true;
            }

            if (status?.value?.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
            }

            // Check if blockhash expired
            const currentBlockHeight = await connection.getBlockHeight();
            if (currentBlockHeight > lastValidBlockHeight) {
                throw new Error("Blockhash expired");
            }
        } catch (e) {
            // Ignore errors during polling, continue trying
            if (e instanceof Error && e.message.includes("Transaction failed")) {
                throw e;
            }
        }
    }

    return false; // Timeout
}

// ============================================================================
// Export Key
// ============================================================================

/**
 * Show export key warning - requires typing CONFIRM
 */
export async function showExportKeyWarning(ctx: UserContext, walletId: number): Promise<void> {
    const wallet = getWalletById(walletId);
    if (!wallet || wallet.telegram_id !== ctx.user.telegram_id) {
        await ctx.answerCallbackQuery("Wallet not found");
        return;
    }

    walletFlowState.set(ctx.user.telegram_id, {
        mode: "export_confirm",
        walletId,
    });

    const text = `🔑 **Export Private Key**\n\n` +
        `⚠️ **DANGER ZONE**\n\n` +
        `Your private key grants FULL access to this wallet.\n` +
        `• Never share it with anyone\n` +
        `• Never paste it on websites\n` +
        `• Store it securely offline\n\n` +
        `**To reveal your private key, type exactly:**\n` +
        `\`CONFIRM\`\n\n` +
        `_(Case-sensitive)_`;

    const keyboard = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.WALLET}:select:${walletId}`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Reveal the private key after CONFIRM input
 */
export async function revealPrivateKey(ctx: UserContext): Promise<void> {
    const state = walletFlowState.get(ctx.user.telegram_id);
    if (!state || state.mode !== "export_confirm" || !state.walletId) {
        return;
    }

    const wallet = getWalletById(state.walletId);
    if (!wallet) return;

    // Decrypt and display
    const keypair = decryptWallet(wallet.encrypted_private_key);
    const privateKeyBase58 = bs58.encode(keypair.secretKey);

    // Send as a new message that auto-deletes
    const text = `🔑 **Private Key for ${wallet.name}**\n\n` +
        `\`${privateKeyBase58}\`\n\n` +
        `⚠️ _This message will NOT auto-delete. Please delete it manually after copying._`;

    const keyboard = new InlineKeyboard()
        .text("⬅️ Back to Wallet", `${CallbackPrefix.WALLET}:select:${state.walletId}`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });

    clearWalletFlowState(ctx.user.telegram_id);
}

// ============================================================================
// Import Wallet
// ============================================================================

/**
 * Show import wallet prompt
 */
export async function showImportWallet(ctx: UserContext): Promise<void> {
    walletFlowState.set(ctx.user.telegram_id, {
        mode: "import",
    });

    const text = `🔄 **Import Wallet**\n\n` +
        `Paste your private key (base58 format):\n\n` +
        `_This will add a NEW wallet to your account._\n` +
        `_Your existing wallets will remain unchanged._`;

    const keyboard = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.MENU}:wallet`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Process imported private key
 */
export async function processImportedKey(ctx: UserContext, privateKey: string): Promise<boolean> {
    const state = walletFlowState.get(ctx.user.telegram_id);
    if (!state || state.mode !== "import") {
        return false;
    }

    try {
        // Validate and import
        const { address, encryptedPrivateKey } = importWallet(privateKey.trim());

        // Check if wallet already exists for this user
        const existingWallets = getWallets(ctx.user.telegram_id);
        const alreadyExists = existingWallets.some(w => w.wallet_address === address);

        if (alreadyExists) {
            await ctx.reply("❌ This wallet is already added to your account.");
            clearWalletFlowState(ctx.user.telegram_id);
            return true;
        }

        // Add wallet
        const newWallet = addWallet(ctx.user.telegram_id, address, encryptedPrivateKey);

        const text = `✅ **Wallet Imported Successfully!**\n\n` +
            `Name: **${newWallet.name}**\n` +
            `Address: \`${address.slice(0, 8)}...${address.slice(-8)}\`\n\n` +
            `_Tap "Set Active" to use this wallet for trading._`;

        const keyboard = new InlineKeyboard()
            .text("✅ Set Active", `${CallbackPrefix.WALLET}:activate:${newWallet.id}`)
            .row()
            .text("⬅️ Back to Wallets", `${CallbackPrefix.MENU}:wallet`)
            .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

        await ctx.reply(text, {
            parse_mode: "Markdown",
            reply_markup: keyboard,
        });

        clearWalletFlowState(ctx.user.telegram_id);
        return true;

    } catch (error) {
        await ctx.reply("❌ Invalid private key. Please check and try again.");
        return true;
    }
}

// ============================================================================
// Generate New Wallet
// ============================================================================

/**
 * Generate a new wallet and add it to user's account
 */
export async function generateNewWallet(ctx: UserContext): Promise<void> {
    const { address, encryptedPrivateKey } = generateWallet();
    const newWallet = addWallet(ctx.user.telegram_id, address, encryptedPrivateKey);

    const text = `🆕 **New Wallet Generated!**\n\n` +
        `Name: **${newWallet.name}**\n` +
        `Address: \`${address}\`\n\n` +
        `⚠️ **Important:** Export and backup the private key!`;

    const keyboard = new InlineKeyboard()
        .text("✅ Set Active", `${CallbackPrefix.WALLET}:activate:${newWallet.id}`)
        .text("🔑 Export Key", `${CallbackPrefix.WALLET}:export:${newWallet.id}`)
        .row()
        .text("⬅️ Back to Wallets", `${CallbackPrefix.MENU}:wallet`)
        .text("🏠 Main Menu", `${CallbackPrefix.MENU}:main`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

// ============================================================================
// Wallet Actions
// ============================================================================

/**
 * Activate a wallet (make it the active wallet)
 */
export async function activateWallet(ctx: UserContext, walletId: number): Promise<void> {
    const success = switchWallet(ctx.user.telegram_id, walletId);

    if (success) {
        await ctx.answerCallbackQuery("✅ Wallet activated!");

        // Refresh autosell monitoring for new wallet (async, don't block UI)
        refreshUser(ctx.user.telegram_id).catch(err =>
            console.error(`❌ Failed to refresh autosell for user ${ctx.user.telegram_id}:`, err)
        );

        // Refresh the wallet details view
        await showWalletDetails(ctx, walletId);
    } else {
        await ctx.answerCallbackQuery("❌ Failed to activate wallet");
    }
}

/**
 * Show rename prompt
 */
export async function showRenameWallet(ctx: UserContext, walletId: number): Promise<void> {
    const wallet = getWalletById(walletId);
    if (!wallet) return;

    walletFlowState.set(ctx.user.telegram_id, {
        mode: "rename",
        walletId,
    });

    const text = `✏️ **Rename Wallet**\n\n` +
        `Current name: **${wallet.name}**\n\n` +
        `Enter a new name:`;

    const keyboard = new InlineKeyboard()
        .text("❌ Cancel", `${CallbackPrefix.WALLET}:select:${walletId}`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Process wallet rename
 */
export async function processRename(ctx: UserContext, newName: string): Promise<boolean> {
    const state = walletFlowState.get(ctx.user.telegram_id);
    if (!state || state.mode !== "rename" || !state.walletId) {
        return false;
    }

    const success = renameWallet(state.walletId, newName.trim());

    if (success) {
        await ctx.reply(`✅ Wallet renamed to "${newName.trim()}"`);
        clearWalletFlowState(ctx.user.telegram_id);
        return true;
    } else {
        await ctx.reply("❌ Failed to rename wallet");
        return true;
    }
}

/**
 * Delete wallet confirmation
 */
export async function showDeleteConfirm(ctx: UserContext, walletId: number): Promise<void> {
    const wallet = getWalletById(walletId);
    if (!wallet) return;

    const text = `🗑️ **Delete Wallet?**\n\n` +
        `Wallet: **${wallet.name}**\n` +
        `Address: \`${wallet.wallet_address.slice(0, 8)}...${wallet.wallet_address.slice(-8)}\`\n\n` +
        `⚠️ **This will NOT transfer any remaining funds!**\n` +
        `Make sure to withdraw or export the key first.`;

    const keyboard = new InlineKeyboard()
        .text("🗑️ Yes, Delete", `${CallbackPrefix.WALLET}:delete_confirm:${walletId}`)
        .text("❌ Cancel", `${CallbackPrefix.WALLET}:select:${walletId}`);

    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
}

/**
 * Execute wallet deletion
 */
export async function executeDeleteWallet(ctx: UserContext, walletId: number): Promise<void> {
    const result = deleteWallet(ctx.user.telegram_id, walletId);

    if (result.success) {
        await ctx.answerCallbackQuery("✅ Wallet deleted");
        await showWalletMenu(ctx);
    } else {
        await ctx.answerCallbackQuery(`❌ ${result.error}`);
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if user is in wallet flow
 */
export function isInWalletFlow(telegramId: number): boolean {
    return walletFlowState.has(telegramId);
}

/**
 * Get wallet flow state
 */
export function getWalletFlowState(telegramId: number): WalletFlowState | undefined {
    return walletFlowState.get(telegramId);
}

/**
 * Clear wallet flow state
 */
export function clearWalletFlowState(telegramId: number): void {
    walletFlowState.delete(telegramId);
}

/**
 * Handle text input for wallet flows
 */
export async function handleWalletInput(ctx: UserContext, text: string): Promise<boolean> {
    const state = walletFlowState.get(ctx.user.telegram_id);
    if (!state) return false;

    switch (state.mode) {
        case "import":
            return await processImportedKey(ctx, text);

        case "withdraw_address":
            await showWithdrawAmount(ctx, text);
            return true;

        case "withdraw_amount":
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) {
                await ctx.reply("❌ Invalid amount. Please enter a number.");
                return true;
            }
            if (state.walletId && state.withdrawAddress) {
                await showWithdrawConfirm(ctx, state.walletId, state.withdrawAddress, amount);
            }
            return true;

        case "export_confirm":
            if (text === "CONFIRM") {
                await revealPrivateKey(ctx);
            } else {
                await ctx.reply("❌ Please type exactly `CONFIRM` (case-sensitive) to reveal your key.", {
                    parse_mode: "Markdown",
                });
            }
            return true;

        case "rename":
            return await processRename(ctx, text);

        default:
            return false;
    }
}
