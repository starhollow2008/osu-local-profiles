export type Counts = Partial<Record<'c300' | 'c100' | 'c50' | 'geki' | 'katu' | 'miss' | 'tailMiss' | 'tickMiss', number>>;

export function countsFromStatistics(mode: number, statistics: Record<string, number> | null | undefined): Counts;

export function sliderMisses(
  statistics: Record<string, number> | null | undefined,
  maximum: Record<string, number> | null | undefined,
): { tailMiss: number; tickMiss: number };

export function judgementsForAccuracy(
  mode: number,
  accuracy: number,
  play: { perfect: Record<string, number>; counts?: Counts; ends?: { sliders: number; ticks: number } | null },
): { counts: Counts; reached: boolean };

export function accuracyOf(mode: number, counts: Counts, ends?: { sliders: number; ticks: number } | null): number;
