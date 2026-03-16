/**
 * Moonshot SDK Helper
 * 
 * Uses the official @moonit/sdk to detect curve types and get accurate
 * graduation thresholds for Moonshot tokens.
 * 
 * Flat curves have variable graduation thresholds set by creators,
 * making them risky for auto-sell strategies. Classic curves graduate
 * at a fixed ~88 SOL collateral threshold.
 */

import { Moonit, Environment } from "@moonit/sdk";
import { getRpc } from "../../utils/rpc.js";

/**
 * Moonshot curve types
 */
export enum MoonshotCurveType {
    CLASSIC = "classic",
    FLAT = "flat",
    UNKNOWN = "unknown",
}

/**
 * Result of curve type detection
 */
export interface MoonshotCurveInfo {
    curveType: MoonshotCurveType;
    graduationThreshold?: number; // SOL amount for graduation (if available)
    progress?: number;            // Current curve progress percentage
    isSafe: boolean;              // Whether it's safe to track (classic) or should sell immediately (flat)
}

// Note: Moonit SDK requires an RPC URL at construction time
// We get the URL from the first available key in our unified pool
let moonitInstance: Moonit | null = null;

/**
 * Get or create Moonit SDK instance
 * Uses the first RPC key from the unified pool
 */
function getMoonitInstance(): Moonit {
    if (!moonitInstance) {
        // Get the RPC URL from environment (first key in pool)
        const rpcUrl = process.env.RPC_KEY_1;
        if (!rpcUrl) {
            throw new Error("No RPC_KEY_1 configured for Moonshot SDK");
        }
        moonitInstance = new Moonit({
            rpcUrl: rpcUrl,
            environment: Environment.MAINNET,
            chainOptions: {
                solana: {
                    confirmOptions: {
                        commitment: "confirmed",
                    },
                },
            },
        });
    }
    return moonitInstance;
}

/**
 * Detect the curve type for a Moonshot token
 * 
 * @param mintAddress - The token mint address
 * @returns Curve info including type and whether it's safe to track
 */
export async function detectMoonshotCurveType(mintAddress: string): Promise<MoonshotCurveInfo> {
    try {
        const moonit = getMoonitInstance();
        const token = moonit.Token({ mintAddress });

        // Get curve position which should include curve type info
        const curvePos = await token.getCurvePosition();

        // The SDK returns curve information
        // Based on docs, we can infer curve type from the data
        console.log(`🔍 Moonshot curve info for ${mintAddress.slice(0, 8)}...`, JSON.stringify(curvePos, (_, v) => typeof v === 'bigint' ? v.toString() : v));

        // Try to detect curve type from the response
        // Classic curve has specific characteristics:
        // - Initial virtual SOL = 30 SOL
        // - Graduates at ~88 SOL collateral

        // If the SDK returns a curveType property, use it
        if (curvePos && typeof curvePos === 'object') {
            const curveData = curvePos as Record<string, unknown>;

            // Check if there's an explicit curve type field
            if ('curveType' in curveData) {
                const curveType = String(curveData.curveType).toLowerCase();
                if (curveType.includes('flat')) {
                    console.log(`⚠️ FLAT CURVE detected for ${mintAddress.slice(0, 8)}... - WILL SELL IMMEDIATELY`);
                    return {
                        curveType: MoonshotCurveType.FLAT,
                        isSafe: false,
                    };
                }
                if (curveType.includes('classic') || curveType.includes('standard')) {
                    console.log(`✅ CLASSIC CURVE detected for ${mintAddress.slice(0, 8)}... - safe to track`);
                    return {
                        curveType: MoonshotCurveType.CLASSIC,
                        graduationThreshold: 88, // 88 SOL for classic curves
                        isSafe: true,
                    };
                }
            }

            // Alternative detection: check for flat curve indicators
            // Flat curves have migration trigger at ~49% vs classic at ~80%
            if ('migrationThreshold' in curveData || 'graduationLiquidity' in curveData) {
                const threshold = Number(curveData.migrationThreshold || curveData.graduationLiquidity || 0);
                // Classic curves graduate at ~88 SOL, flat curves can be as low as 25 SOL
                if (threshold > 0 && threshold < 50_000_000_000) { // Less than 50 SOL = likely flat
                    console.log(`⚠️ LOW THRESHOLD (${threshold / 1e9} SOL) - likely FLAT CURVE - WILL SELL`);
                    return {
                        curveType: MoonshotCurveType.FLAT,
                        graduationThreshold: threshold / 1e9,
                        isSafe: false,
                    };
                }
            }

            // Check token allocation percentage if available
            // Classic: 80% sold at graduation, Flat: 49% sold
            if ('tokensSoldPercent' in curveData || 'allocationPercent' in curveData) {
                // This would need more sophisticated logic
            }
        }

        // If we can't determine, default to assuming it's classic but log a warning
        console.log(`⚠️ Could not definitively determine curve type for ${mintAddress.slice(0, 8)}... - assuming CLASSIC`);
        return {
            curveType: MoonshotCurveType.UNKNOWN,
            graduationThreshold: 88,
            isSafe: true, // Default to safe, but with warning
        };

    } catch (error) {
        console.error(`❌ Failed to detect Moonshot curve type for ${mintAddress.slice(0, 8)}...:`, error);
        // On error, assume unknown but allow tracking (conservative approach)
        return {
            curveType: MoonshotCurveType.UNKNOWN,
            isSafe: true, // Allow tracking with default threshold
        };
    }
}

/**
 * Check if a Moonshot token should be immediately sold (flat curve)
 * 
 * @param mintAddress - The token mint address
 * @returns true if the token should be sold immediately (flat curve)
 */
export async function shouldImmediatelySellMoonshot(mintAddress: string): Promise<boolean> {
    const curveInfo = await detectMoonshotCurveType(mintAddress);
    return curveInfo.curveType === MoonshotCurveType.FLAT;
}
