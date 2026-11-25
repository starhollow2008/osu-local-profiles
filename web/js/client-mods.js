/**
 * Mods only another client has, and which of them a mod picker shows.
 *
 * Someone who plays only osu!stable and lazer has no use for McOsu's, neomod's, Torii's or
 * Ritsu's mods, so a picker shows a client's mods only when the app found that client
 * (`clientsWithOwnMods` in `/api/state`, `Torii.ClientsWithOwnMods` in dotnet/App/Clients/Torii.cs),
 * or when Other settings asks for all of them. A mod the saved filter already names is shown
 * either way, so no rule in it is out of sight.
 */
import { MCOSU_DEFINITIONS } from './mcosu-mods.js';
import { NEOMOD_DEFINITIONS } from './neomod-mods.js';
import { TORII_DEFINITIONS, TORII_OWN } from './torii-mods.js';

/** Each client's own mods. Ritsu is built on Torii, so it has Torii's two, and its Miss Challenge is MC. */
export const CLIENT_MODS = {
  mcosu: Object.keys(MCOSU_DEFINITIONS),
  neomod: Object.keys(NEOMOD_DEFINITIONS),
  torii: [...TORII_OWN],
  ritsu: [...Object.keys(TORII_DEFINITIONS), 'MC'],
};

/** Every acronym only another client has. */
export const OTHER_CLIENT_MODS = new Set(Object.values(CLIENT_MODS).flat());

/**
 * The other clients' mods a picker shows: all of them with `all`, otherwise those of the
 * clients found, and any of them in `named`.
 */
export function shownClientMods({ clients = [], all = false, named = [] } = {}) {
  if (all) return new Set(OTHER_CLIENT_MODS);
  return new Set([
    ...clients.flatMap((c) => CLIENT_MODS[c] ?? []),
    ...named.filter((a) => OTHER_CLIENT_MODS.has(a)),
  ]);
}
