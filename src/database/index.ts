/**
 * Database initialization and connection management
 */

import Database from "better-sqlite3";
import { DATABASE_PATH } from "../config.js";
import { runMigrations } from "./schema.js";
import * as fs from "fs";
import * as path from "path";

let db: Database.Database | null = null;

/**
 * Initialize the database connection
 */
export function initDatabase(): Database.Database {
    if (db) {
        return db;
    }

    // Ensure data directory exists
    const dbDir = path.dirname(DATABASE_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        console.log(`📁 Created database directory: ${dbDir}`);
    }

    // Open database connection
    db = new Database(DATABASE_PATH);

    // Enable WAL mode for better concurrent access
    db.pragma("journal_mode = WAL");

    // Enable foreign keys
    db.pragma("foreign_keys = ON");

    console.log(`📂 Database opened: ${DATABASE_PATH}`);

    // Run migrations
    runMigrations(db);

    return db;
}

/**
 * Get the database instance (must be initialized first)
 */
export function getDatabase(): Database.Database {
    if (!db) {
        throw new Error("Database not initialized. Call initDatabase() first.");
    }
    return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        console.log("📂 Database connection closed");
    }
}

// Export types
export type { Database };
