/** Types for scripts/truetype.mjs, which `test/truetype.test.ts` exercises. */
declare module '*/truetype.mjs' {
  export function contoursOf(d: string): { x: number; y: number; on: boolean }[][];

  export function buildTrueType(font: {
    family: string;
    copyright: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    glyphs: { codePoint: number; advance: number; d: string }[];
  }): Buffer;
}
