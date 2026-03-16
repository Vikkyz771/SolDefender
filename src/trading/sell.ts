/**
 * Sell execution - sell tokens via Jupiter Ultra API
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { executeUltraSell, getSellQuote as getUltraSellQuote } from "../utils/jupiterUltra.js";
import { getPosition, updatePositionAmount, closePosition, Position } from "../database/positions.js";
import { recordSell } from "../database/transactions.js";
import { getWalletTokenHoldings, closeTokenAccount } from "../utils/wallet.js";
import { clearPoolCache } from "../cache/pools.js";
import { stopTracking } from "../autosell/index.js";

export interface SellResult {
    success: boolean;
    signature?: string;
    solReceived?: number;
    pnlPercent?: number;
    rentRecovered?: number; // SOL recovered from closing account
    error?: string;
}

/**
 * Get token balance for a user's wallet
 */
async function getTokenBalance(walletPubkey: PublicKey, tokenMint: string): Promise<bigint> {
    const holdings = await getWalletTokenHoldings(walletPubkey);
    const holding = holdings.find(h => h.mint.toBase58() === tokenMint);
    return holding?.balance || 0n;
}

/**
 * Execute a sell by percentage of holdings
 * If 100% is sold, automatically closes the token account to recover rent
 */
export async function executeSellPercent(
    telegramId: number,
    walletId: number,
    tokenMint: string,
    tokenSymbol: string | null,
    sellPercent: number,
    wallet: Keypair,
    slippageBps: number = 1500
): Promise<SellResult> {
    try {
        // Get token amount from position in database (more reliable than RPC for new buys)
        // RPC balance queries have significant latency issues, especially for Pump.fun tokens
        const position = getPosition(telegramId, tokenMint);
        let tokenAmount: bigint;

        if (position && position.entry_amount) {
            // Use position data - this is set from the actual Jupiter buy confirmation
            tokenAmount = BigInt(position.entry_amount);
            console.log(`📊 Using position data: ${tokenAmount} tokens (from DB)`);
        } else {
            // Fallback to RPC balance for untracked tokens (external transfers, etc.)
            console.log(`⚠️ No position found, falling back to RPC balance query`);
            const balance = await getTokenBalance(wallet.publicKey, tokenMint);
            if (balance === 0n) {
                return { success: false, error: "No tokens to sell" };
            }
            tokenAmount = balance;
        }

        // Calculate amount to sell
        const sellAmount = (tokenAmount * BigInt(sellPercent)) / 100n;
        if (sellAmount === 0n) {
            return { success: false, error: "Sell amount too small" };
        }

        // Execute the sell
        const result = await executeSellExact(
            telegramId,
            walletId,
            tokenMint,
            tokenSymbol,
            sellAmount,
            wallet,
            slippageBps
        );

        // If 100% sell was successful, auto-close the token account
        if (result.success && sellPercent === 100) {
            console.log("📌 100% sell detected - attempting to close token account...");

            // Small delay to let the sell transaction confirm
            await new Promise(resolve => setTimeout(resolve, 1000));

            const closeResult = await closeTokenAccount(tokenMint, wallet);
            if (closeResult.success) {
                result.rentRecovered = closeResult.rentRecovered;

                // Additional delay to let wallet balance settle before notification
                await new Promise(resolve => setTimeout(resolve, 500));
                console.log(`✅ Wallet balance settled, ready to notify`);
            }
        }

        return result;

    } catch (error) {
        const errorMessage = parseJupiterError(error);
        console.error(`❌ Sell failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
}

/**
 * Parse Jupiter/Solana errors into friendly messages
 */
function parseJupiterError(error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : String(error);

    // Slippage exceeded (0x1771 = 6001)
    if (rawMessage.includes("0x1771") || rawMessage.includes("6001")) {
        return "Slippage exceeded - price moved too fast. Will retry...";
    }

    // Insufficient funds
    if (rawMessage.includes("insufficient") || rawMessage.includes("InsufficientFunds")) {
        return "Insufficient funds for transaction";
    }

    // No route found
    if (rawMessage.includes("COULD_NOT_FIND_ANY_ROUTE") || rawMessage.includes("No liquidity")) {
        return "No liquidity available for this token";
    }

    // Rate limited
    if (rawMessage.includes("429") || rawMessage.includes("Too Many Requests")) {
        return "Rate limited - retrying...";
    }

    // Transaction simulation failed - extract key info only
    if (rawMessage.includes("Simulation failed")) {
        if (rawMessage.includes("0x1771")) {
            return "Slippage exceeded - price moved too fast. Will retry...";
        }
        return "Transaction simulation failed - market conditions changed";
    }

    // Return a shortened version of long errors
    if (rawMessage.length > 100) {
        return rawMessage.substring(0, 100) + "...";
    }

    return rawMessage;
}

/**
 * Execute a sell with exact token amount
 */
export async function executeSellExact(
    telegramId: number,
    walletId: number,
    tokenMint: string,
    tokenSymbol: string | null,
    tokenAmount: bigint,
    wallet: Keypair,
    slippageBps: number = 1500
): Promise<SellResult> {
    try {
        console.log(`💸 Executing sell: ${tokenAmount} ${tokenMint.slice(0, 8)}... → SOL`);

        // Get position for P&L calculation
        const position = getPosition(telegramId, tokenMint);
        const entrySol = position?.entry_sol || 0;

        // Execute via Ultra API (handles slippage, priority fees, MEV protection automatically)
        const signature = await executeUltraSell(
            tokenMint,
            tokenAmount,
            wallet
        );

        // Get actual SOL received from a fresh quote (approximation)
        const { estimatedSOL } = await getUltraSellQuote(tokenMint, tokenAmount, wallet.publicKey.toBase58()).catch(() => ({
            estimatedSOL: 0,
        }));

        // Calculate SOL-based P&L (proportional to tokens sold)
        // We need to calculate P&L based on proportional entry cost, not total entry
        let pnlPercent: number | null = null;
        if (position && entrySol > 0 && estimatedSOL > 0) {
            // Get total tokens in position to calculate sell ratio
            const totalTokens = BigInt(position.entry_amount);

            // Calculate proportional entry cost for the tokens being sold
            // proportionalEntry = entry_sol * (tokens_being_sold / total_tokens)
            const sellRatio = Number(tokenAmount) / Number(totalTokens);
            const proportionalEntrySol = entrySol * sellRatio;

            // P&L = (received - proportional_entry) / proportional_entry * 100
            if (proportionalEntrySol > 0) {
                pnlPercent = ((estimatedSOL - proportionalEntrySol) / proportionalEntrySol) * 100;
            }
        }

        // Check actual wallet balance after sell to determine if position should close
        const remainingBalance = await getTokenBalance(wallet.publicKey, tokenMint);

        // Update position in database
        if (position) {
            if (remainingBalance === 0n) {
                // No tokens left - close the position completely
                closePosition(position.id);
                // Clear cached pool for this token
                clearPoolCache(tokenMint);
                // Stop autosell monitoring for this token
                stopTracking(telegramId, tokenMint);
                console.log(`📊 Position closed: ${tokenMint.slice(0, 8)}... (no tokens remaining)`);
            } else {
                // Update with actual remaining balance
                updatePositionAmount(position.id, remainingBalance.toString());
            }
        } else {
            // No position but still sold - might be untracked token
            // Still try to stop tracking in case it was being monitored
            stopTracking(telegramId, tokenMint);
        }

        // Record transaction with SOL-based P&L
        recordSell(
            telegramId,
            walletId,
            tokenMint,
            tokenSymbol,
            tokenAmount.toString(),
            estimatedSOL,
            0, // Price in USD - not used for P&L anymore
            signature,
            pnlPercent
        );

        const pnlStr = pnlPercent !== null
            ? ` (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`
            : "";
        console.log(`✅ Sell complete: ${tokenAmount} tokens for ~${estimatedSOL.toFixed(4)} SOL${pnlStr}`);

        return {
            success: true,
            signature,
            solReceived: estimatedSOL,
            pnlPercent: pnlPercent || undefined,
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`❌ Sell failed:`, error);
        return { success: false, error: errorMessage };
    }
}

/**
 * Close all positions (sell all tokens and close accounts)
 */
export async function closeAllPositions(
    telegramId: number,
    walletId: number,
    wallet: Keypair,
    slippageBps: number = 1500
): Promise<{ successes: number; failures: number; rentRecovered: number }> {
    const holdings = await getWalletTokenHoldings(wallet.publicKey);

    let successes = 0;
    let failures = 0;
    let rentRecovered = 0;

    for (const holding of holdings) {
        const tokenMint = holding.mint.toBase58();

        // Use executeSellPercent with 100% to get full flow including account closure
        const result = await executeSellPercent(
            telegramId,
            walletId,
            tokenMint,
            null,
            100, // Sell 100% triggers account closure
            wallet,
            slippageBps
        );

        if (result.success) {
            successes++;
            if (result.rentRecovered) {
                rentRecovered += result.rentRecovered;
            }
        } else {
            failures++;
        }

        // Small delay between sells
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`🧹 Close All: ${successes} sold, ${failures} failed, ${rentRecovered.toFixed(4)} SOL recovered`);
    return { successes, failures, rentRecovered };
}
