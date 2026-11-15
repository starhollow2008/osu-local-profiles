/** Types for the parts of web/js/score-list.js that the tests exercise. */

export interface ScoreListView {
  show: 'best' | 'every';
  uncounted: boolean;
  sort: string;
  order: 'asc' | 'desc';
  then: SortLevel[];
  search: string;
  mods: string[];
  grades: string[];
  clients: string[];
  starsMin: number | null;
  starsMax: number | null;
  from: number | null;
  to: number | null;
  layout: 'table' | 'rows';
  pageSize: number;
}

export interface SortLevel {
  sort: string;
  order: 'asc' | 'desc';
}

export const DEFAULT_VIEW: Readonly<ScoreListView>;
export const SORTS: string[];
export function startingOrder(sort: string): 'asc' | 'desc';
export function sortLevels(view: Partial<ScoreListView>): SortLevel[];
export function withSortLevels(view: Partial<ScoreListView>, levels: SortLevel[]): ScoreListView;
export function addSortLevel(levels: SortLevel[]): SortLevel[];
export const PAGE_SIZES: number[];
export function normaliseView(view: Partial<ScoreListView> | null | undefined): ScoreListView;
export function viewChanged(view: Partial<ScoreListView> | null | undefined): boolean;
export function resetView(view: Partial<ScoreListView> | null | undefined): ScoreListView;
export function dayOf(ms: number): string;
export function activeFilters(view: Partial<ScoreListView>): { key: string; value?: string; label: string }[];
export function withoutFilter(view: Partial<ScoreListView>, key: string, value?: string): ScoreListView;
export function sortedBy(view: Partial<ScoreListView>, sort: string): ScoreListView;
export function scoreListUrl(path: string, view: Partial<ScoreListView>, mode: number, extra?: Record<string, string | number>): string;
export function playsText(n: number): string;
export function tableHtml(plays: Record<string, unknown>[], view: Partial<ScoreListView>, offset?: number): string;
export function rowsHtml(plays: Record<string, unknown>[], options?: { starRating?: boolean }): string;
