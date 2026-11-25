/** Types for the parts of web/js/sections.js that the tests exercise. */

export function reconcileSectionOrder(
  saved: readonly string[] | null | undefined,
  defaultOrder: readonly string[],
  retiredDefaults?: readonly (readonly string[])[],
): string[];

/**
 * What to say, once, above a total osu! would not have calculated the same way. Empty when
 * the profile is scoring officially.
 */
export function countingNoteText(counting: {
  countUnresolved?: boolean;
  includeUnrankedMods?: boolean;
  preferStrippedPp?: boolean;
  extraMapStatuses?: readonly number[];
} | null | undefined): string;

/** How Settings asks score rows to look, as `playRow` options. */
export interface RowLooks {
  starRating: boolean;
  starBadge: boolean;
  judgements: boolean;
  background: boolean;
}
export function rowLooks(config: Record<string, unknown> | null | undefined): RowLooks;

/** One score row, as osu-web's `.play-detail`. */
export function playRow(
  play: Record<string, unknown>,
  options?: { showWeight?: boolean; actions?: boolean; reorderable?: boolean; playcount?: string | null } & Partial<RowLooks>,
): string;
