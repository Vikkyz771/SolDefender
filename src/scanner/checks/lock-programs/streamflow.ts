/**
 * StreamFlow Lock Account Parser
 * 
 * Parses StreamFlow lock accounts to extract unlock time information.
 * 
 * Account structure (from StreamFlow docs):
 * - start_time: u64 (Unix timestamp when funds begin to unlock)
 * - end_time: u64 (Unix timestamp when funds are fully unlocked)
 * - amount: u64 (Total amount locked)
 * - withdrawn: u64 (Amount already withdrawn)
 * - sender: 32 bytes (public key)
 * - recipient: 32 bytes (public key)
 */

import { PublicKey, Connection } from "@solana/web3.js";
import { getMonitoringHttpRpc } from "../../../utils/rpc.js";
import { STREAMFLOW_PROGRAMS } from "./index.js";

/**
 * StreamFlow lock info
 */
export interface StreamFlowLockInfo {
    startTime: number;      // Unix timestamp
    endTime: number;        // Unix timestamp
    amount: bigint;
    withdrawn: bigint;
    sender: string;
    recipient: string;
    // Derived fields
    isFullyUnlocked: boolean;
    daysUntilUnlock: number;
    unlockDateStr: string;
}

/**
 * Parse StreamFlow lock account data
 * 
 * Based on the StreamFlow timelock account layout:
 * Offset 0: start_time (8 bytes, u64)
 * Offset 8: end_time (8 bytes, u64)
 * Offset 16: amount (8 bytes, u64)
 * Offset 24: withdrawn (8 bytes, u64)
 * Offset 32: sender (32 bytes)
 * Offset 64: recipient (32 bytes)
 * 
 * Note: Actual layout may vary - this is a best-effort parse
 */
function parseStreamFlowAccountData(data: Buffer): StreamFlowLockInfo | null {
    try {
        // Need at least 96 bytes for the base structure
        if (data.length < 96) {
            return null;
        }

        // Read u64 values (little-endian)
        const startTime = Number(data.readBigUInt64LE(0));
        const endTime = Number(data.readBigUInt64LE(8));
        const amount = data.readBigUInt64LE(16);
        const withdrawn = data.readBigUInt64LE(24);

        // Read public keys
        const senderBytes = data.slice(32, 64);
        const recipientBytes = data.slice(64, 96);
        const sender = new PublicKey(senderBytes).toBase58();
        const recipient = new PublicKey(recipientBytes).toBase58();

        // Calculate derived fields
        const now = Math.floor(Date.now() / 1000);
        const isFullyUnlocked = now >= endTime;
        const daysUntilUnlock = isFullyUnlocked ? 0 : Math.ceil((endTime - now) / 86400);

        // Format unlock date
        const unlockDate = new Date(endTime * 1000);
        const unlockDateStr = unlockDate.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
        });

        return {
            startTime,
            endTime,
            amount,
            withdrawn,
            sender,
            recipient,
            isFullyUnlocked,
            daysUntilUnlock,
            unlockDateStr,
        };
    } catch (error) {
        console.error("Failed to parse StreamFlow account:", error);
        return null;
    }
}

/**
 * Get StreamFlow lock info for an account
 */
export async function getStreamFlowLockInfo(
    accountAddress: string
): Promise<StreamFlowLockInfo | null> {
    try {
        const connection = getMonitoringHttpRpc();
        const pubkey = new PublicKey(accountAddress);
        const accountInfo = await connection.getAccountInfo(pubkey);

        if (!accountInfo?.data) {
            return null;
        }

        // Verify owner is StreamFlow
        const owner = accountInfo.owner.toBase58();
        if (owner !== STREAMFLOW_PROGRAMS.COMMUNITY &&
            owner !== STREAMFLOW_PROGRAMS.COMMERCIAL) {
            return null;
        }

        return parseStreamFlowAccountData(Buffer.from(accountInfo.data));
    } catch (error) {
        console.error(`Failed to get StreamFlow lock info for ${accountAddress}:`, error);
        return null;
    }
}

/**
 * Format lock duration for display
 */
export function formatLockDuration(daysUntilUnlock: number): string {
    if (daysUntilUnlock <= 0) {
        return "Unlocked";
    }
    if (daysUntilUnlock > 365) {
        const years = Math.floor(daysUntilUnlock / 365);
        return `${years}+ years`;
    }
    if (daysUntilUnlock > 30) {
        const months = Math.floor(daysUntilUnlock / 30);
        return `${months} months`;
    }
    return `${daysUntilUnlock} days`;
}

/**
 * Get lock risk level based on days until unlock
 */
export function getLockRiskLevel(
    daysUntilUnlock: number
): "UNLOCKED" | "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "SAFE" {
    if (daysUntilUnlock <= 0) return "UNLOCKED";
    if (daysUntilUnlock <= 7) return "CRITICAL";
    if (daysUntilUnlock <= 30) return "HIGH";
    if (daysUntilUnlock <= 180) return "MEDIUM";
    if (daysUntilUnlock <= 365) return "LOW";
    return "SAFE";
}
