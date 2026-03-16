import { checkAuthorities, AuthorityCheckResult } from "./authority.js";
import { checkMetadata, MetadataCheckResult } from "./metadata.js";
import { checkLiquidityRisk, LiquidityRiskResult } from "./liquidity/index.js";

export interface SecurityCheckResult {
    authority: AuthorityCheckResult;
    metadata: MetadataCheckResult;
    liquidity: LiquidityRiskResult | null;
    riskScore: number; // 0-100, higher = more risky
    riskFactors: string[];
    error?: string;
}

/**
 * Run all security checks on a token
 * Checks: Mint Authority, Freeze Authority, Metadata Mutability, Liquidity Lock
 */
export async function runSecurityChecks(mintAddress: string): Promise<SecurityCheckResult> {
    try {
        // Run all checks in parallel
        const [authority, metadata, liquidity] = await Promise.all([
            checkAuthorities(mintAddress),
            checkMetadata(mintAddress),
            checkLiquidityRisk(mintAddress).catch((error) => {
                console.warn("⚠️ Liquidity check failed:", error);
                return null;
            }),
        ]);

        // Calculate risk score
        const riskFactors: string[] = [];
        let riskScore = 0;

        // Check for errors in individual checks
        if (authority.error) {
            riskFactors.push(`Authority check failed: ${authority.error}`);
        }

        // Authority risks (40 points each = 80 total)
        if (authority.mintAuthorityEnabled) {
            riskScore += 40;
            riskFactors.push("Mint authority enabled - can create unlimited tokens");
        }
        if (authority.freezeAuthorityEnabled) {
            riskScore += 40;
            riskFactors.push("Freeze authority enabled - can freeze your tokens");
        }

        // Metadata risks (20 points)
        if (metadata.isMutable) {
            riskScore += 20;
            riskFactors.push("Metadata is mutable - token info can be changed");
        }

        // Liquidity risks (30 points max)
        if (liquidity) {
            riskScore += liquidity.riskScore;
            riskFactors.push(...liquidity.riskFactors);
        }

        return {
            authority,
            metadata,
            liquidity,
            riskScore: Math.min(100, riskScore),
            riskFactors,
        };
    } catch (error) {
        console.error(`Critical error in security checks for ${mintAddress}:`, error);
        // Return a safe default with error info
        return {
            authority: {
                mintAuthorityEnabled: false,
                mintAuthority: null,
                freezeAuthorityEnabled: false,
                freezeAuthority: null,
                error: "Check failed",
            },
            metadata: {
                hasMetadata: false,
                isMutable: false,
                name: null,
                symbol: null,
                updateAuthority: null,
            },
            liquidity: null,
            riskScore: 0,
            riskFactors: [],
            error: error instanceof Error ? error.message : "Unknown error analyzing token",
        };
    }
}

export { checkAuthorities, checkMetadata };
export { checkMeteoraSafety, formatMeteoraSafetyReport } from "./meteora.js";
export { checkPostGraduationSafety, formatPostGraduationReport } from "./meteora-graduated.js";
export { checkLPSafety, formatLPSafetyReport } from "./lp-safety.js";
export { getMainPool, getTokenPools, hasGraduated } from "./dexscreener.js";
export type { AuthorityCheckResult, MetadataCheckResult, LiquidityRiskResult };
export type { MeteoraSafetyResult } from "./meteora.js";
export type { PostGraduationSafety } from "./meteora-graduated.js";
export type { LPSafetyResult, LPHolder } from "./lp-safety.js";
export type { DexScreenerPool } from "./dexscreener.js";
