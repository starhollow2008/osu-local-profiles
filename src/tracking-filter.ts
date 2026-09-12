import fs from 'node:fs';
import type { Db } from './db/index.ts';
import type { LazerMod, Ruleset } from './osr.ts';
import {
  Status,
  UNRESOLVED_STATUS,
  type BeatmapResolver,
  type ResolvedBeatmap,
} from './clients/beatmaps.ts';
import { beatmapLengthMs, playRate } from './calc/play-time.ts';

/**
 * Which plays are tracked at all.
 *
 * Every other setting in this app decides how a stored play is *read* -- whether it counts
 * toward pp, which score scale it shows on -- and can therefore be changed at any time with
 * nothing but a redraw. This one is different in kind: a play the filter rejects is never
 * written down, so the decision is made once, at ingest, and cannot be revisited. That is
 * the point of it (someone tracking a mouse-only profile does not want their tablet warmup
 * in it), and it is why the filter starts switched off and, when switched on, starts with
 * every criterion wide open -- turning it on must change nothing until something is narrowed.
 *
 * Two rules follow from having no second chance:
 *
 * - **An unknowable criterion never rejects a play.** Over half of what osu! counts as a
 *   play leaves no replay -- a quit, an HP fail, a retry -- and those have no mod list and no
 *   star rating recorded anywhere (see src/tracker/incomplete.ts). The other seven criteria
 *   still judge them. Dropping what cannot be fully judged would make the profile's play
 *   count disagree with osu!'s the moment the filter came on, which is a worse answer than a
 *   filter that admits what it cannot see.
 * - **Nothing here is derived from a stored score.** Every fact the filter tests comes from
 *   the replay, the `.osu` file or `online.db`, so the same filter gives the same answer at
 *   live ingest and during Import past plays.
 */

/**
 * A mod's place in the filter.
 *
 * Three states rather than a checkbox, because "must" and "may" are genuinely different
 * questions: with Hidden *allowed* and everything else *excluded*, nomod and HD plays are
 * tracked and nothing else; with Double Time *required* and Hidden *allowed*, DT and DTHD
 * are tracked. Neither is expressible with one bit per mod.
 */
export type ModState = 'allowed' | 'required' | 'excluded';

/** A closed interval; `max` of null is no upper bound, which is the default on both ranges. */
export interface NumberRange {
  min: number;
  max: number | null;
}

/** A date interval in epoch milliseconds. Null at either end is no bound there. */
export interface DateRange {
  from: number | null;
  to: number | null;
}

/**
 * A date interval over a date osu! does not always have.
 *
 * `online.db` records a submission and a ranked date only for the sets osu! has ranked,
 * approved or loved, so a pending, WIP, graveyarded, qualified or never-submitted beatmap has
 * neither. `includeUnknown` is on by default, so those beatmaps keep being tracked unless the
 * user says otherwise -- without it, touching either date range would silently drop every
 * unranked map.
 */
export interface UnknownableDateRange extends DateRange {
  includeUnknown: boolean;
}

export interface TrackingFilter {
  /** Off by default. While it is off nothing below is consulted. */
  enabled: boolean;
  /** Comma-separated; a play matches when any one of them appears in the beatmap's text. */
  keywords: string;
  modes: Ruleset[];
  /** Star rating as played, mods included. */
  stars: NumberRange;
  /** Length as played, in seconds -- the beatmap's own length divided by the play's rate. */
  length: NumberRange;
  /**
   * Only the mods that are not `allowed`. Storing the default state would freeze today's mod
   * list into the setting, so a filter saved now still means the same thing after osu! adds a
   * mod: the new one is allowed, like everything else nobody has ruled on.
   */
  mods: Record<string, ModState>;
  /** Whether a play with no mods at all is required, excluded, or neither. */
  noMod: ModState;
  categories: FilterCategory[];
  /** When the beatmap arrived on this machine. */
  added: DateRange;
  submitted: UnknownableDateRange;
  ranked: UnknownableDateRange;
}

/**
 * The beatmap states the filter offers, each mapping to osu!'s own `approved` values.
 *
 * `ranked` covers RANKED and APPROVED together, as osu! itself does -- "approved" is the old
 * name for a ranked map of unbounded length, and no profile page distinguishes them.
 * Deliberately a separate list from `UNRANKED_MAP_STATUSES` in clients/beatmaps.ts: that one
 * is about which stored scores award pp and so names only the unranked states, while this one
 * has to name every state a beatmap can be in.
 */
export const FILTER_CATEGORIES = {
  ranked: [Status.RANKED, Status.APPROVED],
  qualified: [Status.QUALIFIED],
  loved: [Status.LOVED],
  pending: [Status.PENDING],
  wip: [Status.WIP],
  graveyard: [Status.GRAVEYARD],
  unsubmitted: [UNRESOLVED_STATUS],
} as const;

export type FilterCategory = keyof typeof FILTER_CATEGORIES;

export const FILTER_CATEGORY_NAMES = Object.keys(FILTER_CATEGORIES) as FilterCategory[];

/** Every mode, which is the default: the filter narrows nothing until it is told to. */
const ALL_MODES: Ruleset[] = [0, 1, 2, 3];

/**
 * The earliest date the sliders offer, measured rather than chosen: the oldest `submit_date`
 * in this machine's `online.db` is `2007-10-06 17:46:31+00:00`, the day osu!'s beatmap
 * listing begins.
 */
export const OSU_EPOCH = Date.UTC(2007, 9, 6);

/** Star rating the upper slider counts down from, and the ceiling a typed value is held to. */
export const MAX_STARS = 15;

/** Length the upper slider counts down from, in seconds -- one hour. */
export const MAX_LENGTH_SECONDS = 3600;

export function defaultTrackingFilter(): TrackingFilter {
  return {
    enabled: false,
    keywords: '',
    modes: [...ALL_MODES],
    stars: { min: 0, max: null },
    length: { min: 0, max: null },
    mods: {},
    noMod: 'allowed',
    categories: [...FILTER_CATEGORY_NAMES],
    added: { from: null, to: null },
    submitted: { from: null, to: null, includeUnknown: true },
    ranked: { from: null, to: null, includeUnknown: true },
  };
}

/* ------------------------------------------------------------------ coercion */

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const truthy = (raw: unknown): boolean =>
  raw === true || raw === 'true' || raw === 1 || raw === '1';

const notFalse = (raw: unknown): boolean =>
  !(raw === false || raw === 'false' || raw === 0 || raw === '0');

/** A finite number held to a range, or null. Strings are accepted: form fields post strings. */
function optionalNumber(raw: unknown, min: number, max: number): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function coerceRange(raw: unknown, limit: number, round: (n: number) => number): NumberRange {
  const source = isRecord(raw) ? raw : {};
  const min = round(optionalNumber(source['min'], 0, limit) ?? 0);
  const max = optionalNumber(source['max'], 0, limit);
  // A range typed back to front is read as the range it describes rather than rejected: the
  // two text fields are independent, so "6.9 to 5.1" is a plausible thing to type.
  if (max === null) return { min, max: null };
  const top = round(max);
  return { min: Math.min(min, top), max: Math.max(min, top) };
}

const roundStars = (n: number) => Math.round(n * 100) / 100;
const roundSeconds = (n: number) => Math.round(n);

function coerceDateRange(raw: unknown): DateRange {
  const source = isRecord(raw) ? raw : {};
  const bound = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const at = typeof value === 'string' ? Date.parse(value) : Number(value);
    if (!Number.isFinite(at)) return null;
    // No upper limit: a beatmap ranked tomorrow is a real beatmap, and clamping to "now"
    // would make a saved filter quietly narrower every day it was not opened.
    return Math.max(OSU_EPOCH, Math.floor(at));
  };
  const from = bound(source['from']);
  const to = bound(source['to']);
  if (from !== null && to !== null && from > to) return { from: to, to: from };
  return { from, to };
}

function coerceUnknownableDateRange(raw: unknown): UnknownableDateRange {
  const source = isRecord(raw) ? raw : {};
  return { ...coerceDateRange(raw), includeUnknown: notFalse(source['includeUnknown']) };
}

const MOD_STATES: ModState[] = ['allowed', 'required', 'excluded'];

const coerceModState = (raw: unknown): ModState =>
  MOD_STATES.includes(raw as ModState) ? (raw as ModState) : 'allowed';

/**
 * Clean whatever arrived from the page, or was read back out of a database written by another
 * version. Like every other setting this is the only validation there is, so it has to accept
 * anything at all and answer with something usable.
 */
export function coerceTrackingFilter(raw: unknown): TrackingFilter {
  const out = defaultTrackingFilter();
  if (!isRecord(raw)) return out;

  out.enabled = truthy(raw['enabled']);
  if (typeof raw['keywords'] === 'string') {
    // One line, and short enough that the readout can show it whole.
    out.keywords = raw['keywords'].replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  }

  if (Array.isArray(raw['modes'])) {
    const modes = new Set<Ruleset>();
    for (const value of raw['modes']) {
      const mode = Number(value);
      if (mode === 0 || mode === 1 || mode === 2 || mode === 3) modes.add(mode);
    }
    // An empty list is kept rather than repaired: it means "no mode", a filter that tracks
    // nothing. The dialog says so loudly; widening it silently would misreport what was saved.
    out.modes = ALL_MODES.filter((m) => modes.has(m));
  }

  out.stars = coerceRange(raw['stars'], MAX_STARS, roundStars);
  out.length = coerceRange(raw['length'], MAX_LENGTH_SECONDS, roundSeconds);

  if (isRecord(raw['mods'])) {
    for (const [acronym, state] of Object.entries(raw['mods'])) {
      // osu!'s acronyms are two or three characters; mania's key counts start with a digit.
      if (!/^[0-9A-Z]{2,3}$/.test(acronym)) continue;
      const coerced = coerceModState(state);
      if (coerced !== 'allowed') out.mods[acronym] = coerced;
    }
  }
  out.noMod = coerceModState(raw['noMod']);

  if (Array.isArray(raw['categories'])) {
    const seen = new Set(
      raw['categories'].filter(
        (value): value is FilterCategory => typeof value === 'string' && value in FILTER_CATEGORIES,
      ),
    );
    out.categories = FILTER_CATEGORY_NAMES.filter((name) => seen.has(name));
  }

  out.added = coerceDateRange(raw['added']);
  out.submitted = coerceUnknownableDateRange(raw['submitted']);
  out.ranked = coerceUnknownableDateRange(raw['ranked']);

  return out;
}

/* ------------------------------------------------------------------- matching */

/** The facts a play is judged on. Anything null is not knowable, and never rejects. */
export interface PlayFacts {
  mode: Ruleset;
  /** What the player chose -- null for a play that left no replay. */
  mods: LazerMod[] | null;
  /** As played, mods included. Null until osu!'s calculator has been asked. */
  stars: number | null;
  /** As played, in seconds. */
  lengthSeconds: number | null;
  /** osu!'s `approved` value, or UNRESOLVED_STATUS. */
  status: number | null;
  /** Artist, title, difficulty and mapper joined -- what the keywords are matched against. */
  text: string | null;
  addedAt: number | null;
  submittedAt: number | null;
  rankedAt: number | null;
}

/** Which criterion turned a play away, named as the dialog names it. */
export type FilterCriterion =
  | 'mode'
  | 'keywords'
  | 'category'
  | 'date added'
  | 'date submitted'
  | 'date ranked'
  | 'length'
  | 'mods'
  | 'star rating';

/** The keywords, split as the dialog says they are split: commas separate, spaces do not. */
export function filterKeywords(keywords: string): string[] {
  return keywords
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term !== '');
}

function outsideRange(value: number, range: NumberRange): boolean {
  if (value < range.min) return true;
  return range.max !== null && value > range.max;
}

function outsideDates(at: number | null, range: DateRange, includeUnknown: boolean): boolean {
  if (at === null) return !includeUnknown;
  if (range.from !== null && at < range.from) return true;
  return range.to !== null && at > range.to;
}

function modsRejected(filter: TrackingFilter, mods: readonly LazerMod[]): boolean {
  const present = new Set(mods.map((m) => m.acronym));
  if (filter.noMod === 'required' && present.size > 0) return true;
  if (filter.noMod === 'excluded' && present.size === 0) return true;
  for (const [acronym, state] of Object.entries(filter.mods)) {
    if (state === 'required' && !present.has(acronym)) return true;
    if (state === 'excluded' && present.has(acronym)) return true;
  }
  return false;
}

function categoryAllowed(filter: TrackingFilter, status: number): boolean {
  for (const name of filter.categories) {
    if ((FILTER_CATEGORIES[name] as readonly number[]).includes(status)) return true;
  }
  return false;
}

/**
 * Which criterion rejects this play, or null if the filter tracks it.
 *
 * Facts may be supplied in stages, because they are not equally cheap: the star rating costs
 * a round trip to osu!'s calculator, so ingest calls this once with everything else and only
 * computes the rating if the play survived. That works because a missing fact never rejects,
 * which is the same rule that lets a play with no replay through the mods and stars tests.
 */
export function filterRejects(
  filter: TrackingFilter,
  facts: Partial<PlayFacts>,
): FilterCriterion | null {
  if (!filter.enabled) return null;

  if (facts.mode !== undefined && !filter.modes.includes(facts.mode)) return 'mode';

  const terms = filterKeywords(filter.keywords);
  if (terms.length > 0 && facts.text) {
    const haystack = facts.text.toLowerCase();
    if (!terms.some((term) => haystack.includes(term))) return 'keywords';
  }

  if (facts.status != null && !categoryAllowed(filter, facts.status)) return 'category';

  if (facts.addedAt !== undefined && outsideDates(facts.addedAt, filter.added, true)) {
    return 'date added';
  }
  if (
    facts.submittedAt !== undefined &&
    outsideDates(facts.submittedAt, filter.submitted, filter.submitted.includeUnknown)
  ) {
    return 'date submitted';
  }
  if (
    facts.rankedAt !== undefined &&
    outsideDates(facts.rankedAt, filter.ranked, filter.ranked.includeUnknown)
  ) {
    return 'date ranked';
  }

  if (facts.lengthSeconds != null && outsideRange(facts.lengthSeconds, filter.length)) {
    return 'length';
  }

  if (facts.mods != null && modsRejected(filter, facts.mods)) return 'mods';

  // Rounded to what the page shows, so a filter typed as "up to 6.9" does not reject a play
  // the whole app calls 6.90 because osu! made it 6.9000001.
  if (facts.stars != null && outsideRange(roundStars(facts.stars), filter.stars)) {
    return 'star rating';
  }

  return null;
}

/**
 * Whether the filter can actually turn a play away.
 *
 * An enabled filter with everything wide open is the state the dialog opens in, and it is not
 * worth a mark on the menu or a note on the page -- so "on" and "narrowing something" are
 * separate questions.
 */
export function filterNarrows(filter: TrackingFilter): boolean {
  if (!filter.enabled) return false;
  if (filter.modes.length < ALL_MODES.length) return true;
  if (filterKeywords(filter.keywords).length > 0) return true;
  if (filter.stars.min > 0 || filter.stars.max !== null) return true;
  if (filter.length.min > 0 || filter.length.max !== null) return true;
  if (filter.noMod !== 'allowed') return true;
  if (Object.keys(filter.mods).length > 0) return true;
  if (filter.categories.length < FILTER_CATEGORY_NAMES.length) return true;
  for (const range of [filter.added, filter.submitted, filter.ranked]) {
    if (range.from !== null || range.to !== null) return true;
  }
  if (!filter.submitted.includeUnknown || !filter.ranked.includeUnknown) return true;
  return false;
}

/* ---------------------------------------------------------------------- facts */

/**
 * The beatmap's half of the facts, each looked up once and remembered on the `beatmaps` row.
 *
 * Same convention as `length_ms`, which this joins: NULL in the column means never looked up,
 * 0 means looked up and not knowable. So a beatmap cached long before this feature existed is
 * covered on the next play with no migration pass over osu!'s store -- and a beatmap whose
 * file has been deleted is not re-read on every play for the rest of time.
 */
export interface BeatmapFilterFacts {
  status: number;
  text: string;
  lengthMs: number | null;
  addedAt: number | null;
  submittedAt: number | null;
  rankedAt: number | null;
}

/**
 * When osu! put this file on the machine.
 *
 * The file's *creation* time, not its mtime, and the difference is not academic: beatmaps
 * osu!lazer imported from osu!stable's `Songs` here keep mtimes from 2019-2021 -- the age of
 * the beatmap -- while their creation time is the day they were imported. Where a filesystem
 * reports no creation time at all, mtime stands in rather than the date being invented.
 */
function fileCreatedAt(file: string): number {
  try {
    const stat = fs.statSync(file);
    const born = Math.round(stat.birthtimeMs);
    return born > 0 ? born : Math.round(stat.mtimeMs);
  } catch {
    return 0;
  }
}

/** 0 in a column means "looked up, and there is nothing there"; the filter wants null. */
const orNull = (value: number) => (value > 0 ? value : null);

export function beatmapFilterFacts(
  db: Db,
  resolver: BeatmapResolver,
  beatmap: ResolvedBeatmap,
): BeatmapFilterFacts {
  const row = db
    .prepare('SELECT length_ms, added_at, submitted_at, ranked_at FROM beatmaps WHERE md5 = ?')
    .get(beatmap.md5) as
    | {
        length_ms: number | null;
        added_at: number | null;
        submitted_at: number | null;
        ranked_at: number | null;
      }
    | undefined;

  let lengthMs = row?.length_ms ?? null;
  let addedAt = row?.added_at ?? null;
  let submittedAt = row?.submitted_at ?? null;
  let rankedAt = row?.ranked_at ?? null;

  if (lengthMs === null) {
    lengthMs = 0;
    if (beatmap.osuPath) {
      try {
        lengthMs = beatmapLengthMs(fs.readFileSync(beatmap.osuPath, 'utf8'));
      } catch {
        /* moved or deleted since it was indexed: unknown, and remembered as such */
      }
    }
  }

  if (addedAt === null) addedAt = beatmap.osuPath ? fileCreatedAt(beatmap.osuPath) : 0;

  if (submittedAt === null || rankedAt === null) {
    const dates =
      beatmap.beatmapsetId === null ? null : resolver.beatmapsetDates(beatmap.beatmapsetId);
    submittedAt = dates?.submittedAt ?? 0;
    rankedAt = dates?.rankedAt ?? 0;
  }

  // One statement for all four, and only when the row is there -- resolve() writes it, and a
  // beatmap that has never been resolved has nothing to attach these to.
  if (row) {
    db.prepare(
      'UPDATE beatmaps SET length_ms = ?, added_at = ?, submitted_at = ?, ranked_at = ? WHERE md5 = ?',
    ).run(lengthMs, addedAt, submittedAt, rankedAt, beatmap.md5);
  }

  return {
    status: beatmap.status ?? UNRESOLVED_STATUS,
    text: [beatmap.artist, beatmap.title, beatmap.version, beatmap.creator]
      .filter((part): part is string => Boolean(part))
      .join(' '),
    lengthMs: orNull(lengthMs),
    addedAt: orNull(addedAt),
    submittedAt: orNull(submittedAt),
    rankedAt: orNull(rankedAt),
  };
}

/**
 * The beatmap facts as the filter reads them, with the length at the speed it was played.
 *
 * `mods` being null -- a play with no replay -- leaves the length at the beatmap's own speed,
 * which is the only answer available: lazer's log never says what was on.
 */
export function playFacts(
  facts: BeatmapFilterFacts,
  mode: Ruleset,
  mods: LazerMod[] | null,
): Omit<PlayFacts, 'stars'> {
  const rate = mods === null ? 1 : playRate(mods);
  return {
    mode,
    mods,
    lengthSeconds: facts.lengthMs === null ? null : Math.round(facts.lengthMs / rate / 1000),
    status: facts.status,
    text: facts.text,
    addedAt: facts.addedAt,
    submittedAt: facts.submittedAt,
    rankedAt: facts.rankedAt,
  };
}
