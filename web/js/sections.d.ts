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
