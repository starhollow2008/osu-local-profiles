import type { Db } from './db/index.ts';

/**
 * Per-profile settings, edited from the page.
 *
 * These are deliberately *not* in `config.json`. That file is what the app reads to boot --
 * port, install roots -- and the page must never be able to leave it unparseable. Settings
 * are app state, so they live in the database next to the profile they belong to.
 *
 * Keyed by profile because two profiles are two playstyles: a description written for
 * "left hand" has nothing to do with "mouse only", and a profile may later choose to count
 * relax plays while another stays strictly like osu!.
 *
 * Storage is one row per key rather than one row per profile, so adding a setting later is
 * a new entry in DEFS and nothing else -- no migration, and an older database simply falls
 * back to the default for anything it has never stored.
 */

export interface Settings {
  /** Two-letter ISO code shown beside the name, or empty for no country. */
  country: string;
  /** What to call the playstyle under the profile name, e.g. "left hand, mouse only". */
  tagline: string;
}

/**
 * A setting is its default plus how to clean whatever arrives from the page. `coerce` is
 * the only validation there is, so it has to accept anything -- including a value read back
 * from a database written by a different version.
 */
interface SettingDef<K extends keyof Settings> {
  default: Settings[K];
  coerce: (raw: unknown) => Settings[K];
}

type Defs = { [K in keyof Settings]: SettingDef<K> };

/**
 * Trim to one line and one length. Control characters become spaces rather than being
 * dropped, so pasted multi-line text keeps its word boundaries instead of running together.
 */
function cleanText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out.trim().slice(0, maxLength);
}

const DEFS: Defs = {
  country: {
    default: '',
    coerce: (raw) => {
      // Cleaned to more than two characters on purpose, so that "USA" is *rejected* rather
      // than silently truncated to "US" -- a wrong country is worse than no country.
      const code = cleanText(raw, 16).toUpperCase();
      return /^[A-Z]{2}$/.test(code) ? code : '';
    },
  },
  tagline: {
    default: '',
    coerce: (raw) => cleanText(raw, 120),
  },
};

const KEYS = Object.keys(DEFS) as (keyof Settings)[];

export function defaultSettings(): Settings {
  const out = {} as Settings;
  for (const key of KEYS) out[key] = DEFS[key].default as never;
  return out;
}

/**
 * Every setting for a profile, defaults filling in whatever has never been stored.
 *
 * `fallbacks` supplies a different default for keys with no stored row -- used to carry the
 * country and tagline out of `config.json` for a profile that has never edited them. Once a
 * profile stores a value the stored one wins, *including an empty one*, which is what makes
 * "clear my country" stick rather than snapping back to the config file on the next load.
 */
export function getSettings(db: Db, profileId: number, fallbacks: Partial<Settings> = {}): Settings {
  const settings = defaultSettings();
  for (const key of KEYS) {
    const fallback = fallbacks[key];
    if (fallback !== undefined) settings[key] = DEFS[key].coerce(fallback) as never;
  }

  const rows = db
    .prepare('SELECT key, value FROM profile_settings WHERE profile_id = ?')
    .all(profileId) as { key: string; value: string }[];

  for (const row of rows) {
    if (!KEYS.includes(row.key as keyof Settings)) continue; // written by a different version
    const key = row.key as keyof Settings;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue; // a corrupt row falls back to the default rather than breaking the page
    }
    settings[key] = DEFS[key].coerce(parsed) as never;
  }

  return settings;
}

/**
 * Apply a partial update and return the whole set.
 *
 * Unknown keys are ignored rather than rejected, so a page left open across an upgrade
 * cannot fail its save on a key that has since been renamed or removed.
 */
export function updateSettings(
  db: Db,
  profileId: number,
  patch: Record<string, unknown>,
  fallbacks: Partial<Settings> = {},
): Settings {
  const upsert = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
  );

  db.exec('BEGIN');
  try {
    for (const key of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      upsert.run(profileId, key, JSON.stringify(DEFS[key].coerce(patch[key])));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return getSettings(db, profileId, fallbacks);
}
