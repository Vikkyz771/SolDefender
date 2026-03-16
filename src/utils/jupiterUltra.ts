/**
 * Jupiter Ultra API Integration
 * 
 * Ultra API features:
 * - Dynamic rate limits (scales with volume)
 * - MEV protection
 * - Gasless swaps (when available)
 * - Automatic priority fees
 * - Fast landing (0-1 blocks)
 * - RPC-less architecture
 * 
 * Endpoints:
 * - POST /order - Request a swap order
 * - POST /execute - Execute a signed order
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { getSOLPriceSync } from "./solPrice.js";

// Ultra API endpoints
const ULTRA_API_BASE = "https://api.jup.ag/ultra/v1";
const ULTRA_ORDER_ENDPOINT = `${ULTRA_API_BASE}/order`;
const ULTRA_EXECUTE_ENDPOINT = `${ULTRA_API_BASE}/execute`;

// SOL mint constant
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Load Jupiter Ultra API keys from environment
function loadUltraKeys(): string[] {
    const keys: string[] = [];
    let i = 1;
    while (true) {
        const key = process.env[`JUPITER_ULTRA_KEY_${i}`];
        if (!key) break;
        keys.push(key);
        i++;
    }
    if (keys.length === 0) {
        console.warn("⚠️ No Jupiter Ultra API keys found in .env");
    } else {
        console.log(`🔑 Loaded ${keys.length} Jupiter Ultra API keys`);
    }
    return keys;
}

// Key rotation state
let ultraKeys: string[] = [];
let currentKeyIndex = 0;

/**
 * Initialize Ultra API (call on startup)
 */
export function initJupiterUltra(): void {
    ultraKeys = loadUltraKeys();
}

/**
 * Get next API key (round-robin)
 */
function getNextKey(): string {
    if (ultraKeys.length === 0) {
        throw new Error("No Jupiter Ultra API keys configured");
    }
    const key = ultraKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % ultraKeys.length;
    return key;
}

/**
 * Ultra Order Response
 */
export interface UltraOrderResponse {
    requestId: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapType: string;
    priceImpactPct: string;
    dynamicSlippageReport?: {
        slippageBps: number;
        otherAmount: string;
        simulatedIncurredSlippageBps: number;
    };
    transaction: string; // Base64 encoded transaction
    prioritizationType?: {
        computeBudget?: {
            microLamports: number;
            estimatedMicroLamports: number;
        };
    };
}

/**
 * Ultra Execute Response
 */
export interface UltraExecuteResponse {
    signature: string;
    status: "Success" | "Failed";
    code?: string;
    error?: string;
    inputAmountResult?: string;
    outputAmountResult?: string;
    swapEvents?: Array<{
        type: string;
        inputMint: string;
        outputMint: string;
        inputAmount: string;
        outputAmount: string;
    }>;
}

/**
 * Request a swap order from Ultra API
 * Note: /order uses GET with query params, /execute uses POST with body
 */
export async function getUltraOrder(
    inputMint: string,
    outputMint: string,
    amount: string,
    taker: string
): Promise<UltraOrderResponse> {
    const apiKey = getNextKey();

    console.log(`\n📋 [Ultra] Requesting order...`);
    console.log(`   Input: ${inputMint.slice(0, 8)}...`);
    console.log(`   Output: ${outputMint.slice(0, 8)}...`);
    console.log(`   Amount: ${amount}`);

    // Build URL with query parameters (Ultra /order uses GET)
    const url = new URL(ULTRA_ORDER_ENDPOINT);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    url.searchParams.set("taker", taker);

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "x-api-key": apiKey,
        },
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [Ultra] Order failed: ${response.status} - ${errorText}`);

        // Parse error for user-friendly message
        try {
            const errorData = JSON.parse(errorText);
            if (errorData.error?.includes("No route found")) {
                throw new Error("No liquidity found. Token may not be tradable yet.");
            }
            throw new Error(errorData.error || errorData.message || `Ultra API error: ${response.status}`);
        } catch (e) {
            if (e instanceof Error && e.message.includes("No liquidity")) throw e;
            throw new Error(`Ultra API error: ${response.status} - ${errorText}`);
        }
    }

    const order = await response.json() as UltraOrderResponse;

    console.log(`✅ [Ultra] Order received:`);
    console.log(`   Request ID: ${order.requestId}`);
    console.log(`   Out Amount: ${order.outAmount}`);
    console.log(`   Price Impact: ${order.priceImpactPct}%`);
    if (order.dynamicSlippageReport) {
        console.log(`   Dynamic Slippage: ${order.dynamicSlippageReport.slippageBps} bps`);
    }

    return order;
}

/**
 * Execute a signed order via Ultra API
 */
export async function executeUltraOrder(
    requestId: string,
    signedTransaction: string
): Promise<UltraExecuteResponse> {
    const apiKey = getNextKey();

    console.log(`\n🚀 [Ultra] Executing order ${requestId}...`);

    const response = await fetch(ULTRA_EXECUTE_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
        },
        body: JSON.stringify({
            requestId,
            signedTransaction,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [Ultra] Execute failed: ${response.status} - ${errorText}`);
        throw new Error(`Ultra execute error: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as UltraExecuteResponse;

    if (result.status === "Success") {
        console.log(`✅ [Ultra] Transaction successful!`);
        console.log(`   Signature: ${result.signature}`);
        console.log(`   🔗 https://solscan.io/tx/${result.signature}`);
    } else {
        console.error(`❌ [Ultra] Transaction failed: ${result.error}`);
        throw new Error(result.error || "Transaction failed");
    }

    return result;
}

/**
 * Execute a BUY (SOL → Token) via Ultra API
 */
export async function executeUltraBuy(
    tokenMint: string,
    solAmount: number,
    wallet: Keypair
): Promise<{ signature: string; tokenAmount: string }> {
    const solPrice = getSOLPriceSync();
    const lamports = Math.floor(solAmount * 1_000_000_000);

    console.log("\n" + "▓".repeat(60));
    console.log("🟢 EXECUTING ULTRA BUY");
    console.log("▓".repeat(60));
    console.log(`Token: ${tokenMint}`);
    console.log(`Amount: ${solAmount} SOL (~$${(solAmount * solPrice).toFixed(2)})`);

    // 1. Get order
    const order = await getUltraOrder(
        SOL_MINT,
        tokenMint,
        lamports.toString(),
        wallet.publicKey.toBase58()
    );

    // 2. Sign the transaction
    const txBuffer = Buffer.from(order.transaction, "base64");
    const { VersionedTransaction } = await import("@solana/web3.js");
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([wallet]);

    // 3. Serialize signed transaction
    const signedTx = Buffer.from(transaction.serialize()).toString("base64");

    // 4. Execute
    const result = await executeUltraOrder(order.requestId, signedTx);

    console.log("▓".repeat(60) + "\n");

    // Get actual token amount from swap events
    const tokenAmount = result.swapEvents?.find(e => e.outputMint === tokenMint)?.outputAmount
        || order.outAmount;

    return {
        signature: result.signature,
        tokenAmount,
    };
}

/**
 * Execute a SELL (Token → SOL) via Ultra API
 */
export async function executeUltraSell(
    tokenMint: string,
    tokenAmount: bigint,
    wallet: Keypair
): Promise<string> {
    const solPrice = getSOLPriceSync();

    console.log("\n" + "▓".repeat(60));
    console.log("🔴 EXECUTING ULTRA SELL");
    console.log("▓".repeat(60));
    console.log(`Token: ${tokenMint}`);
    console.log(`Amount: ${tokenAmount.toString()} tokens`);

    // 1. Get order
    const order = await getUltraOrder(
        tokenMint,
        SOL_MINT,
        tokenAmount.toString(),
        wallet.publicKey.toBase58()
    );

    const expectedSOL = Number(order.outAmount) / 1e9;
    console.log(`📤 Expected: ${expectedSOL.toFixed(6)} SOL (~$${(expectedSOL * solPrice).toFixed(2)})`);

    // 2. Sign the transaction
    const txBuffer = Buffer.from(order.transaction, "base64");
    const { VersionedTransaction } = await import("@solana/web3.js");
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([wallet]);

    // 3. Serialize signed transaction
    const signedTx = Buffer.from(transaction.serialize()).toString("base64");

    // 4. Execute
    const result = await executeUltraOrder(order.requestId, signedTx);

    console.log("▓".repeat(60) + "\n");

    return result.signature;
}

/**
 * Get a quote (without executing) for UI display
 */
export async function getUltraQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    taker: string
): Promise<{ outAmount: string; priceImpactPct: string }> {
    // Ultra API's /order endpoint doubles as a quote endpoint
    // We just don't execute it
    const order = await getUltraOrder(inputMint, outputMint, amount, taker);
    return {
        outAmount: order.outAmount,
        priceImpactPct: order.priceImpactPct,
    };
}

/**
 * Get buy quote for UI
 */
export async function getBuyQuote(
    tokenMint: string,
    solAmount: number,
    taker: string
): Promise<{ estimatedTokens: string; priceImpactPct: string }> {
    const lamports = Math.floor(solAmount * 1_000_000_000);
    const quote = await getUltraQuote(SOL_MINT, tokenMint, lamports.toString(), taker);
    return {
        estimatedTokens: quote.outAmount,
        priceImpactPct: quote.priceImpactPct,
    };
}

/**
 * Get sell quote for UI
 */
export async function getSellQuote(
    tokenMint: string,
    tokenAmount: bigint,
    taker: string
): Promise<{ estimatedSOL: number; priceImpactPct: string }> {
    const quote = await getUltraQuote(tokenMint, SOL_MINT, tokenAmount.toString(), taker);
    return {
        estimatedSOL: Number(quote.outAmount) / 1e9,
        priceImpactPct: quote.priceImpactPct,
    };
}

/**
 * Batch sell quote result (for TP/SL monitor)
 */
export interface SellQuoteResult {
    tokenMint: string;
    tokenAmount: bigint;
    solOutput: number;
    success: boolean;
    error?: string;
}

/**
 * Get sell quotes for multiple positions (for TP/SL monitoring)
 * Uses a dummy taker address since we just need quotes, not execution
 */
export async function getBatchSellQuotes(
    positions: Array<{ tokenMint: string; tokenAmount: bigint }>,
    slippageBps: number = 1500
): Promise<Map<string, SellQuoteResult>> {
    const results = new Map<string, SellQuoteResult>();
    const DUMMY_TAKER = "11111111111111111111111111111111";

    // Process quotes sequentially (Ultra API rate limits handled internally)
    for (const pos of positions) {
        try {
            const quote = await getUltraQuote(
                pos.tokenMint,
                SOL_MINT,
                pos.tokenAmount.toString(),
                DUMMY_TAKER
            );

            results.set(pos.tokenMint, {
                tokenMint: pos.tokenMint,
                tokenAmount: pos.tokenAmount,
                solOutput: Number(quote.outAmount) / 1e9,
                success: true,
            });
        } catch (error) {
            results.set(pos.tokenMint, {
                tokenMint: pos.tokenMint,
                tokenAmount: pos.tokenAmount,
                solOutput: 0,
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    return results;
}
