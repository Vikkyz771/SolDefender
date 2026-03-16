/**
 * Known LP Locker Programs
 * 
 * Registry of trusted locker programs and their unlock time parsing logic
 */

import { PublicKey } from "@solana/web3.js";
import { getMonitoringHttpRpc } from "../../../../utils/rpc.js";
import { LockerConfig } from "../types.js";

// =============================================================================
// Known Locker Programs
// =============================================================================

export const KNOWN_LOCKERS: Record<string, LockerConfig> = {
    // Raydium LP Locker
    "RLquMVjJTkfcvMNcUzDyJt7gYNsL4kfdMkFTbr8bDW9": {
        name: "Raydium Locker",
        programId: "RLquMVjJTkfcvMNcUzDyJt7gYNsL4kfdMkFTbr8bDW9",
        parseUnlockTime: parseRaydiumLockerUnlockTime,
    },

    // Streamflow Token Vesting
    "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m": {
        name: "Streamflow",
        programId: "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",
        parseUnlockTime: parseStreamflowUnlockTime,
    },

    // Team Finance Locker (Solana)
    "TFiM3SBfT1BpqrJzP5TLVsjJNT4ywNbmLPMR9Kos9U8": {
        name: "Team Finance",
        programId: "TFiM3SBfT1BpqrJzP5TLVsjJNT4ywNbmLPMR9Kos9U8",
        parseUnlockTime: parseTeamFinanceUnlockTime,
    },

    // FluxBeam Locker
    "FLuxXJCKuJSC7bHqz6A2zVPg9FSZ1zSN1VYSvKdVFjL": {
        name: "FluxBeam",
        programId: "FLuxXJCKuJSC7bHqz6A2zVPg9FSZ1zSN1VYSvKdVFjL",
        // parseUnlockTime not implemented yet
    },
};

// =============================================================================
// Locker Detection
// =============================================================================

/**
 * Check if an address is a known locker program
 */
export function isKnownLocker(address: string): LockerConfig | null {
    return KNOWN_LOCKERS[address] || null;
}

/**
 * Get all known locker program IDs
 */
export function getKnownLockerProgramIds(): string[] {
    return Object.keys(KNOWN_LOCKERS);
}

// =============================================================================
// Unlock Time Parsing
// =============================================================================

/**
 * Get unlock timestamp from a locker escrow account
 * Returns Unix timestamp in seconds, or null if cannot parse
 */
export async function getLockerUnlockTime(
    holderAddress: string,
    ownerProgram: string
): Promise<number | null> {
    const locker = KNOWN_LOCKERS[ownerProgram];
    if (!locker || !locker.parseUnlockTime) {
        return null;
    }

    try {
        const connection = getMonitoringHttpRpc();
        const accountInfo = await connection.getAccountInfo(new PublicKey(holderAddress));

        if (!accountInfo?.data) {
            return null;
        }

        return locker.parseUnlockTime(accountInfo.data as Buffer);
    } catch (error) {
        console.warn(`Failed to parse unlock time for ${holderAddress}:`, error);
        return null;
    }
}

/**
 * Convert unlock timestamp to days remaining
 */
export function getLockerDaysRemaining(unlockTimestamp: number): number {
    const now = Math.floor(Date.now() / 1000);
    const secondsRemaining = unlockTimestamp - now;

    if (secondsRemaining <= 0) {
        return 0;  // Already unlocked
    }

    return Math.ceil(secondsRemaining / (24 * 60 * 60));
}

// =============================================================================
// Locker-Specific Parsers
// =============================================================================

/**
 * Raydium Locker unlock time parser
 * Layout: 8 bytes discriminator + ... + unlock_time (i64 at offset TBD)
 */
function parseRaydiumLockerUnlockTime(data: Buffer): number | null {
    try {
        // Raydium locker escrow layout:
        // 0-7: discriminator
        // 8-15: locker address
        // 16-23: owner
        // 24-31: token_mint
        // 32-39: amount
        // 40-47: unlock_time (i64 Unix timestamp)
        if (data.length < 48) {
            return null;
        }

        const unlockTime = data.readBigInt64LE(40);
        return Number(unlockTime);
    } catch {
        return null;
    }
}

/**
 * Streamflow unlock time parser
 * Layout varies by stream type
 */
function parseStreamflowUnlockTime(data: Buffer): number | null {
    try {
        // Streamflow contract layout (simplified):
        // 0-7: discriminator
        // 8-39: metadata
        // 40-47: start_time (i64)
        // 48-55: end_time (i64) - this is the unlock time
        if (data.length < 56) {
            return null;
        }

        const endTime = data.readBigInt64LE(48);
        return Number(endTime);
    } catch {
        return null;
    }
}

/**
 * Team Finance unlock time parser
 */
function parseTeamFinanceUnlockTime(data: Buffer): number | null {
    try {
        // Team Finance layout (estimated):
        // Similar structure to other lockers
        // unlock_time typically at a fixed offset
        if (data.length < 64) {
            return null;
        }

        // Try common offset for unlock time
        const unlockTime = data.readBigInt64LE(56);
        return Number(unlockTime);
    } catch {
        return null;
    }
}

// =============================================================================
// Burn Address Detection
// =============================================================================

export const BURN_ADDRESSES = [
    "1111111111111111111111111111111111111112",  // System program (true burn)
    "1nc1nerator11111111111111111111111111111",  // Incinerator
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",  // Common burn pattern
];

/**
 * Check if an address is a known burn address
 */
export function isBurnAddress(address: string): boolean {
    // Check exact matches
    if (BURN_ADDRESSES.includes(address)) {
        return true;
    }

    // Check patterns (addresses starting with 1111... are likely burns)
    if (address.startsWith("1111111111")) {
        return true;
    }

    // Check for "burn" or "dead" in address (rare but exists)
    const lowerAddr = address.toLowerCase();
    if (lowerAddr.includes("burn") || lowerAddr.startsWith("dead")) {
        return true;
    }

    return false;
}
