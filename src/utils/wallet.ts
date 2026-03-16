import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress, createCloseAccountInstruction } from "@solana/spl-token";
import { getMonitoringHttpRpc, executionRpc } from "./rpc.js";
import { TOKEN_PROGRAM_ID, ENCRYPTION_KEY } from "../config.js";
import { getSOLPriceSync } from "./solPrice.js";
import bs58 from "bs58";
import * as crypto from "crypto";

// Encryption algorithm
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get the encryption key as a buffer
 */
function getEncryptionKey(): Buffer {
    if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
        // Generate a warning but use a fallback for development
        console.warn("⚠️ ENCRYPTION_KEY not set or invalid. Using insecure fallback.");
        // Use SHA-256 of a fixed string as fallback (NOT SECURE - only for dev)
        return crypto.createHash("sha256").update("dev-fallback-key").digest();
    }
    return Buffer.from(ENCRYPTION_KEY, "hex");
}

/**
 * Encrypt a private key for storage
 */
export function encryptPrivateKey(privateKeyBase58: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(privateKeyBase58, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encryptedData (all hex)
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt a private key from storage
 */
export function decryptPrivateKey(encryptedData: string): string {
    const key = getEncryptionKey();
    const parts = encryptedData.split(":");

    if (parts.length !== 3) {
        throw new Error("Invalid encrypted data format");
    }

    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
}

/**
 * Generate a new wallet keypair
 * Returns the address and encrypted private key for storage
 */
export function generateWallet(): { address: string; encryptedPrivateKey: string } {
    const keypair = Keypair.generate();
    const privateKeyBase58 = bs58.encode(keypair.secretKey);
    const address = keypair.publicKey.toBase58();
    const encryptedPrivateKey = encryptPrivateKey(privateKeyBase58);

    console.log(`🔐 Generated new wallet: ${address.slice(0, 8)}...`);

    return { address, encryptedPrivateKey };
}

/**
 * Import a wallet from a private key
 * Returns the address and encrypted private key for storage
 */
export function importWallet(privateKeyBase58: string): { address: string; encryptedPrivateKey: string } {
    // Validate the private key
    let keypair: Keypair;
    try {
        const secretKey = bs58.decode(privateKeyBase58);
        keypair = Keypair.fromSecretKey(secretKey);
    } catch (error) {
        throw new Error("Invalid private key format");
    }

    const address = keypair.publicKey.toBase58();
    const encryptedPrivateKey = encryptPrivateKey(privateKeyBase58);

    console.log(`🔐 Imported wallet: ${address.slice(0, 8)}...`);

    return { address, encryptedPrivateKey };
}

/**
 * Decrypt stored private key and return Keypair for signing
 */
export function decryptWallet(encryptedPrivateKey: string): Keypair {
    const privateKeyBase58 = decryptPrivateKey(encryptedPrivateKey);
    const secretKey = bs58.decode(privateKeyBase58);
    return Keypair.fromSecretKey(secretKey);
}



/**
 * Token holding info
 */
export interface TokenHolding {
    mint: PublicKey;
    tokenAccount: PublicKey;
    balance: bigint;
    decimals: number;
}

/**
 * Get all SPL token holdings for a wallet
 */
export async function getWalletTokenHoldings(walletPubkey: PublicKey): Promise<TokenHolding[]> {
    const tokenAccounts = await getMonitoringHttpRpc().getParsedTokenAccountsByOwner(walletPubkey, {
        programId: new PublicKey(TOKEN_PROGRAM_ID),
    });

    const holdings: TokenHolding[] = [];

    for (const { pubkey, account } of tokenAccounts.value) {
        const parsed = account.data.parsed.info;
        const balance = BigInt(parsed.tokenAmount.amount);

        // Skip zero-balance accounts
        if (balance === 0n) continue;

        holdings.push({
            mint: new PublicKey(parsed.mint),
            tokenAccount: pubkey,
            balance,
            decimals: parsed.tokenAmount.decimals,
        });
    }

    return holdings;
}

/**
 * Get SOL balance for a wallet
 */
export async function getWalletSOLBalance(walletPubkey: PublicKey): Promise<number> {
    const lamports = await getMonitoringHttpRpc().getBalance(walletPubkey);
    return lamports / 1_000_000_000; // Convert lamports to SOL
}

/**
 * Get token balance for a specific mint in a wallet
 * Returns 0n if no token account exists or balance is 0
 */
export async function getWalletTokenBalance(walletPubkey: PublicKey, tokenMint: string): Promise<bigint> {
    try {
        const mintPubkey = new PublicKey(tokenMint);
        const tokenAccountAddress = await getAssociatedTokenAddress(mintPubkey, walletPubkey);

        const accountInfo = await getMonitoringHttpRpc().getParsedAccountInfo(tokenAccountAddress);

        if (!accountInfo.value) {
            return 0n; // No token account exists
        }

        const parsedData = accountInfo.value.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } };
        return BigInt(parsedData.parsed?.info?.tokenAmount?.amount || "0");
    } catch {
        return 0n; // Any error means no balance
    }
}

/**
 * Close a token account to reclaim rent (~0.002 SOL)
 * Only works if the token account has 0 balance
 * Returns the amount of SOL recovered, or null if failed
 */
export async function closeTokenAccount(
    tokenMint: string,
    wallet: Keypair
): Promise<{ success: boolean; rentRecovered: number; signature?: string }> {
    const solPrice = getSOLPriceSync();

    try {
        const mintPubkey = new PublicKey(tokenMint);
        const tokenAccountAddress = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);

        // Check if the account exists and has 0 balance using pure RPC (no subscriptions)
        const accountInfo = await executionRpc.getParsedAccountInfo(tokenAccountAddress);

        if (!accountInfo.value) {
            console.log(`ℹ️ Token account for ${tokenMint.slice(0, 8)}... doesn't exist or already closed`);
            return { success: false, rentRecovered: 0 };
        }

        // Parse the token account data - retry with delay if balance not yet updated
        let balance = BigInt(0);
        let retryCount = 0;
        const maxRetries = 5;
        const retryDelayMs = 1500;

        while (retryCount < maxRetries) {
            const accountInfo = await executionRpc.getParsedAccountInfo(tokenAccountAddress);
            if (!accountInfo.value) {
                console.log(`ℹ️ Token account for ${tokenMint.slice(0, 8)}... doesn't exist or already closed`);
                return { success: false, rentRecovered: 0 };
            }

            const parsedData = accountInfo.value.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } };
            balance = BigInt(parsedData.parsed?.info?.tokenAmount?.amount || "0");

            if (balance === 0n) {
                break; // Balance is 0, proceed with close
            }

            retryCount++;
            if (retryCount < maxRetries) {
                console.log(`⏳ Waiting for balance to update... (attempt ${retryCount}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }

        // Verify balance is 0 after retries
        if (balance > 0n) {
            console.log(`⚠️ Cannot close account - still has ${balance} tokens after ${maxRetries} attempts`);
            return { success: false, rentRecovered: 0 };
        }


        // Get the rent amount we'll recover
        const accountData = await executionRpc.getAccountInfo(tokenAccountAddress);
        const rentLamports = accountData?.lamports || 0;
        const rentSOL = rentLamports / 1e9;

        console.log("\n" + "─".repeat(50));
        console.log("🧹 CLOSING EMPTY TOKEN ACCOUNT");
        console.log("─".repeat(50));
        console.log(`Token: ${tokenMint.slice(0, 8)}...`);
        console.log(`Account: ${tokenAccountAddress.toBase58().slice(0, 8)}...`);
        console.log(`Rent to recover: ${rentSOL.toFixed(6)} SOL (~$${(rentSOL * solPrice).toFixed(4)})`);

        // Create close account instruction
        const closeInstruction = createCloseAccountInstruction(
            tokenAccountAddress,      // Account to close
            wallet.publicKey,          // Destination for rent
            wallet.publicKey,          // Owner/authority
            [],                        // No multisig signers
            new PublicKey(TOKEN_PROGRAM_ID)
        );

        // Build transaction
        const transaction = new Transaction().add(closeInstruction);
        const { blockhash, lastValidBlockHeight } = await executionRpc.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = wallet.publicKey;
        transaction.sign(wallet);

        // Send transaction (without WebSocket confirmation - use polling instead)
        const signature = await executionRpc.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
        });

        console.log(`📤 Transaction sent: ${signature.slice(0, 20)}...`);

        // Poll for confirmation (max 30 seconds at 500ms intervals)
        let confirmed = false;
        for (let i = 0; i < 60; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const status = await executionRpc.getSignatureStatus(signature);
            if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
                confirmed = true;
                break;
            }
            if (status?.value?.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
            }
        }

        if (!confirmed) {
            console.warn("⚠️ Transaction sent but confirmation timed out. Check Solscan.");
        }

        console.log(`✅ Account closed!`);
        console.log(`💰 Recovered: ${rentSOL.toFixed(6)} SOL (~$${(rentSOL * solPrice).toFixed(4)})`);
        console.log(`🔗 Signature: ${signature}`);
        console.log("─".repeat(50) + "\n");

        return { success: true, rentRecovered: rentSOL, signature };

    } catch (error) {
        console.error(`❌ Failed to close token account:`, error);
        return { success: false, rentRecovered: 0 };
    }
}


