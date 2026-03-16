/**
 * Database Schema - SQL definitions and migrations
 */

export const SCHEMA_VERSION = 6;

export const CREATE_TABLES_SQL = `
-- Users table
CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- User settings
CREATE TABLE IF NOT EXISTS settings (
    telegram_id INTEGER PRIMARY KEY,
    slippage_bps INTEGER DEFAULT 1500,
    quick_buy_1 REAL DEFAULT 0.1,
    quick_buy_2 REAL DEFAULT 0.5,
    quick_sell_1 INTEGER DEFAULT 25,
    quick_sell_2 INTEGER DEFAULT 50,
    instant_buy_enabled INTEGER DEFAULT 0,
    instant_buy_amount REAL DEFAULT 0.1,
    autosell_threshold INTEGER DEFAULT 85,
    -- Global TP/SL defaults (applied to new positions automatically)
    default_tp_enabled INTEGER DEFAULT 0,
    default_tp_percent REAL DEFAULT 100,
    default_tp_sell_percent INTEGER DEFAULT 50,
    default_sl_enabled INTEGER DEFAULT 0,
    default_sl_percent REAL DEFAULT 30,
    default_sl_sell_percent INTEGER DEFAULT 100,
    default_trail_enabled INTEGER DEFAULT 0,
    default_trail_percent REAL DEFAULT 20,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Positions (active trades)
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    wallet_id INTEGER,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    entry_price REAL NOT NULL,
    entry_amount TEXT NOT NULL,
    entry_sol REAL NOT NULL,
    entry_time INTEGER NOT NULL,
    entry_market_cap REAL,
    UNIQUE(wallet_id, token_mint),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
    FOREIGN KEY (wallet_id) REFERENCES wallets(id)
);

-- TP/SL rules
CREATE TABLE IF NOT EXISTS tp_sl_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('TP', 'SL', 'TRAILING_SL')),
    trigger_percent REAL NOT NULL,
    sell_percent INTEGER NOT NULL,
    trail_distance REAL,
    peak_price REAL,
    triggered INTEGER DEFAULT 0,
    triggered_at INTEGER,
    FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
);

-- Transaction history
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    wallet_id INTEGER,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    type TEXT NOT NULL CHECK(type IN ('BUY', 'SELL')),
    token_amount TEXT NOT NULL,
    sol_amount REAL NOT NULL,
    price REAL NOT NULL,
    signature TEXT,
    pnl_percent REAL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
    FOREIGN KEY (wallet_id) REFERENCES wallets(id)
);

-- Recent tokens (last accessed)
CREATE TABLE IF NOT EXISTS recent_tokens (
    telegram_id INTEGER NOT NULL,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    accessed_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, token_mint),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Favorite tokens (watchlist)
CREATE TABLE IF NOT EXISTS favorite_tokens (
    telegram_id INTEGER NOT NULL,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, token_mint),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Wallets table (multi-wallet support)
CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Indexes (base indexes only - wallet_id indexes added by migration v5)
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_tpsl_position ON tp_sl_rules(position_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_recent_tokens_user ON recent_tokens(telegram_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(telegram_id);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);
`;

/**
 * Run database migrations
 */
export function runMigrations(db: import("better-sqlite3").Database): void {
    // Check current version
    const versionTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get();

    let currentVersion = 0;

    if (versionTable) {
        const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number } | undefined;
        currentVersion = row?.version || 0;
    }

    if (currentVersion < SCHEMA_VERSION) {
        console.log(`📦 Running database migrations (v${currentVersion} → v${SCHEMA_VERSION})`);

        // Run schema creation (idempotent with IF NOT EXISTS)
        db.exec(CREATE_TABLES_SQL);

        // Run incremental migrations
        if (currentVersion < 2) {
            // Migration v2: Add global TP/SL default columns to settings
            console.log("📦 Migration v2: Adding global TP/SL defaults to settings...");
            try {
                db.exec(`ALTER TABLE settings ADD COLUMN default_tp_enabled INTEGER DEFAULT 0`);
                db.exec(`ALTER TABLE settings ADD COLUMN default_tp_percent REAL DEFAULT 100`);
                db.exec(`ALTER TABLE settings ADD COLUMN default_tp_sell_percent INTEGER DEFAULT 50`);
                db.exec(`ALTER TABLE settings ADD COLUMN default_sl_enabled INTEGER DEFAULT 0`);
                db.exec(`ALTER TABLE settings ADD COLUMN default_sl_percent REAL DEFAULT 30`);
                db.exec(`ALTER TABLE settings ADD COLUMN default_sl_sell_percent INTEGER DEFAULT 100`);
                db.exec(`ALTER TABLE settings ADD COLUMN default_trail_enabled INTEGER DEFAULT 0`);
                db.exec(`ALTER TABLE settings ADD COLUMN default_trail_percent REAL DEFAULT 20`);
            } catch (e) {
                // Columns may already exist
                console.log("📦 Global TP/SL columns already exist or migration skipped");
            }
        }

        if (currentVersion < 3) {
            // Migration v3: Add entry_market_cap column to positions
            console.log("📦 Migration v3: Adding entry_market_cap to positions...");
            try {
                db.exec(`ALTER TABLE positions ADD COLUMN entry_market_cap REAL`);
            } catch (e) {
                // Column may already exist
                console.log("📦 entry_market_cap column already exists or migration skipped");
            }
        }

        if (currentVersion < 4) {
            // Migration v4: Create wallets table and migrate existing wallet data
            console.log("📦 Migration v4: Creating wallets table for multi-wallet support...");
            try {
                // Create wallets table (idempotent)
                db.exec(`
                    CREATE TABLE IF NOT EXISTS wallets (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        telegram_id INTEGER NOT NULL,
                        name TEXT NOT NULL,
                        wallet_address TEXT NOT NULL,
                        encrypted_private_key TEXT NOT NULL,
                        is_active INTEGER DEFAULT 0,
                        created_at INTEGER NOT NULL,
                        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
                    )
                `);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(telegram_id)`);

                // Migrate existing wallet data from users table
                const existingUsers = db.prepare(`
                    SELECT telegram_id, wallet_address, encrypted_private_key, created_at
                    FROM users
                    WHERE wallet_address IS NOT NULL AND wallet_address != ''
                `).all() as { telegram_id: number; wallet_address: string; encrypted_private_key: string; created_at: number }[];

                const insertWallet = db.prepare(`
                    INSERT INTO wallets (telegram_id, name, wallet_address, encrypted_private_key, is_active, created_at)
                    VALUES (?, ?, ?, ?, 1, ?)
                `);

                for (const user of existingUsers) {
                    // Check if wallet already migrated
                    const existing = db.prepare(`SELECT 1 FROM wallets WHERE telegram_id = ?`).get(user.telegram_id);
                    if (!existing) {
                        insertWallet.run(
                            user.telegram_id,
                            "Main Wallet",
                            user.wallet_address,
                            user.encrypted_private_key,
                            user.created_at
                        );
                        console.log(`📦 Migrated wallet for user ${user.telegram_id}`);
                    }
                }

                console.log(`📦 Migration v4 complete: ${existingUsers.length} wallets migrated`);
            } catch (e) {
                console.log("📦 Wallets table already exists or migration error:", e);
            }
        }

        if (currentVersion < 5) {
            // Migration v5: Add wallet_id to positions and transactions for per-wallet data
            console.log("📦 Migration v5: Adding wallet_id to positions and transactions...");
            try {
                // Check if wallet_id column already exists in positions
                const positionsInfo = db.prepare("PRAGMA table_info(positions)").all() as { name: string }[];
                const positionsHasWalletId = positionsInfo.some(col => col.name === "wallet_id");

                if (!positionsHasWalletId) {
                    db.exec(`ALTER TABLE positions ADD COLUMN wallet_id INTEGER REFERENCES wallets(id)`);
                    console.log("   Added wallet_id column to positions");
                }

                // Check if wallet_id column already exists in transactions
                const transactionsInfo = db.prepare("PRAGMA table_info(transactions)").all() as { name: string }[];
                const transactionsHasWalletId = transactionsInfo.some(col => col.name === "wallet_id");

                if (!transactionsHasWalletId) {
                    db.exec(`ALTER TABLE transactions ADD COLUMN wallet_id INTEGER REFERENCES wallets(id)`);
                    console.log("   Added wallet_id column to transactions");
                }

                // Populate wallet_id for existing positions (use user's active wallet)
                // Get all users who have positions and wallets
                const usersWithWallets = db.prepare(`
                    SELECT telegram_id, id as wallet_id FROM wallets WHERE is_active = 1
                `).all() as { telegram_id: number; wallet_id: number }[];

                for (const user of usersWithWallets) {
                    // Update positions for this user
                    db.prepare(`UPDATE positions SET wallet_id = ? WHERE telegram_id = ? AND wallet_id IS NULL`)
                        .run(user.wallet_id, user.telegram_id);
                    // Update transactions for this user
                    db.prepare(`UPDATE transactions SET wallet_id = ? WHERE telegram_id = ? AND wallet_id IS NULL`)
                        .run(user.wallet_id, user.telegram_id);
                }

                // Create indexes
                try {
                    db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_id)`);
                    db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id)`);
                } catch {
                    // Indexes may already exist
                }

                console.log("📦 Migration v5 complete: wallet_id added to positions and transactions");
            } catch (e) {
                console.log("📦 Migration v5 error:", e);
            }
        }

        if (currentVersion < 6) {
            // Migration v6: Recreate positions table with UNIQUE(wallet_id, token_mint) constraint
            // SQLite doesn't support altering constraints, so we need to recreate the table
            console.log("📦 Migration v6: Updating positions table unique constraint...");
            try {
                db.exec(`
                    -- Create new table with correct constraint
                    CREATE TABLE IF NOT EXISTS positions_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        telegram_id INTEGER NOT NULL,
                        wallet_id INTEGER,
                        token_mint TEXT NOT NULL,
                        token_symbol TEXT,
                        entry_price REAL NOT NULL,
                        entry_amount TEXT NOT NULL,
                        entry_sol REAL NOT NULL,
                        entry_time INTEGER NOT NULL,
                        entry_market_cap REAL,
                        UNIQUE(wallet_id, token_mint),
                        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
                        FOREIGN KEY (wallet_id) REFERENCES wallets(id)
                    );

                    -- Copy data from old table
                    INSERT OR IGNORE INTO positions_new 
                    SELECT * FROM positions;

                    -- Drop old table
                    DROP TABLE positions;

                    -- Rename new table
                    ALTER TABLE positions_new RENAME TO positions;

                    -- Recreate indexes
                    CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(telegram_id);
                    CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_id);
                `);
                console.log("📦 Migration v6 complete: positions table constraint updated");
            } catch (e) {
                console.log("📦 Migration v6 error:", e);
            }
        }

        // Update version
        db.prepare("INSERT OR REPLACE INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);

        console.log("✅ Database migrations complete");
    }
}

