/**
 * Retry utility for transient network errors
 * Handles DNS failures, connection resets, timeouts, etc.
 */

export interface RetryOptions {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    retryableErrors?: string[];
}

const DEFAULT_RETRYABLE_ERRORS = [
    // DNS errors
    "EAI_AGAIN",
    "ENOTFOUND",
    "getaddrinfo",

    // Connection errors
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",

    // Network/socket errors
    "fetch failed",
    "socket hang up",
    "Socket closed",
    "network socket disconnected",

    // Timeout errors
    "timeout",
    "TIMEOUT",
    "TimeoutError",

    // Generic transient
    "EPROTO",
    "EAI_FAIL",
];

/**
 * Check if an error is retryable (transient network error)
 */
export function isRetryableError(error: unknown, customRetryableErrors?: string[]): boolean {
    const errorStr = error instanceof Error
        ? `${error.message} ${(error as any).code || ""} ${(error as any).cause || ""}`
        : String(error);

    const retryablePatterns = customRetryableErrors || DEFAULT_RETRYABLE_ERRORS;

    return retryablePatterns.some(pattern =>
        errorStr.toLowerCase().includes(pattern.toLowerCase())
    );
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an async function with retry logic for transient errors
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    operationName: string,
    options: RetryOptions = {}
): Promise<T> {
    const {
        maxRetries = 3,
        initialDelayMs = 1000,
        maxDelayMs = 10000,
        backoffMultiplier = 2,
        retryableErrors = DEFAULT_RETRYABLE_ERRORS,
    } = options;

    let lastError: unknown;
    let delay = initialDelayMs;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Check if this is a retryable error
            if (!isRetryableError(error, retryableErrors)) {
                // Non-retryable error, throw immediately
                throw error;
            }

            // If we've exhausted retries, throw the last error
            if (attempt > maxRetries) {
                console.error(`❌ ${operationName} failed after ${maxRetries} retries:`, error);
                throw error;
            }

            // Log retry attempt
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`⚠️ ${operationName} failed (attempt ${attempt}/${maxRetries + 1}): ${errorMessage}`);
            console.log(`🔄 Retrying in ${delay}ms...`);

            // Wait before retrying
            await sleep(delay);

            // Increase delay for next attempt (exponential backoff)
            delay = Math.min(delay * backoffMultiplier, maxDelayMs);
        }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError;
}

/**
 * Wrap a function to automatically retry on transient errors
 */
export function withAutoRetry<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    operationName: string,
    options: RetryOptions = {}
): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs) => {
        return withRetry(() => fn(...args), operationName, options);
    };
}
