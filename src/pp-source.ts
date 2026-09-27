import { OfficialCalculator } from './calc/official.ts';
import {
  buildSourceHelper,
  checkOsuSource,
  readSourceHelper,
  sameFolder,
  sourceCandidate,
  sourceVersion,
  type SourceHelper,
} from './calc/source-helper.ts';
import type { Tracker } from './tracker/index.ts';

/**
 * Settings -> pp calculator: price every score with the player's own osu! source, or with the
 * release this app ships, and switch between the two (roadmap 5.70).
 *
 * A switch is always whole: the new calculator takes over every profile and every score is
 * recalculated with it (`Tracker.switchCalculator`), so no total ever adds pp from two formulas.
 * And it never falls back. If the source's helper will not build or start, nothing changes --
 * the calculator in use stays in use -- and the page is told why; if it will not start at a
 * launch, the app prices nothing that session rather than quietly using the release
 * (`startupCalculator`), the same as when the bundled helper is missing.
 */

export interface PpSourceState {
  /** The source in use, or '' for the release. */
  source: string;
  /** What that source's pp is labelled, while it is in use. */
  version: string | null;
  /** A build under way: from where, and the last line `dotnet` printed. */
  building: { source: string; line: string } | null;
  /** Why the last build or switch did not happen, until the next one starts. */
  error: string | null;
}

export interface PpSourceView extends PpSourceState {
  /**
   * What the source folder would be labelled if it were built now. Differs from `version` once
   * the player has changed their source since it was built -- the page offers a rebuild then.
   */
  now: string | null;
}

export interface PpSourceDeps {
  tracker: Pick<Tracker, 'switchCalculator' | 'calculatorVersion' | 'recalculating'>;
  dataDir: string;
  /** This app's `tools/PpCalculator/Program.cs`. */
  program: string;
  /** The source config.json names, and how to change it. */
  getSource(): string;
  setSource(source: string): void;
  /** Why the launch started with no calculator for the configured source, if it did. */
  startupProblem?: string | null;
}

export interface PpSourceService {
  /** Cheap: what is in use and under way. */
  state(): PpSourceState;
  /** `state`, and what the source folder would be labelled now, which asks git. */
  view(): PpSourceView;
  /** Build (when needed) and switch to `source`'s calculator. Resolves once it has started. */
  use(source: string): Promise<PpSourceState>;
  /** Switch back to the bundled release. */
  useRelease(): Promise<PpSourceState>;
  onChange(listener: (state: PpSourceState) => void): void;
}

/**
 * The calculator a launch starts with. With a source configured, only the helper built from it
 * -- never the release in its place, which would reprice the profile with a formula nobody
 * chose. Null, with the reason, when there is none to be had.
 */
export async function startupCalculator(
  source: string,
  dataDir: string,
): Promise<{ calculator: OfficialCalculator | null; problem: string | null }> {
  if (source === '') return { calculator: await OfficialCalculator.create(), problem: null };
  const helper = readSourceHelper(dataDir);
  if (helper === null || !sameFolder(helper.source, source)) {
    return { calculator: null, problem: `no calculator has been built from your osu! source at ${source}` };
  }
  const calculator = await OfficialCalculator.create(sourceCandidate(helper), helper.version);
  return {
    calculator,
    problem: calculator ? null : `the calculator built from your osu! source (${helper.version}) would not start`,
  };
}

export function ppSourceService(deps: PpSourceDeps): PpSourceService {
  const listeners: ((state: PpSourceState) => void)[] = [];
  let building: PpSourceState['building'] = null;
  let error: string | null = deps.startupProblem ?? null;
  /** A switch under way, from its first check to its last: one at a time. */
  let switching = false;

  const state = (): PpSourceState => {
    const source = deps.getSource();
    return { source, version: source === '' ? null : deps.tracker.calculatorVersion, building, error };
  };
  const changed = () => {
    const now = state();
    for (const listener of listeners) listener(now);
  };
  const fail = (e: unknown): PpSourceState => {
    error = (e as Error).message;
    building = null;
    changed();
    return state();
  };
  const RECALCULATING = 'scores are being recalculated; switch once that has finished';
  const busy = (): string | null =>
    switching
      ? building !== null
        ? 'your osu! source is already being built'
        : 'the calculator is already being switched'
      : deps.tracker.recalculating
        ? RECALCULATING
        : null;

  /**
   * Hand `calculator` to the tracker, reprice everything with it, and remember `source` as the
   * one in use. Refused, with nothing changed, if a recalculation began meanwhile -- checked in
   * the same tick as the tracker's own check, so there is no moment between the two.
   */
  const switchTo = async (calculator: OfficialCalculator, source: string): Promise<PpSourceState> => {
    if (deps.tracker.recalculating) {
      calculator.dispose();
      return fail(new Error(RECALCULATING));
    }
    const repriced = deps.tracker.switchCalculator(calculator, () => {
      deps.setSource(source);
      error = null;
      changed();
    });
    // The recalculation reports its own progress; a failure in it is not a failed switch.
    await repriced.catch((e: Error) => {
      error = `switched, but recalculating failed: ${e.message}`;
    });
    changed();
    return state();
  };

  /** One switch at a time, whatever it does. */
  const exclusive = async (run: () => Promise<PpSourceState>): Promise<PpSourceState> => {
    const refused = busy();
    if (refused) return fail(new Error(refused));
    switching = true;
    try {
      return await run();
    } finally {
      switching = false;
      building = null;
    }
  };

  return {
    state,

    view() {
      const now = state();
      let current: string | null = null;
      if (now.source !== '') {
        try {
          current = sourceVersion(now.source);
        } catch {
          current = null;
        }
      }
      return { ...now, now: current };
    },

    use(source) {
      return exclusive(async () => {
        const problem = checkOsuSource(source);
        if (problem) return fail(new Error(problem));
        let version: string;
        try {
          version = sourceVersion(source);
        } catch (e) {
          return fail(e);
        }

        // In use already, exactly as the source is now: nothing to do.
        const inUse = deps.getSource();
        if (inUse !== '' && sameFolder(inUse, source) && deps.tracker.calculatorVersion === version) {
          error = null;
          changed();
          return state();
        }

        // Built from exactly this source as it is now: start that rather than build it again.
        let helper: SourceHelper | null = readSourceHelper(deps.dataDir);
        if (!helper || !sameFolder(helper.source, source) || helper.version !== version) {
          building = { source, line: '' };
          error = null;
          changed();
          let last = 0;
          try {
            helper = await buildSourceHelper({
              source,
              dataDir: deps.dataDir,
              program: deps.program,
              onOutput: (line) => {
                building = { source, line };
                // Enough to show it is moving, without a message per line the compiler prints.
                if (Date.now() - last > 500) {
                  last = Date.now();
                  changed();
                }
              },
            });
          } catch (e) {
            return fail(e);
          }
          building = null;
        }

        const calculator = await OfficialCalculator.create(sourceCandidate(helper), helper.version);
        if (calculator === null) {
          return fail(new Error(`it built, but the calculator from your osu! source (${helper.version}) would not start`));
        }
        return switchTo(calculator, source);
      });
    },

    useRelease() {
      return exclusive(async () => {
        const calculator = await OfficialCalculator.create();
        if (calculator === null) return fail(new Error("this app's own pp calculator would not start"));
        return switchTo(calculator, '');
      });
    },

    onChange(listener) {
      listeners.push(listener);
    },
  };
}
