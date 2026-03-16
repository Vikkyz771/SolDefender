/**
 * User-friendly error message mapping
 * 
 * Maps technical blockchain errors to clean, professional messages
 */

interface ErrorMapping {
    match: string | RegExp;
    message: string;
}

const ERROR_MAPPINGS: ErrorMapping[] = [
    // Insufficient funds errors
    {
        match: /insufficient lamports/i,
        message: "Insufficient SOL balance. Please add more SOL to your wallet."
    },
    {
        match: /insufficient funds/i,
        message: "Insufficient SOL balance. Please add more SOL to your wallet."
    },
    {
        match: /need \d+ lamports/i,
        message: "Not enough SOL for transaction fees. Please add more SOL."
    },

    // Slippage / price movement errors
    {
        match: /slippage/i,
        message: "Price moved too much. Try increasing slippage or try again."
    },
    {
        match: /exceeds desired slippage/i,
        message: "Price moved beyond slippage limit. Try again or increase slippage."
    },

    // Liquidity errors
    {
        match: /no route found/i,
        message: "No liquidity available for this token."
    },
    {
        match: /no swap route/i,
        message: "No liquidity available for this token."
    },
    {
        match: /400.*bad request/i,
        message: "Token has no liquidity or is not tradeable."
    },

    // Token account errors
    {
        match: /token account.*not found/i,
        message: "Token not found in your wallet."
    },
    {
        match: /account.*does not exist/i,
        message: "Token account not found."
    },

    // Rate limit errors
    {
        match: /429/i,
        message: "Network busy. Please try again in a moment."
    },
    {
        match: /too many requests/i,
        message: "Network busy. Please try again in a moment."
    },

    // Simulation failures
    {
        match: /simulation failed/i,
        message: "Transaction simulation failed. The token may have trading restrictions."
    },
    {
        match: /custom program error/i,
        message: "Transaction failed. The token may have transfer restrictions."
    },

    // Network errors
    {
        match: /timeout/i,
        message: "Network timeout. Please try again."
    },
    {
        match: /connection.*refused/i,
        message: "Network connection issue. Please try again."
    },
    {
        match: /fetch failed/i,
        message: "Network error. Please try again."
    },

    // Transaction errors
    {
        match: /transaction failed/i,
        message: "Transaction failed. Please try again."
    },
    {
        match: /blockhash not found/i,
        message: "Transaction expired. Please try again."
    },
    {
        match: /all rpc endpoints failed/i,
        message: "Network congested. Please try again in a moment."
    },
];

/**
 * Convert a technical error message to a user-friendly one
 */
export function formatUserError(error: unknown): string {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check each mapping
    for (const mapping of ERROR_MAPPINGS) {
        if (typeof mapping.match === "string") {
            if (errorMessage.toLowerCase().includes(mapping.match.toLowerCase())) {
                return mapping.message;
            }
        } else if (mapping.match.test(errorMessage)) {
            return mapping.message;
        }
    }

    // Default fallback - don't show raw technical errors
    return "Transaction failed. Please try again.";
}

/**
 * Check if an error is related to insufficient funds
 */
export function isInsufficientFundsError(error: unknown): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return /insufficient (lamports|funds)/i.test(errorMessage) ||
        /need \d+ lamports/i.test(errorMessage);
}

/**
 * Check if an error is related to liquidity
 */
export function isLiquidityError(error: unknown): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return /no route|no swap|no liquidity|400.*bad request/i.test(errorMessage);
}
