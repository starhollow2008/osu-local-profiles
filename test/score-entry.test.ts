import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseReplay } from '../src/osr.ts';
import { buildLinkedReplay, buildManualReplay } from '../src/built-replays.ts';
import { extractScorePage, parseScoreLink, scoreUrl, type OsuWebScore } from '../src/clients/osu-web.ts';
import { encodeLegacyMods, scorePricing } from '../src/calc/pp.ts';
import { beatmapIdOf, convertImportedScores, enterScore, parseMods, searchBeatmaps, type EntryDeps } from '../src/score-entry.ts';
import { importScore } from '../src/tracker/online-import.ts';
import { applyScoreAction, replayDownload, scoreDetail } from '../src/scores.ts';
import { isProfileFile } from '../src/backup.ts';
import type { PpResult } from '../src/calc/pp.ts';
import { UNKNOWN_IDENTITY } from '../src/player-identity.ts';
import { harness, MD5, SINCE, type Harness } from './import-fixture.ts';

/*
 * Scores added by name: from their link on osu.ppy.sh, or entered by hand (src/score-entry.ts).
 *
 * Both become a replay this app builds (src/built-replays.ts) and prices like any other, so a pp
 * rework reprices them here, offline, with every other score. Measured against osu! itself while
 * this was written: a 2015 osu!stable score with no replay anywhere, 175.697pp on osu! and
 * 175.6969 here from its built replay; a lazer score, 338.837 and 338.8372. Nothing here reaches
 * osu.ppy.sh -- what the network gives is tested as text.
 */

/** A score as osu-web describes one, for building from. */
function osuScore(over: Partial<OsuWebScore> = {}): OsuWebScore {
  return {
    id: '308368918',
    legacyScoreId: '2019594028',
    mode: 0,
    beatmapMD5: MD5,
    beatmapId: 4000001,
    beatmapsetId: 2000001,
    artist: 'Reji',
    title: 'Shoujo wa Yoru to Azayaka ni',
    version: 'Vivid Collab',
    creator: 'ADoorNob',
    mapStatus: 1,
    beatmapStars: 5.09,
    mods: [{ acronym: 'HD' }, { acronym: 'NC' }, { acronym: 'CL' }],
    statistics: { great: 437, ok: 2 },
    maximumStatistics: { great: 439 },
    accuracy: 0.996963,
    maxCombo: 653,
    totalScore: 976070,
    classicTotalScore: 8690430,
    legacyTotalScore: 8690430,
    grade: 'S',
    passed: true,
    legacyPerfect: true,
    ranked: true,
    pp: 175.697,
    playedAt: Date.parse('2015-11-27T03:36:31Z'),
    weightPercentage: null,
    ...over,
  };
}

test('a stable score from its link is built as the stable replay osu!stable would have written', async () => {
  const score = await parseReplay(buildLinkedReplay(osuScore(), { id: 3119700, name: 'Tangy' })!);
  assert.equal(score.client, 'stable');
  assert.deepEqual(
    [score.count300, score.count100, score.count50, score.countMiss, score.maxCombo, score.totalScore],
    [437, 2, 0, 0, 653, 8690430],
  );
  // Nightcore sets Double Time's bit as well, as stable writes it; Classic has no bit.
  assert.equal(score.legacyMods, encodeLegacyMods([{ acronym: 'HD' }, { acronym: 'NC' }]));
  assert.equal(score.legacyMods, (1 << 3) | (1 << 6) | (1 << 9));
  assert.equal(score.onlineScoreId, 2019594028n, 'the legacy id, as a stable replay carries');
  assert.equal(score.playedAt.getTime(), Date.parse('2015-11-27T03:36:31Z'));
  assert.deepEqual(score.built, { origin: 'link', legacyTotal: true });
  // Its total is osu!stable's own, so stable pricing reads it.
  assert.deepEqual(scorePricing(score, null), {});
});

test('a lazer score from its link keeps its statistics and mod settings in lazer’s own block', async () => {
  const mods = [{ acronym: 'DT', settings: { speed_change: 1.3 } }];
  const built = buildLinkedReplay(
    osuScore({
      id: '5542633708',
      legacyScoreId: null,
      mods,
      statistics: { great: 872, ok: 9, miss: 5, slider_tail_hit: 375, large_tick_hit: 66 },
      maximumStatistics: { great: 886, slider_tail_hit: 375, large_tick_hit: 66 },
      grade: 'A',
    }),
    { id: 3119700, name: 'Tangy' },
  )!;
  const score = await parseReplay(built);
  assert.equal(score.client, 'lazer');
  assert.deepEqual(score.extras?.mods, mods);
  assert.equal(score.extras?.statistics?.['slider_tail_hit'], 375);
  assert.equal(score.extras?.user_id, 3119700);
  assert.equal(score.onlineScoreId, 5542633708n);
  assert.deepEqual(score.built, { origin: 'link', legacyTotal: false });
  // A stable score cannot hold a lazer-only setting, so it cannot be built as one.
  assert.equal(buildLinkedReplay(osuScore({ mods }), { id: null, name: '' }), null);
});

test('a score entered with no total is priced without one', async () => {
  const entry = {
    mode: 0 as const,
    beatmapMD5: MD5,
    player: 'Tangy',
    counts: { c300: 2, c100: 0, c50: 0, geki: 0, katu: 0, miss: 0 },
    maxCombo: 2,
    legacyMods: 0,
    playedAt: SINCE,
  };
  const without = await parseReplay(buildManualReplay({ ...entry, totalScore: null }));
  assert.deepEqual(without.built, { origin: 'manual', legacyTotal: false });
  assert.deepEqual(scorePricing(without, null), { ignoreLegacyTotalScore: true });
  const typed = await parseReplay(buildManualReplay({ ...entry, totalScore: 1234 }));
  assert.deepEqual(scorePricing(typed, null), {}, 'a total typed in is priced like osu!stable’s own');
});

test('a score link is read the way osu! numbers scores, and never confused', () => {
  assert.equal(parseScoreLink('https://osu.ppy.sh/scores/308368918'), 'scores/308368918');
  assert.equal(parseScoreLink('osu.ppy.sh/scores/5542633708?foo#bar'), 'scores/5542633708');
  // A legacy id only means that score under its ruleset: the bare form is someone else's.
  assert.equal(parseScoreLink('https://osu.ppy.sh/scores/osu/2019594028'), 'scores/osu/2019594028');
  assert.equal(parseScoreLink('308368918'), 'scores/308368918');
  assert.equal(parseScoreLink('https://example.com/scores/1'), null);
  assert.equal(parseScoreLink('https://osu.ppy.sh/users/3119700'), null);

  // And back out again, for View on osu!.
  const url = (o: Partial<Parameters<typeof scoreUrl>[0]>) =>
    scoreUrl({ mode: 0, client: 'stable', onlineScoreId: null, legacyScoreId: null, ...o });
  assert.equal(url({ client: 'lazer', onlineScoreId: '5542633708' }), 'https://osu.ppy.sh/scores/5542633708');
  assert.equal(url({ onlineScoreId: '2019594028' }), 'https://osu.ppy.sh/scores/osu/2019594028');
  assert.equal(url({ mode: 3, onlineScoreId: '7' }), 'https://osu.ppy.sh/scores/mania/7');
  // An imported stable play keeps its legacy id, which only the ruleset form finds.
  assert.equal(url({ onlineScoreId: '308368918', legacyScoreId: '2019594028' }), 'https://osu.ppy.sh/scores/osu/2019594028');
  assert.equal(url({ client: 'lazer', onlineScoreId: '5542633708', legacyScoreId: null }), 'https://osu.ppy.sh/scores/5542633708');
  assert.equal(url({}), null, 'a play osu! never had');
  assert.equal(url({ client: 'mcosu', onlineScoreId: '1' }), null);

  assert.equal(beatmapIdOf('https://osu.ppy.sh/beatmapsets/2000001#osu/4000001'), 4000001);
  assert.equal(beatmapIdOf('https://osu.ppy.sh/b/4000001'), 4000001);
  assert.equal(beatmapIdOf('4000001'), 4000001);
  assert.equal(beatmapIdOf('https://osu.ppy.sh/beatmapsets/2000001'), null, 'a set is not one difficulty');
});

test('a score page’s own JSON is what is read, with who set it', () => {
  const json = {
    id: 308368918,
    legacy_score_id: 2019594028,
    ruleset_id: 0,
    mods: [{ acronym: 'CL' }],
    statistics: { great: 437, ok: 2 },
    maximum_statistics: { great: 439 },
    accuracy: 0.996963,
    max_combo: 653,
    total_score: 976070,
    legacy_total_score: 8690430,
    rank: 'S',
    passed: true,
    legacy_perfect: true,
    ranked: true,
    pp: 175.697,
    ended_at: '2015-11-27T03:36:31Z',
    user_id: 3119700,
    user: { username: 'Tangy' },
    beatmap: { id: 293573, checksum: 'afdced8eef76a5e78ccc08bc036f02ff', status: 'ranked', version: 'Lunatic' },
    beatmapset: { id: 1, artist: 'Arte Refact', title: 'Space Accelerator', creator: 'x' },
  };
  const page = `<html><script id="json-show" type="application/json">${JSON.stringify(json)}</script></html>`;
  const linked = extractScorePage(page)!;
  assert.deepEqual(linked.player, { id: 3119700, name: 'Tangy' });
  assert.equal(linked.score.legacyScoreId, '2019594028');
  assert.equal(linked.score.legacyPerfect, true);
  assert.equal(extractScorePage('<html>no score here</html>'), null);
});

test('mods are typed as osu!stable shows them, and only ones the ruleset has', () => {
  assert.deepEqual(parseMods('+HD DT', 0), { bits: (1 << 3) | (1 << 6), acronyms: ['HD', 'DT'] });
  assert.deepEqual(parseMods('hdnc', 0), { bits: (1 << 3) | (1 << 6) | (1 << 9), acronyms: ['HD', 'NC'] });
  assert.deepEqual(parseMods('', 0), { bits: 0, acronyms: [] });
  assert.ok('error' in parseMods('4K', 0), 'a key count is mania’s');
  assert.deepEqual(parseMods('4K', 3), { bits: 1 << 15, acronyms: ['4K'] });
  assert.ok('error' in parseMods('EZHR', 0));
  assert.ok('error' in parseMods('AT', 0), 'nobody enters a play Autoplay set');
  assert.ok('error' in parseMods('XX', 0));
});

function deps(h: Harness, dataDir: string, maxCombo = 2): EntryDeps {
  return {
    db: h.db,
    resolver: h.tracker.beatmaps,
    dataDir,
    profileId: h.profileId,
    identity: UNKNOWN_IDENTITY,
    importBuiltReplay: (file) => h.tracker.importBuiltReplay(file),
    // What osu!'s calculator says of the beatmap, without running it: its maximum combo.
    priceReplay: async () => ({ maxCombo, pp: 1 }) as PpResult,
    canPrice: true,
  };
}

test('a score entered by hand is checked against its beatmap, then marked everywhere it shows', async () => {
  const h = await harness();
  const dataDir = path.join(path.dirname(h.replays), 'data');
  fs.mkdirSync(dataDir);
  try {
    const d = deps(h, dataDir);
    const [beatmap] = searchBeatmaps(d, 'reji vivid');
    assert.equal(beatmap!.md5, MD5, 'found among the installed beatmaps by name');
    assert.equal(beatmap!.objects, 2);

    const entry = {
      md5: MD5,
      mode: 0,
      counts: { c300: 2 },
      maxCombo: 2,
      mods: 'HD',
      playedAt: SINCE,
    };
    await assert.rejects(enterScore(d, { ...entry, counts: { c300: 1 } }, 'Tangy'), /add up to 1.*has 2 objects/);
    await assert.rejects(enterScore(d, { ...entry, maxCombo: 3 }, 'Tangy'), /more than this beatmap's maximum of 2/);
    await assert.rejects(enterScore(d, { ...entry, playedAt: Date.now() + 86_400_000 }, 'Tangy'), /when the play was set/);
    await assert.rejects(enterScore({ ...d, canPrice: false }, entry, 'Tangy'), /pp calculator/);
    assert.equal(h.count('scores'), 0, 'nothing refused was written');
    assert.equal(fs.readdirSync(path.join(dataDir, 'replays')).length, 0, 'nor kept');

    const added = await enterScore(d, entry, 'Tangy');
    assert.equal(added.status, 'added');
    const row = h.db.prepare('SELECT id, origin, mods_label FROM scores').get() as { id: number; origin: string; mods_label: string };
    assert.equal(row.origin, 'manual');
    assert.equal(row.mods_label, 'HD');

    // Marked on the profile, offered no replay to download, and never twice.
    // Read as the card reads it: with no calculator here there is no pp, so no top play to list.
    const play = scoreDetail(h.db, h.profileId, row.id);
    assert.equal(play?.source, 'manual');
    assert.equal(play?.hasReplay, false);
    assert.equal(play?.osuUrl, null, 'osu! has never seen it');
    assert.deepEqual(replayDownload(h.db, h.profileId, row.id, 'Tangy'), { error: 'this score has no replay file' });
    assert.equal((await enterScore(d, entry, 'Tangy')).status, 'already');
    assert.equal(h.count('scores'), 1);
  } finally {
    h.cleanup();
  }
});

test('a score from its link is marked, and links back to osu!', async () => {
  const h = await harness();
  try {
    const file = h.write('built.osr', buildLinkedReplay(osuScore({ mods: [{ acronym: 'CL' }] }), { id: 3119700, name: 'Tangy' })!);
    assert.equal((await h.tracker.importBuiltReplay(file)).status, 'added');
    const { id } = h.db.prepare('SELECT id FROM scores').get() as { id: number };
    const play = scoreDetail(h.db, h.profileId, id);
    assert.equal(play?.source, 'link');
    assert.equal(play?.hasReplay, false);
    assert.equal(play?.osuUrl, 'https://osu.ppy.sh/scores/osu/2019594028');
  } finally {
    h.cleanup();
  }
});

/*
 * Best performances imported from osu! are put on a built replay too, so a pp rework reprices
 * them here with everything else -- rebuilt from what osu! handed over, nothing fetched again.
 */
test('an imported best performance is rebuilt as a replay and priced here, keeping its row', async () => {
  const h = await harness();
  const dataDir = path.join(path.dirname(h.replays), 'data');
  fs.mkdirSync(dataDir);
  try {
    const played = osuScore({ statistics: { great: 2 }, maximumStatistics: { great: 2 }, maxCombo: 2 });
    const { id } = importScore(h.db, h.tracker.beatmaps, h.profileId, played) as { id: number };
    applyScoreAction(h.db, h.profileId, id, 'pin');
    // One on a beatmap that is not installed, which a launch does not go online to fetch.
    importScore(h.db, h.tracker.beatmaps, h.profileId, osuScore({ id: '9', legacyScoreId: '99', beatmapMD5: 'f'.repeat(32) }));

    const d = deps(h, dataDir);
    assert.deepEqual(await convertImportedScores(d, h.profileId, { download: false }), { converted: 1, left: 1 });

    const row = h.db.prepare('SELECT id, origin, imported_at, replay_path, pinned_at, legacy_score_id FROM scores WHERE id = ?').get(id) as {
      id: number;
      origin: string;
      imported_at: number | null;
      replay_path: string;
      pinned_at: number | null;
      legacy_score_id: string;
    };
    assert.equal(row.origin, 'link');
    assert.equal(row.imported_at, null, 'no longer osu!’s figures: priced here, and by every recalculation');
    assert.ok(row.replay_path.startsWith(path.join(dataDir, 'replays')));
    assert.notEqual(row.pinned_at, null, 'its pin kept');
    assert.equal(scoreDetail(h.db, h.profileId, id)?.osuUrl, 'https://osu.ppy.sh/scores/osu/2019594028');

    // Done once: the next launch finds nothing left to do but the map it cannot fetch.
    assert.deepEqual(await convertImportedScores(d, h.profileId, { download: false }), { converted: 0, left: 1 });
    // With no calculator, nothing is touched.
    assert.deepEqual(await convertImportedScores({ ...d, canPrice: false }, h.profileId, { download: false }), {
      converted: 0,
      left: 1,
    });
    assert.equal(h.count('scores'), 2);
  } finally {
    h.cleanup();
  }
});

test('a downloaded beatmap is carried by a backup, so a restore can reprice with no internet', () => {
  assert.equal(isProfileFile(`beatmaps/${MD5}.osu`), true);
  assert.equal(isProfileFile('beatmaps/not-a-hash.osu'), false);
});
