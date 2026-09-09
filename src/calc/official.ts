import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';


/**
 * Talks to the bundled `osu-pp` helper, which is a thin wrapper around osu!'s *own*
 * difficulty and performance calculators (the `ppy.osu.Game.Rulesets.*` packages).
 *
 * This exists because every reimplementation of osu!'s pp algorithm lags behind its
 * reworks. rosu-pp 4.0.1 implements the 2025-10-29 algorithm, so after osu!'s 2026-07-03
 * rework it reported 7.03 stars / 142pp for a play osu! itself scores at 6.93 / 151.
 * Keeping current is now a version bump in `tools/PpCalculator/PpCalculator.csproj`.
 *
 * The helper is handed the replay file itself and decodes it with osu!'s LegacyScoreDecoder,
 * which is what makes osu!stable replays correct: it sets IsLegacyScore from the replay
 * version, applies classic slider accuracy, and populates MaximumStatistics from the
 * beatmap. Reconstructing a ScoreInfo by hand would silently score stable plays as lazer.
 *
 * The helper stays resident and speaks one JSON object per line, so we pay process
 * startup once rather than per score.
 */

export interface OfficialRequest {
  /** The .osr replay. lazer stores these with no file extension. */
  replayPath: string;
  /** The .osu the replay was set on, located by its MD5. */
  beatmapPath: string;
  /**
   * Mod acronyms to remove from the decoded score before scoring it, so the play is priced
   * as if those mods had not been on. Used for Relax and Autopilot; see src/calc/pp.ts.
   */
  stripMods?: string[];
}

export interface OfficialResult {
  stars: number;
  /** The beatmap's maximum achievable combo. */
  maxCombo: number;
  accuracy: number;
  /** The combo the player actually reached. */
  combo: number;
  rank: string;
  /** True for osu!stable replays, which osu! scores differently. */
  isLegacy: boolean;
  mods: string[];
  pp: number | null;
  /** True when `stripMods` actually removed something, so the result is not "as played". */
  stripped: boolean;
}

interface Response {
  ok: boolean;
  error?: string;
  stars?: number;
  maxCombo?: number;
  accuracy?: number;
  combo?: number;
  rank?: string;
  isLegacy?: boolean;
  mods?: string[];
  pp?: number | null;
  stripped?: boolean;
}

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Where the helper might live, most preferred first.
 *
 * Resolved from this module's location, not the working directory: a packaged build is
 * started by double-clicking, so the process can begin in any directory at all. Getting
 * this wrong is quiet -- the app runs, tracks scores, and simply records no pp.
 */
function candidates(): Array<{ command: string; args: string[] }> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const selfContained = path.join(root, 'tools', 'pp', process.platform === 'win32' ? 'osu-pp.exe' : 'osu-pp');
  const built = path.join(root, 'tools', 'PpCalculator', 'bin', 'Release', 'net8.0');
  const exe = path.join(built, process.platform === 'win32' ? 'osu-pp.exe' : 'osu-pp');
  const dll = path.join(built, 'osu-pp.dll');

  const out: Array<{ command: string; args: string[] }> = [];
  if (fs.existsSync(selfContained)) out.push({ command: selfContained, args: [] });
  if (fs.existsSync(exe)) out.push({ command: exe, args: [] });
  if (fs.existsSync(dll)) out.push({ command: 'dotnet', args: [dll] });
  return out;
}

export class OfficialCalculator {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private pending: ((value: Response) => void) | null = null;
  /** Serialises requests: the line protocol has no request ids. */
  private queue: Promise<unknown> = Promise.resolve();
  private dead = false;
  /** Surfaced so a failure is reported rather than silently producing no pp. */
  lastError: string | null = null;

  private constructor(child: ChildProcessWithoutNullStreams, lines: readline.Interface) {
    this.child = child;
    this.lines = lines;

    this.lines.on('line', (line) => {
      const take = this.pending;
      if (!take) return;
      this.pending = null;
      try {
        take(JSON.parse(line) as Response);
      } catch {
        take({ ok: false, error: `unparseable response: ${line.slice(0, 120)}` });
      }
    });

    const die = () => {
      this.dead = true;
      this.pending?.({ ok: false, error: 'calculator exited' });
      this.pending = null;
    };
    child.on('exit', die);
    child.on('error', die);
  }

  /** Returns null when the helper is not built or cannot start. */
  static async create(): Promise<OfficialCalculator | null> {
    /*
     * The candidate list is a convenience for development, where a packaged helper and a
     * plain `dotnet build` output can both exist. It is also a trap: a broken packaged
     * helper falls through to the working one, so the tests pass while the thing that
     * would actually ship is dead. That happened -- pruning removed an assembly osu!
     * loads from a module initializer, and three pp tests kept passing against the
     * fallback. So say when a candidate was there and failed, rather than moving on
     * silently.
     */
    let attempt = 0;
    for (const { command, args } of candidates()) {
      if (attempt++ > 0) {
        console.warn(`  note: falling back to ${path.basename(path.dirname(command))} -- the preferred pp helper failed to start`);
      }
      try {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const lines = readline.createInterface({ input: child.stdout });

        const ready = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), STARTUP_TIMEOUT_MS);
          lines.once('line', (line) => {
            clearTimeout(timer);
            try {
              resolve((JSON.parse(line) as { ready?: boolean }).ready === true);
            } catch {
              resolve(false);
            }
          });
          child.once('error', () => {
            clearTimeout(timer);
            resolve(false);
          });
          child.once('exit', () => {
            clearTimeout(timer);
            resolve(false);
          });
        });

        if (ready) return new OfficialCalculator(child, lines);
        child.kill();
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  calculate(request: OfficialRequest): Promise<OfficialResult | null> {
    const run = async (): Promise<OfficialResult | null> => {
      if (this.dead) return null;

      const response = await new Promise<Response>((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: false, error: 'calculator timed out' }),
          REQUEST_TIMEOUT_MS,
        );
        this.pending = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        this.child.stdin.write(`${JSON.stringify(request)}\n`);
      });

      if (!response.ok || typeof response.stars !== 'number') {
        if (response.error) this.lastError = response.error;
        return null;
      }
      return {
        stars: response.stars,
        maxCombo: response.maxCombo ?? 0,
        accuracy: response.accuracy ?? 0,
        combo: response.combo ?? 0,
        rank: response.rank ?? '',
        isLegacy: response.isLegacy ?? false,
        mods: response.mods ?? [],
        pp: response.pp ?? null,
        stripped: response.stripped ?? false,
      };
    };

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.dead = true;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}
