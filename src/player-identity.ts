import type { Db } from './db/index.ts';
import type { ReplayScore } from './osr.ts';
import type { OsuInstall } from './clients/detect.ts';
import { detectLocalSessions } from './clients/session.ts';
import { getSettings } from './settings.ts';

/**
 * Whose play a replay actually is.
 *
 * osu! keeps the replays you *watch* in the same places it keeps the ones you set. Stable
 * caches a downloaded leaderboard replay in `Data/r` beside your own; lazer imports one into
 * the same content-addressed store. Nothing about where the file sits says who played it --
 * which is how a profile ends up holding mrekk's 1,857pp Crystalia play. Measured on this
 * machine's corpus: 2,411 replays under the owner's name, 88 under 62 other players'.
 *
 * The name is written inside the replay, so the question is only ever "is this name mine?".
 * Getting that wrong in the other direction is far worse than the bug it fixes -- a play
 * silently refused is a play lost -- so everything here fails towards *yours*:
 *
 * - **A replay with no name is always yours.** osu!stable writes an empty name for a play
 *   made signed out; three of them are in this corpus. Nobody downloads an anonymous replay.
 * - **lazer's `Guest` is always yours.** That is what lazer calls the local user when it is
 *   not signed in, and an offline play is the case this whole app exists to catch.
 * - **A name you used to have is yours.** osu! publishes `previous_usernames`, and a stable
 *   replay carries no user id at all -- only the name that was current when it was set -- so
 *   without that list every play from before a rename would look like a stranger's. The
 *   account this was built on has two.
 * - **Not knowing means not filtering.** A profile that cannot say who it belongs to tracks
 *   everything, exactly as it always has.
 * - **Who you are is who osu! says is signed in here**, not an account linked for its
 *   pictures -- see `resolveIdentity`.
 *
 * A lazer replay also carries a numeric `user_id`, which settles it outright when both sides
 * have one: ids do not change when a name does.
 */

/** lazer's name for the local user when nobody is signed in. Never a downloaded replay. */
const GUEST_NAME = 'guest';

/**
 * Where the answer came from, so the app can say how sure it is.
 *
 * - `signed-in`: the account osu! itself says is signed in on this machine.
 * - `linked`: the same, confirmed by an osu! account linked to the profile -- which then adds
 *   its user id and previous usernames. A link to anyone *else* decides nothing: see
 *   `resolveIdentity`.
 * - `tracked-plays`: nobody is signed in, so the name behind most of the profile's own plays.
 * - `unknown`: none of those, so nothing is refused.
 */
export type IdentitySource = 'linked' | 'signed-in' | 'tracked-plays' | 'unknown';

export interface PlayerIdentity {
  /** osu!'s numeric id, when it is known. Only lazer replays can be matched against it. */
  userId: number | null;
  /** Every name that counts as this profile's, lowercased. Empty means nothing is known. */
  names: Set<string>;
  /** The owner's name as it is written, for saying so on screen. */
  displayName: string;
  /**
   * Whether `names` is osu!'s complete list, previous usernames included.
   *
   * False whenever a name could be missing: an account linked before this app asked osu! for
   * previous usernames, a name read from osu!stable's config, one inferred from the plays
   * already tracked. A play can still be refused on an incomplete list -- a play arriving now
   * carries the name you have now -- but nothing may be *removed* on one, because a play set
   * before a rename would be indistinguishable from a stranger's.
   */
  namesComplete: boolean;
  source: IdentitySource;
}

export const UNKNOWN_IDENTITY: PlayerIdentity = {
  userId: null,
  names: new Set(),
  displayName: '',
  namesComplete: false,
  source: 'unknown',
};

/** Whether this identity can actually turn a replay away. */
export function identityKnown(identity: PlayerIdentity): boolean {
  return identity.userId !== null || identity.names.size > 0;
}

/**
 * The name most of this profile's own tracked plays were set under.
 *
 * The last resort, for when no client says who is signed in -- lazer only remembers the name
 * with "remember username" on, and stable only with its own. It reads the profile's own rows
 * rather than the store, so it
 * costs one indexed query rather than a walk of 63,000 files, and it only answers when one
 * name is behind at least four fifths of the plays. Below that there is no clear owner and
 * it says so, because a profile with two players' replays in it is the very thing being
 * fixed and must not be resolved by majority vote alone.
 *
 * McOsu's plays are left out. McOsu's name is whatever its `name` setting says -- `Guest`
 * until changed -- and says nothing about who plays osu!, so an evening of McOsu must not
 * decide whose osu! replays these are.
 */
export function dominantTrackedName(
  db: Db,
  profileId: number,
): { name: string; userId: number | null } | null {
  const rows = db
    .prepare(
      `SELECT player_name AS name, player_id AS id, COUNT(*) AS n
         FROM scores
        WHERE profile_id = ? AND player_name IS NOT NULL AND player_name <> '' AND client <> 'mcosu'
        GROUP BY LOWER(player_name)
        ORDER BY n DESC`,
    )
    .all(profileId) as { name: string; id: number | null; n: number }[];
  if (rows.length === 0) return null;

  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const top = rows[0]!;
  // A handful of plays is not evidence of anything.
  if (total < 10 || top.n / total < 0.8) return null;
  return { name: top.name, userId: top.id };
}

/**
 * Who this profile's plays belong to: whoever osu! says is signed in on this machine, else
 * the name behind the profile's own tracked plays, else nobody in particular.
 *
 * **Signed in** is read from each client's own config (`detectLocalSessions`): lazer's
 * `game.ini` and stable's `osu!.<user>.cfg`, both `Username = ...`, both written by the game.
 * With both clients signed in as different accounts, both are yours.
 *
 * **A linked osu! account decides nothing by itself.** It is how a profile borrows a name,
 * avatar, banner and the rest -- and people link someone else's for exactly that: an alt, a
 * friend, a player whose banner they like. When a link also meant "these are that account's
 * plays", every play of your own osu! had submitted was refused as a stranger's, while your
 * fails (read from lazer's log, which names nobody) were kept. So a link counts only when it
 * *is* the account signed in here -- its name or a previous name matches -- and then it adds
 * what the configs cannot: osu!'s list of previous usernames, and the numeric id.
 *
 * The id only when every signed-in client is that account. An id settles a play outright,
 * whatever its name, which would refuse the lazer plays of a second account signed in on the
 * other client; with the id left out those are matched by name.
 */
export function resolveIdentity(
  db: Db,
  profileId: number,
  installs: readonly OsuInstall[],
): PlayerIdentity {
  const signedIn = detectLocalSessions(installs).map((s) => s.username);
  if (signedIn.length > 0) {
    const names = new Set(signedIn.map((name) => name.toLowerCase()));
    const settings = getSettings(db, profileId);
    const linkedNames = [settings.linkedUsername, ...settings.linkedPreviousNames]
      .filter((name) => name !== '')
      .map((name) => name.toLowerCase());
    if (linkedNames.some((name) => names.has(name))) {
      const allTheLinkedAccount = [...names].every((name) => linkedNames.includes(name));
      return {
        userId: allTheLinkedAccount && settings.linkedUserId > 0 ? settings.linkedUserId : null,
        names: new Set([...names, ...linkedNames]),
        displayName: settings.linkedUsername,
        namesComplete: settings.linkedNamesKnown,
        source: 'linked',
      };
    }
    return {
      userId: null,
      names,
      displayName: signedIn[0]!,
      namesComplete: false,
      source: 'signed-in',
    };
  }

  const tracked = dominantTrackedName(db, profileId);
  if (tracked !== null) {
    return {
      userId: tracked.userId,
      names: new Set([tracked.name.toLowerCase()]),
      displayName: tracked.name,
      namesComplete: false,
      source: 'tracked-plays',
    };
  }

  return UNKNOWN_IDENTITY;
}

/** What a replay says about who set it. Split out so it can be read off a stored row too. */
export interface ReplayPlayer {
  /** The name written in the replay. Empty when osu! recorded none. */
  name: string;
  /** lazer's numeric user id. Null on every osu!stable replay -- it records none. */
  userId: number | null;
  /**
   * osu!'s own id for the score, when osu! ever accepted it. Null for a play that was never
   * submitted -- offline, signed out, or on a beatmap osu! does not rank.
   *
   * This is what makes a custom offline name safe. osu!stable lets anyone put
   * `Username = Cat` in its config and play, and the replay then says `Cat` -- a name that
   * may even belong to a real player. But a replay you *downloaded* is by definition a score
   * osu! accepted and put on a leaderboard, so it always carries one of these. A replay with
   * none was never on a leaderboard, so it cannot have been downloaded, so it was set on this
   * machine. Measured across a real corpus: all 91 replays set by other players carried an
   * id, and 258 of the owner's own -- 164 stable and 94 lazer -- did not.
   */
  onlineId: number | null;
}

/**
 * The id osu! gave the score, from wherever this replay keeps it.
 *
 * lazer writes the legacy header field as 0 and puts the real one in its own block, so
 * reading only the header would call every lazer play unsubmitted.
 */
function onlineIdOf(score: ReplayScore): number | null {
  const lazer = score.extras?.online_id;
  if (typeof lazer === 'number' && lazer > 0) return lazer;
  const legacy = score.onlineScoreId === null ? 0 : Number(score.onlineScoreId);
  return legacy > 0 ? legacy : null;
}

export function replayPlayer(score: ReplayScore): ReplayPlayer {
  const userId = score.extras?.user_id;
  return {
    name: score.username ?? '',
    userId: typeof userId === 'number' && userId > 0 ? userId : null,
    onlineId: onlineIdOf(score),
  };
}

/** Whether osu! ever accepted this play, which is what a downloaded replay always proves. */
export function wasSubmitted(player: ReplayPlayer): boolean {
  return player.onlineId !== null;
}

/**
 * Is this play the profile's own?
 *
 * `null` means there is not enough to say, which every caller treats as yours -- see the
 * module note. Only `false` is a refusal, and it is only ever returned on positive evidence
 * that someone else set the play.
 */
export function ownsPlay(identity: PlayerIdentity, player: ReplayPlayer): boolean | null {
  if (!identityKnown(identity)) return null;

  const name = player.name.trim();
  // A play osu! recorded no name for, or one lazer set while signed out. Nobody downloads
  // either, and an offline play is exactly what this app is for.
  if (name === '' || name.toLowerCase() === GUEST_NAME) return true;

  /*
   * A play osu! never accepted cannot have been downloaded from osu!, because there was no
   * leaderboard entry to download -- so whatever name it carries, it was set here.
   *
   * This is what lets osu!stable's configurable name be anything at all. Set `Username = Cat`
   * and play offline and the replay says `Cat`, which may even be a real player's name; it is
   * still yours, and refusing it would throw away exactly the offline plays this app exists
   * to catch. A downloaded replay of the real Cat carries an id and is refused as it should
   * be.
   */
  if (!wasSubmitted(player)) return true;

  // Ids settle it outright, and survive a rename where a name cannot.
  if (identity.userId !== null && player.userId !== null) {
    return identity.userId === player.userId;
  }

  if (identity.names.size === 0) return null;
  return identity.names.has(name.toLowerCase());
}

/**
 * Whether a stored score is certainly someone else's, for the one-off clean-up.
 *
 * Deliberately stricter than `ownsPlay`. That decides what to track from here on, where the
 * cost of a wrong refusal is one play the user can import again. This decides what to take
 * out of a profile that already has it, so it answers true only on a **linked** identity --
 * the one source that carries osu!'s own list of previous usernames, without which a rename
 * is indistinguishable from a stranger.
 */
export function certainlySomeoneElse(identity: PlayerIdentity, player: ReplayPlayer): boolean {
  // A linked account, *and* osu!'s complete list of names for it. Without both, a play set
  // before a rename cannot be told from a stranger's -- and this is the one path that takes
  // a play out of a profile that already has it.
  if (identity.source !== 'linked' || !identity.namesComplete) return false;
  // Never submitted, so never downloaded, so set on this machine -- whatever it calls itself.
  if (!wasSubmitted(player)) return false;
  // An id settles it whatever the names say, and cannot go stale across a rename.
  if (identity.userId !== null && player.userId !== null) {
    return identity.userId !== player.userId;
  }
  return ownsPlay(identity, player) === false;
}

/** What a sweep of a profile's existing scores found. */
export interface ForeignScoreSweep {
  /** Rows examined: this profile's own tracked scores that are still showing. */
  checked: number;
  hidden: number;
  byPlayer: { name: string; count: number }[];
  /**
   * Rows that could not be attributed -- tracked before the name was recorded, and their
   * replay is no longer on disk to ask. Left exactly as they are.
   */
  unattributable: number;
}

/**
 * Take the plays somebody else set out of a profile that already has them, once.
 *
 * Every removal here is a **hide**, the same one the `···` menu performs: the row stays, it
 * appears under Removed scores, and it can be put back with one click. That is what makes
 * doing this without asking defensible -- nothing is destroyed, and a mistake is visible and
 * reversible rather than silent and permanent.
 *
 * It only ever runs against a **linked** identity (`certainlySomeoneElse`), because only a
 * linked account brings osu!'s own list of previous usernames -- and without that list a play
 * you set before renaming looks exactly like a stranger's. A signed-out play, which carries
 * no name at all, and a lazer `Guest` play are never touched either.
 *
 * Rows tracked before the name was recorded are read from their replay file, and the name is
 * written back onto the row as it goes, so this is the last time any of them has to be
 * parsed. A row whose replay has since been deleted cannot be attributed and is left alone.
 */
export async function sweepForeignScores(
  db: Db,
  profileId: number,
  identity: PlayerIdentity,
  parseReplayFile: (file: string) => Promise<ReplayPlayer | null>,
): Promise<ForeignScoreSweep> {
  const sweep: ForeignScoreSweep = { checked: 0, hidden: 0, byPlayer: [], unattributable: 0 };
  if (identity.source !== 'linked') return sweep;

  const rows = db
    .prepare(
      `SELECT id, player_name, player_id, online_score_id, replay_path
         FROM scores
        WHERE profile_id = ? AND hidden_at IS NULL AND imported_at IS NULL`,
    )
    .all(profileId) as {
    id: number;
    player_name: string | null;
    player_id: number | null;
    online_score_id: string | null;
    replay_path: string | null;
  }[];

  const remember = db.prepare('UPDATE scores SET player_name = ?, player_id = ? WHERE id = ?');
  const hide = db.prepare(
    'UPDATE scores SET hidden_at = ?, pinned_at = NULL, pin_order = NULL WHERE id = ?',
  );
  const counts = new Map<string, number>();
  const now = Date.now();

  for (const row of rows) {
    sweep.checked++;

    /*
     * A stored row carries the id osu! gave the score, so it can say on its own whether the
     * play was ever submitted -- see `ReplayPlayer.onlineId`. A row from before these columns
     * has no name and is read from its replay instead.
     */
    const storedId = Number(row.online_score_id ?? 0);
    let player: ReplayPlayer | null =
      row.player_name === null
        ? null
        : {
            name: row.player_name,
            userId: row.player_id,
            onlineId: Number.isFinite(storedId) && storedId > 0 ? storedId : null,
          };
    if (player === null && row.replay_path !== null) {
      player = await parseReplayFile(row.replay_path);
      // Written back so no later pass has to open this file again.
      if (player !== null) remember.run(player.name, player.userId, row.id);
    }
    if (player === null) {
      sweep.unattributable++;
      continue;
    }

    if (!certainlySomeoneElse(identity, player)) continue;
    hide.run(now, row.id);
    sweep.hidden++;
    const name = player.name.trim() || '(no name)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  sweep.byPlayer = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return sweep;
}
