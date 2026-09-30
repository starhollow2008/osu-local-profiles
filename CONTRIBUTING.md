# Contributing

Pull requests are welcome. This page covers setting up, what a pull request needs, and where the
project's rules are written down.

## Setting up

You need Node.js 22.5 or newer and the .NET 10 SDK. Go is optional: without it the tray launcher's
tests skip.

```
npm install
npm run build:pp     # builds osu!'s pp calculator
npm run dev          # starts the app at http://localhost:7272
```

The page has no build step, so edit `web/` and reload. The app needs an osu! installation (stable,
lazer or McOsu) to start. `npm run check:app` says whether it found one and whether the pp
calculator starts.

## Before you open a pull request

- **`npm run check` passes.** It's the typecheck and the full test suite. Tests that need a real
  osu! installation skip themselves. CI runs the same on Windows, macOS and Linux.
- **`npm run ui` passes** if you changed the page. It drives the running app in headless Chrome,
  so start the app first.
- **Commits follow [Conventional Commits](https://www.conventionalcommits.org/)**: `feat:`,
  `fix:`, `docs:`, `chore:`, `test:`, `refactor:`, `perf:` or `style:`.
- **History stays linear.** Rebase your branch onto `main` rather than merging `main` into it.
- **After changing `tools/PpCalculator/Program.cs`**, run `npm run build:pp:local`. A stale helper
  in `tools/pp/` keeps answering the old protocol without failing.

## Changelog

Add an entry for your change to [`CHANGELOG.md`](CHANGELOG.md), under the next release's section at
the top. If the top section is a version that's already released (see the tags), start a new one
above it as `## <next version>`. Each entry is one bullet with a bold lead that says what changed
on its own, then a sentence or two in plain words for players. Look at the existing entries for the
style. The release notes and the app's patch notes use the bold lead alone.

You'll be credited on the entry, so there's no need to add that yourself.

## Where the rules are

- [`CLAUDE.md`](CLAUDE.md): the rules that must not break, the code conventions and the key entry
  points. It's written for AI coding tools but applies to everyone.
- [`docs/architecture.md`](docs/architecture.md): why each of those rules exists.
- [`docs/roadmap.md`](docs/roadmap.md): what's planned and what's done. Rules often cite an entry
  by number, like "roadmap 5.61".
- [`docs/maintaining.md`](docs/maintaining.md): development commands, releases and keeping pp
  current.
- [`docs/osu-web-fidelity.md`](docs/osu-web-fidelity.md): matching the page to osu!'s own site.

A few worth knowing before you start:

- TypeScript runs through Node's type stripping, so no `enum`, `namespace`, decorators or
  constructor parameter properties.
- The Node process loads no native modules.
- The app never polls osu!'s API and works with no credentials or network.

## UI text

Option descriptions and hints are short and plain: say what the option does in one sentence, or
in a couple of words. [`CLAUDE.md`](CLAUDE.md) has examples under "UI text". Add every new string
to `web/i18n/en.json`. Translations in the other files are welcome, and a key missing from one
shows in English.

## README

Please don't edit `README.md` in a pull request. If your change should be mentioned there, suggest
the text in the pull request's description.

## Licence and third-party material

The project is AGPL-3.0-or-later, and contributions are accepted under the same licence. Anything
you bring in from a third party goes in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Some
material can't be used under any licence: `ppy/osu-resources`, osu!'s Torus and Venera fonts, and
the osu! and ppy logos. osu-web's artwork only arrives through `npm run build:osu-web`, never edited
by hand.

## AI tools

AI-assisted contributions are fine. Claude Code reads [`CLAUDE.md`](CLAUDE.md) on its own, and
other tools read [`AGENTS.md`](AGENTS.md), which points to it. Please review and test what a tool
writes before you submit it.
