import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { BeatmapResolver, Status, UNRESOLVED_STATUS } from '../src/clients/beatmaps.ts';
import { getSettings, updateSettings } from '../src/settings.ts';
import {
  beatmapFilterFacts,
  coerceTrackingFilter,
  defaultTrackingFilter,
  filterKeywords,
  filterNarrows,
  filterRejects,
  playFacts,
  type TrackingFilter,
} from '../src/tracking-filter.ts';
import { ingestIncompletePlay } from '../src/tracker/incomplete.ts';
import type { ResolvedLoggedPlay } from '../src/clients/lazer-log.ts';
import type { AddressInfo } from 'node:net';
import { Tracker } from '../src/tracker/index.ts';
import { startServer } from '../src/http/server.ts';

/*
 * The play tracking filter decides whether a play is *written*, which makes it the one
 * setting in this app with no second chance: there is no row to revisit afterwards. So these
 * tests are mostly about the two rules that follow from that -- a fact the filter does not
 * have never rejects a play, and nothing is narrowed until it is narrowed on purpose.
 */

/** The filter as the dialog hands it over, with only the named parts changed. */
function filter(overrides: Partial<TrackingFilter> = {}): TrackingFilter {
  return { ...defaultTrackingFilter(), enabled: true, ...overrides };
}

const facts = {
  mode: 0 as const,
  mods: [] as { acronym: string }[],
  stars: 5,
  lengthSeconds: 120,
  status: Status.RANKED,
  text: 'Yooh - Dreamin Attraction!! [Extra] Sotarks',
  addedAt: Date.UTC(2024, 0, 1),
  submittedAt: Date.UTC(2020, 0, 1),
  rankedAt: Date.UTC(2020, 5, 1),
};

/* ------------------------------------------------------------------ defaults */

test('the filter is off by default, and off means nothing is judged', () => {
  const off = defaultTrackingFilter();
  assert.equal(off.enabled, false);
  assert.equal(filterNarrows(off), false);
  // Even a fact that would fail every criterion: while it is off, nothing is consulted.
  assert.equal(filterRejects(off, { ...facts, mode: 3, stars: 99 }), null);
});

test('switched on and untouched, every play still passes', () => {
  const wide = filter();
  assert.equal(filterRejects(wide, facts), null);
  assert.equal(filterRejects(wide, { ...facts, mode: 3, status: UNRESOLVED_STATUS }), null);
  assert.equal(
    filterRejects(wide, { ...facts, mods: [{ acronym: 'RX' }, { acronym: 'DT' }], stars: 14.2 }),
    null,
  );
  // Switched on but wide open is not something to warn anyone about.
  assert.equal(filterNarrows(wide), false);
});

test('filterNarrows notices each criterion on its own', () => {
  assert.equal(filterNarrows(filter({ keywords: 'sotarks' })), true);
  assert.equal(filterNarrows(filter({ modes: [0, 1, 2] })), true);
  assert.equal(filterNarrows(filter({ stars: { min: 5, max: null } })), true);
  assert.equal(filterNarrows(filter({ stars: { min: 0, max: 7 } })), true);
  assert.equal(filterNarrows(filter({ length: { min: 0, max: 300 } })), true);
  assert.equal(filterNarrows(filter({ mods: { HD: 'required' } })), true);
  assert.equal(filterNarrows(filter({ noMod: 'excluded' })), true);
  assert.equal(filterNarrows(filter({ categories: ['ranked'] })), true);
  assert.equal(filterNarrows(filter({ added: { from: 1, to: null } })), true);
  assert.equal(
    filterNarrows(filter({ submitted: { from: null, to: null, includeUnknown: false } })),
    true,
  );
  // Keywords that are only punctuation are not keywords.
  assert.equal(filterNarrows(filter({ keywords: ' , , ' })), false);
});

/* ------------------------------------------------------------------ keywords */

test('keywords are separated by commas, not by spaces', () => {
  assert.deepEqual(filterKeywords('Blue Zenith, Sotarks'), ['blue zenith', 'sotarks']);
  assert.deepEqual(filterKeywords('  ,  '), []);
});

test('a play matches if any one keyword appears in any of the four fields', () => {
  const byMapper = filter({ keywords: 'sotarks' });
  assert.equal(filterRejects(byMapper, facts), null);
  assert.equal(filterRejects(byMapper, { ...facts, text: 'Yooh - Dreamin [Extra] Monstrata' }), 'keywords');

  // Any one of them, which is what makes "track these two mappers" expressible.
  const either = filter({ keywords: 'monstrata, sotarks' });
  assert.equal(filterRejects(either, facts), null);

  // A phrase with a space in it is one keyword, and matches across the joined fields.
  assert.equal(filterRejects(filter({ keywords: 'dreamin attraction' }), facts), null);
  assert.equal(filterRejects(filter({ keywords: 'attraction dreamin' }), facts), 'keywords');
});

test('a beatmap with no readable metadata is not rejected on its keywords', () => {
  // Nothing to match against is not the same as "does not match" -- see the module's header.
  assert.equal(filterRejects(filter({ keywords: 'sotarks' }), { ...facts, text: null }), null);
  assert.equal(filterRejects(filter({ keywords: 'sotarks' }), { ...facts, text: '' }), null);
});

/* --------------------------------------------------------------------- mods */

test('an allowed mod is neither required nor excluded', () => {
  const anyMods = filter({ mods: { HD: 'allowed' } });
  assert.equal(filterRejects(anyMods, { ...facts, mods: [] }), null);
  assert.equal(filterRejects(anyMods, { ...facts, mods: [{ acronym: 'HD' }] }), null);
});

/*
 * The user's own reading of the three states, and the reason there are three: with Hidden
 * allowed and everything else excluded, nomod and HD plays are tracked; with DT required and
 * HD allowed, DT and DTHD are. Neither is expressible with one checkbox per mod.
 */
test('allowed, required and excluded together describe a mod combination', () => {
  const hdOrNothing = filter({
    mods: { DT: 'excluded', HR: 'excluded', FL: 'excluded' },
  });
  assert.equal(filterRejects(hdOrNothing, { ...facts, mods: [] }), null);
  assert.equal(filterRejects(hdOrNothing, { ...facts, mods: [{ acronym: 'HD' }] }), null);
  assert.equal(filterRejects(hdOrNothing, { ...facts, mods: [{ acronym: 'DT' }] }), 'mods');

  const dtWithOrWithoutHd = filter({ mods: { DT: 'required' } });
  assert.equal(filterRejects(dtWithOrWithoutHd, { ...facts, mods: [{ acronym: 'DT' }] }), null);
  assert.equal(
    filterRejects(dtWithOrWithoutHd, { ...facts, mods: [{ acronym: 'DT' }, { acronym: 'HD' }] }),
    null,
  );
  assert.equal(filterRejects(dtWithOrWithoutHd, { ...facts, mods: [{ acronym: 'HD' }] }), 'mods');
});

test('the nomod chip says something the grid cannot', () => {
  const onlyNomod = filter({ noMod: 'required' });
  assert.equal(filterRejects(onlyNomod, { ...facts, mods: [] }), null);
  assert.equal(filterRejects(onlyNomod, { ...facts, mods: [{ acronym: 'HD' }] }), 'mods');

  const neverNomod = filter({ noMod: 'excluded' });
  assert.equal(filterRejects(neverNomod, { ...facts, mods: [] }), 'mods');
  assert.equal(filterRejects(neverNomod, { ...facts, mods: [{ acronym: 'HD' }] }), null);
});

/*
 * osu! adds Classic to every legacy score before scoring it and osu-web lists a stable play as
 * `DTCL`, but `mods_json` -- and so the filter -- holds what the player actually chose. A mod
 * nobody picked must not decide whether their play is recorded.
 */
test('an osu!stable play is matched on what the player chose, without Classic', () => {
  const exactDt = filter({ mods: { DT: 'required', CL: 'excluded' } });
  assert.equal(filterRejects(exactDt, { ...facts, mods: [{ acronym: 'DT' }] }), null);
});

test('how a mod was configured is not part of the comparison', () => {
  const dt = filter({ mods: { DT: 'required' } });
  const customised = [{ acronym: 'DT', settings: { speed_change: 1.35 } }];
  assert.equal(filterRejects(dt, { ...facts, mods: customised }), null);
});

test('a play with no mod list recorded is not judged on its mods', () => {
  // Over half of what osu! counts: a quit, an HP fail, a retry. lazer writes down no mods.
  const dt = filter({ mods: { DT: 'required' }, noMod: 'excluded' });
  assert.equal(filterRejects(dt, { ...facts, mods: null }), null);
});

/* ------------------------------------------------------------- stars, length */

test('the star rating is judged as played, and only when there is one', () => {
  const midRange = filter({ stars: { min: 5.1, max: 6.9 } });
  assert.equal(filterRejects(midRange, { ...facts, stars: 6 }), null);
  assert.equal(filterRejects(midRange, { ...facts, stars: 5 }), 'star rating');
  assert.equal(filterRejects(midRange, { ...facts, stars: 7.83 }), 'star rating');
  // No calculator, no replay, or a beatmap file that could not be read.
  assert.equal(filterRejects(midRange, { ...facts, stars: null }), null);
});

test('a star rating is compared at the precision the page shows', () => {
  const upTo = filter({ stars: { min: 0, max: 6.9 } });
  // osu! produces a float; 6.9000001 is 6.90 everywhere in this app and must not be rejected.
  assert.equal(filterRejects(upTo, { ...facts, stars: 6.900000123 }), null);
  assert.equal(filterRejects(upTo, { ...facts, stars: 6.905 }), 'star rating');
});

test('an open upper bound really is open', () => {
  const fiveUp = filter({ stars: { min: 5, max: null } });
  assert.equal(filterRejects(fiveUp, { ...facts, stars: 40 }), null);
  assert.equal(filterRejects(fiveUp, { ...facts, stars: 4.99 }), 'star rating');
});

test('length is judged at the speed the play ran', () => {
  const upToThreeMinutes = filter({ length: { min: 0, max: 180 } });
  const beatmap = { status: Status.RANKED, text: '', lengthMs: 240_000, addedAt: null, submittedAt: null, rankedAt: null };

  // Four minutes nomod is too long; the same map under DT is 2:40 and is not.
  assert.equal(
    filterRejects(upToThreeMinutes, playFacts(beatmap, 0, [])),
    'length',
  );
  assert.equal(
    filterRejects(upToThreeMinutes, playFacts(beatmap, 0, [{ acronym: 'DT' }])),
    null,
  );
  // A play with no mods recorded is measured at the beatmap's own speed, the only answer there is.
  assert.equal(filterRejects(upToThreeMinutes, playFacts(beatmap, 0, null)), 'length');
});

/* ------------------------------------------------------- categories and dates */

test('categories map onto osu!’s own approved values', () => {
  const rankedOnly = filter({ categories: ['ranked'] });
  assert.equal(filterRejects(rankedOnly, { ...facts, status: Status.RANKED }), null);
  // "Approved" is the old name for a ranked map of unbounded length; osu! does not separate them.
  assert.equal(filterRejects(rankedOnly, { ...facts, status: Status.APPROVED }), null);
  assert.equal(filterRejects(rankedOnly, { ...facts, status: Status.LOVED }), 'category');
  assert.equal(filterRejects(rankedOnly, { ...facts, status: UNRESOLVED_STATUS }), 'category');

  const local = filter({ categories: ['unsubmitted'] });
  assert.equal(filterRejects(local, { ...facts, status: UNRESOLVED_STATUS }), null);
});

test('a date range is inclusive at both ends', () => {
  const year = filter({ added: { from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 11, 31) } });
  assert.equal(filterRejects(year, { ...facts, addedAt: Date.UTC(2024, 0, 1) }), null);
  assert.equal(filterRejects(year, { ...facts, addedAt: Date.UTC(2024, 11, 31) }), null);
  assert.equal(filterRejects(year, { ...facts, addedAt: Date.UTC(2023, 11, 31) }), 'date added');
  assert.equal(filterRejects(year, { ...facts, addedAt: Date.UTC(2025, 0, 1) }), 'date added');
});

/*
 * online.db records a submission and a ranked date only for the sets osu! has ranked, approved
 * or loved. Without this box, narrowing either date would silently stop tracking every pending,
 * WIP, graveyarded and never-submitted beatmap -- which is not what anyone typing a year means.
 */
test('beatmaps with no date on record are kept unless the box is unticked', () => {
  const range = { from: Date.UTC(2020, 0, 1), to: Date.UTC(2021, 0, 1) };
  const keep = filter({ submitted: { ...range, includeUnknown: true } });
  assert.equal(filterRejects(keep, { ...facts, submittedAt: null }), null);

  const drop = filter({ submitted: { ...range, includeUnknown: false } });
  assert.equal(filterRejects(drop, { ...facts, submittedAt: null }), 'date submitted');
  assert.equal(filterRejects(drop, { ...facts, submittedAt: Date.UTC(2020, 6, 1) }), null);
});

test('an unranked beatmap is kept by the ranked-date box, not by luck', () => {
  const onlyRecentlyRanked = filter({
    ranked: { from: Date.UTC(2025, 0, 1), to: null, includeUnknown: false },
  });
  assert.equal(filterRejects(onlyRecentlyRanked, { ...facts, rankedAt: null }), 'date ranked');
  assert.equal(
    filterRejects(onlyRecentlyRanked, { ...facts, rankedAt: Date.UTC(2026, 0, 1) }),
    null,
  );
});

/* --------------------------------------------------------------------- modes */

test('the mode criterion is the played mode', () => {
  const maniaOnly = filter({ modes: [3] });
  assert.equal(filterRejects(maniaOnly, { ...facts, mode: 3 }), null);
  assert.equal(filterRejects(maniaOnly, { ...facts, mode: 0 }), 'mode');
});

/* ------------------------------------------------------------------ coercion */

test('anything at all coerces to a usable filter', () => {
  assert.deepEqual(coerceTrackingFilter(null), defaultTrackingFilter());
  assert.deepEqual(coerceTrackingFilter('nonsense'), defaultTrackingFilter());
  assert.deepEqual(coerceTrackingFilter([1, 2, 3]), defaultTrackingFilter());
});

test('a range typed back to front is read as the range it describes', () => {
  const back = coerceTrackingFilter({ stars: { min: 6.9, max: 5.1 } });
  assert.deepEqual(back.stars, { min: 5.1, max: 6.9 });
});

test('values out of range are held to it rather than rejected', () => {
  const wild = coerceTrackingFilter({
    stars: { min: -4, max: 900 },
    length: { min: 0, max: 99999 },
  });
  assert.deepEqual(wild.stars, { min: 0, max: 15 });
  assert.deepEqual(wild.length, { min: 0, max: 3600 });
});

/*
 * Only the mods that are not "allowed" are stored, which is what stops today's mod list from
 * being frozen into a saved filter: a mod osu! adds next year is allowed, like everything else
 * nobody has ruled on.
 */
test('only the mods that are not allowed are written down', () => {
  const coerced = coerceTrackingFilter({
    mods: { DT: 'required', RX: 'excluded', HD: 'allowed', 'bad name': 'required', QQ: 'rubbish' },
  });
  // HD is at its default and QQ's state is not a state, so neither is stored; "bad name" is
  // not an acronym at all. What is left is exactly the two rulings someone actually made.
  assert.deepEqual(coerced.mods, { DT: 'required', RX: 'excluded' });
});

test('an empty mode list is kept, because it is a real answer', () => {
  // "No mode" tracks nothing. The dialog warns loudly; widening it here would misreport what
  // was actually saved.
  assert.deepEqual(coerceTrackingFilter({ modes: [] }).modes, []);
  assert.deepEqual(coerceTrackingFilter({ modes: [9, 'x', 1, 1] }).modes, [1]);
});

test('a date before osu! existed is held to the day osu!’s listing begins', () => {
  const early = coerceTrackingFilter({ added: { from: 0, to: null } });
  assert.equal(early.added.from, Date.UTC(2007, 9, 6));
});

test('dates may be sent as strings, which is what a date field posts', () => {
  const typed = coerceTrackingFilter({ ranked: { from: '2020-01-01T00:00:00.000Z', to: '' } });
  assert.equal(typed.ranked.from, Date.UTC(2020, 0, 1));
  assert.equal(typed.ranked.to, null);
});

/* ------------------------------------------------------------------ settings */

test('the filter round-trips through the profile settings store', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-filter-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');

  assert.deepEqual(getSettings(db, profileId).trackingFilter, defaultTrackingFilter());

  const saved = updateSettings(db, profileId, {
    trackingFilter: {
      enabled: true,
      keywords: 'sotarks',
      mods: { HD: 'required' },
      stars: { min: 5, max: 7 },
    },
  }).trackingFilter;
  assert.equal(saved.enabled, true);
  assert.equal(saved.keywords, 'sotarks');
  assert.deepEqual(saved.mods, { HD: 'required' });
  assert.deepEqual(saved.stars, { min: 5, max: 7 });
  // Everything not mentioned keeps its default rather than disappearing.
  assert.deepEqual(saved.modes, [0, 1, 2, 3]);
  assert.equal(saved.submitted.includeUnknown, true);

  // And it survives being read back out, which is the case a fresh app start hits.
  assert.deepEqual(getSettings(db, profileId).trackingFilter, saved);

  // Settings are per profile: two playstyles may filter differently.
  const second = getOrCreateProfile(db, 'Second');
  assert.equal(getSettings(db, second).trackingFilter.enabled, false);

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* --------------------------------------------------------------------- facts */

const OSU_FILE = `osu file format v14

[General]
Mode: 0

[Metadata]
Title:Dreamin Attraction!!
Artist:Yooh
Creator:Sotarks
Version:Extra
BeatmapID:100
BeatmapSetID:10

[HitObjects]
256,192,1000,1,0,0:0:0:0:
256,192,61000,1,0,0:0:0:0:
`;

function factsHarness(): { db: Db; resolver: BeatmapResolver; file: string; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-facts-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const file = path.join(tmp, 'map.osu');
  fs.writeFileSync(file, OSU_FILE);
  return {
    db,
    resolver: new BeatmapResolver(db, []),
    file,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('the beatmap facts are read once and remembered on the row', () => {
  const h = factsHarness();
  h.db.prepare(
    'INSERT INTO osu_files (path, md5, size, indexed_at) VALUES (?, ?, ?, ?)',
  ).run(h.file, 'abc', 1, Date.now());
  const beatmap = h.resolver.resolve('abc');

  const read = beatmapFilterFacts(h.db, h.resolver, beatmap);
  assert.equal(read.lengthMs, 60_000);
  assert.equal(read.text, 'Yooh Dreamin Attraction!! Extra Sotarks');
  // The file's creation time, not the beatmap's own age -- see the module's header.
  assert.ok(read.addedAt !== null && Math.abs(read.addedAt - Date.now()) < 60_000);
  // Nothing on this machine can date a set that online.db has never heard of.
  assert.equal(read.submittedAt, null);
  assert.equal(read.rankedAt, null);

  const row = h.db.prepare('SELECT length_ms, added_at, submitted_at, ranked_at FROM beatmaps WHERE md5 = ?').get('abc') as
    Record<string, number>;
  assert.equal(row['length_ms'], 60_000);
  assert.ok(row['added_at']! > 0);
  // 0, not NULL: looked up, and there is nothing there. It must not be looked up again.
  assert.equal(row['submitted_at'], 0);
  assert.equal(row['ranked_at'], 0);

  // A file that has since gone is still answered from the row rather than re-read.
  fs.rmSync(h.file);
  assert.equal(beatmapFilterFacts(h.db, h.resolver, beatmap).lengthMs, 60_000);

  h.cleanup();
});

test('a beatmap with no local file has no facts, and no facts rejects nothing', () => {
  const h = factsHarness();
  const beatmap = h.resolver.resolve('nothing-here');
  const read = beatmapFilterFacts(h.db, h.resolver, beatmap);
  assert.equal(read.lengthMs, null);
  assert.equal(read.addedAt, null);
  assert.equal(read.status, UNRESOLVED_STATUS);

  const strict = filter({
    length: { min: 60, max: 120 },
    added: { from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 0, 2) },
    categories: ['unsubmitted'],
  });
  assert.equal(filterRejects(strict, playFacts(read, 0, [])), null);
  h.cleanup();
});

/* ------------------------------------------------------- an unfinished play */

test('an unfinished play is judged on the seven criteria that can judge it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-filter-quit-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  const resolver = new BeatmapResolver(db, []);
  const file = path.join(tmp, 'map.osu');
  fs.writeFileSync(file, OSU_FILE);
  db.prepare('INSERT INTO osu_files (path, md5, size, indexed_at) VALUES (?, ?, ?, ?)').run(
    file,
    'quit-md5',
    1,
    Date.now(),
  );
  resolver.resolve('quit-md5');

  const play: ResolvedLoggedPlay = {
    token: 'token-1',
    beatmapId: null,
    beatmapName: 'Yooh - Dreamin Attraction!! (Sotarks) [Extra]',
    countedAt: Date.now(),
    startedAt: Date.now() - 20_000,
    onlineScoreId: '1',
    passed: false,
  };

  // A mods criterion it cannot possibly judge does not turn it away: osu! counted this play,
  // so the profile has to as well, or its play count stops agreeing with the website's.
  const modded = ingestIncompletePlay(play, {
    db,
    resolver,
    profileId,
    trackingSince: 0,
    filter: filter({ mods: { DT: 'required' } }),
  });
  assert.equal(modded.status, 'added');

  // A criterion it *can* be judged on does.
  const elsewhere = ingestIncompletePlay(
    { ...play, token: 'token-2' },
    {
      db,
      resolver,
      profileId,
      trackingSince: 0,
      filter: filter({ keywords: 'something else entirely' }),
    },
  );
  assert.equal(elsewhere.status, 'filtered');
  assert.equal(elsewhere.status === 'filtered' && elsewhere.criterion, 'keywords');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM incomplete_plays').get() as { n: number }).n,
    1,
    'a filtered play must leave no row at all',
  );

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- the page */

/*
 * The page's two connections to the filter, both of which exist only because a declined play
 * leaves nothing behind: `/api/state` says whether a filter is narrowing anything (the mark on
 * the Options menu) and how many plays it has declined, and a declined play is announced over
 * SSE. Without the announcement a filter set one notch too tight is indistinguishable from
 * tracking having stopped.
 */
test('the page is told that a filter is on, and when one declines a play', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-filter-http-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [],
    profileId,
    trackingSince: 0,
    official: null,
  });
  const server = startServer({
    db,
    tracker,
    installs: [],
    country: '',
    tagline: '',
    dataDir: tmp,
    port: 0,
    appConfig: { get: () => ({ openBrowser: false }), set: () => undefined },
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const state = async () =>
      (await (await fetch(`${base}/api/state`)).json()) as {
        filterNarrowing: boolean;
        playsFiltered: number;
      };

    const before = await state();
    assert.equal(before.filterNarrowing, false);
    assert.equal(before.playsFiltered, 0);

    // On but wide open is not worth a mark on the menu: it has not narrowed anything yet.
    updateSettings(db, profileId, { trackingFilter: { enabled: true } });
    assert.equal((await state()).filterNarrowing, false);

    updateSettings(db, profileId, { trackingFilter: { enabled: true, mods: { DT: 'required' } } });
    assert.equal((await state()).filterNarrowing, true);

    const events = await fetch(`${base}/api/events`);
    const reader = events.body!.getReader();
    const seen = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      // The stream never ends on its own, so this reads until the event it is waiting for.
      for (let i = 0; i < 20; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('event: filtered')) return buffer;
      }
      return buffer;
    })();

    await new Promise((r) => setTimeout(r, 50));
    tracker.emit('filtered', {
      title: 'Artist - Title [Insane]',
      criterion: 'mods',
      kind: 'score',
      at: Date.now(),
    });

    const stream = await seen;
    assert.match(stream, /event: filtered/);
    assert.match(stream, /Artist - Title \[Insane\]/);
    await reader.cancel();
  } finally {
    server.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
