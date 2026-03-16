import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { getMonitoringHttpRpc } from "../../utils/rpc.js";

export interface AuthorityCheckResult {
    mintAuthorityEnabled: boolean;
    mintAuthority: string | null;
    freezeAuthorityEnabled: boolean;
    freezeAuthority: string | null;
    error?: string;
}

/**
 * Retry with RPC rotation
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            // Don't retry on non-retryable errors
            const msg = lastError.message;
            if (msg.includes("Invalid public key") || msg.includes("not found")) {
                throw lastError;
            }

            // Retry on 500, 429, timeout errors
            if (msg.includes("500") || msg.includes("429") || msg.includes("timeout")) {
                await new Promise(r => setTimeout(r, 300));
                continue;
            }

            throw lastError;
        }
    }

    throw lastError || new Error("Max retries exceeded");
}

/**
 * Check mint and freeze authority status for a token
 * - Mint authority: can create unlimited new tokens (rug risk)
 * - Freeze authority: can freeze token accounts (rug risk)
 */
export async function checkAuthorities(mintAddress: string): Promise<AuthorityCheckResult> {
    try {
        const mintPubkey = new PublicKey(mintAddress);

        const mintInfo = await withRetry(async () => {
            return await getMint(getMonitoringHttpRpc(), mintPubkey);
        });

        return {
            mintAuthorityEnabled: mintInfo.mintAuthority !== null,
            mintAuthority: mintInfo.mintAuthority?.toBase58() ?? null,
            freezeAuthorityEnabled: mintInfo.freezeAuthority !== null,
            freezeAuthority: mintInfo.freezeAuthority?.toBase58() ?? null,
        };
    } catch (error) {
        console.error(`Error checking authorities for ${mintAddress}:`, error);
        return {
            mintAuthorityEnabled: false,
            mintAuthority: null,
            freezeAuthorityEnabled: false,
            freezeAuthority: null,
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
}
