/** Types for the parts of web/js/badges.js the tests use. */

export interface ModDefinition {
  name: string;
  type: string;
  modes: number[];
  playable: boolean;
  settings: Record<string, string>;
}

export interface Mod {
  acronym: string;
  settings?: Record<string, unknown>;
}

export function modDefinition(acronym: string, client?: string | null): ModDefinition | null;
/** Mods to choose from in osu-web's order: `mode`'s own, or the one for every ruleset at once. */
export function inModOrder(acronyms: string[], mode?: number | null): string[];
export function modPill(mod: Mod | string, options?: { title?: string; client?: string | null }): string;
export function modList(mods: Mod[] | null | undefined, client?: string | null): string;
