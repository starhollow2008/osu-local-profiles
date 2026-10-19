/**
 * One request at a time to osu!, at most one a second, shared by everything the app asks of it.
 *
 * osu! asks that whatever reads it stay under 60 requests a minute, "generally 1 request per
 * second" (osu.ppy.sh/docs, Terms of Use). That is written for its API, and this app reads its
 * website instead -- the same servers, so the same courtesy. Every request the app itself makes
 * to an osu! domain (osu.ppy.sh, a.ppy.sh, assets.ppy.sh) goes through one gate: an import of
 * 9,000 favourites or of hundreds of beatmaps queues behind it rather than arriving at once. The
 * images and previews the browser loads for the cards on screen are the browser's own, as on
 * osu!'s site, and never pass through here.
 *
 * Told to slow down (429), the whole gate waits as long as osu! says before anything else is
 * asked (`pauseFor`), so a second import started meanwhile cannot keep knocking. See
 * src/clients/osu-web.ts, `fetchWithTimeout`, and roadmap 5.78.
 */

export class RequestGate {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The earliest the next request may start. */
  private next = 0;
  /** The turns already promised, so each waits for the one before it. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    intervalMs: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.sleep = sleep;
  }

  /** Run `task` once its turn comes. Turns start `intervalMs` apart, in the order asked. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(async () => {
      // Read again after each wait: a pause can arrive while this turn is already waiting.
      for (let wait = this.next - this.now(); wait > 0; wait = this.next - this.now()) {
        await this.sleep(wait);
      }
      this.next = this.now() + this.intervalMs;
    });
    this.queue = turn;
    return turn.then(task);
  }

  /** Hold every request still to come for `ms`: osu! asked the app to slow down. */
  pauseFor(ms: number): void {
    this.next = Math.max(this.next, this.now() + ms);
  }
}

/** The longest a Retry-After is taken at its word, and what a 429 without one waits. */
export const MAX_PAUSE_MS = 5 * 60_000;
export const DEFAULT_PAUSE_MS = 60_000;

/**
 * How long a 429 says to wait: `Retry-After` in seconds or as a date, held to between a second
 * and `MAX_PAUSE_MS`, or `DEFAULT_PAUSE_MS` when it says nothing usable.
 */
export function retryAfterMs(header: string | null, now: number): number {
  const raw = header?.trim() ?? '';
  let ms = NaN;
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
  else if (raw !== '') ms = Date.parse(raw) - now;
  if (!Number.isFinite(ms)) return DEFAULT_PAUSE_MS;
  return Math.min(MAX_PAUSE_MS, Math.max(1000, ms));
}
