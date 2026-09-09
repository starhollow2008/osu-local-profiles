PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A "fresh profile" = one alternative playstyle being tracked (left hand, mouse only, ...).
CREATE TABLE IF NOT EXISTS profiles (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL,
  -- Scores older than this are ignored, so switching tracking on never retroactively
  -- imports plays you set with your normal playstyle earlier the same day.
  tracking_since INTEGER NOT NULL,
  default_mode   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scores (
  id              INTEGER PRIMARY KEY,
  profile_id      INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  dedupe_key      TEXT    NOT NULL,
  mode            INTEGER NOT NULL,
  beatmap_md5     TEXT    NOT NULL,
  beatmap_id      INTEGER,
  client          TEXT    NOT NULL,
  mods_json       TEXT    NOT NULL,
  mods_label      TEXT    NOT NULL,
  count300        INTEGER NOT NULL,
  count100        INTEGER NOT NULL,
  count50         INTEGER NOT NULL,
  count_geki      INTEGER NOT NULL,
  count_katu      INTEGER NOT NULL,
  count_miss      INTEGER NOT NULL,
  statistics_json TEXT,
  max_statistics_json TEXT,
  accuracy        REAL    NOT NULL,
  max_combo       INTEGER NOT NULL,
  total_score     INTEGER NOT NULL,
  passed          INTEGER NOT NULL,
  grade           TEXT    NOT NULL,
  stars           REAL,
  pp              REAL,
  pp_source       TEXT,
  ranked          INTEGER NOT NULL DEFAULT 0,
  played_at       INTEGER NOT NULL,
  online_score_id TEXT,
  replay_path     TEXT,
  UNIQUE (profile_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS scores_profile_mode_pp ON scores (profile_id, mode, pp DESC);
CREATE INDEX IF NOT EXISTS scores_profile_played  ON scores (profile_id, played_at DESC);

-- Beatmap metadata, cached permanently (resolved offline from lazer's online.db where possible).
CREATE TABLE IF NOT EXISTS beatmaps (
  md5           TEXT PRIMARY KEY,
  beatmap_id    INTEGER,
  beatmapset_id INTEGER,
  artist        TEXT,
  title         TEXT,
  version       TEXT,
  creator       TEXT,
  status        INTEGER,
  stars         REAL,
  max_combo     INTEGER,
  osu_path      TEXT,
  cached_at     INTEGER NOT NULL
);

-- MD5 -> path index of local .osu files. lazer stores files by SHA-256, so this is the
-- only way to find the beatmap for a score without opening its Realm database.
CREATE TABLE IF NOT EXISTS osu_files (
  path       TEXT PRIMARY KEY,
  md5        TEXT NOT NULL,
  size       INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS osu_files_md5 ON osu_files (md5);

-- Paths already examined and found not to be .osu files, so rescans stay cheap.
CREATE TABLE IF NOT EXISTS not_beatmaps (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY,
  profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  mode         INTEGER NOT NULL,
  at           INTEGER NOT NULL,
  total_pp     REAL    NOT NULL,
  global_rank  INTEGER,
  accuracy     REAL    NOT NULL,
  playcount    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
