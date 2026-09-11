/** Types for the parts of web/js/beatmapsets.js that the tests exercise. */

export function getDiffColour(rating: number | null | undefined): string | null;
export function getDiffTextColour(rating: number | null | undefined): string;

export interface CardDifficulty {
  id: number | null;
  mode: 'osu' | 'taiko' | 'fruits' | 'mania';
  stars: number | null;
  version: string;
}
export function groupDifficulties<T extends CardDifficulty>(difficulties: T[]): Map<string, T[]>;
export function beatmapsetCard(card: unknown): string;
export function beatmapsPopupContent(card: unknown): string;
export function favoriteList(cards: unknown[] | null | undefined): string;
