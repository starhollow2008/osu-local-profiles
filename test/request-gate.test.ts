import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAUSE_MS, MAX_PAUSE_MS, RequestGate, retryAfterMs } from '../src/clients/request-gate.ts';

/*
 * osu! asks for at most 60 requests a minute. Every request the app makes to an osu! domain
 * waits its turn at one gate (roadmap 5.78), so these are about the turns: a second apart, in
 * order, and all held back when osu! says to slow down. The clock is fake, so nothing sleeps.
 */

function fakeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('requests start a second apart, in the order asked', async () => {
  const clock = fakeClock();
  const gate = new RequestGate(1000, clock.now, clock.sleep);
  const started: [string, number][] = [];
  const ask = (name: string) => gate.run(async () => started.push([name, clock.now()]));

  await Promise.all([ask('a'), ask('b'), ask('c')]);
  assert.deepEqual(
    started.map(([name, at]) => [name, at - started[0]![1]]),
    [
      ['a', 0],
      ['b', 1000],
      ['c', 2000],
    ],
  );

  // A request after a quiet spell does not wait at all.
  clock.advance(10_000);
  const before = clock.now();
  await ask('d');
  assert.equal(started.at(-1)![1], before);
});

test('a failed request does not stop the ones after it', async () => {
  const clock = fakeClock();
  const gate = new RequestGate(1000, clock.now, clock.sleep);
  await assert.rejects(gate.run(async () => { throw new Error('offline'); }));
  assert.equal(await gate.run(async () => 'next'), 'next');
});

test('told to slow down, every request still to come waits', async () => {
  const clock = fakeClock();
  const gate = new RequestGate(1000, clock.now, clock.sleep);
  await gate.run(async () => {});
  gate.pauseFor(30_000);
  const asked = clock.now();
  let at = 0;
  await gate.run(async () => {
    at = clock.now();
  });
  assert.equal(at - asked, 30_000);
});

test("Retry-After is read in seconds or as a date, and held to sensible bounds", () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(retryAfterMs('20', now), 20_000);
  assert.equal(retryAfterMs('Mon, 19 Oct 2026 12:00:45 GMT', now), 45_000);
  assert.equal(retryAfterMs('0', now), 1000, 'never sooner than a second');
  assert.equal(retryAfterMs('86400', now), MAX_PAUSE_MS, 'never longer than five minutes');
  assert.equal(retryAfterMs(null, now), DEFAULT_PAUSE_MS);
  assert.equal(retryAfterMs('soon', now), DEFAULT_PAUSE_MS);
});

/*
 * The real path, with fetch stubbed: nothing here reaches osu!. The gate is the real one, so
 * each request after the first waits its second -- a few seconds in all.
 */
test('the favourites import has no cap, ends on a page with nothing new, and waits out a 429', async (t) => {
  const { fetchFavouriteBeatmapsets } = await import('../src/clients/osu-web.ts');
  const set = (id: number) => ({ id, title: `t${id}`, artist: 'a', status: 'ranked', beatmaps: [] });
  const asked: string[] = [];
  let slowedDown = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    asked.push(url);
    const offset = Number(new URL(url).searchParams.get('offset'));
    if (offset === 100 && !slowedDown) {
      slowedDown = true;
      return new Response('', { status: 429, headers: { 'retry-after': '1' } });
    }
    // Two pages of a hundred, then osu! repeating the last one rather than ending.
    const page = offset >= 200 ? 100 : offset;
    return Response.json(Array.from({ length: 100 }, (_, i) => set(page + i + 1)));
  });

  const progress: number[] = [];
  const sets = await fetchFavouriteBeatmapsets(42, (read) => progress.push(read));
  assert.equal(sets.length, 200);
  assert.deepEqual(progress, [100, 200, 200]);
  assert.equal(asked.length, 4, 'page 1, a 429, page 2 again, and the repeat that ends it');
});
