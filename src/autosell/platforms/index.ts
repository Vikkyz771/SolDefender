/**
 * Platform Adapters Index
 * 
 * Exports all platform adapters and provides unified detection/lookup
 */

import { PublicKey } from "@solana/web3.js";
import { Platform, PlatformAdapter, BondingCurveData } from "../types.js";
import { PROGRAM_IDS } from "../../config.js";
import { getMonitoringHttpRpc } from "../../utils/rpc.js";

// Import adapters
import { pumpfunAdapter } from "./pumpfun.js";
import { raydiumLaunchLabAdapter } from "./raydium.js";
import { moonshotAdapter } from "./moonshot.js";
import { meteoraAdapter } from "./meteora.js";

/**
 * Map of platform to adapter
 */
export const adapters: Record<Platform, PlatformAdapter | null> = {
    [Platform.PUMPFUN]: pumpfunAdapter,
    [Platform.RAYDIUM_LAUNCHLAB]: raydiumLaunchLabAdapter,
    [Platform.MOONSHOT]: moonshotAdapter,
    [Platform.METEORA_DBC]: meteoraAdapter,
    [Platform.UNKNOWN]: null,
};

/**
 * Map of program ID to platform
 */
const programIdToPlatform: Record<string, Platform> = {
    [PROGRAM_IDS.PUMPFUN]: Platform.PUMPFUN,
    [PROGRAM_IDS.RAYDIUM_LAUNCHLAB]: Platform.RAYDIUM_LAUNCHLAB,
    [PROGRAM_IDS.MOONSHOT]: Platform.MOONSHOT,
    [PROGRAM_IDS.METEORA_DBC]: Platform.METEORA_DBC,
};

/**
 * Get adapter for a specific platform
 */
export function getAdapter(platform: Platform): PlatformAdapter | null {
    return adapters[platform];
}

/**
 * Detect which platform a token belongs to by checking if curve PDAs exist
 * 
 * Detection order:
 * 1. Pump.fun - most common
 * 2. Raydium LaunchLab - powers Bonk.fun and partners
 * 3. Moonshot - dexscreener's launchpad
 * 4. Meteora DBC - uses getProgramAccounts search
 */
export async function detectPlatform(mint: string): Promise<Platform> {
    console.log(`🔍 [Detect] Checking platforms for ${mint.slice(0, 8)}...`);

    // Try each platform's PDA derivation and check if account exists
    const platformChecks: [Platform, PlatformAdapter][] = [
        [Platform.PUMPFUN, pumpfunAdapter],
        [Platform.RAYDIUM_LAUNCHLAB, raydiumLaunchLabAdapter],
        [Platform.MOONSHOT, moonshotAdapter],
        [Platform.METEORA_DBC, meteoraAdapter],
    ];

    for (const [platform, adapter] of platformChecks) {
        console.log(`   → Checking ${platform}...`);
        try {
            const curveAddress = await adapter.deriveCurveAccount(mint);
            console.log(`     PDA: ${curveAddress.slice(0, 12)}...`);

            const accountInfo = await getMonitoringHttpRpc().getAccountInfo(
                new PublicKey(curveAddress)
            );

            if (accountInfo) {
                console.log(`   ✅ FOUND on ${platform}!`);
                return platform;
            } else {
                console.log(`     ✗ No account`);
            }
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.log(`     ⚠️ Error: ${errMsg.slice(0, 50)}`);
        }
    }

    console.log(`❌ [Detect] No platform found for ${mint.slice(0, 8)}... (UNKNOWN)`);
    return Platform.UNKNOWN;
}

/**
 * Derive bonding curve account for a token on a specific platform
 */
export async function deriveCurveAccount(
    mint: string,
    platform: Platform
): Promise<string | null> {
    const adapter = getAdapter(platform);
    if (!adapter) {
        return null;
    }

    try {
        return await adapter.deriveCurveAccount(mint);
    } catch (error) {
        console.error(`Failed to derive curve for ${mint} on ${platform}:`, error);
        return null;
    }
}

/**
 * Parse bonding curve data for a specific platform (synchronous)
 * NOTE: For Meteora, this returns 0 - use getCurveProgress() instead
 */
export function parseCurveData(data: Buffer, platform: Platform): BondingCurveData {
    const adapter = getAdapter(platform);
    if (!adapter) {
        return { progress: 0, complete: false };
    }

    return adapter.parseCurveData(data);
}

/**
 * Get bonding curve progress for a token (async - uses SDK for Meteora)
 * This is the preferred method for getting accurate progress
 */
export async function getCurveProgress(
    curveAddress: string,
    platform: Platform
): Promise<BondingCurveData> {
    // Meteora requires SDK for accurate progress calculation
    if (platform === Platform.METEORA_DBC) {
        try {
            const { getMeteoraPoolStatus } = await import("./meteora.js");
            const status = await getMeteoraPoolStatus(curveAddress);
            return {
                progress: status.progress,
                complete: status.migrated
            };
        } catch (error) {
            console.warn("⚠️ Failed to get Meteora progress:", error);
            return { progress: 0, complete: false };
        }
    }

    // For other platforms, use synchronous parsing
    const adapter = getAdapter(platform);
    if (!adapter) {
        return { progress: 0, complete: false };
    }

    try {
        const connection = getMonitoringHttpRpc();
        const accountInfo = await connection.getAccountInfo(new PublicKey(curveAddress));
        if (accountInfo?.data) {
            return adapter.parseCurveData(accountInfo.data as Buffer);
        }
    } catch (error) {
        console.warn(`⚠️ Failed to get ${platform} progress:`, error);
    }

    return { progress: 0, complete: false };
}

// Re-export individual adapters
export { pumpfunAdapter } from "./pumpfun.js";
export { raydiumLaunchLabAdapter } from "./raydium.js";
export { moonshotAdapter } from "./moonshot.js";
export { meteoraAdapter, getMeteoraPoolStatus, getMeteoraPoolSafety } from "./meteora.js";
export type { MeteoraPoolSafety } from "./meteora.js";
