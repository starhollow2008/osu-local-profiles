/** Types for web/js/statistics.js. */

export interface CardStatistic {
  attribute: string;
  label: string;
  basic: boolean;
  value: number;
  maximumValue: number | null;
}

export function statisticsFor(score: {
  mode: number;
  statistics: Record<string, number>;
  maximumStatistics: Record<string, number>;
}): { basic: CardStatistic[]; extra: CardStatistic[] };
