import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { computeStats, recentPlays, topPlays } from '../src/calc/stats.ts';
import { buildHistory } from '../src/calc/history.ts';
import { eligibilityOf, VANILLA } from '../src/calc/eligibility.ts';
import { defaultSettings, type Settings } from '../src/settings.ts';
import { Status, UNRESOLVED_STATUS } from '../src/clients/beatmaps.ts';
import {
  isCustomised,
  modsAwardPp,
  modsCountable,
  strippableMods,
} from '../src/calc/pp.ts';

/* ------------------------------------------------------------ mod classification */

test('osu! ranks only the ranked mods, at their default settings', () => {
  assert.equal(modsAwardPp([]), true);
  assert.equal(modsAwardPp([{ acronym: 'HD' }, { acronym: 'HR' }]), true);
  assert.equal(modsAwardPp([{ acronym: 'RX' }]), false);
  assert.equal(modsAwardPp([{ acronym: 'AP' }]), false);
  assert.equal(modsAwardPp([{ acronym: 'DA' }]), false);
});

/*
 * The bug this fixes was live: a DT at 1.45x was stored as ranked because only the acronym
 * was checked. lazer writes `settings` exactly when the player left the defaults, which is
 * the same condition that unranks the mod in osu! itself.
 */
test('a customised rate mod is not ranked, even though its acronym is', () => {
  assert.equal(modsAwardPp([{ acronym: 'DT' }]), true);
  assert.equal(modsAwardPp([{ acronym: 'DT', settings: { speed_change: 1.45 } }]), false);
  assert.equal(modsAwardPp([{ acronym: 'HT', settings: { speed_change: 0.5 } }]), false);
  // An empty settings object is not a customisation.
  assert.equal(modsAwardPp([{ acronym: 'DT', settings: {} }]), true);
});

test('isCustomised only fires on an actual setting', () => {
  assert.equal(isCustomised({ acronym: 'HD' }), false);
  assert.equal(isCustomised({ acronym: 'HD', settings: {} }), false);
  assert.equal(isCustomised({ acronym: 'HD', settings: { only_fade_approach_circles: true } }), true);
});

test('autoplay and cinema can never count; everything else can', () => {
  assert.equal(modsCountable([{ acronym: 'RX' }]), true);
  assert.equal(modsCountable([{ acronym: 'DT', settings: { speed_change: 1.6 } }]), true);
  assert.equal(modsCountable([{ acronym: 'AT' }]), false);
  assert.equal(modsCountable([{ acronym: 'CN' }]), false);
  assert.equal(modsCountable([{ acronym: 'HD' }, { acronym: 'AT' }]), false);
});

test('only relax and autopilot are strippable, and in osu!s order', () => {
  assert.deepEqual(strippableMods([{ acronym: 'RX' }, { acronym: 'DT' }]), ['RX']);
  assert.deepEqual(strippableMods([{ acronym: 'AP' }, { acronym: 'RX' }]), ['RX', 'AP']);
  assert.deepEqual(strippableMods([{ acronym: 'HD' }]), []);
  assert.deepEqual(strippableMods([{ acronym: 'DA' }]), []);
});

/* ------------------------------------------------------------ settings -> rules */

function rules(patch: Partial<Settings>) {
  return eligibilityOf({ ...defaultSettings(), ...patch });
}

test('the pp basis only applies while unranked mods are counted at all', () => {
  assert.deepEqual(rules({}), VANILLA);
  // The default basis is the "as if the mod were off" one the user asked for.
  assert.equal(rules({ includeUnrankedMods: true }).preferStrippedPp, true);
  assert.equal(
    rules({ includeUnrankedMods: true, unrankedModPp: 'as-played' }).preferStrippedPp,
    false,
  );
  // Off, the basis is irrelevant and must not leak into an otherwise-official profile.
  assert.equal(rules({ unrankedModPp: 'without-the-mod' }).preferStrippedPp, false);
});

/* ------------------------------------------------------------ the queries */

interface ScoreFixture {
  md5: string;
  pp: number | null;
  ppNomod?: number | null;
  mapStatus?: number;
  modsRanked?: boolean;
  modsCountable?: boolean;
  passed?: boolean;
  mods?: string;
}

function harness(): { db: Db; profileId: number; add: (s: ScoreFixture) => void; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-eligibility-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  let n = 0;

  const add = (s: ScoreFixture) => {
    const modsRanked = s.modsRanked ?? true;
    const mapStatus = s.mapStatus ?? Status.RANKED;
    const ranked = modsRanked && (mapStatus === Status.RANKED || mapStatus === Status.APPROVED);
    db.prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         accuracy, max_combo, total_score, passed, grade, stars, pp,
         pp_nomod, stars_nomod, map_status, mods_ranked, mods_countable, ranked, played_at)
       VALUES (?,?,0,?,'lazer',?,'None',100,0,0,0,0,0,0.99,100,500000,?,'S',5.0,?,?,?,?,?,?,?,?)`,
    ).run(
      profileId, `key-${++n}`, s.md5, s.mods ?? '[]',
      (s.passed ?? true) ? 1 : 0,
      s.pp, s.ppNomod ?? null, s.ppNomod === undefined || s.ppNomod === null ? null : 6.0,
      mapStatus, modsRanked ? 1 : 0, (s.modsCountable ?? true) ? 1 : 0, ranked ? 1 : 0,
      Date.now() + n * 1000,
    );
  };

  return {
    db,
    profileId,
    add,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('by default only what osu! would rank counts', () => {
  const h = harness();
  try {
    h.add({ md5: 'ranked', pp: 100 });
    h.add({ md5: 'relax', pp: 50, ppNomod: 400, modsRanked: false, mods: '[{"acronym":"RX"}]' });
    h.add({ md5: 'loved', pp: 300, mapStatus: Status.LOVED });
    h.add({ md5: 'failed', pp: 200, passed: false });

    const top = topPlays(h.db, h.profileId, 0, 100, VANILLA);
    assert.deepEqual(top.map((p) => p.beatmapMd5), ['ranked']);
    assert.equal(top[0]!.pp, 100);
    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).distinctRankedBeatmaps, 1);
  } finally {
    h.cleanup();
  }
});

test('including unranked mods brings relax in at its stripped pp', () => {
  const h = harness();
  try {
    h.add({ md5: 'ranked', pp: 100 });
    h.add({ md5: 'relax', pp: 50, ppNomod: 400, modsRanked: false, mods: '[{"acronym":"RX"}]' });

    const e = rules({ includeUnrankedMods: true });
    const top = topPlays(h.db, h.profileId, 0, 100, e);
    assert.deepEqual(top.map((p) => [p.beatmapMd5, p.pp]), [['relax', 400], ['ranked', 100]]);
    assert.equal(top[0]!.ppBasis, 'without-unranked-mods');
    assert.equal(top[1]!.ppBasis, 'as-played');
    // A stripped play is still not something osu! would rank.
    assert.equal(top[0]!.ranked, false);
    assert.equal(top[0]!.counted, true);
  } finally {
    h.cleanup();
  }
});

test('the as-played basis uses osu!s own relax pp instead', () => {
  const h = harness();
  try {
    h.add({ md5: 'relax', pp: 50, ppNomod: 400, modsRanked: false, mods: '[{"acronym":"RX"}]' });

    const top = topPlays(
      h.db,
      h.profileId,
      0,
      100,
      rules({ includeUnrankedMods: true, unrankedModPp: 'as-played' }),
    );
    assert.equal(top[0]!.pp, 50);
    assert.equal(top[0]!.ppBasis, 'as-played');
  } finally {
    h.cleanup();
  }
});

test('an unranked map stays out even with unranked mods included', () => {
  const h = harness();
  try {
    h.add({ md5: 'loved', pp: 300, mapStatus: Status.LOVED });
    h.add({ md5: 'graveyard', pp: 300, mapStatus: Status.GRAVEYARD });
    h.add({ md5: 'unsubmitted', pp: 300, mapStatus: UNRESOLVED_STATUS });

    const top = topPlays(h.db, h.profileId, 0, 100, rules({ includeUnrankedMods: true }));
    assert.deepEqual(top, []);
  } finally {
    h.cleanup();
  }
});

test('autoplay is excluded however permissive the settings', () => {
  const h = harness();
  try {
    h.add({
      md5: 'auto',
      pp: 900,
      modsRanked: false,
      modsCountable: false,
      mods: '[{"acronym":"AT"}]',
    });
    assert.deepEqual(topPlays(h.db, h.profileId, 0, 100, rules({ includeUnrankedMods: true })), []);
  } finally {
    h.cleanup();
  }
});

test('a failed play never counts, whatever is included', () => {
  const h = harness();
  try {
    h.add({ md5: 'failed', pp: 500, passed: false, modsRanked: false });
    assert.deepEqual(topPlays(h.db, h.profileId, 0, 100, rules({ includeUnrankedMods: true })), []);
  } finally {
    h.cleanup();
  }
});

test('recent plays list everything, and say which of them counted', () => {
  const h = harness();
  try {
    h.add({ md5: 'ranked', pp: 100 });
    h.add({ md5: 'loved', pp: 300, mapStatus: Status.LOVED });

    const recent = recentPlays(h.db, h.profileId, 0, 25, VANILLA);
    assert.equal(recent.length, 2);
    const byMap = new Map(
      recent.filter((p) => p.kind === 'score').map((p) => [p.beatmapMd5, p]),
    );
    assert.equal(byMap.get('ranked')!.counted, true);
    assert.equal(byMap.get('loved')!.counted, false);
    // The pp is still reported: it is the honest answer to "what would this be worth".
    assert.equal(byMap.get('loved')!.pp, 300);
  } finally {
    h.cleanup();
  }
});

test('the pp history follows the same rules as the totals', () => {
  const h = harness();
  try {
    h.add({ md5: 'ranked', pp: 100 });
    h.add({ md5: 'relax', pp: 50, ppNomod: 400, modsRanked: false, mods: '[{"acronym":"RX"}]' });

    const vanilla = buildHistory(h.db, h.profileId, 0, 15, VANILLA);
    const permissive = buildHistory(h.db, h.profileId, 0, 15, rules({ includeUnrankedMods: true }));

    const last = (hist: typeof vanilla) => hist.pp[hist.pp.length - 1]!.pp;
    assert.ok(last(permissive) > last(vanilla));
    // Both play counts are the same: the monthly chart is about what was played.
    assert.deepEqual(
      vanilla.monthlyPlaycounts.map((m) => m.count),
      permissive.monthlyPlaycounts.map((m) => m.count),
    );
  } finally {
    h.cleanup();
  }
});

/*
 * Rows written before these columns existed have NULL in them. They must keep behaving the
 * way they did rather than vanishing from the profile, until a recompute fills them in.
 */
test('scores predating the eligibility columns still count', () => {
  const h = harness();
  try {
    h.db.prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         accuracy, max_combo, total_score, passed, grade, pp, ranked, played_at)
       VALUES (?,'legacy',0,'old','lazer','[]','None',100,0,0,0,0,0,0.99,100,500000,1,'S',120,1,?)`,
    ).run(h.profileId, Date.now());

    for (const e of [VANILLA, rules({ includeUnrankedMods: true })]) {
      const top = topPlays(h.db, h.profileId, 0, 100, e);
      assert.deepEqual(top.map((p) => p.beatmapMd5), ['old']);
    }
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------ unranked maps */

test('each unranked beatmap state is included independently', () => {
  const h = harness();
  try {
    h.add({ md5: 'loved', pp: 10, mapStatus: Status.LOVED });
    h.add({ md5: 'qualified', pp: 20, mapStatus: Status.QUALIFIED });
    h.add({ md5: 'pending', pp: 30, mapStatus: Status.PENDING });
    h.add({ md5: 'wip', pp: 40, mapStatus: Status.WIP });
    h.add({ md5: 'graveyard', pp: 50, mapStatus: Status.GRAVEYARD });
    h.add({ md5: 'unsubmitted', pp: 60, mapStatus: UNRESOLVED_STATUS });
    h.add({ md5: 'ranked', pp: 70 });

    const counted = (maps: string[]) =>
      topPlays(h.db, h.profileId, 0, 100, rules({ includeUnrankedMaps: maps as never }))
        .map((p) => p.beatmapMd5)
        .sort();

    assert.deepEqual(counted([]), ['ranked']);
    assert.deepEqual(counted(['loved']), ['loved', 'ranked']);
    assert.deepEqual(counted(['graveyard']), ['graveyard', 'ranked']);
    assert.deepEqual(counted(['unsubmitted']), ['ranked', 'unsubmitted']);
    assert.deepEqual(counted(['wip', 'pending']), ['pending', 'ranked', 'wip']);
    assert.deepEqual(
      counted(['loved', 'qualified', 'pending', 'wip', 'graveyard', 'unsubmitted']),
      ['graveyard', 'loved', 'pending', 'qualified', 'ranked', 'unsubmitted', 'wip'],
    );
  } finally {
    h.cleanup();
  }
});

/*
 * The two settings are independent: a loved map played with relax needs both before it
 * counts, and neither one on its own may let it through.
 */
test('map and mod rules are both required, not either', () => {
  const h = harness();
  try {
    h.add({
      md5: 'loved-relax',
      pp: 10,
      ppNomod: 200,
      mapStatus: Status.LOVED,
      modsRanked: false,
      mods: '[{"acronym":"RX"}]',
    });

    const counted = (patch: Parameters<typeof rules>[0]) =>
      topPlays(h.db, h.profileId, 0, 100, rules(patch)).length;

    assert.equal(counted({}), 0);
    assert.equal(counted({ includeUnrankedMods: true }), 0);
    assert.equal(counted({ includeUnrankedMaps: ['loved'] as never }), 0);
    assert.equal(
      counted({ includeUnrankedMods: true, includeUnrankedMaps: ['loved'] as never }),
      1,
    );
  } finally {
    h.cleanup();
  }
});

test('including a beatmap state moves ranked score, bonus pp and the grade counts too', () => {
  const h = harness();
  try {
    h.add({ md5: 'ranked', pp: 100 });
    h.add({ md5: 'loved', pp: 100, mapStatus: Status.LOVED });

    const before = computeStats(h.db, h.profileId, 0, VANILLA);
    const after = computeStats(
      h.db,
      h.profileId,
      0,
      rules({ includeUnrankedMaps: ['loved'] as never }),
    );

    assert.equal(before.distinctRankedBeatmaps, 1);
    assert.equal(after.distinctRankedBeatmaps, 2);
    assert.ok(after.bonusPp > before.bonusPp);
    assert.ok(after.rankedScore > before.rankedScore);
    assert.equal(after.grades.S, before.grades.S + 1);
  } finally {
    h.cleanup();
  }
});

test('an unrecognised beatmap state in stored settings is dropped, not trusted', () => {
  const h = harness();
  try {
    h.add({ md5: 'ranked', pp: 100 });
    h.add({ md5: 'loved', pp: 999, mapStatus: Status.LOVED });

    // As if a newer version had written a state this one does not know about.
    const e = eligibilityOf({
      ...defaultSettings(),
      includeUnrankedMaps: ['loved', 'nonsense', 'loved'] as never,
    });
    assert.deepEqual(e.extraMapStatuses, [Status.LOVED]);
    assert.equal(topPlays(h.db, h.profileId, 0, 100, e).length, 2);
  } finally {
    h.cleanup();
  }
});
