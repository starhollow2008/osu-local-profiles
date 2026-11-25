/**
 * A score's judgements as osu-web names and orders them, for the score card and a score's row.
 */
import { t } from './i18n.js';

/** lazer's ruleset names, by this app's mode number. */
const RULESET = ['osu', 'taiko', 'fruits', 'mania'];

/* ------------------------------------------------------------------------ */
/* Statistics                                                                */
/* ------------------------------------------------------------------------ */

/*
 * osu-web's `scoreStatisticsMapping`, the entries it shows on a single score's page. `basic`
 * rows are the judgements; the rest are shown as `value/maximum`, and only when the beatmap
 * could have produced any (`maximumValue > 0`, which is ppy/osu's own rule).
 */
const STATISTICS = {
  osu: [
    { attributes: ['great'], basic: true, label: 'great' },
    { attributes: ['ok'], basic: true, label: 'ok' },
    { attributes: ['meh'], basic: true, label: 'meh' },
    { attributes: ['miss'], basic: true, label: 'Miss' },
    { attributes: ['large_tick_hit'], basic: false, label: 'slider tick' },
    { attributes: ['small_tick_hit', 'slider_tail_hit'], basic: false, label: 'slider end' },
    { attributes: ['large_bonus'], basic: false, label: 'spinner bonus' },
    { attributes: ['small_bonus'], basic: false, label: 'spinner spin' },
  ],
  taiko: [
    { attributes: ['great'], basic: true, label: 'great' },
    { attributes: ['ok'], basic: true, label: 'ok' },
    { attributes: ['miss'], basic: true, label: 'Miss' },
    { attributes: ['large_bonus'], basic: false, label: 'bonus' },
    { attributes: ['small_bonus'], basic: false, label: 'drum tick' },
  ],
  fruits: [
    { attributes: ['great'], basic: true, label: 'great' },
    { attributes: ['miss'], basic: true, label: 'Miss' },
    { attributes: ['large_tick_hit'], basic: false, label: 'large droplet' },
    { attributes: ['small_tick_hit'], basic: false, label: 'small droplet' },
    { attributes: ['large_bonus'], basic: false, label: 'banana' },
  ],
  mania: [
    { attributes: ['perfect'], basic: true, label: 'perfect' },
    { attributes: ['great'], basic: true, label: 'great' },
    { attributes: ['good'], basic: true, label: 'good' },
    { attributes: ['ok'], basic: true, label: 'ok' },
    { attributes: ['meh'], basic: true, label: 'meh' },
    { attributes: ['miss'], basic: true, label: 'Miss' },
  ],
};

/**
 * osu!'s name for a judgement, in the reader's language.
 *
 * A table of literal `t()` calls rather than `t(\`judgement.\${label}\`)`, so
 * scripts/build-i18n.mjs can see every key. Rebuilt per call because the language can change
 * while the page is open; it is fifteen lookups on a card that is opened by hand.
 */
function judgementLabel(label) {
  const table = {
    'great': t('judgement.great'),
    'ok': t('judgement.ok'),
    'meh': t('judgement.meh'),
    'Miss': t('judgement.miss'),
    'slider tick': t('judgement.sliderTick'),
    'slider end': t('judgement.sliderEnd'),
    'spinner bonus': t('judgement.spinnerBonus'),
    'spinner spin': t('judgement.spinnerSpin'),
    'bonus': t('judgement.bonus'),
    'drum tick': t('judgement.drumTick'),
    'large droplet': t('judgement.largeDroplet'),
    'small droplet': t('judgement.smallDroplet'),
    'banana': t('judgement.banana'),
    'perfect': t('judgement.perfect'),
    'good': t('judgement.good'),
  };
  return table[label] ?? label;
}

/** osu-web's `calculateStatisticsFor(score, 'single')`, split into its two rows. */
export function statisticsFor(score) {
  const sum = (from, attributes) => attributes.reduce((n, a) => n + (from?.[a] ?? 0), 0);
  const all = (STATISTICS[RULESET[score.mode]] ?? STATISTICS.osu).map((m) => ({
    attribute: m.attributes[0],
    // Translated where the table is read, not in the table itself: STATISTICS is a mirror of
    // osu-web's own mapping and stays one.
    label: judgementLabel(m.label),
    basic: m.basic,
    value: sum(score.statistics, m.attributes),
    maximumValue: m.basic ? null : sum(score.maximumStatistics, m.attributes),
  }));
  return {
    basic: all.filter((s) => s.basic),
    extra: all.filter((s) => !s.basic && s.maximumValue > 0),
  };
}
