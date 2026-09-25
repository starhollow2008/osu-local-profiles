/** Types for the generated pp parity corpus, which `test/pp-parity-corpus.test.ts` reaches into. */
declare module '*/pp-parity-corpus.mjs' {
  export interface ParityCorpus {
    /** Every generated replay, with the beatmap it was set on. */
    replays: { file: string; beatmap: string }[];
    /** The generated beatmaps of each ruleset, by osu!'s ruleset id. */
    maps: Record<0 | 1 | 2 | 3, { file: string; md5: string }[]>;
  }

  /** Write the corpus into `dir`, the same on every machine, and describe it. */
  export function generateCorpus(dir: string): ParityCorpus;

  /** An osu!stable replay header with no frames. */
  export function stableReplay(mode: number, md5: string, mods: number): Buffer;

  /** A lazer replay with the LZMA block of mods, settings and statistics lazer appends. */
  export function lazerReplay(
    mode: number,
    md5: string,
    mods: { acronym: string; settings?: Record<string, unknown> }[],
  ): Buffer;
}
