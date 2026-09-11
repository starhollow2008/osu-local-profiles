PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A profile = one alternative playstyle being tracked (left hand, mouse only, ...).
CREATE TABLE IF NOT EXISTS profiles (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL,
  -- Scores older than this are ignored, so switching tracking on never retroactively
  -- imports plays you set with your normal playstyle earlier the same day.
  tracking_since INTEGER NOT NULL,
  default_mode   INTEGER NOT NULL DEFAULT 0
);

-- Settings the user edits from the page, one row per key so that adding a setting later
-- never needs a migration. Values are JSON; see src/settings.ts for the key list.
CREATE TABLE IF NOT EXISTS profile_settings (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  PRIMARY KEY (profile_id, key)
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
  -- pp and star rating with Relax/Autopilot removed, so the play can be priced as if the
  -- mod had not been on. Only set when the score actually carries one; both values come
  -- from osu!'s own calculators, given a different mod list. See src/calc/pp.ts.
  pp_nomod        REAL,
  stars_nomod     REAL,
  -- The beatmap's own maximum combo, as osu!'s difficulty calculator reports it. Needed to
  -- tell a full combo from a dropped-slider-end run.
  beatmap_max_combo INTEGER,
  -- The three facts that decide whether a score counts, kept separately so that changing a
  -- setting is a query and not a reingest:
  --   map_status     osu!'s `approved` enum, or -3 when the beatmap is not in online.db at
  --                  all (never submitted). NULL means the row predates these columns.
  --   mods_ranked    would osu! itself rank this mod combination, settings included?
  --   mods_countable could it ever count -- false only for Autoplay and Cinema.
  map_status      INTEGER,
  mods_ranked     INTEGER,
  mods_countable  INTEGER,
  -- Whether osu! itself would rank this score: the map and the mods both allow it.
  ranked          INTEGER NOT NULL DEFAULT 0,
  played_at       INTEGER NOT NULL,
  online_score_id TEXT,
  replay_path     TEXT,
  -- Removed from the profile by the user. A hide rather than a DELETE: the replay is still
  -- on disk, so a deleted row would be re-ingested and dedupe would no longer suppress it.
  hidden_at       INTEGER,
  -- Pinned to the profile, as on osu!. pin_order is the user's own ordering within a mode.
  pinned_at       INTEGER,
  pin_order       INTEGER,
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
  cached_at     INTEGER NOT NULL,
  -- First hit object to last, in ms, read from the .osu file on first need. 0 means the file
  -- could not be read, so it is not tried again. See src/calc/play-time.ts.
  length_ms     INTEGER
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

-- Plays osu! counted that left no replay behind: a quit, a retry, or an HP fail outside
-- multiplayer. lazer imports a score only for a map played to the end, so these exist
-- nowhere on disk except lazer's own log -- see src/clients/lazer-log.ts.
--
-- Deliberately *not* rows in `scores`. An incomplete play has no accuracy, combo, mods, pp
-- or total score, and a row of zeroes in `scores` would quietly corrupt weighted accuracy,
-- the grade counts, ranked score, the level bar and every medal. The aggregates that should
-- include these plays -- the play count, the monthly play counts, Most Played and Recent
-- Plays -- read this table explicitly instead.
CREATE TABLE IF NOT EXISTS incomplete_plays (
  id          INTEGER PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- lazer's submission token: server-issued and unique per play, so re-reading a log can
  -- never duplicate one.
  dedupe_key  TEXT    NOT NULL,
  mode        INTEGER NOT NULL,
  -- Both may be null: a play can be counted before its beatmap can be resolved locally.
  beatmap_md5 TEXT,
  beatmap_id  INTEGER,
  -- What the log called the beatmap, kept so a row is still readable when the map is not
  -- installed and nothing else can name it.
  beatmap_name TEXT,
  played_at   INTEGER NOT NULL,
  -- When osu! issued the play's token. With played_at (the submission) this is how long the
  -- play lasted, which is what Total Play Time needs. Null when the log was joined mid-play.
  started_at  INTEGER,
  online_score_id TEXT,
  -- Removed from the profile by the user, exactly as on `scores`, so visibleSql() applies
  -- to this table verbatim.
  hidden_at   INTEGER,
  UNIQUE (profile_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS incomplete_profile_played
  ON incomplete_plays (profile_id, mode, played_at DESC);

-- The profile's Favorite Beatmaps, as osu! keeps favourites per account. This app's own:
-- nothing here is ever written to osu!. Kept by a reset, like the profile's settings --
-- they are curation, not tracked plays -- and removed with the profile.
CREATE TABLE IF NOT EXISTS favorite_beatmapsets (
  profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  beatmapset_id INTEGER NOT NULL,
  favorited_at  INTEGER NOT NULL,
  PRIMARY KEY (profile_id, beatmapset_id)
);

-- A beatmapset as osu.ppy.sh describes it, fetched once when it is favourited: star ratings
-- and modes for every difficulty, and the explicit / spotlight / featured-artist flags that
-- nothing on this machine records. JSON, trimmed to what the card draws (see
-- src/clients/osu-web.ts). Shared by every profile.
CREATE TABLE IF NOT EXISTS beatmapset_details (
  beatmapset_id INTEGER PRIMARY KEY,
  data          TEXT    NOT NULL,
  fetched_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
