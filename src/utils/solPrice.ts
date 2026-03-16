/**
 * Cached SOL price service with real-time updates
 * Uses multiple sources for reliability (NO Jupiter - it's unreliable for SOL)
 * 
 * Sources:
 * 1. Binance (fastest, most reliable)
 * 2. DexScreener (Solana native)
 * 3. CoinGecko (fallback)
 */

// API endpoints (no Jupiter - it's slow and unreliable for SOL price)
const BINANCE_API = "https://api.binance.com/api/v3/ticker/price";
const DEXSCREENER_SOL_API = "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112";
const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";

// Cache configuration
const CACHE_TTL_MS = 3_000;  // 3 seconds - refresh frequently

// Cached price state (starts at 0 - MUST fetch on startup)
let cachedSOLPrice: number = 0;
let lastFetchTime: number = 0;
let fetchInProgress: Promise<number> | null = null;
let lastLogTime: number = 0;
let hadPriceError: boolean = false; // Track if we had an error to log recovery

/**
 * Simple fetch with timeout (no retry, used internally)
 */
async function fetchWithTimeout(url: string, timeoutMs: number = 3000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        return response;
    } catch (error) {
        clearTimeout(timeout);
        throw error;
    }
}

/**
 * Try Binance API (most reliable, fastest)
 */
async function fetchFromBinance(): Promise<number | null> {
    try {
        const response = await fetchWithTimeout(`${BINANCE_API}?symbol=SOLUSDT`, 2000);
        if (!response.ok) return null;
        const data = await response.json();
        const price = parseFloat(data.price || "0");
        return price > 0 ? price : null;
    } catch {
        return null;
    }
}

/**
 * Try DexScreener API (Solana native, good for new tokens too)
 */
async function fetchFromDexScreener(): Promise<number | null> {
    try {
        const response = await fetchWithTimeout(DEXSCREENER_SOL_API, 3000);
        if (!response.ok) return null;
        const data = await response.json();
        // DexScreener returns pairs, find USDT/USDC pair
        const pairs = data.pairs || [];
        for (const pair of pairs) {
            if (pair.chainId === "solana" && (pair.quoteToken?.symbol === "USDC" || pair.quoteToken?.symbol === "USDT")) {
                const price = parseFloat(pair.priceUsd || "0");
                if (price > 0) return price;
            }
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Try CoinGecko API (free, no key required, good fallback)
 */
async function fetchFromCoinGecko(): Promise<number | null> {
    try {
        const response = await fetchWithTimeout(`${COINGECKO_API}?ids=solana&vs_currencies=usd`, 3000);
        if (!response.ok) return null;
        const data = await response.json();
        const price = data.solana?.usd;
        return typeof price === "number" && price > 0 ? price : null;
    } catch {
        return null;
    }
}

/**
 * Fetch SOL price from multiple sources with fallback
 */
async function fetchSOLPrice(): Promise<number> {
    // Try sources in order of preference
    const binancePrice = await fetchFromBinance();
    if (binancePrice) {
        // Log recovery if we previously had an error
        if (hadPriceError) {
            console.log(`✅ SOL price recovered: $${binancePrice.toFixed(2)} (via Binance)`);
            hadPriceError = false;
        }
        cachedSOLPrice = binancePrice;
        lastFetchTime = Date.now();
        return binancePrice;
    }

    const dexScreenerPrice = await fetchFromDexScreener();
    if (dexScreenerPrice) {
        if (hadPriceError) {
            console.log(`✅ SOL price recovered: $${dexScreenerPrice.toFixed(2)} (via DexScreener)`);
            hadPriceError = false;
        }
        cachedSOLPrice = dexScreenerPrice;
        lastFetchTime = Date.now();
        return dexScreenerPrice;
    }

    const coingeckoPrice = await fetchFromCoinGecko();
    if (coingeckoPrice) {
        if (hadPriceError) {
            console.log(`✅ SOL price recovered: $${coingeckoPrice.toFixed(2)} (via CoinGecko)`);
            hadPriceError = false;
        }
        cachedSOLPrice = coingeckoPrice;
        lastFetchTime = Date.now();
        return coingeckoPrice;
    }

    // All sources failed - log warning (throttled)
    const now = Date.now();
    if (now - lastLogTime > 60000) {
        console.warn("⚠️ All SOL price sources failed, retrying...");
        lastLogTime = now;
    }
    hadPriceError = true; // Mark that we had an error

    // If we have a cached price, use it; otherwise keep trying
    if (cachedSOLPrice > 0) {
        return cachedSOLPrice;
    }

    // No cached price - keep retrying
    await new Promise(resolve => setTimeout(resolve, 1000));
    return fetchSOLPrice(); // Recursive retry
}

/**
 * Get SOL price (uses cache, refreshes if stale)
 * Fast - returns cached value immediately if fresh
 */
export async function getSOLPriceCached(): Promise<number> {
    const now = Date.now();

    // If cache is fresh, return immediately
    if (now - lastFetchTime < CACHE_TTL_MS) {
        return cachedSOLPrice;
    }

    // If fetch already in progress, wait for it
    if (fetchInProgress) {
        return fetchInProgress;
    }

    // Start new fetch
    fetchInProgress = fetchSOLPrice().finally(() => {
        fetchInProgress = null;
    });

    return fetchInProgress;
}

/**
 * Get SOL price synchronously (returns cached value, may be stale)
 * Use when you need instant response and slight staleness is OK
 */
export function getSOLPriceSync(): number {
    // Trigger background refresh if stale
    if (Date.now() - lastFetchTime > CACHE_TTL_MS) {
        getSOLPriceCached().catch(() => { });
    }
    return cachedSOLPrice;
}

/**
 * Convert USD to SOL (sync - uses cached price for speed)
 */
export function usdToSOLSync(usdAmount: number): number {
    return usdAmount / cachedSOLPrice;
}

/**
 * Convert USD to SOL (async - ensures fresh price)
 */
export async function usdToSOL(usdAmount: number): Promise<number> {
    const solPrice = await getSOLPriceCached();
    return usdAmount / solPrice;
}

/**
 * Convert SOL to USD (sync - uses cached price for speed)
 */
export function solToUSDSync(solAmount: number): number {
    return solAmount * cachedSOLPrice;
}

/**
 * Convert SOL to USD (async - ensures fresh price)
 */
export async function solToUSD(solAmount: number): Promise<number> {
    const solPrice = await getSOLPriceCached();
    return solAmount * solPrice;
}

/**
 * Parse user input - handles both SOL and USD amounts
 * Examples: "0.5" -> 0.5 SOL, "$20" -> converts $20 to SOL
 */
export async function parseAmountInput(input: string): Promise<{ solAmount: number; isUSD: boolean } | null> {
    const trimmed = input.trim();

    // Check for dollar sign prefix
    if (trimmed.startsWith("$")) {
        const usdAmount = parseFloat(trimmed.slice(1));
        if (isNaN(usdAmount) || usdAmount <= 0) {
            return null;
        }
        // Use cached price for instant response
        const solAmount = usdToSOLSync(usdAmount);
        return { solAmount, isUSD: true };
    }

    // Plain SOL amount
    const solAmount = parseFloat(trimmed);
    if (isNaN(solAmount) || solAmount <= 0) {
        return null;
    }
    return { solAmount, isUSD: false };
}

/**
 * Format SOL amount with USD equivalent
 * Example: "0.5 SOL (~$90)"
 */
export function formatSOLWithUSD(solAmount: number): string {
    const usdValue = solToUSDSync(solAmount);
    return `${solAmount} SOL (~$${usdValue.toFixed(2)})`;
}

/**
 * Start background price refresh (call on bot startup)
 */
export function startPriceRefresh(): void {
    // Initial fetch
    getSOLPriceCached().then(price => {
        console.log(`💰 SOL price initialized: $${price.toFixed(2)}`);
    });

    // Periodic refresh every 10 seconds
    setInterval(() => {
        getSOLPriceCached().catch(() => { });
    }, CACHE_TTL_MS);
}


