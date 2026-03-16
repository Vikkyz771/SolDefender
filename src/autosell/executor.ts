/**
 * Sell Executor - Jupiter Ultra API swap execution
 */

import { Keypair } from "@solana/web3.js";
import { executeUltraSell, getSellQuote as getUltraSellQuote } from "../utils/jupiterUltra.js";
import { closeTokenAccount } from "../utils/wallet.js";
import { recordSell } from "../database/transactions.js";
import { formatUserError } from "../utils/errorMessages.js";
import { TrackedToken } from "./types.js";

export interface AutosellResult {
    success: boolean;
    signature?: string;
    error?: string;
    pnlPercent?: number;      // P&L percentage for notification
    estimatedSOL?: number;    // SOL received from sale
    entrySol?: number;        // Original entry SOL
    rentRecovered?: number;   // SOL recovered from closing account
}

/**
 * Execute a sell for a tracked token
 * Returns result object with success status and error details
 */
export async function executeSell(
    token: TrackedToken,
    wallet: Keypair,
    telegramId: number,
    slippageBps: number = 1500 // 15% slippage for volatile memecoins
): Promise<AutosellResult> {
    try {
        console.log(`🔥 [User ${telegramId}] SELLING ${token.mint.slice(0, 8)}... at ${token.currentProgress.toFixed(2)}% progress`);
        console.log(`   Balance: ${token.balance.toString()}`);

        // Get estimated SOL output for recording (non-blocking)
        let estimatedSOL = 0;
        try {
            const quote = await getUltraSellQuote(token.mint, token.balance, wallet.publicKey.toBase58());
            estimatedSOL = quote.estimatedSOL;
        } catch {
            // Non-blocking - we'll still execute even without quote
        }

        // Get position data for P&L calculation
        const { getPosition } = await import("../database/positions.js");
        const position = getPosition(telegramId, token.mint);
        const entrySol = position?.entry_sol || 0;

        // Calculate P&L
        let pnlPercent: number | null = null;
        if (entrySol > 0 && estimatedSOL > 0) {
            pnlPercent = ((estimatedSOL - entrySol) / entrySol) * 100;
            console.log(`📊 [User ${telegramId}] Autosell P&L: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% (${entrySol.toFixed(4)} SOL → ${estimatedSOL.toFixed(4)} SOL)`);
        }

        // Execute via Ultra API (handles slippage, priority fees, MEV protection automatically)
        const signature = await executeUltraSell(
            token.mint,
            token.balance,
            wallet
        );

        console.log(`✅ [User ${telegramId}] Sell complete: ${signature}`);

        // Record transaction in history WITH P&L
        recordSell(
            telegramId,
            token.walletId,
            token.mint,
            null, // No symbol in TrackedToken, but history will still work
            token.balance.toString(),
            estimatedSOL,
            0, // Price in USD - not used
            signature,
            pnlPercent // Now passing calculated P&L!
        );

        // Close empty token account to recover rent
        let rentRecovered = 0;
        try {
            // Small delay to let the sell transaction fully confirm
            await new Promise(resolve => setTimeout(resolve, 1000));

            const closeResult = await closeTokenAccount(token.mint, wallet);
            if (closeResult.success) {
                rentRecovered = closeResult.rentRecovered || 0;
                console.log(`💰 [User ${telegramId}] Recovered ${rentRecovered.toFixed(6)} SOL from closing account`);
            }
        } catch (closeError) {
            // Non-blocking - account close failure shouldn't affect the sell success
            console.log(`⚠️ [User ${telegramId}] Could not close token account (may still have tokens or already closed)`);
        }

        // Additional delay to let wallet balance settle before notification
        // This ensures the user sees the correct balance in their wallet
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log(`✅ [User ${telegramId}] Wallet balance settled, ready to notify`);

        return {
            success: true,
            signature,
            pnlPercent: pnlPercent ?? undefined,
            estimatedSOL,
            entrySol,
            rentRecovered,
        };

    } catch (error) {
        const errorMessage = formatUserError(error);
        console.error(`❌ [User ${telegramId}] Sell failed for ${token.mint.slice(0, 8)}...:`, error);
        return { success: false, error: errorMessage };
    }
}

/**
 * Execute sells for multiple tokens (batch processing)
 */
export async function executeBatchSells(
    tokens: TrackedToken[],
    wallet: Keypair,
    slippageBps: number = 1500
): Promise<Map<string, AutosellResult>> {
    const results = new Map<string, AutosellResult>();

    // Execute sequentially to avoid nonce issues
    for (const token of tokens) {
        const result = await executeSell(token, wallet, token.telegramId, slippageBps);
        results.set(token.mint, result);

        // Small delay between transactions
        if (tokens.indexOf(token) < tokens.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    return results;
}

