/**
 * Transaction History Pool Discovery (Fallback Approach)
 * 
 * Scans token's recent transactions to find pools that interacted with it.
 * Used when PDA derivation doesn't find any pools (e.g., PumpSwap).
 * 
 * Strategy: Look for accounts that are owned by known DEX programs.
 */

import { PublicKey } from "@solana/web3.js";
import { getMonitoringHttpRpc } from "../../../../utils/rpc.js";
import { PoolInfo, DexType } from "../types.js";
import { DEX_POOL_PROGRAMS, getDexInfo } from "../constants.js";

// =============================================================================
// Constants
// =============================================================================

const MAX_SIGNATURES = 20;
const MAX_TRANSACTIONS = 5;

// =============================================================================
// Main Discovery Function
// =============================================================================

/**
 * Discover pools by scanning transaction history
 * 
 * Strategy:
 * 1. Get recent transaction signatures
 * 2. For each transaction, find accounts owned by DEX programs
 * 3. Those accounts are likely pool accounts
 */
export async function discoverPoolsViaTxHistory(tokenMint: string): Promise<PoolInfo[]> {
    const pools: PoolInfo[] = [];
    const seenAddresses = new Set<string>();
    const connection = getMonitoringHttpRpc();

    console.log(`🔍 [TxHistory] Scanning transactions for ${tokenMint.slice(0, 8)}...`);

    try {
        // Step 1: Get recent transaction signatures
        const signatures = await connection.getSignaturesForAddress(
            new PublicKey(tokenMint),
            { limit: MAX_SIGNATURES }
        );

        if (signatures.length === 0) {
            console.log(`   [TxHistory] No transactions found`);
            return pools;
        }

        console.log(`   [TxHistory] Found ${signatures.length} signatures, checking ${Math.min(signatures.length, MAX_TRANSACTIONS)}...`);

        // Step 2: Fetch transaction details
        const signaturesSlice = signatures.slice(0, MAX_TRANSACTIONS);

        for (const sig of signaturesSlice) {
            try {
                const tx = await connection.getParsedTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                });

                if (!tx?.meta) continue;

                // Step 3: Check all account keys against known DEX programs
                const accountKeys = tx.transaction.message.accountKeys;

                // Find which programs were involved in this transaction
                const involvedDexPrograms = new Set<string>();
                for (const acc of accountKeys) {
                    const pubkey = acc.pubkey.toBase58();
                    if (DEX_POOL_PROGRAMS[pubkey]) {
                        involvedDexPrograms.add(pubkey);
                    }
                }

                if (involvedDexPrograms.size === 0) continue;

                // Step 4: For accounts in this transaction, check if they're owned by a DEX
                // We need to verify account ownership, not just presence in transaction
                const candidateAddresses = accountKeys
                    .filter(acc => acc.writable && !acc.signer)
                    .map(acc => acc.pubkey);

                // Batch check account ownership
                const accountInfos = await connection.getMultipleAccountsInfo(candidateAddresses);

                for (let i = 0; i < candidateAddresses.length; i++) {
                    const info = accountInfos[i];
                    const address = candidateAddresses[i].toBase58();

                    if (!info || seenAddresses.has(address)) continue;

                    const ownerProgram = info.owner.toBase58();
                    const dexInfo = getDexInfo(ownerProgram);

                    if (dexInfo && dexInfo.hasLpToken) {
                        // This is a DEX pool account!
                        seenAddresses.add(address);

                        console.log(`   ✅ Found ${dexInfo.label} pool: ${address.slice(0, 8)}...`);

                        pools.push({
                            dex: dexInfo.name,
                            poolAddress: address,
                            lpMint: "",
                            tokenAMint: tokenMint,
                            tokenBMint: "",
                            liquiditySol: 0,
                            liquidityUSD: 0,
                            lpSupply: BigInt(0),
                        });
                    }
                }
            } catch (e) {
                // Skip failed transaction fetches
                continue;
            }
        }

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️ [TxHistory] Error: ${errMsg.slice(0, 60)}`);
    }

    console.log(`✅ [TxHistory] Found ${pools.length} pools via transaction scan`);

    return pools;
}
