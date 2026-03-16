/**
 * Trailing Stop Loss logic
 * Handles peak price tracking and threshold calculations
 */

import { TPSLRule, updatePeakPrice } from "../database/tpsl.js";

export interface TrailingSLResult {
    newPeak: boolean;       // Whether a new peak was recorded
    shouldTrigger: boolean; // Whether the trailing SL should execute
    currentThreshold: number; // Current trigger price
}

/**
 * Update and check a trailing stop loss
 * 
 * @param rule - The trailing SL rule
 * @param currentPrice - Current token price in USD
 * @returns Result with new peak status and trigger status
 */
export function checkTrailingSL(
    rule: TPSLRule,
    currentPrice: number
): TrailingSLResult {
    if (rule.type !== "TRAILING_SL") {
        throw new Error("Not a trailing SL rule");
    }

    const trailDistance = rule.trail_distance!;
    const peakPrice = rule.peak_price || currentPrice;

    // Calculate the trigger threshold
    // If trail distance is 20%, trigger when price drops 20% below peak
    const threshold = peakPrice * (1 - trailDistance / 100);

    // Check if price made a new high
    if (currentPrice > peakPrice) {
        // Update peak price in database
        updatePeakPrice(rule.id, currentPrice);

        return {
            newPeak: true,
            shouldTrigger: false,
            currentThreshold: currentPrice * (1 - trailDistance / 100),
        };
    }

    // Check if price dropped below threshold
    const shouldTrigger = currentPrice <= threshold;

    return {
        newPeak: false,
        shouldTrigger,
        currentThreshold: threshold,
    };
}

/**
 * Calculate trailing SL threshold from peak
 */
export function calculateTrailingThreshold(
    peakPrice: number,
    trailDistancePercent: number
): number {
    return peakPrice * (1 - trailDistancePercent / 100);
}

/**
 * Format trailing SL info for display
 */
export function formatTrailingSLInfo(rule: TPSLRule): string {
    if (rule.type !== "TRAILING_SL") return "";

    const peak = rule.peak_price || 0;
    const trail = rule.trail_distance || 0;
    const threshold = calculateTrailingThreshold(peak, trail);

    return `📉 Trail: ${trail}% | Peak: $${peak.toFixed(8)} | Trigger: $${threshold.toFixed(8)}`;
}
