/**
 * Lock Program Registry
 * 
 * Contains program IDs for known LP locker contracts on Solana.
 * Used to detect if LP tokens are locked vs held in regular wallets.
 */

// StreamFlow Token Lock Programs
export const STREAMFLOW_PROGRAMS = {
    COMMUNITY: "8e72pYCDaxu3GqMfeQ5r8wFgoZSYk6oua1Qo9XpsZjX",  // Free/open-source
    COMMERCIAL: "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",  // Paid version
};

// UNCX Network (Unicrypt) Raydium Locker Programs
export const UNCX_PROGRAMS = {
    AMM_V4_1: "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo",
    AMM_V4_2: "BzKincxjgFQjj4FmhaWrwHES1ekBGN73YesA7JwJJo7X",
    SMART_LOCKER_1: "UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN",
    SMART_LOCKER_2: "DAtFFs2mhQFvrgNLA29vEDeTLLN8vHknAaAhdLEc4SQH",
    CP_SWAP_1: "UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB",
    CP_SWAP_2: "FEmGEWdxCBSJ1QFKeX5B6k7VTDPwNU3ZLdfgJkvGYrH5",
};

// Burn/Null Addresses (LP sent here = permanently removed)
export const BURN_ADDRESSES = new Set([
    "11111111111111111111111111111111",  // System program null
    "1nc1nerator11111111111111111111111111111111",  // Incinerator
]);

// All known lock program IDs (for quick lookup)
export const ALL_LOCK_PROGRAMS = new Set([
    // StreamFlow
    STREAMFLOW_PROGRAMS.COMMUNITY,
    STREAMFLOW_PROGRAMS.COMMERCIAL,
    // UNCX
    UNCX_PROGRAMS.AMM_V4_1,
    UNCX_PROGRAMS.AMM_V4_2,
    UNCX_PROGRAMS.SMART_LOCKER_1,
    UNCX_PROGRAMS.SMART_LOCKER_2,
    UNCX_PROGRAMS.CP_SWAP_1,
    UNCX_PROGRAMS.CP_SWAP_2,
]);

/**
 * Check if an address is a known lock program
 */
export function isLockProgram(address: string): boolean {
    return ALL_LOCK_PROGRAMS.has(address);
}

/**
 * Check if an address is a burn address
 */
export function isBurnAddress(address: string): boolean {
    return BURN_ADDRESSES.has(address);
}

/**
 * Get the name of a lock program by address
 */
export function getLockProgramName(address: string): string {
    // StreamFlow
    if (address === STREAMFLOW_PROGRAMS.COMMUNITY) return "StreamFlow";
    if (address === STREAMFLOW_PROGRAMS.COMMERCIAL) return "StreamFlow";

    // UNCX
    if (Object.values(UNCX_PROGRAMS).includes(address)) return "UNCX";

    return "Unknown Locker";
}
