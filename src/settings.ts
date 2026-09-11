import type { Db } from './db/index.ts';
import { UNRANKED_MAP_STATUSES, type UnrankedMapStatus } from './clients/beatmaps.ts';
import type { IncompleteDisplay } from './calc/stats.ts';

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
  /**
   * Count scores osu! refuses to rank because of their mods -- Relax, Autopilot, a
   * customised rate such as DT at 1.45x. Off by default: on, the profile stops being
   * comparable with a real osu! account, which is the whole point of it.
   */
  includeUnrankedMods: boolean;
  /**
   * How to price a Relax or Autopilot play once they are being counted.
   *
   * `without-the-mod` scores the play's hits as if the mod had been off, which is what
   * makes "relax counts as nomod, relax + DT counts as DT" true. `as-played` uses osu!'s
   * own relax-aware difficulty and performance calculation instead. Both come from osu!'s
   * code and both are stored, so switching is instant -- but they are far apart (111pp
   * against 239pp on one real replay), because a relax play's accuracy and combo are not
   * what the same player could reach by hand.
   */
  unrankedModPp: 'without-the-mod' | 'as-played';
  /**
   * Beatmap states to count besides ranked and approved: `loved`, `qualified`, `pending`,
   * `wip`, `graveyard`, `unsubmitted`. Empty by default.
   *
   * A list rather than one switch, because these are not one proposition -- a Loved map is
   * played competitively, a graveyarded one may be a draft nobody finished, and an
   * unsubmitted one exists only on this machine.
   */
  includeUnrankedMaps: UnrankedMapStatus[];
  /**
   * An osu! account this profile borrows its name, avatar and banner from. 0 for none,
   * which is the default and stays the default -- a local profile is a different identity
   * by definition, so it is never linked without being asked for.
   */
  linkedUserId: number;
  /** The username that id had when it was looked up, so the link reads as a name. */
  linkedUsername: string;
  /**
   * The profile's own description -- osu!'s "me!" box.
   *
   * osu!'s BBCode, stored exactly as it was typed or imported. It is never trusted: the page
   * renders it with web/js/bbcode.js, which escapes everything and emits only its own tags.
   */
  aboutMe: string;
  /**
   * Whether Recent Plays shows the plays that finished without a score -- a quit, a retry,
   * an HP fail.
   *
   * Note what this setting is *not*: whether those plays are counted. They always are, in
   * the play count, the monthly play counts and Most Played, because osu! counts them and a
   * profile that disagreed with the website about how much someone had played would simply
   * be wrong. This only decides whether they are listed.
   *
   * Three states rather than a switch because there is a middle answer worth having.
   * `collapse` -- the default -- folds a consecutive run of attempts on one beatmap into a
   * single row carrying the count, which is what keeps the feed readable for anyone who
   * retries a map twenty times before finishing it.
   */
  showIncompleteInRecent: IncompleteDisplay;
  /**
   * The order the profile's sections appear in, as their ids.
   *
   * Reconciled against the code's own list on every read: ids that no longer exist are
   * dropped and new ones are appended, so adding a section later never leaves a saved order
   * stale, and a hand-edited value cannot make a section unreachable.
   */
  sectionOrder: string[];
  /**
   * Whether the Scores section warns that this profile's pp is not comparable with a real osu!
   * account.
   *
   * On by default, and only *shown* at all when a setting has actually made the profile
   * incomparable -- `countingNoteText` returns nothing otherwise. Dismissing it is a
   * per-profile preference rather than a global one: a profile that has deliberately
   * turned on relax scoring does not need telling twice, while another profile on the same
   * install may still be scoring officially.
   *
   * Turning it off hides the sentence, not the fact: unranked-mod scores keep their `*`,
   * and the Settings dialog still says what each option does.
   */
  showCountingNote: boolean;
  /**
   * Whether an empty Favorite Beatmaps says how to fill it -- favourite from a play's menu,
   * or import an osu! account's -- with a Don't show again, like the counting note.
   */
  showFavoritesHint: boolean;
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

/**
 * Like `cleanText`, but for a box the user is meant to write paragraphs in: newlines are
 * kept and only the other control characters are flattened.
 */
function cleanMultiline(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10) out += ch; // newline
    else if (code === 13) continue; // carriage return, so CRLF normalises to LF
    else out += code < 32 || code === 127 ? ' ' : ch;
  }
  // Runs of blank lines collapse to one, so pasted text cannot push the page apart.
  return out.replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLength);
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
  includeUnrankedMods: {
    default: false,
    // Checkboxes post strings, and JSON round-trips booleans, so accept both shapes.
    coerce: (raw) => raw === true || raw === 'true' || raw === 1 || raw === '1',
  },
  unrankedModPp: {
    default: 'without-the-mod',
    coerce: (raw) => (raw === 'as-played' ? 'as-played' : 'without-the-mod'),
  },
  aboutMe: {
    default: '',
    // osu!'s own me! pages run long, and an imported one should arrive whole.
    coerce: (raw) => cleanMultiline(raw, 60000),
  },
  showIncompleteInRecent: {
    default: 'collapse',
    coerce: (raw) => (raw === 'yes' || raw === 'no' ? raw : 'collapse'),
  },
  showCountingNote: {
    default: true,
    // Defaults to on, so anything but an explicit "off" leaves the warning showing.
    coerce: (raw) => !(raw === false || raw === 'false' || raw === 0 || raw === '0'),
  },
  showFavoritesHint: {
    default: true,
    coerce: (raw) => !(raw === false || raw === 'false' || raw === 0 || raw === '0'),
  },
  sectionOrder: {
    default: [],
    coerce: (raw) => {
      if (!Array.isArray(raw)) return [];
      // Only shape is checked here; which ids are real is the page's business, and it
      // reconciles against its own list anyway.
      const seen = new Set<string>();
      return raw.filter((value): value is string => {
        if (typeof value !== 'string' || !/^[a-z_]{1,32}$/.test(value)) return false;
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });
    },
  },
  linkedUserId: {
    default: 0,
    coerce: (raw) => {
      const id = Math.floor(Number(raw));
      return Number.isFinite(id) && id > 0 ? id : 0;
    },
  },
  linkedUsername: {
    default: '',
    coerce: (raw) => cleanText(raw, 32),
  },
  includeUnrankedMaps: {
    default: [],
    coerce: (raw) => {
      if (!Array.isArray(raw)) return [];
      // Filtered against the known set and de-duplicated, so a stored list written by a
      // different version cannot widen what counts.
      const seen = new Set<string>();
      return raw.filter((value): value is UnrankedMapStatus => {
        if (typeof value !== 'string' || !(value in UNRANKED_MAP_STATUSES)) return false;
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });
    },
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
