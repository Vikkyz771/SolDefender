/**
 * Buy execution - purchase tokens via Jupiter Ultra API
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { executeUltraBuy } from "../utils/jupiterUltra.js";
import { createPosition, getPosition } from "../database/positions.js";
import { recordBuy } from "../database/transactions.js";
import { addRecentToken } from "../database/tokens.js";
import { getTokenPrice, getTokenMarketCap } from "./quote.js";
import { getGlobalTPSL, getSettings } from "../database/settings.js";
import { addTPRule, addSLRule, addTrailingSL } from "../database/tpsl.js";
import { getSOLPriceSync } from "../utils/solPrice.js";

export interface BuyResult {
    success: boolean;
    signature?: string;
    tokenAmount?: string;
    error?: string;
}

/**
 * Execute a buy order via Jupiter Ultra API
 * Note: Slippage is automatically optimized by Ultra API
 */
export async function executeBuy(
    telegramId: number,
    walletId: number,
    tokenMint: string,
    tokenSymbol: string | null,
    solAmount: number,
    wallet: Keypair,
    slippageBps: number = 1500 // Kept for backward compatibility but not used
): Promise<BuyResult> {
    try {
        console.log(`🛒 Executing buy: ${solAmount} SOL → ${tokenMint.slice(0, 8)}...`);

        // Execute via Ultra API (handles slippage, priority fees, MEV protection automatically)
        const { signature, tokenAmount } = await executeUltraBuy(
            tokenMint,
            solAmount,
            wallet
        );

        // Calculate entry price from ACTUAL swap execution data
        // This is ALWAYS accurate, even for tokens DexScreener doesn't know yet
        const solPriceUSD = getSOLPriceSync();
        const tokensReceived = Number(tokenAmount);

        // Entry price = (SOL spent × SOL price in USD) / tokens received
        const calculatedEntryPrice = (solAmount * solPriceUSD) / tokensReceived;

        console.log(`📊 Entry price calculated from swap: $${calculatedEntryPrice.toExponential(4)}`);
        console.log(`   (${solAmount} SOL × $${solPriceUSD} / ${tokensReceived.toLocaleString()} tokens)`);

        // Fetch market cap for storage (non-blocking, null if unavailable)
        const entryMarketCap = await getTokenMarketCap(tokenMint);
        if (entryMarketCap) {
            console.log(`📊 Entry market cap: $${(entryMarketCap / 1e6).toFixed(2)}M`);
        }

        // Create/update position in database with calculated entry price and market cap
        const position = createPosition(
            telegramId,
            walletId,
            tokenMint,
            tokenSymbol,
            calculatedEntryPrice,
            tokenAmount,
            solAmount,
            entryMarketCap
        );

        // Apply global TP/SL defaults to new position
        // (Autosell monitor will handle selling if above threshold on its next poll)
        applyGlobalTPSLDefaults(telegramId, position.id, calculatedEntryPrice);

        // Record transaction
        recordBuy(
            telegramId,
            walletId,
            tokenMint,
            tokenSymbol,
            tokenAmount,
            solAmount,
            calculatedEntryPrice,
            signature
        );

        console.log(`✅ Buy complete: ${tokenAmount} tokens for ${solAmount} SOL`);

        // Track as recent token
        addRecentToken(telegramId, tokenMint, tokenSymbol || undefined);

        return {
            success: true,
            signature,
            tokenAmount,
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`❌ Buy failed:`, error);

        return {
            success: false,
            error: errorMessage,
        };
    }
}

/**
 * Apply global TP/SL defaults to a new position
 */
function applyGlobalTPSLDefaults(telegramId: number, positionId: number, entryPrice: number): void {
    const globalSettings = getGlobalTPSL(telegramId);

    if (globalSettings.default_tp_enabled) {
        addTPRule(positionId, globalSettings.default_tp_percent, globalSettings.default_tp_sell_percent);
        console.log(`🎯 Auto-applied global TP: +${globalSettings.default_tp_percent}%`);
    }

    if (globalSettings.default_sl_enabled) {
        addSLRule(positionId, -globalSettings.default_sl_percent, globalSettings.default_sl_sell_percent);
        console.log(`🛑 Auto-applied global SL: -${globalSettings.default_sl_percent}%`);
    }

    if (globalSettings.default_trail_enabled) {
        addTrailingSL(positionId, globalSettings.default_trail_percent, entryPrice);
        console.log(`📉 Auto-applied global Trail: ${globalSettings.default_trail_percent}%`);
    }
}

