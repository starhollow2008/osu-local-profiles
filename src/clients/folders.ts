import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { OsuFolders } from '../http/server.ts';
import { classify, discoverInstalls, type DiscoveryResult } from './discover.ts';
import type { OsuInstall } from './detect.ts';

/**
 * The page's answer to "it did not find my osu! folder".
 *
 * Auto-detection is as good as it can be made -- the registry, lazer's `storage.ini`, the
 * Start Menu, and a walk of every drive -- and it will still miss sometimes, because osu!
 * goes wherever the player put it and a folder can be on a disk that was not mounted at the
 * time. The only certain fix is being *told*, and the place to tell it has to be the page:
 * the person who needs this is the one for whom the app did not work, and "edit this JSON
 * file and restart" is not a repair anyone should have to perform.
 *
 * Three verbs, and they are deliberately not symmetrical:
 *
 * - **add** writes to `installRoots`, which is the user speaking and is never overruled.
 * - **remove** takes a root *out of* `installRoots`, and can do nothing else. A folder the
 *   app found by itself cannot be removed, only outranked by one that was added -- there is
 *   nowhere to write "not this one" that a fresh search would not simply undo.
 * - **rescan** throws away what was remembered and searches from scratch.
 *
 * Nothing here restarts anything. The install list decides what the watchers watch and what
 * the beatmap resolver has open, both built once at startup, so a change takes effect on the
 * next start and `needsRestart` says so plainly rather than the page pretending otherwise.
 */
export interface FolderDeps {
  config: Config;
  save: (config: Config) => void;
  /** The installs the tracker is actually using, fixed for the life of the process. */
  tracking: readonly OsuInstall[];
  /** What startup found, so the first `list()` needs no work. */
  initial: DiscoveryResult;
}

export interface FolderService {
  list(): OsuFolders;
  add(root: string): Promise<OsuFolders>;
  remove(root: string): OsuFolders;
  rescan(): Promise<OsuFolders>;
}

/** Same folder, written two ways. Windows is case-insensitive; trailing slashes are noise. */
function sameRoot(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

export function osuFolderService(deps: FolderDeps): FolderService {
  let discovery = deps.initial;

  const view = (): OsuFolders => {
    const configured = deps.config.installRoots;
    /*
     * "Active" means the tracker is using it *now*, not that it would be chosen on a
     * restart. Those differ the moment a folder is added, and conflating them would show a
     * tick beside a folder holding no scores yet.
     */
    const candidates = discovery.candidates.map((c) => ({
      root: c.root,
      kind: c.kind,
      configured: configured.some((r) => sameRoot(r, c.root)),
      active: deps.tracking.some((i) => sameRoot(i.root, c.root)),
    }));

    const wouldTrack = discovery.installs.map((i) => i.root);
    const needsRestart =
      wouldTrack.length !== deps.tracking.length ||
      !wouldTrack.every((root) => deps.tracking.some((i) => sameRoot(i.root, root)));

    return {
      candidates,
      tracking: deps.tracking.map((i) => ({ root: i.root, kind: i.kind })),
      searched: deps.config.searchedForInstalls,
      needsRestart,
    };
  };

  /** Re-run discovery over the current config, without searching unless asked. */
  const refresh = async (force: boolean): Promise<OsuFolders> => {
    discovery = await discoverInstalls({
      configured: deps.config.installRoots,
      remembered: force ? [] : deps.config.discoveredRoots,
      force,
      noSearch: !force && deps.config.searchedForInstalls,
    });
    deps.config.discoveredRoots = discovery.candidates
      .filter((c) => c.source !== 'configured')
      .map((c) => c.root);
    if (discovery.searched) deps.config.searchedForInstalls = true;
    deps.save(deps.config);
    return view();
  };

  return {
    list: view,

    async add(input: string): Promise<OsuFolders> {
      /*
       * Everything that can be wrong here is worth its own sentence. This is the endpoint
       * somebody reaches after the app has already failed them once, and "invalid path" at
       * that point is an insult rather than a message.
       */
      const root = path.resolve(input.replace(/^["']|["']$/g, '').trim());
      let stat: fs.Stats;
      try {
        stat = fs.statSync(root);
      } catch {
        throw new Error(`There is no folder at ${root}.`);
      }
      if (!stat.isDirectory()) throw new Error(`${root} is a file, not a folder.`);

      if (!classify(root)) {
        /*
         * The commonest mistake by a distance: picking the folder *above* the install,
         * because that is the one called "osu!" in Explorer. Say which folder to pick rather
         * than making them guess a second time.
         */
        const inside: string[] = [];
        try {
          for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.isDirectory() && classify(path.join(root, entry.name))) {
              inside.push(path.join(root, entry.name));
            }
          }
        } catch {
          /* unreadable: the plain message below is still right */
        }
        if (inside.length > 0) {
          throw new Error(
            `${root} is not an osu! folder itself, but it contains ${inside.length === 1 ? 'one' : `${inside.length}`}: ` +
              `${inside.slice(0, 3).join(', ')}`,
          );
        }
        throw new Error(
          `${root} does not look like an osu! install -- an osu!stable folder has osu!.exe ` +
            'in it, an osu!lazer folder has client.realm, and a McOsu folder has McEngine.exe.',
        );
      }

      if (!deps.config.installRoots.some((r) => sameRoot(r, root))) {
        // Newest first: a folder added now is the one being asked for, so it outranks one
        // added last month if both are the same client.
        deps.config.installRoots = [root, ...deps.config.installRoots];
      }
      return refresh(false);
    },

    remove(root: string): OsuFolders {
      deps.config.installRoots = deps.config.installRoots.filter((r) => !sameRoot(r, root));
      // Dropped from the remembered list too, or a folder removed by hand comes straight
      // back as something the app "found".
      deps.config.discoveredRoots = deps.config.discoveredRoots.filter((r) => !sameRoot(r, root));
      deps.save(deps.config);
      discovery = {
        ...discovery,
        candidates: discovery.candidates.filter((c) => !sameRoot(c.root, root)),
        installs: discovery.installs.filter((i) => !sameRoot(i.root, root)),
      };
      return view();
    },

    rescan(): Promise<OsuFolders> {
      return refresh(true);
    },
  };
}
