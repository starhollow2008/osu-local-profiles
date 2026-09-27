import { createRequire } from 'node:module';

/**
 * Writing `.osr` files, for the replays this app builds rather than reads: a McOsu play's
 * (src/clients/mcosu.ts), and a score imported from its osu! link or entered by hand
 * (src/built-replays.ts).
 *
 * Every one of them is written for the same reason -- osu!'s calculator is handed a replay file
 * and nothing else, so a play with no replay of its own is given one -- and every one is a
 * replay with no frames: the judgements, combo, total and mods osu! prices from, and no cursor
 * data, which pp has never read. That is also why none of them is ever offered for download.
 *
 * The layout is the one src/osr.ts reads, field for field.
 */

const require = createRequire(import.meta.url);
const LZMA = require('lzma-js-simple-v2') as { compress(data: string, mode: number): number[] };

/** .NET ticks at the unix epoch, which is how a replay dates itself. */
const TICKS_AT_EPOCH = 621355968000000000n;

/** osu!stable's six counters, as a replay's header holds them. */
export interface LegacyCounts {
  c300: number;
  c100: number;
  c50: number;
  geki: number;
  katu: number;
  miss: number;
}

export interface ReplayHeader {
  mode: number;
  /** An osu!stable version (2xxxxxxx) or a lazer one (300000xx), which decides how it is read. */
  version: number;
  beatmapMD5: string;
  player: string;
  /** osu!'s hash of the replay. Null for a built one, which is then known by beatmap and time. */
  replayMD5: string | null;
  counts: LegacyCounts;
  totalScore: number;
  maxCombo: number;
  perfect: boolean;
  legacyMods: number;
  /** When the play ended, in unix ms. */
  playedAt: number;
  /** osu!'s id for the score, or 0 for none. */
  onlineId: bigint;
}

class Writer {
  private readonly parts: Buffer[] = [];
  byte(v: number) {
    this.parts.push(Buffer.from([v]));
  }
  short(v: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(Math.max(0, Math.min(v, 0xffff)));
    this.parts.push(b);
  }
  int(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.parts.push(b);
  }
  long(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    this.parts.push(b);
  }
  /** ULEB128-prefixed UTF-8, or a single 0x00 for null. */
  string(s: string | null) {
    if (s === null) return this.byte(0);
    const data = Buffer.from(s, 'utf8');
    const len: number[] = [];
    let n = data.length;
    do {
      let x = n & 0x7f;
      n >>>= 7;
      if (n) x |= 0x80;
      len.push(x);
    } while (n);
    this.parts.push(Buffer.from([0x0b, ...len]), data);
  }
  bytes(b: Buffer) {
    this.parts.push(b);
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

/**
 * A replay with no frames, followed by `tail`: nothing for a stable replay, or lazer's own block
 * then anything of this app's -- see `lazerBlock` and `appBlock`.
 */
export function encodeReplay(h: ReplayHeader, tail: Buffer[] = []): Buffer {
  const w = new Writer();
  w.byte(h.mode);
  w.int(h.version);
  w.string(h.beatmapMD5);
  w.string(h.player);
  w.string(h.replayMD5);
  w.short(h.counts.c300);
  w.short(h.counts.c100);
  w.short(h.counts.c50);
  w.short(h.counts.geki);
  w.short(h.counts.katu);
  w.short(h.counts.miss);
  // stable's field is 32 bits; a total beyond it would be a marathon well past any stable one.
  w.int(Math.min(Math.max(0, Math.round(h.totalScore)), 0x7fffffff));
  w.short(h.maxCombo);
  w.byte(h.perfect ? 1 : 0);
  w.int(h.legacyMods);
  w.string(null); // life bar
  w.long(BigInt(Math.round(h.playedAt)) * 10_000n + TICKS_AT_EPOCH);
  w.int(0); // no frames
  w.long(h.onlineId);
  for (const part of tail) w.bytes(part);
  return w.done();
}

/** lazer's own block after the online id: its length, then the LZMA-compressed JSON. */
export function lazerBlock(json: unknown): Buffer {
  const compressed = Buffer.from(LZMA.compress(JSON.stringify(json), 1));
  const len = Buffer.alloc(4);
  len.writeInt32LE(compressed.length);
  return Buffer.concat([len, compressed]);
}

/** One of this app's blocks: a magic string, the JSON's length, the JSON. osu! never reads it. */
export function appBlock(magic: string, json: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(json), 'utf8');
  const len = Buffer.alloc(4);
  len.writeInt32LE(data.length);
  return Buffer.concat([Buffer.from(magic, 'latin1'), len, data]);
}

/** The JSON of one of this app's blocks at the start of `rest`, or null when it is not there. */
export function readAppBlock(rest: Buffer, magic: string): unknown {
  const tag = Buffer.from(magic, 'latin1');
  if (rest.length < tag.length + 4 || !rest.subarray(0, tag.length).equals(tag)) return null;
  const len = rest.readInt32LE(tag.length);
  const start = tag.length + 4;
  if (len <= 0 || start + len > rest.length) return null;
  try {
    return JSON.parse(rest.toString('utf8', start, start + len)) as unknown;
  } catch {
    return null;
  }
}
