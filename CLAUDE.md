# osu! local profiles

## Before roadmap work

For roadmap-tracked implementation, search [`docs/roadmap.md`](docs/roadmap.md) for the relevant entry; never read it whole. Update it only when the task changes its status.

Read only relevant sections of [`docs/architecture.md`](docs/architecture.md) when architecture context is needed.

## TS: strip-only, no runtime emit

`node src/main.ts` runs TS via Node type stripping. Types erased, never compiled.

- No `constructor(private db: Db)` — declare field + assign in body
- No `enum` (use `const` objects `as const`)
- No `namespace`, no decorators

`npm run check` = typecheck + full test suite. Run it before every commit.

Tests: `node --test "test/**/*.test.ts"` (quoted glob required).

## pp: official .NET helper only

`tools/PpCalculator/` wraps `ppy.osu.Game.Rulesets.*` NuGet. Driven via JSON-lines pipe from `src/calc/official.ts`.

- Hand the replay file, never a reconstructed ScoreInfo
- No fallback calc (`rosu-pp` removed). Helper down = store no pp, say so
- Do not trim it. `PublishTrimmed` breaks osu!'s own graph — see `docs/architecture.md`, roadmap 5.44
- Every pp carries osu! release version + breakdown. Parts must match the pp beside them
- `docs/reference-links.md` has links to osu-web, ppy/osu, API docs

## Design constraints

- No native modules in Node process. `node:sqlite` + pure-JS LZMA only
- `/api/profile` cached until DB changes (`total_changes()` stamp)
- No API polling. Local detection only. Works with no credentials, no network
- No scan-and-import on startup. Import past plays is explicit: pick cutoff, preview, confirm
- Ingestion serialized through promise queue (`src/tracker/index.ts`)
- Live feed is SSE, and a browser allows 6 connections per origin. Only a *visible* tab may
  hold the stream open, or open tabs starve the page itself (`web/js/main.js`)

## UI checks

`npm run ui` drives the **running app** (`http://localhost:7272/`, override with an argv
URL) in headless Chrome via CDP and asserts computed style. Start the app first, or it
fails.

`[hidden] { display: none !important; }` in `web/css/base.css` is global. Keep it.

## Git

Conventional Commits, scope optional: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`,
`perf:`, `style:`. Releases are `chore: release vX.Y.Z`.

History is linear — rebase onto `main`, do not merge it into a branch.

## Key entry points

- `src/main.ts`: application startup
- `src/osr.ts`: legacy and lazer replay parser
- `src/tracker/index.ts`: serialized replay ingestion
- `src/calc/official.ts`: JSON-lines bridge to `tools/PpCalculator/`
- `src/http/server.ts`: HTTP API and static serving
