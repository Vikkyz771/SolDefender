/**
 * One-time cleanup script to remove orphaned positions and TP/SL rules
 * Run with: npx tsx scripts/cleanup-positions.ts
 */

import Database from "better-sqlite3";
import * as path from "path";

const dbPath = path.join(process.cwd(), "data", "bot.db");
console.log(`📂 Opening database: ${dbPath}`);

const db = new Database(dbPath);

// Count before cleanup
const posCountBefore = (db.prepare("SELECT COUNT(*) as count FROM positions").get() as { count: number }).count;
const ruleCountBefore = (db.prepare("SELECT COUNT(*) as count FROM tp_sl_rules").get() as { count: number }).count;

console.log(`\n📊 Before cleanup:`);
console.log(`   Positions: ${posCountBefore}`);
console.log(`   TP/SL Rules: ${ruleCountBefore}`);

// Show positions
const positions = db.prepare("SELECT id, telegram_id, token_mint, token_symbol FROM positions").all() as Array<{
    id: number;
    telegram_id: number;
    token_mint: string;
    token_symbol: string | null;
}>;

console.log(`\n📋 Existing positions:`);
for (const pos of positions) {
    console.log(`   ID: ${pos.id} | ${pos.token_symbol || pos.token_mint.slice(0, 8)}`);
}

// Delete all TP/SL rules first (due to FK constraint)
const rulesDeleted = db.prepare("DELETE FROM tp_sl_rules").run();
console.log(`\n🗑️ Deleted ${rulesDeleted.changes} TP/SL rules`);

// Delete all positions
const positionsDeleted = db.prepare("DELETE FROM positions").run();
console.log(`🗑️ Deleted ${positionsDeleted.changes} positions`);

// Count after cleanup
const posCountAfter = (db.prepare("SELECT COUNT(*) as count FROM positions").get() as { count: number }).count;
const ruleCountAfter = (db.prepare("SELECT COUNT(*) as count FROM tp_sl_rules").get() as { count: number }).count;

console.log(`\n✅ After cleanup:`);
console.log(`   Positions: ${posCountAfter}`);
console.log(`   TP/SL Rules: ${ruleCountAfter}`);

db.close();
console.log("\n🎉 Cleanup complete!");
