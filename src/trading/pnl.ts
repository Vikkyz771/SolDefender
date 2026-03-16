/**
 * P&L Calculation Utilities
 * Provides profit/loss calculations for positions and portfolios
 */

import { Position } from "../database/positions.js";
import { Transaction } from "../database/transactions.js";
import { getSOLPriceSync } from "../utils/solPrice.js";

export interface PnLResult {
    pnlPercent: number;
    pnlSOL: number;
    pnlUSD: number;
    currentValueSOL: number;
}

export interface PortfolioStats {
    totalValueSOL: number;
    totalValueUSD: number;
    realizedPnLSOL: number;
    realizedPnLUSD: number;
    winCount: number;
    lossCount: number;
    winRate: number;
}

/**
 * Calculate P&L for a position given current SOL value
 */
export function calculatePnL(entrySol: number, currentSolValue: number): PnLResult {
    const solPrice = getSOLPriceSync();

    // Avoid division by zero for externally acquired tokens
    if (entrySol <= 0) {
        return {
            pnlPercent: 0,
            pnlSOL: 0,
            pnlUSD: 0,
            currentValueSOL: currentSolValue,
        };
    }

    const pnlSOL = currentSolValue - entrySol;
    const pnlPercent = ((currentSolValue - entrySol) / entrySol) * 100;
    const pnlUSD = pnlSOL * solPrice;

    return {
        pnlPercent,
        pnlSOL,
        pnlUSD,
        currentValueSOL: currentSolValue,
    };
}

/**
 * Calculate portfolio statistics from positions and transactions
 */
export function getPortfolioStats(
    positions: Position[],
    currentValuesSOL: Map<string, number>,
    transactions: Transaction[]
): PortfolioStats {
    const solPrice = getSOLPriceSync();

    // Calculate total portfolio value
    let totalValueSOL = 0;
    for (const position of positions) {
        const currentValue = currentValuesSOL.get(position.token_mint) || 0;
        totalValueSOL += currentValue;
    }

    // Calculate realized P&L from SELL transactions only
    // Realized P&L = cumulative (profit or loss) from each completed sell
    // Formula: For each sell, profit = SOL_received - entry_cost_for_tokens_sold
    // We derive entry_cost from: entry_cost = SOL_received / (1 + pnl_percent/100)
    let realizedPnLSOL = 0;
    let winCount = 0;
    let lossCount = 0;

    for (const tx of transactions) {
        // Only process SELL transactions with a recorded P&L percentage
        if (tx.type === "SELL" && tx.pnl_percent !== null) {
            // Count wins and losses
            if (tx.pnl_percent > 0) {
                winCount++;
            } else if (tx.pnl_percent < 0) {
                lossCount++;
            }

            // Calculate the actual profit/loss in SOL for this trade:
            // pnl_percent = ((sol_received - entry_cost) / entry_cost) * 100
            // Rearranging: entry_cost = sol_received / (1 + pnl_percent/100)
            // profit = sol_received - entry_cost
            const pnlMultiplier = 1 + (tx.pnl_percent / 100);
            if (pnlMultiplier > 0) {
                const entryValueForSoldTokens = tx.sol_amount / pnlMultiplier;
                const tradeProfitSOL = tx.sol_amount - entryValueForSoldTokens;
                realizedPnLSOL += tradeProfitSOL;
            }
        }
    }

    const totalTrades = winCount + lossCount;
    const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;

    return {
        totalValueSOL,
        totalValueUSD: totalValueSOL * solPrice,
        realizedPnLSOL,
        realizedPnLUSD: realizedPnLSOL * solPrice,
        winCount,
        lossCount,
        winRate,
    };
}

/**
 * Format P&L as a display string with emoji
 */
export function formatPnL(pnlPercent: number): string {
    const sign = pnlPercent >= 0 ? "+" : "";
    const emoji = pnlPercent >= 0 ? "🟢" : "🔴";
    return `${sign}${pnlPercent.toFixed(1)}% ${emoji}`;
}

/**
 * Format P&L with SOL and USD values
 */
export function formatPnLFull(pnlPercent: number, pnlSOL: number, pnlUSD: number): string {
    const sign = pnlPercent >= 0 ? "+" : "";
    const emoji = pnlPercent >= 0 ? "🟢" : "🔴";
    const solSign = pnlSOL >= 0 ? "+" : "";

    return `${sign}${pnlPercent.toFixed(1)}% (${solSign}${pnlSOL.toFixed(4)} SOL / ~$${Math.abs(pnlUSD).toFixed(2)}) ${emoji}`;
}

/**
 * Format market cap for display
 */
export function formatMarketCap(marketCap: number | null): string {
    if (marketCap === null || marketCap === 0) {
        return "N/A";
    }

    if (marketCap >= 1e9) {
        return `$${(marketCap / 1e9).toFixed(2)}B`;
    } else if (marketCap >= 1e6) {
        return `$${(marketCap / 1e6).toFixed(2)}M`;
    } else if (marketCap >= 1e3) {
        return `$${(marketCap / 1e3).toFixed(2)}K`;
    }

    return `$${marketCap.toFixed(2)}`;
}

/**
 * Format time duration for "held for" display
 */
export function formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h`;
    } else if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m`;
    }

    return "&lt; 1m";
}
