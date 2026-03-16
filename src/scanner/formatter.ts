import { SecurityCheckResult, checkMeteoraSafety, checkLPSafety, formatLPSafetyReport } from "./checks/index.js";
import { LiquidityRiskResult } from "./checks/liquidity/index.js";

/**
 * Get risk level emoji and label based on score
 */
function getRiskLevel(score: number): { emoji: string; label: string } {
    if (score >= 70) return { emoji: "🔴", label: "HIGH RISK" };
    if (score >= 40) return { emoji: "🟠", label: "MEDIUM RISK" };
    if (score >= 20) return { emoji: "🟡", label: "LOW RISK" };
    return { emoji: "🟢", label: "SAFE" };
}

/**
 * Format boolean as checkmark/cross
 */
function formatBool(value: boolean, invertMeaning = false): string {
    const good = invertMeaning ? value : !value;
    return good ? "✅" : "❌";
}

/**
 * Format USD amount with K/M suffixes
 */
function formatUSD(amount: number): string {
    if (amount >= 1_000_000) {
        return "$" + (amount / 1_000_000).toFixed(2) + "M";
    }
    if (amount >= 1_000) {
        return "$" + (amount / 1_000).toFixed(1) + "K";
    }
    return "$" + amount.toFixed(0);
}

/**
 * Generate progress bar for bonding curve
 */
function generateProgressBar(progress: number): string {
    const filled = Math.round(progress / 10);
    const empty = 10 - filled;
    return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Format security check result as Telegram HTML message
 */
export async function formatSecurityReport(
    contractAddress: string,
    result: SecurityCheckResult
): Promise<string> {

    const { authority, metadata, liquidity, riskScore, riskFactors } = result;
    const risk = getRiskLevel(riskScore);

    // Header
    let report = `<b>${risk.emoji} Token Security Report</b>\n`;
    report += `<code>${contractAddress}</code>\n\n`;

    // Show error if critical failure
    if (result.error) {
        report += `<b>⚠️ Analysis Error:</b> ${result.error}\n\n`;
    }

    // Token info (if available)
    if (metadata.name || metadata.symbol) {
        report += `<b>📋 Token:</b> ${metadata.name || "Unknown"} (${metadata.symbol || "???"})\n\n`;
    }

    // Risk score
    report += `<b>⚠️ Risk Score:</b> ${riskScore}/100 - ${risk.label}\n\n`;

    // Authority checks
    report += `<b>🔐 Authorities</b>\n`;
    if (authority.error) {
        report += `⚠️ Could not check (${authority.error})\n\n`;
    } else {
        report += `${formatBool(authority.mintAuthorityEnabled)} Mint Authority: ${authority.mintAuthorityEnabled ? "ENABLED" : "Revoked"}\n`;
        report += `${formatBool(authority.freezeAuthorityEnabled)} Freeze Authority: ${authority.freezeAuthorityEnabled ? "ENABLED" : "Revoked"}\n\n`;
    }

    // Metadata checks
    report += `<b>📝 Metadata</b>\n`;
    if (!metadata.hasMetadata) {
        report += `⚠️ No metadata found\n\n`;
    } else {
        report += `${formatBool(metadata.isMutable)} Mutability: ${metadata.isMutable ? "MUTABLE" : "Immutable"}\n\n`;
    }

    // Liquidity section
    if (liquidity) {
        report += await formatLiquiditySection(contractAddress, liquidity);
    }

    // Risk factors
    if (riskFactors.length > 0) {
        report += `<b>⚠️ Risk Factors</b>\n`;
        for (const factor of riskFactors) {
            report += `• ${factor}\n`;
        }
    }

    return report;
}

/**
 * Format liquidity section based on bonding curve vs graduated
 */
async function formatLiquiditySection(contractAddress: string, liquidity: LiquidityRiskResult): Promise<string> {
    if (liquidity.isBondingCurve) {
        return await formatBondingCurveSection(contractAddress, liquidity);
    }
    return await formatDexPoolsSection(contractAddress, liquidity);
}

/**
 * Format bonding curve section
 */
async function formatBondingCurveSection(contractAddress: string, liq: LiquidityRiskResult): Promise<string> {
    const platformNames: Record<string, string> = {
        "PUMPFUN": "Pump.fun",
        "RAYDIUM_LAUNCHLAB": "Bonk.fun",
        "METEORA_DBC": "Meteora",
        "MOONSHOT": "Moonshot",
    };

    const platformName = platformNames[liq.platform || ""] || liq.platform || "Unknown";
    const progress = liq.curveProgress || 0;
    const bar = generateProgressBar(progress);

    let section = `<b>📈 Launchpad: ${platformName}</b>\n`;
    section += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    section += `   Progress: ${bar} ${progress.toFixed(1)}%\n\n`;

    // Add Meteora-specific safety checks
    if (liq.platform === "METEORA_DBC") {
        try {
            const meteoraSafety = await checkMeteoraSafety(contractAddress);
            if (meteoraSafety.isMeteoraToken && meteoraSafety.safetyLines.length > 0) {
                section += `<b>🔒 Pool Safety</b>\n`;
                for (const line of meteoraSafety.safetyLines) {
                    section += `${line}\n`;
                }
                section += `\n`;
            }
        } catch (error) {
            console.warn("⚠️ Could not fetch Meteora safety:", error);
        }
    }

    return section;
}

/**
 * Format DEX pools section with universal LP safety check (works for all DEXes)
 */
async function formatDexPoolsSection(contractAddress: string, liq: LiquidityRiskResult): Promise<string> {
    let section = `<b>💱 Token is Graduated</b>\n`;
    section += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    section += `Token is trading on DEX pools.\n\n`;

    // Use new universal LP safety check (works for Raydium, Meteora, Orca, etc.)
    try {
        const lpSafety = await checkLPSafety(contractAddress);
        if (lpSafety) {
            section += formatLPSafetyReport(lpSafety);
            section += `\n`;
        }
    } catch (error) {
        console.warn("⚠️ Could not check LP safety:", error);
    }

    return section;
}

/**
 * Get display name for DEX
 */
function getDexDisplayName(dex: string): string {
    const names: Record<string, string> = {
        "raydium_amm": "Raydium AMM",
        "raydium_clmm": "Raydium CLMM",
        "raydium_cpmm": "Raydium CPMM",
        "orca_whirlpool": "Orca",
        "orca_legacy": "Orca Legacy",
        "meteora_dlmm": "Meteora DLMM",
        "meteora_pools": "Meteora",
        "lifinity": "Lifinity",
    };
    return names[dex] || dex;
}

/**
 * Get soonest unlock time from holders
 */
function getSoonestUnlock(holders: Array<{ details?: { daysToUnlock?: number } }>): number | null {
    let soonest: number | null = null;

    for (const holder of holders) {
        const days = holder.details?.daysToUnlock;
        if (days !== undefined && days > 0) {
            if (soonest === null || days < soonest) {
                soonest = days;
            }
        }
    }

    return soonest;
}
