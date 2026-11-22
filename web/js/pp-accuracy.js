/**
 * The pp calculator's arithmetic that needs no calculator: a score's judgements as the replay
 * counters the calculator is given, and judgements for an accuracy typed in.
 *
 * An accuracy is reached the way a player loses it: the misses stay as typed, and the rest goes
 * to the next best judgement (100s in osu!), and only when every hit is that, on to the one after
 * (50s). The accuracy osu! then works out from them is the one shown; these only choose the counts.
 */

/** A score's statistics, as lazer names them, by the replay counter each sits in (OnlineImport.LegacyCounts). */
export function countsFromStatistics(mode, statistics) {
  const n = (key) => Number(statistics?.[key] ?? 0) || 0;
  switch (mode) {
    case 0:
      return { c300: n('great'), c100: n('ok'), c50: n('meh'), miss: n('miss') };
    case 1:
      return { c300: n('great'), c100: n('ok'), miss: n('miss') };
    case 2:
      return { c300: n('great'), c100: n('large_tick_hit'), c50: n('small_tick_hit'), katu: n('small_tick_miss'), miss: n('miss') };
    default:
      return { geki: n('perfect'), c300: n('great'), katu: n('good'), c100: n('ok'), c50: n('meh'), miss: n('miss') };
  }
}

/** A lazer osu! score's slider ends and ticks missed. A stable score has neither, and no maximum to say. */
export function sliderMisses(statistics, maximum) {
  const ends = Number(maximum?.slider_tail_hit ?? 0) || 0;
  return {
    tailMiss: ends > 0 ? Math.max(0, ends - (Number(statistics?.slider_tail_hit ?? 0) || 0)) : 0,
    tickMiss: Number(statistics?.large_tick_miss ?? 0) || 0,
  };
}

/**
 * Each ruleset's judgements from best to worst, with what each is worth toward accuracy. The
 * first holds whatever the others leave; mania's MAX and 300 are worth the same in osu!stable.
 */
const LADDERS = {
  0: [['c300', 6], ['c100', 2], ['c50', 1]],
  1: [['c300', 2], ['c100', 1]],
  3: [['geki', 6], ['katu', 4], ['c100', 2], ['c50', 1]],
};

/**
 * `hits` judgements, each worth one of `values` (best first), adding up to as near `target` as
 * whole judgements can: all of the best, then the next best one at a time, and so on.
 */
function spread(hits, values, target) {
  const counts = values.map(() => 0);
  if (hits <= 0) return { counts, reached: target <= 0 };
  if (target >= hits * values[0]) {
    counts[0] = hits;
    return { counts, reached: target <= hits * values[0] + 1e-9 };
  }
  for (let i = 1; i < values.length; i++) {
    if (target < hits * values[i]) continue;
    const lower = Math.min(hits, Math.max(0, Math.round((hits * values[i - 1] - target) / (values[i - 1] - values[i]))));
    counts[i] = lower;
    counts[i - 1] = hits - lower;
    return { counts, reached: true };
  }
  counts[values.length - 1] = hits;
  return { counts, reached: false };
}

/**
 * The accuracy of these judgements (0 to 1), as osu!stable works it out, or lazer in osu! without
 * Classic (`ends`, as judgementsForAccuracy takes it). osu!'s own figure comes back with the pp;
 * this one is for the page before it does.
 */
export function accuracyOf(mode, counts, ends = null) {
  const n = (key) => Number(counts?.[key] ?? 0) || 0;
  switch (mode) {
    case 0: {
      const total = n('c300') + n('c100') + n('c50') + n('miss');
      if (ends) {
        const max = 300 * total + 30 * ends.ticks + 150 * ends.sliders;
        const hit = 300 * n('c300') + 100 * n('c100') + 50 * n('c50') + 30 * (ends.ticks - n('tickMiss')) + 150 * (ends.sliders - n('tailMiss'));
        return max > 0 ? hit / max : 1;
      }
      return total > 0 ? (300 * n('c300') + 100 * n('c100') + 50 * n('c50')) / (300 * total) : 1;
    }
    case 1: {
      const total = n('c300') + n('c100') + n('miss');
      return total > 0 ? (n('c300') + n('c100') / 2) / total : 1;
    }
    case 2: {
      const total = n('c300') + n('c100') + n('c50') + n('katu') + n('miss');
      return total > 0 ? (n('c300') + n('c100') + n('c50')) / total : 1;
    }
    default: {
      const total = n('geki') + n('c300') + n('katu') + n('c100') + n('c50') + n('miss');
      return total > 0 ? (300 * (n('geki') + n('c300')) + 200 * n('katu') + 100 * n('c100') + 50 * n('c50')) / (300 * total) : 1;
    }
  }
}

/**
 * Judgements for an accuracy (0 to 1), keeping the misses in `counts` and, in osu! without
 * Classic, the slider ends and ticks missed. `perfect` is a perfect play's judgements, and `ends`
 * the beatmap's slider ends and ticks ({ sliders, ticks }) when the play is scored without Classic.
 * `reached` is false when no judgements can make that accuracy with those misses: the nearest is given.
 */
export function judgementsForAccuracy(mode, accuracy, { perfect, counts = {}, ends = null }) {
  const total = Object.values(perfect).reduce((a, b) => a + b, 0);
  const miss = Math.min(total, Math.max(0, counts.miss ?? 0));
  const out = { ...counts, miss };
  const acc = Math.min(1, Math.max(0, accuracy));

  if (mode === 2) {
    // Catch: fruits and drops are caught or missed, so only the droplets are left to miss.
    const droplets = perfect.c50 ?? 0;
    const droplet = Math.min(droplets, Math.max(0, Math.round(total - miss - acc * total)));
    out.katu = droplet;
    out.c50 = droplets - droplet;
    out.c100 = Math.min(counts.c100 ?? perfect.c100 ?? 0, Math.max(0, total - miss - droplets));
    out.c300 = total - miss - out.c50 - out.c100 - out.katu;
    const wanted = total - miss - Math.round(acc * total);
    return { counts: out, reached: wanted >= 0 && wanted <= droplets };
  }

  const ladder = LADDERS[mode];
  const unit = mode === 1 ? 2 : 6;
  // In 50s (osu!, mania) or halves of a 300 (taiko): what the judgements must add up to.
  let target = acc * unit * total;
  if (mode === 0 && ends) {
    // lazer's accuracy counts every slider end (150) and tick (30) hit, out of all of them.
    const max = 300 * total + 30 * ends.ticks + 150 * ends.sliders;
    const hit = 30 * (ends.ticks - (counts.tickMiss ?? 0)) + 150 * (ends.sliders - (counts.tailMiss ?? 0));
    target = (acc * max - hit) / 50;
  }
  const { counts: spreadOut, reached } = spread(total - miss, ladder.map(([, v]) => v), target);
  ladder.forEach(([key], i) => (out[key] = spreadOut[i]));
  if (mode === 3) {
    // The 300s typed are kept, out of the MAX: osu!stable's accuracy cannot tell them apart.
    const three = Math.min(counts.c300 ?? 0, out.geki);
    out.c300 = three;
    out.geki -= three;
  }
  return { counts: out, reached };
}
