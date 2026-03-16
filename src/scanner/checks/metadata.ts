import { PublicKey } from "@solana/web3.js";
import { getMonitoringHttpRpc } from "../../utils/rpc.js";
import { METAPLEX_PROGRAM_ID } from "../../config.js";

export interface MetadataCheckResult {
    hasMetadata: boolean;
    isMutable: boolean;
    name: string | null;
    symbol: string | null;
    updateAuthority: string | null;
}

/**
 * Retry with RPC rotation
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            // Don't retry on non-retryable errors
            const msg = lastError.message;
            if (msg.includes("Invalid public key") || msg.includes("not found")) {
                throw lastError;
            }

            // Retry on 500, 429, timeout errors
            if (msg.includes("500") || msg.includes("429") || msg.includes("timeout")) {
                await new Promise(r => setTimeout(r, 300));
                continue;
            }

            throw lastError;
        }
    }

    throw lastError || new Error("Max retries exceeded");
}

/**
 * Derive the Metaplex metadata PDA for a mint
 */
function getMetadataPDA(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metadata"),
            new PublicKey(METAPLEX_PROGRAM_ID).toBuffer(),
            mint.toBuffer(),
        ],
        new PublicKey(METAPLEX_PROGRAM_ID)
    );
    return pda;
}

/**
 * Parse Metaplex metadata account data
 * Layout: https://docs.metaplex.com/programs/token-metadata/accounts
 */
function parseMetadata(data: Buffer): {
    isMutable: boolean;
    name: string;
    symbol: string;
    updateAuthority: string;
} {
    // Key (1) + UpdateAuthority (32) + Mint (32) + Name (4 + 32) + Symbol (4 + 10) + Uri + ...
    // isMutable is at the end of the fixed fields

    let offset = 1; // Skip key byte

    const updateAuthority = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;

    offset += 32; // Skip mint

    // Name: 4 bytes length + up to 32 bytes
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    const name = data.subarray(offset, offset + nameLen).toString("utf8").replace(/\0/g, "").trim();
    offset += 32; // Fixed 32 bytes allocated

    // Symbol: 4 bytes length + up to 10 bytes
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    const symbol = data.subarray(offset, offset + symbolLen).toString("utf8").replace(/\0/g, "").trim();
    offset += 10; // Fixed 10 bytes allocated

    // URI: 4 bytes length + up to 200 bytes
    const uriLen = data.readUInt32LE(offset);
    offset += 4;
    offset += 200; // Skip URI

    // Seller fee basis points (2 bytes)
    offset += 2;

    // Creators option (1 byte bool + optional data)
    const hasCreators = data[offset] === 1;
    offset += 1;
    if (hasCreators) {
        const creatorsLen = data.readUInt32LE(offset);
        offset += 4;
        offset += creatorsLen * (32 + 1 + 1); // pubkey + verified + share
    }

    // Primary sale happened (1 byte)
    offset += 1;

    // Is mutable (1 byte)
    const isMutable = data[offset] === 1;

    return { isMutable, name, symbol, updateAuthority };
}

/**
 * Check metadata mutability for a token
 * Mutable metadata = can change token info after launch (potential rug vector)
 */
export async function checkMetadata(mintAddress: string): Promise<MetadataCheckResult> {
    const mintPubkey = new PublicKey(mintAddress);
    const metadataPDA = getMetadataPDA(mintPubkey);

    try {
        const accountInfo = await withRetry(async () => {
            return await getMonitoringHttpRpc().getAccountInfo(metadataPDA);
        });

        if (!accountInfo || !accountInfo.data) {
            return {
                hasMetadata: false,
                isMutable: false,
                name: null,
                symbol: null,
                updateAuthority: null,
            };
        }

        const parsed = parseMetadata(Buffer.from(accountInfo.data));

        return {
            hasMetadata: true,
            isMutable: parsed.isMutable,
            name: parsed.name,
            symbol: parsed.symbol,
            updateAuthority: parsed.updateAuthority,
        };
    } catch (error) {
        console.error("Error fetching metadata:", error);
        return {
            hasMetadata: false,
            isMutable: false,
            name: null,
            symbol: null,
            updateAuthority: null,
        };
    }
}
