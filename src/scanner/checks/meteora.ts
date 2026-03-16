/**
 * Meteora DBC Token Safety Check
 * 
 * Checks Meteora Dynamic Bonding Curve tokens for rug risk:
 * - LP lock percentage (higher = safer)
 * - Claimable LP percentage (lower = safer)
 * - Vesting on claimable LP (if any)
 * 
 * Returns human-readable lines with ✅/❌ indicators
 */

import { detectPlatform, deriveCurveAccount, getMeteoraPoolSafety } from "../../autosell/platforms/index.js";
import { Platform } from "../../autosell/types.js";
import type { MeteoraPoolSafety } from "../../autosell/platforms/index.js";

/**
 * Meteora safety check result
 */
export interface MeteoraSafetyResult {
    isMeteoraToken: boolean;
    poolAddress: string | null;
    migrated: boolean;
    progress: number;
    migrationTarget: string;

    // Human-readable safety lines with emoji indicators
    safetyLines: string[];

    // Raw data for programmatic access
    rawData: MeteoraPoolSafety | null;
}

/**
 * Check Meteora DBC token safety
 * Returns human-readable safety report with ✅/❌ indicators
 * 
 * Thresholds:
 * - LP Locked ≥50% → ✅
 * - Claimable LP ≤20% → ✅ (auto ✅ if 0%)
 * - Vesting enabled → ✅ (auto ✅ if no claimable LP)
 */
export async function checkMeteoraSafety(tokenMint: string): Promise<MeteoraSafetyResult> {
    // Default result for non-Meteora tokens
    const defaultResult: MeteoraSafetyResult = {
        isMeteoraToken: false,
        poolAddress: null,
        migrated: false,
        progress: 0,
        migrationTarget: 'N/A',
        safetyLines: [],
        rawData: null,
    };

    try {
        // 1. Detect if this is a Meteora DBC token
        const platform = await detectPlatform(tokenMint);

        if (platform !== Platform.METEORA_DBC) {
            return defaultResult;
        }

        // 2. Get pool address
        const poolAddress = await deriveCurveAccount(tokenMint, Platform.METEORA_DBC);

        if (!poolAddress) {
            return {
                ...defaultResult,
                isMeteoraToken: true,
                safetyLines: ["⚠️ Could not find Meteora pool address"],
            };
        }

        // 3. Get full safety data
        const safety = await getMeteoraPoolSafety(poolAddress);

        if (!safety) {
            return {
                ...defaultResult,
                isMeteoraToken: true,
                poolAddress,
                safetyLines: ["⚠️ Could not fetch pool safety configuration"],
            };
        }

        // 4. Build safety report lines with ✅/❌
        const safetyLines: string[] = [];

        // LP Locked check (≥50% = good)
        const lpLockedGood = safety.totalLockedLpPercentage >= 50;
        safetyLines.push(
            `${lpLockedGood ? '✅' : '❌'} ${safety.totalLockedLpPercentage.toFixed(1)}% LP permanently locked`
        );

        // Claimable LP check (≤20% = good, 0% = auto good)
        const noClaimableLP = safety.totalClaimableLpPercentage === 0;
        const claimableGood = noClaimableLP || safety.totalClaimableLpPercentage <= 20;
        safetyLines.push(
            `${claimableGood ? '✅' : '❌'} ${safety.totalClaimableLpPercentage.toFixed(1)}% LP claimable by creator`
        );

        // Vesting check (auto good if no claimable LP)
        // If there's no claimable LP, vesting is irrelevant so we give it a checkmark
        const vestingGood = noClaimableLP || safety.hasVesting;
        const vestingText = noClaimableLP
            ? "N/A (no claimable LP)"
            : safety.hasVesting
                ? "Vesting enabled on claimable LP"
                : "No vesting on claimable LP";
        safetyLines.push(`${vestingGood ? '✅' : '❌'} ${vestingText}`);

        // Migration keeper warning (requires >= $750 USD quoteReserve)
        // If quoteReserve is too low, token may get STUCK after graduation!
        if (safety.migrationAtRisk) {
            safetyLines.push(``);
            safetyLines.push(`🚨 MIGRATION RISK: Pool has ~$${safety.quoteReserveUsd.toFixed(0)} liquidity`);
            safetyLines.push(`   Migration keepers require ≥$750 USD`);
            safetyLines.push(`   Token may get STUCK after graduation!`);
        }

        return {
            isMeteoraToken: true,
            poolAddress,
            migrated: safety.migrated,
            progress: safety.progress,
            migrationTarget: safety.migrationOption,
            safetyLines,
            rawData: safety,
        };

    } catch (error) {
        console.error("❌ [Meteora Safety Check] Error:", (error as Error).message);
        return {
            ...defaultResult,
            safetyLines: [`⚠️ Error checking safety: ${(error as Error).message}`],
        };
    }
}

/**
 * Format Meteora safety result for display (e.g., Telegram message)
 */
export function formatMeteoraSafetyReport(result: MeteoraSafetyResult): string {
    if (!result.isMeteoraToken) {
        return "ℹ️ Not a Meteora DBC token";
    }

    const lines: string[] = [
        "📊 **Meteora Pool Safety**",
        "",
    ];

    // Add safety lines
    lines.push(...result.safetyLines);

    // Add migration info
    lines.push("");
    lines.push(`📍 Migration target: ${result.migrationTarget}`);
    lines.push(`📈 Progress: ${result.progress.toFixed(1)}% to graduation`);

    if (result.migrated) {
        lines.push("✨ Token has already graduated");
    }

    return lines.join("\n");
}
