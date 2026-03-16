/**
 * Meteora Post-Graduation Safety Check
 * 
 * For tokens that have graduated from DBC to DAMM (Meteora's AMM),
 * checks LP token distribution to assess rug risk:
 * - LP burned % (sent to burn address)
 * - LP locked % (sent to known lock contracts)
 * - LP claimable % (still held by creator/others)
 * - Top token holder concentration (dump risk)
 */

import { PublicKey } from "@solana/web3.js";
import { getMonitoringHttpRpc } from "../../utils/rpc.js";
import { fetchJSON } from "../../utils/http.js";

// Meteora DAMM API endpoints
const DAMM_V1_API = "https://amm-v2.meteora.ag";
const DAMM_V2_API = "https://damm-api.meteora.ag";

// Known burn/lock addresses
const BURN_ADDRESSES = new Set([
    "11111111111111111111111111111111",  // System program (null address)
    "1111111111111111111111111111111111111111111", // Extended null
]);

const LOCK_PROGRAMS = new Set([
    "TokenLockup111111111111111111111111111111", // StreamFlow
    // Add more known lock programs as needed
]);

/**
 * Pool info from Meteora API
 */
interface MeteoraPool {
    pool_address: string;
    lp_mint: string;
    pool_token_mints: string[];
    pool_type?: string;
}

/**
 * Meteora API paginated response
 */
interface MeteoraAPIResponse {
    data: MeteoraPool[];
    page: number;
    total_count: number;
}

/**
 * LP holder info
 */
interface LPHolder {
    address: string;
    owner: string;
    amount: string;
    percentage: number;
    status: 'burned' | 'locked' | 'claimable';
}

/**
 * Post-graduation safety result
 */
export interface PostGraduationSafety {
    isGraduated: boolean;
    poolAddress: string | null;
    lpMint: string | null;

    // LP Distribution
    lpBurnedPercentage: number;
    lpLockedPercentage: number;
    lpClaimablePercentage: number;
    topLPHolders: LPHolder[];

    // Token holder concentration (dump risk)
    topTokenHolderPercentage: number;

    // Human-readable safety lines
    safetyLines: string[];

    // Raw error if any
    error?: string;
}

/**
 * Find Meteora DAMM pool for a token mint
 */
async function findMeteoraDAMMPool(tokenMint: string): Promise<MeteoraPool | null> {
    // Try DAMM v1 first (more common for graduated tokens)
    try {
        const v1Url = `${DAMM_V1_API}/pools/search?pool_token_mints=${tokenMint}&page=0&size=10`;
        const v1Response = await fetchJSON<MeteoraAPIResponse>(v1Url);
        const v1Data = v1Response.data || [];

        if (v1Data.length > 0) {
            // Find pool containing this token
            const pool = v1Data.find(p =>
                p.pool_token_mints?.includes(tokenMint)
            );
            if (pool) {
                console.log(`📍 [Meteora Post-Grad] Found DAMM v1 pool: ${pool.pool_address}`);
                return pool;
            }
        }
    } catch (error) {
        console.log(`   DAMM v1 search failed, trying v2...`);
    }

    // Try DAMM v2
    try {
        const v2Url = `${DAMM_V2_API}/pools/search?pool_token_mints=${tokenMint}&page=0&size=10`;
        const v2Response = await fetchJSON<MeteoraAPIResponse>(v2Url);
        const v2Data = v2Response.data || [];

        if (v2Data.length > 0) {
            const pool = v2Data.find(p =>
                p.pool_token_mints?.includes(tokenMint)
            );
            if (pool) {
                console.log(`📍 [Meteora Post-Grad] Found DAMM v2 pool: ${pool.pool_address}`);
                return pool;
            }
        }
    } catch (error) {
        console.log(`   DAMM v2 search also failed`);
    }

    return null;
}

/**
 * Get LP token holders and classify them
 */
async function getLPHolderDistribution(lpMint: string): Promise<{
    holders: LPHolder[];
    burnedPct: number;
    lockedPct: number;
    claimablePct: number;
}> {
    const connection = getMonitoringHttpRpc();
    const lpMintPubkey = new PublicKey(lpMint);

    // Get largest LP token accounts
    const largestAccounts = await connection.getTokenLargestAccounts(lpMintPubkey);

    if (!largestAccounts.value || largestAccounts.value.length === 0) {
        return { holders: [], burnedPct: 0, lockedPct: 0, claimablePct: 100 };
    }

    // Get total supply for percentage calculation
    const supplyInfo = await connection.getTokenSupply(lpMintPubkey);
    const totalSupply = Number(supplyInfo.value.amount);

    if (totalSupply === 0) {
        return { holders: [], burnedPct: 100, lockedPct: 0, claimablePct: 0 };
    }

    // Fetch owner info for each account
    const holders: LPHolder[] = [];
    let burnedAmount = 0;
    let lockedAmount = 0;
    let claimableAmount = 0;

    for (const account of largestAccounts.value.slice(0, 10)) {
        try {
            const accountInfo = await connection.getParsedAccountInfo(account.address);
            const parsedData = accountInfo.value?.data as any;
            const owner = parsedData?.parsed?.info?.owner || 'unknown';
            const amount = Number(account.amount);
            const percentage = (amount / totalSupply) * 100;

            let status: 'burned' | 'locked' | 'claimable';

            if (BURN_ADDRESSES.has(owner)) {
                status = 'burned';
                burnedAmount += amount;
            } else if (LOCK_PROGRAMS.has(owner)) {
                status = 'locked';
                lockedAmount += amount;
            } else {
                status = 'claimable';
                claimableAmount += amount;
            }

            holders.push({
                address: account.address.toBase58(),
                owner,
                amount: account.amount,
                percentage,
                status,
            });
        } catch (error) {
            // Skip accounts we can't parse
            continue;
        }
    }

    return {
        holders,
        burnedPct: (burnedAmount / totalSupply) * 100,
        lockedPct: (lockedAmount / totalSupply) * 100,
        claimablePct: (claimableAmount / totalSupply) * 100,
    };
}

/**
 * Get top token holder concentration
 */
async function getTopHolderConcentration(tokenMint: string): Promise<number> {
    try {
        const connection = getMonitoringHttpRpc();
        const mintPubkey = new PublicKey(tokenMint);

        const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
        const supplyInfo = await connection.getTokenSupply(mintPubkey);

        if (!largestAccounts.value?.[0] || !supplyInfo.value.amount) {
            return 0;
        }

        const topAmount = Number(largestAccounts.value[0].amount);
        const totalSupply = Number(supplyInfo.value.amount);

        return (topAmount / totalSupply) * 100;
    } catch (error) {
        return 0;
    }
}

/**
 * Check post-graduation Meteora token safety
 * 
 * Thresholds for ✅:
 * - LP burned/locked ≥ 80% combined
 * - LP claimable ≤ 20%
 * - Top token holder ≤ 30%
 */
export async function checkPostGraduationSafety(tokenMint: string): Promise<PostGraduationSafety> {
    const defaultResult: PostGraduationSafety = {
        isGraduated: false,
        poolAddress: null,
        lpMint: null,
        lpBurnedPercentage: 0,
        lpLockedPercentage: 0,
        lpClaimablePercentage: 0,
        topLPHolders: [],
        topTokenHolderPercentage: 0,
        safetyLines: [],
    };

    try {
        console.log(`🔍 [Meteora Post-Grad] Checking graduated pool for ${tokenMint.slice(0, 8)}...`);

        // 1. Find the DAMM pool
        const pool = await findMeteoraDAMMPool(tokenMint);

        if (!pool) {
            return {
                ...defaultResult,
                safetyLines: ["ℹ️ No Meteora DAMM pool found"],
            };
        }

        // 2. Get LP holder distribution
        const lpDistribution = await getLPHolderDistribution(pool.lp_mint);

        // 3. Get top token holder concentration
        const topHolderPct = await getTopHolderConcentration(tokenMint);

        // 4. Build safety lines with ✅/❌
        const safetyLines: string[] = [];

        // LP safety (burned + locked combined)
        const safeLP = lpDistribution.burnedPct + lpDistribution.lockedPct;
        const lpSafeGood = safeLP >= 80;

        if (lpDistribution.burnedPct > 0) {
            safetyLines.push(`${lpDistribution.burnedPct >= 80 ? '✅' : '⚠️'} ${lpDistribution.burnedPct.toFixed(1)}% LP burned`);
        }
        if (lpDistribution.lockedPct > 0) {
            safetyLines.push(`${lpDistribution.lockedPct >= 50 ? '✅' : '⚠️'} ${lpDistribution.lockedPct.toFixed(1)}% LP locked`);
        }

        // Claimable LP check
        const claimableGood = lpDistribution.claimablePct <= 20;
        safetyLines.push(
            `${claimableGood ? '✅' : '❌'} ${lpDistribution.claimablePct.toFixed(1)}% LP withdrawable`
        );

        // Top holder concentration (dump risk)
        const concentrationGood = topHolderPct <= 30;
        safetyLines.push(
            `${concentrationGood ? '✅' : '❌'} Top holder: ${topHolderPct.toFixed(1)}% of supply`
        );

        return {
            isGraduated: true,
            poolAddress: pool.pool_address,
            lpMint: pool.lp_mint,
            lpBurnedPercentage: lpDistribution.burnedPct,
            lpLockedPercentage: lpDistribution.lockedPct,
            lpClaimablePercentage: lpDistribution.claimablePct,
            topLPHolders: lpDistribution.holders,
            topTokenHolderPercentage: topHolderPct,
            safetyLines,
        };

    } catch (error) {
        console.error(`❌ [Meteora Post-Grad] Error:`, (error as Error).message);
        return {
            ...defaultResult,
            error: (error as Error).message,
            safetyLines: [`⚠️ Error checking graduated pool: ${(error as Error).message}`],
        };
    }
}

/**
 * Format post-graduation safety report for display
 */
export function formatPostGraduationReport(result: PostGraduationSafety): string {
    if (!result.isGraduated) {
        return result.safetyLines.join('\n') || "ℹ️ Token has not graduated to DAMM";
    }

    return result.safetyLines.join('\n');
}
