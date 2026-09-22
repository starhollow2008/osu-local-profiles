/**
 * Beatmap names, and the same names in the song's own script.
 *
 * osu! offers "prefer metadata in original language", and this is the one place that decides
 * what that means here: which columns a naming query selects, and what the page is handed
 * beside the romanised name. Every list that writes `artist - title` goes through
 * `beatmapName`, so a section added later cannot quietly disagree with the rest of the page
 * about what a beatmap is called.
 *
 * **The choice itself is the page's, not the server's.** Both names are sent and the page
 * picks -- the same arrangement osu-web uses, and the reason the checkbox switches the whole
 * page instantly instead of costing a round trip. It also keeps the preference out of
 * `/api/profile`'s cache key, which is about what is *stored*.
 *
 * An original-language name is sent only when it is actually different. Most beatmaps repeat
 * the romanised value in `TitleUnicode`, or carry no `TitleUnicode` at all, and a field that
 * said the same thing twice would be paid for on every row of every list.
 */

/** A beatmap's names as the columns below select them. */
export interface BeatmapNames {
  artist: string | null;
  title: string | null;
  /** The original-language name, or null when there is no *different* one. */
  artistUnicode: string | null;
  titleUnicode: string | null;
}

/**
 * The beatmap columns a query needs to name what was played, aliased `b`.
 *
 * `artist_unicode` and `title_unicode` are NULL on rows cached before they existed and `''`
 * on beatmaps that have no original-language name -- see `backfillOriginalMetadata` -- and
 * `names` treats both as "no different name", so an un-backfilled database reads exactly as
 * it did before rather than showing blanks.
 */
export const NAME_COLUMNS = 'b.artist, b.title, b.artist_unicode, b.title_unicode';

/**
 * Any query row carrying the four columns, however that query typed itself. Written as
 * optional fields rather than an index signature so a hand-declared row type -- `MedalRow`,
 * the history pass -- satisfies it without being widened.
 */
interface NameRow {
  artist?: string | number | null;
  title?: string | number | null;
  artist_unicode?: string | number | null;
  title_unicode?: string | number | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** One row's four name columns, with an original-language name only where it differs. */
export function names(r: NameRow): BeatmapNames {
  const artist = text(r.artist);
  const title = text(r.title);
  const artistUnicode = text(r.artist_unicode);
  const titleUnicode = text(r.title_unicode);
  return {
    artist,
    title,
    artistUnicode: artistUnicode === artist ? null : artistUnicode,
    titleUnicode: titleUnicode === title ? null : titleUnicode,
  };
}

/**
 * The same, for a beatmap that came through `BeatmapResolver.resolve` rather than a query.
 *
 * Its fields are already camelCase and already carry `''` for "no original-language name",
 * so this only has to apply the same "only when different" rule the columns get.
 */
export function resolvedNames(b: {
  artist: string | null;
  title: string | null;
  artistUnicode: string | null;
  titleUnicode: string | null;
}): BeatmapNames {
  return names({
    artist: b.artist,
    title: b.title,
    artist_unicode: b.artistUnicode,
    title_unicode: b.titleUnicode,
  });
}

/**
 * The same names, with `fallback` standing in for a title the beatmap cache does not have.
 *
 * For a play read out of lazer's log on a beatmap that is not installed: the log's own name
 * for the map is all there is, and a row that showed a hash instead would be worse than one
 * showing a romanised name. There is no original-language name to fall back to, by
 * definition, so that half stays null.
 */
export function withFallbackTitle(n: BeatmapNames, fallback: string | null): BeatmapNames {
  return n.title === null && fallback ? { ...n, title: fallback, titleUnicode: null } : n;
}

/** `artist - title`, the way every list writes it. '' when the beatmap has neither. */
export function beatmapName(n: BeatmapNames): string {
  return [n.artist, n.title].filter(Boolean).join(' - ');
}

/**
 * The same name in the song's own script, or null when it would read the same.
 *
 * Built from whichever half has an original-language name, so a Japanese title by an artist
 * written in Latin script still reads in its own script where it has one.
 */
export function beatmapNameOriginal(n: BeatmapNames): string | null {
  if (n.artistUnicode === null && n.titleUnicode === null) return null;
  const original = [n.artistUnicode ?? n.artist, n.titleUnicode ?? n.title].filter(Boolean).join(' - ');
  return original === '' || original === beatmapName(n) ? null : original;
}
