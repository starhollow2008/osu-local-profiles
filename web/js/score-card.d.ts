/** Types for the parts of web/js/score-card.js that the tests exercise. */

export function rankCutoffs(mode: number, legacy: boolean): number[];
export function flooredAccuracy(accuracy: number): number;
export function dialFill(accuracy: number, grade: string, cutoffs: number[]): number;
export function scoreDial(score: unknown): string;
export function legacyRank(grade: string): string;

export interface CardOwner {
  name: string;
  avatar: string;
  country: string;
  countryName: string;
  cover: string | null;
  tracking: boolean;
}
export function scoreCard(score: unknown, who: CardOwner, calculator?: string | null): string;
