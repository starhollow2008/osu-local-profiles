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
  // Added with the unranked-mods setting. These stay NULL on rows ingested before it,
  // which is why every query that reads them falls back to `ranked`; `/api/recompute`
  // fills them in from the replays.
  { table: 'scores', column: 'pp_nomod', definition: 'REAL' },
  { table: 'scores', column: 'stars_nomod', definition: 'REAL' },
  { table: 'scores', column: 'beatmap_max_combo', definition: 'INTEGER' },
  { table: 'scores', column: 'map_status', definition: 'INTEGER' },
  { table: 'scores', column: 'mods_ranked', definition: 'INTEGER' },
  { table: 'scores', column: 'mods_countable', definition: 'INTEGER' },
  // Added with pinning and removing scores.
  { table: 'scores', column: 'hidden_at', definition: 'INTEGER' },
  { table: 'scores', column: 'pinned_at', definition: 'INTEGER' },
  { table: 'scores', column: 'pin_order', definition: 'INTEGER' },
  // Added with Total Play Time. Both stay NULL on older rows: a beatmap's length is filled
  // in lazily from its .osu file, and an incomplete play from before this column simply has
  // no start time to measure from -- see src/calc/play-time.ts.
  { table: 'beatmaps', column: 'length_ms', definition: 'INTEGER' },
  { table: 'incomplete_plays', column: 'started_at', definition: 'INTEGER' },
  // NULL marks rows indexed by an older version and makes the index backfill them once.
  { table: 'osu_files', column: 'beatmap_id', definition: 'INTEGER' },
  // Added with the pp breakdown and the calculator version. NULL on older rows until the
  // score is recalculated -- opening its details does that for one score, Settings for all.
  { table: 'scores', column: 'score_standard', definition: 'INTEGER' },
  { table: 'scores', column: 'score_classic', definition: 'INTEGER' },
  { table: 'scores', column: 'pp_parts', definition: 'TEXT' },
  { table: 'scores', column: 'pp_nomod_parts', definition: 'TEXT' },
  { table: 'scores', column: 'pp_version', definition: 'TEXT' },
  // Added with the play tracking filter. Filled lazily like length_ms above, so a beatmap
  // cached before the filter existed needs no migration pass over osu!'s store.
  { table: 'beatmaps', column: 'added_at', definition: 'INTEGER' },
  { table: 'beatmaps', column: 'submitted_at', definition: 'INTEGER' },
  { table: 'beatmaps', column: 'ranked_at', definition: 'INTEGER' },
  // Added with attempts osu! could not submit. NULL marks rows indexed before names were read,
  // which the index backfills once -- in the same pass as beatmap_id above for anyone upgrading
  // from a release that had neither.
  { table: 'osu_files', column: 'name', definition: 'TEXT' },
  { table: 'incomplete_plays', column: 'unsubmitted', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

/**
 * Tables earlier versions created and nothing reads any more. `snapshots` was meant to record
 * the profile over time and was never written: history is replayed from the scores instead
 * (src/calc/history.ts), which a reingest cannot leave stale. Always empty, so dropping it
 * loses nothing.
 */
const RETIRED_TABLES = ['snapshots'];

function migrate(db: Db): void {
  for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue; // table not created yet
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS osu_files_beatmap_id ON osu_files (beatmap_id)');
  // Here rather than in schema.sql: on an existing database the column does not exist until
  // the loop above has added it, and schema.sql runs first.
  db.exec('CREATE INDEX IF NOT EXISTS osu_files_name ON osu_files (name)');
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
