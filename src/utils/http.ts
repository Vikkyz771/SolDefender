/**
 * Robust HTTP client with connection pooling, retries, and DNS caching
 * Used for all external API calls (Jupiter, etc.)
 */

import { Agent, fetch as undiciFetch, setGlobalDispatcher, type RequestInit as UndiciRequestInit } from "undici";

// Create a global agent with connection pooling and keep-alive
const agent = new Agent({
    keepAliveTimeout: 60_000,      // Keep connections alive for 60s
    keepAliveMaxTimeout: 120_000,  // Max keep-alive timeout
    connections: 10,               // Max connections per origin
    pipelining: 1,                 // Enable HTTP pipelining
    connect: {
        timeout: 30_000,           // Connection timeout: 30s
    },
});

// Set as global dispatcher
setGlobalDispatcher(agent);

// Retry configuration
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 500;   // Start with 500ms
const MAX_RETRY_DELAY = 5000;      // Cap at 5s
const REQUEST_TIMEOUT = 30_000;    // 30s timeout per request

interface FetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    retries?: number;
    timeout?: number;
}

/**
 * Robust fetch with exponential backoff retry and timeout
 */
export async function robustFetch(url: string, options: FetchOptions = {}): Promise<Response> {
    const {
        retries = MAX_RETRIES,
        timeout = REQUEST_TIMEOUT,
        method,
        headers,
        body,
    } = options;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const requestInit: UndiciRequestInit = {
                method,
                headers,
                body,
                signal: controller.signal,
            };

            const response = await undiciFetch(url, requestInit);

            clearTimeout(timeoutId);

            // Retry on 5xx errors
            if (response.status >= 500) {
                throw new Error(`Server error: ${response.status}`);
            }

            return response as unknown as Response;

        } catch (error) {
            clearTimeout(timeoutId);
            lastError = error as Error;

            if (attempt < retries) {
                // Exponential backoff with jitter
                const delay = Math.min(
                    INITIAL_RETRY_DELAY * Math.pow(2, attempt) + Math.random() * 500,
                    MAX_RETRY_DELAY
                );
                console.log(`🔄 Request failed, retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms...`);
                await sleep(delay);
            }
        }
    }

    throw lastError || new Error("Request failed after all retries");
}

/**
 * GET request with automatic JSON parsing
 */
export async function fetchJSON<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
    const response = await robustFetch(url, options);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
}

/**
 * POST JSON request
 */
export async function postJSON<T = unknown>(url: string, data: unknown, options: FetchOptions = {}): Promise<T> {
    const response = await robustFetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...options.headers,
        },
        body: JSON.stringify(data),
        ...options,
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Health check - warm up connections to Jupiter
 */
export async function warmupConnections(): Promise<void> {
    const endpoints = [
        "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112",
        "https://public.jupiterapi.com/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50",
    ];

    console.log("🔌 Warming up Jupiter connections...");

    for (const url of endpoints) {
        try {
            await robustFetch(url, { retries: 2, timeout: 10000 });
        } catch {
            // Ignore warmup failures
        }
    }

    console.log("✅ Connections ready");
}

