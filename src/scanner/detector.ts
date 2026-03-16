/**
 * Solana base58 address regex
 * Matches 32-44 character base58 strings (Solana addresses)
 */
const SOLANA_ADDRESS_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/**
 * Known non-token addresses to exclude (programs, system accounts)
 */
const EXCLUDED_ADDRESSES = new Set([
    "11111111111111111111111111111111", // System Program
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // Metaplex
    "So11111111111111111111111111111111111111112", // Wrapped SOL
]);

/**
 * Detect Solana contract addresses in text
 * Returns unique addresses, excluding known programs
 */
export function detectContractAddress(text: string): string[] {
    const matches = text.match(SOLANA_ADDRESS_REGEX) || [];

    // Filter and deduplicate
    const unique = [...new Set(matches)].filter(
        (addr) => !EXCLUDED_ADDRESSES.has(addr)
    );

    return unique;
}
