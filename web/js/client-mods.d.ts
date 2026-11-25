/** Types for web/js/client-mods.js. */

export const CLIENT_MODS: Record<'mcosu' | 'neomod' | 'torii' | 'ritsu', string[]>;
export const OTHER_CLIENT_MODS: Set<string>;
export function shownClientMods(options?: { clients?: string[]; all?: boolean; named?: string[] }): Set<string>;
