/**
 * Reader for osu! `.osr` replay files.
 *
 * We parse these ourselves rather than using a library because osu!lazer appends an
 * LZMA-compressed JSON block after the replay data (`LegacyReplaySoloScoreInfo`) that
 * carries the *authoritative* mods, statistics and rank. The legacy header alone is
 * misleading for lazer scores -- it reports rank "F" for plays that actually ranked A.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LZMA = require('lzma-js-simple-v2') as {
  decompress(data: number[], cb: (result: string | number[], err?: Error) => void): void;
};

/** Version marker at which lazer began appending the extended score block. */
const LAZER_EXT_MIN_VERSION = 30000001;

/** .NET ticks (100ns since 0001-01-01) -> unix ms. */
const TICKS_EPOCH_OFFSET_MS = 62135596800000;

export type Ruleset = 0 | 1 | 2 | 3;

export interface LazerMod {
  acronym: string;
  /** Present when the player customised the mod (e.g. DT at 1.3x instead of 1.5x). */
  settings?: Record<string, number | boolean | string>;
}

/** The lazer-only JSON block. Field names are lazer's, kept verbatim. */
export interface LazerExtras {
  client_version?: string;
  rank?: string;
  user_id?: number;
  online_id?: number;
  mods?: LazerMod[];
  /** Lazer hit names: great / ok / meh / miss / slider_tail_hit / large_tick_hit / ... */
  statistics?: Record<string, number>;
  maximum_statistics?: Record<string, number>;
  total_score_without_mods?: number;
  pauses?: unknown[];
}

export interface ReplayScore {
  client: 'lazer' | 'stable';
  mode: Ruleset;
  version: number;
  beatmapMD5: string;
  username: string;
  /** osu!'s own hash of the replay -- a natural dedupe key. */
  replayMD5: string | null;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  perfectCombo: boolean;
  /** Legacy mod bitmask. Authoritative for stable; use `extras.mods` for lazer. */
  legacyMods: number;
  playedAt: Date;
  onlineScoreId: bigint | null;
  extras: LazerExtras | null;
}

/**
 * Cheap signature check. lazer's file store holds ~63k files of every kind under
 * hash-named paths with no extension, so the watcher needs to reject non-replays from
 * just the first few bytes.
 */
export function looksLikeReplay(head: Uint8Array): boolean {
  if (head.length < 5) return false;
  const mode = head[0]!;
  if (mode > 3) return false;
  const version = Buffer.from(head.buffer, head.byteOffset, 5).readInt32LE(1);
  // Stable versions look like 20210520; lazer uses 300000xx.
  return version >= 20000000 && version <= 40000000;
}

class Cursor {
  private o = 0;
  private readonly b: Buffer;
  constructor(b: Buffer) { this.b = b; }
  get offset() { return this.o; }
  get remaining() { return this.b.length - this.o; }
  byte() { return this.b[this.o++]!; }
  short() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  int() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  long() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  skip(n: number) { this.o += n; }
  slice(n: number) { const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  /** ULEB128-prefixed UTF-8 string; a leading 0x00 means null. */
  string(): string | null {
    if (this.b[this.o++] === 0x00) return null;
    let shift = 0, len = 0, byte: number;
    do { byte = this.b[this.o++]!; len |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    const s = this.b.subarray(this.o, this.o + len).toString('utf8');
    this.o += len;
    return s;
  }
}

function inflateLzma(block: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    LZMA.decompress([...block], (result, err) => {
      if (err) return reject(err);
      resolve(typeof result === 'string' ? result : Buffer.from(result).toString('utf8'));
    });
  });
}

/**
 * Parse a replay. Replay *frames* are skipped entirely -- pp needs only the score
 * summary, and the frame stream is the bulk of the file.
 */
export async function parseReplay(buf: Buffer): Promise<ReplayScore> {
  const c = new Cursor(buf);

  const mode = c.byte() as Ruleset;
  const version = c.int();
  const beatmapMD5 = c.string() ?? '';
  const username = c.string() ?? '';
  const replayMD5 = c.string();

  const count300 = c.short(), count100 = c.short(), count50 = c.short();
  const countGeki = c.short(), countKatu = c.short(), countMiss = c.short();

  const totalScore = c.int();
  const maxCombo = c.short();
  const perfectCombo = c.byte() !== 0;
  const legacyMods = c.int();

  c.string();                       // life bar graph
  const ticks = c.long();           // .NET ticks
  const frameLength = c.int();
  c.skip(frameLength);

  let onlineScoreId: bigint | null = null;
  let extras: LazerExtras | null = null;

  if (c.remaining >= 8) {
    onlineScoreId = c.long();
    if (version >= LAZER_EXT_MIN_VERSION && c.remaining >= 4) {
      const len = c.int();
      if (len > 0 && len <= c.remaining) {
        try {
          extras = JSON.parse(await inflateLzma(Buffer.from(c.slice(len)))) as LazerExtras;
        } catch {
          extras = null;   // corrupt or unknown block: fall back to legacy fields
        }
      }
    }
  }

  return {
    client: version >= LAZER_EXT_MIN_VERSION ? 'lazer' : 'stable',
    mode, version, beatmapMD5, username, replayMD5,
    count300, count100, count50, countGeki, countKatu, countMiss,
    totalScore, maxCombo, perfectCombo, legacyMods,
    playedAt: new Date(Number(ticks / 10000n) - TICKS_EPOCH_OFFSET_MS),
    onlineScoreId: onlineScoreId === -1n ? null : onlineScoreId,
    extras,
  };
}
