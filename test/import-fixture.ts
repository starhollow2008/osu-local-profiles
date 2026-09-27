import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { BeatmapResolver, indexBeatmapFiles } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';

/*
 * An osu! install made of nothing but what a test writes: one beatmap, a lazer log, and replays
 * built here. For tests of Import past plays and of what it turns away, which need real files to
 * scan rather than whatever osu! happens to have on this machine -- so they run everywhere and
 * never touch it.
 */

export const MAP = 'Reji - Shoujo wa Yoru to Azayaka ni (ADoorNob) [Vivid Collab]';
export const SESSION = '1788778412';
export const SINCE = Date.UTC(2026, 8, 7);

const OSU_FILE = [
  'osu file format v14',
  '',
  '[General]',
  'Mode: 0',
  '',
  '[Metadata]',
  'Title:Shoujo wa Yoru to Azayaka ni',
  'Artist:Reji',
  'Creator:ADoorNob',
  'Version:Vivid Collab',
  'BeatmapID:4000001',
  'BeatmapSetID:2000001',
  '',
  '[HitObjects]',
  '256,192,1000,1,0,0:0:0:0:',
  '256,192,31000,1,0,0:0:0:0:',
  '',
].join('\r\n');
export const MD5 = crypto.createHash('md5').update(OSU_FILE).digest('hex');

/** A lazer runtime log line at a UTC time on 2026-09-07. */
const line = (time: string, text: string) => `2026-09-07 ${time} [verbose]: ${text}`;

/** One attempt osu! could not submit, on the map above, ending at `ended` (HH:MM:SS, UTC). */
export function attemptLog(n: number, started: string, ended: string): string {
  return [
    line(started, `Game-wide working beatmap updated to ${MAP}`),
    line(started, `📺 OsuScreenStack#658(depth:6) entered SoloPlayer#${n}`),
    line(ended, 'No token, skipping score submission'),
    line(ended, `📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#${n}`),
  ].join('\n');
}

/** .NET ticks at the unix epoch, which is how osu!stable dates a replay. */
const TICKS_AT_EPOCH = 621355968000000000n;

/** An osu!stable replay with no frames: enough for everything but pp, which needs no helper here. */
export function stableReplay(o: {
  player: string;
  playedAt: number;
  onlineId?: bigint;
  total?: number;
  hash?: string;
}): Buffer {
  const parts: Buffer[] = [];
  const byte = (v: number) => parts.push(Buffer.from([v]));
  const short = (v: number) => parts.push(Buffer.from(new Int16Array([v]).buffer));
  const int = (v: number) => parts.push(Buffer.from(new Int32Array([v]).buffer));
  const long = (v: bigint) => parts.push(Buffer.from(new BigInt64Array([v]).buffer));
  const string = (s: string) => {
    const d = Buffer.from(s, 'utf8');
    parts.push(Buffer.from([0x0b, d.length]), d);
  };
  byte(0);
  int(20230504);
  string(MD5);
  string(o.player);
  string(o.hash ?? crypto.randomBytes(16).toString('hex'));
  for (const c of [2, 0, 0, 0, 0, 0]) short(c);
  int(o.total ?? 1_000_000);
  short(2);
  byte(1);
  int(0);
  byte(0); // no life bar
  long(BigInt(o.playedAt) * 10_000n + TICKS_AT_EPOCH);
  int(0); // no frames
  long(o.onlineId ?? 0n);
  return Buffer.concat(parts);
}

export interface Harness {
  db: Db;
  profileId: number;
  tracker: Tracker;
  replays: string;
  write: (name: string, buf: Buffer) => string;
  count: (table: string) => number;
  cleanup: () => void;
}

/**
 * The install, signed in as Tangy, with `runtime` as its one session log -- by default a single
 * attempt osu! could not submit, ending 10:54:47.
 */
export async function harness(runtime = attemptLog(109, '10:54:10', '10:54:47')): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-import-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Import Test');

  const files = path.join(tmp, 'files');
  fs.mkdirSync(files);
  fs.writeFileSync(path.join(files, 'reji'), OSU_FILE);
  await indexBeatmapFiles(db, [{ path: files, byExtension: false }]);

  // A lazer install rooted here, signed in as Tangy, so its logs and its owner are this test's.
  fs.writeFileSync(path.join(tmp, 'game.ini'), 'Username = Tangy\n');
  const logs = path.join(tmp, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, `${SESSION}.runtime.log`), `${runtime}\n`);
  const replays = path.join(tmp, 'replays');
  fs.mkdirSync(replays);

  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [{ kind: 'lazer', root: tmp, replayDir: replays, beatmapRoots: [files], onlineDb: null }],
    profileId,
    // In the future: nothing may arrive by the live path, so anything stored came from here.
    trackingSince: Date.now() + 3_600_000,
    official: null,
  });

  return {
    db,
    profileId,
    tracker,
    replays,
    write: (name, buf) => {
      const file = path.join(replays, name);
      fs.writeFileSync(file, buf);
      return file;
    },
    count: (table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
