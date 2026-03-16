/**
 * RPC Connection Management with Unified Round-Robin Rotation
 *
 * All operations (monitoring AND transactions) use the same pool of RPC keys.
 * Keys are loaded dynamically from RPC_KEY_1, RPC_KEY_2, ... RPC_KEY_100
 * and rotated in round-robin order.
 */

import { Connection, VersionedTransaction, SendOptions, PublicKey } from "@solana/web3.js";
import "dotenv/config";

// =============================================================================
// Dynamic URL Loading - Unified Pool
// =============================================================================

const rpcUrls: string[] = [];
for (let i = 1; i <= 100; i++) {
    const url = process.env[`RPC_KEY_${i}`];
    if (url && url.startsWith("http")) {
        rpcUrls.push(url);
    } else if (!url || url.trim() === "") {
        continue;
    }
}

console.log(`📡 [RPC] Loaded ${rpcUrls.length} RPC keys`);

if (rpcUrls.length === 0) {
    throw new Error("No valid RPC keys configured. Add RPC_KEY_1, RPC_KEY_2, etc. to .env file.");
}

let rpcIndex = 0;

// =============================================================================
// Round-Robin Key Rotation
// =============================================================================

/**
 * Get next RPC URL (round-robin through all keys)
 */
function getNextRpcUrl(): string {
    const keyIndex = rpcIndex % rpcUrls.length;
    const url = rpcUrls[keyIndex];
    rpcIndex++;
    return url;
}

// =============================================================================
// Connection Factory Functions
// =============================================================================

/**
 * Create a new Connection using the next RPC URL in rotation
 * Use this for ALL operations (monitoring and transactions)
 */
export function createConnection(): Connection {
    return new Connection(getNextRpcUrl(), {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
    });
}

// Legacy aliases for backward compatibility
export const createMonitoringConnection = createConnection;
export const createExecutionConnection = createConnection;

// =============================================================================
// Rotating Connection Getters
// =============================================================================

/**
 * Get RPC connection - rotates through all keys
 * Used for ALL operations (monitoring AND transactions)
 */
export function getRpc(): Connection {
    return new Connection(getNextRpcUrl(), {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
    });
}

// Legacy aliases for backward compatibility
export const getMonitoringHttpRpc = getRpc;
export const getExecutionRpc = getRpc;
export const getMonitoringConnection = getRpc;
export const getExecutionConnection = getRpc;

// Legacy exports for backward compatibility (single instances)
export const monitoringHttpRpc = createConnection();
export const executionRpc = createConnection();

// =============================================================================
// Batched RPC Operations (for multi-user efficiency)
// =============================================================================

/**
 * Batch fetch multiple accounts in a single RPC call
 * Uses key rotation and supports up to 100 accounts per call
 * Returns Map of pubkey string -> AccountInfo (null if not found)
 */
export async function getMultipleAccountsInfoBatched(
    pubkeys: PublicKey[]
): Promise<Map<string, { data: Buffer } | null>> {
    const results = new Map<string, { data: Buffer } | null>();

    if (pubkeys.length === 0) return results;

    // Solana limits to 100 accounts per call
    const BATCH_SIZE = 100;
    const batches: PublicKey[][] = [];

    for (let i = 0; i < pubkeys.length; i += BATCH_SIZE) {
        batches.push(pubkeys.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
        try {
            const conn = getRpc();
            const accounts = await conn.getMultipleAccountsInfo(batch);

            for (let i = 0; i < batch.length; i++) {
                const pubkey = batch[i].toBase58();
                const account = accounts[i];

                if (account?.data) {
                    results.set(pubkey, { data: account.data as Buffer });
                } else {
                    results.set(pubkey, null);
                }
            }
        } catch (error) {
            console.error(`❌ Batch account fetch failed:`, error);
            for (const pubkey of batch) {
                results.set(pubkey.toBase58(), null);
            }
        }
    }

    return results;
}

// =============================================================================
// Transaction Sending with Fallback
// =============================================================================

/**
 * Send transaction with fallback through multiple RPC endpoints
 * Tries up to 6 different keys from the unified pool
 */
export async function sendTransactionWithFallback(
    transaction: VersionedTransaction,
    options: SendOptions = {}
): Promise<string> {
    const maxRetries = 3;
    const maxEndpoints = Math.min(6, rpcUrls.length);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxEndpoints; attempt++) {
        const url = getNextRpcUrl();
        const endpointName = `RPC ${(rpcIndex - 1) % rpcUrls.length + 1}`;

        try {
            const conn = new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true });
            const signature = await conn.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: options.skipPreflight ?? false,
                    maxRetries: maxRetries,
                    ...options,
                }
            );
            console.log(`✅ [RPC] Transaction sent via ${endpointName}`);

            // Poll for confirmation
            let confirmed = false;
            const maxPolls = 10;

            for (let i = 0; i < maxPolls; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));

                try {
                    const status = await conn.getSignatureStatus(signature);

                    if (status?.value?.err) {
                        throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
                    }

                    if (status?.value?.confirmationStatus === "confirmed" ||
                        status?.value?.confirmationStatus === "finalized") {
                        confirmed = true;
                        console.log(`✅ [RPC] Transaction confirmed!`);
                        break;
                    }
                } catch (statusError) {
                    if (statusError instanceof Error && statusError.message.includes("failed on-chain")) {
                        throw statusError;
                    }
                }
            }

            if (!confirmed) {
                console.warn(`⚠️ [RPC] Transaction sent but confirmation timed out. Signature: ${signature}`);
            }

            return signature;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            const errMsg = lastError.message.slice(0, 50);

            if (!lastError.message.includes("429")) {
                console.warn(`⚠️ [RPC] ${endpointName} failed: ${errMsg}`);
            }

            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    throw new Error(`All RPC endpoints failed. Last error: ${lastError?.message}`);
}

// =============================================================================
// RPC Status Logging
// =============================================================================

export function logRpcStatus(): void {
    console.log(`📡 RPC: ${rpcUrls.length} keys loaded`);
}
