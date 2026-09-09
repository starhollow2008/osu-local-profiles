import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/**
 * schema.sql only uses CREATE TABLE IF NOT EXISTS, so columns added later never reach an
 * existing database. Each entry here is applied once if its column is missing.
 */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; definition: string }> = [
  { table: 'scores', column: 'max_statistics_json', definition: 'TEXT' },
  { table: 'scores', column: 'replay_path', definition: 'TEXT' },
];

function migrate(db: Db): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue; // table not created yet
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Read-only handle for a database owned by the osu! client (never written to). */
export function openReadOnly(file: string): Db | null {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

export function getOrCreateProfile(db: Db, name: string): number {
  const existing = db.prepare('SELECT id FROM profiles WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const now = Date.now();
  db.prepare(
    'INSERT INTO profiles (name, created_at, tracking_since, default_mode) VALUES (?, ?, ?, 0)',
  ).run(name, now, now);
  return (db.prepare('SELECT id FROM profiles WHERE name = ?').get(name) as { id: number }).id;
}
