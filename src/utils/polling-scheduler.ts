/**
 * Unified Polling Scheduler
 * 
 * Coordinates all polling activities with staggered start times to avoid rate limits.
 * 
 * Design:
 * - 4 components, each fires every 700ms
 * - Staggered starts: 0ms, 175ms, 350ms, 525ms
 * - 6 dRPC keys rotating = each key has ~1.05s between uses
 * 
 * Components:
 * 1. TP/SL Monitor (Jupiter quotes)
 * 2. Curve Polling (bonding curve progress)
 * 3. Wallet Polling (new token detection)
 * 4. Stale Check (subscription health)
 */

// Polling interval (all components use same interval)
const POLL_INTERVAL_MS = 700;

// Staggered start offsets (spread 4 components across 700ms)
const STAGGER_OFFSETS = {
    TPSL: 0,        // T=0ms
    CURVE: 175,     // T=175ms
    WALLET: 350,    // T=350ms  
    STALE: 525,     // T=525ms
};

// Polling function types
type PollingFunction = () => Promise<void>;

// Scheduler state
let isRunning = false;
let intervalIds: Map<string, NodeJS.Timeout> = new Map();

// Registered polling functions
const pollingFunctions: Map<string, PollingFunction> = new Map();

/**
 * Register a polling function
 */
export function registerPollingFunction(name: string, fn: PollingFunction): void {
    pollingFunctions.set(name, fn);
    console.log(`📋 [Scheduler] Registered: ${name}`);
}

/**
 * Start the unified polling scheduler
 * 
 * Each registered component starts at its designated offset,
 * then runs every POLL_INTERVAL_MS (700ms)
 */
export function startPollingScheduler(): void {
    if (isRunning) {
        console.log("⚠️ [Scheduler] Already running");
        return;
    }

    isRunning = true;
    console.log(`🔄 [Scheduler] Starting with ${POLL_INTERVAL_MS}ms interval...`);
    console.log(`   Components: ${pollingFunctions.size}`);
    console.log(`   Stagger offsets: ${Object.values(STAGGER_OFFSETS).join(", ")}ms`);

    // Get offset for each component
    const offsetMap: Record<string, number> = {
        "tpsl": STAGGER_OFFSETS.TPSL,
        "curve": STAGGER_OFFSETS.CURVE,
        "wallet": STAGGER_OFFSETS.WALLET,
        "stale": STAGGER_OFFSETS.STALE,
    };

    let componentIndex = 0;
    for (const [name, fn] of pollingFunctions) {
        // Get offset based on component type or default to index-based
        const offset = offsetMap[name.toLowerCase()] ?? (componentIndex * 175);
        componentIndex++;

        // Start after offset, then repeat every POLL_INTERVAL_MS
        setTimeout(() => {
            // Run immediately on first trigger
            runPollingFunction(name, fn);

            // Then set up interval
            const intervalId = setInterval(() => {
                runPollingFunction(name, fn);
            }, POLL_INTERVAL_MS);

            intervalIds.set(name, intervalId);
            console.log(`✅ [Scheduler] ${name} started (offset: ${offset}ms, interval: ${POLL_INTERVAL_MS}ms)`);
        }, offset);
    }

    console.log(`🚀 [Scheduler] All components scheduled`);
}

/**
 * Run a polling function with error handling
 */
async function runPollingFunction(name: string, fn: PollingFunction): Promise<void> {
    try {
        await fn();
    } catch (error) {
        // Silently ignore errors to prevent log spam
        // Individual components can log their own errors if needed
    }
}

/**
 * Stop the polling scheduler
 */
export function stopPollingScheduler(): void {
    if (!isRunning) return;

    isRunning = false;

    for (const [name, intervalId] of intervalIds) {
        clearInterval(intervalId);
        console.log(`🛑 [Scheduler] Stopped: ${name}`);
    }

    intervalIds.clear();
    console.log("🛑 [Scheduler] All polling stopped");
}

/**
 * Check if scheduler is running
 */
export function isSchedulerRunning(): boolean {
    return isRunning;
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus(): {
    running: boolean;
    components: string[];
    interval: number;
} {
    return {
        running: isRunning,
        components: Array.from(pollingFunctions.keys()),
        interval: POLL_INTERVAL_MS,
    };
}
