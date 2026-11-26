# Contributing

Pull requests are welcome. This page covers setting up, what a pull request needs, and where the
project's rules are written down.

## Setting up

You need the .NET 10 SDK and Node.js 22.5 or newer. The app is C# (`dotnet/`); Node runs the
build scripts and the tests of the page and the packaging. Go is optional: without it the tray
launcher's tests skip.

```
npm install
npm start            # builds and starts the app at http://localhost:7272
```

The page has no build step, so edit `web/` and reload. The app needs an osu! installation (stable,
lazer or McOsu) to start. `dotnet run --project dotnet/App -- --check-only` says whether it found
one and whether the pp calculator starts.

## Before you open a pull request

- **`npm run check:port` and `npm run check` pass.** The first is the app's tests, the second the
  typecheck and the tests of the page, the packaging and the tray launcher. CI runs both on
  Windows, macOS and Linux.
- **`npm run ui` passes** if you changed the page. It drives the running app in headless Chrome,
  so start the app first.
- **Commits follow [Conventional Commits](https://www.conventionalcommits.org/)**: `feat:`,
  `fix:`, `docs:`, `chore:`, `test:`, `refactor:`, `perf:` or `style:`.
- **History stays linear.** Rebase your branch onto `main` rather than merging `main` into it.

## Changelog

Add an entry for your change to [`CHANGELOG.md`](CHANGELOG.md), under the next release's section at
the top. If the top section is a version that's already released (see the tags), start a new one
above it as `## <next version>`. Each entry is one bullet with a bold lead that says what changed
on its own, then a sentence or two in plain words for players. Look at the existing entries for the
style. The release notes and the app's patch notes use the bold lead alone.

You'll be credited on the entry, so there's no need to add that yourself.

## Where the rules are

- [`AGENTS.md`](AGENTS.md): the rules that must not break, the code conventions and the key entry
  points. It's written for AI coding tools but applies to everyone.
- [`docs/architecture.md`](docs/architecture.md): why each of those rules exists.
- [`docs/roadmap.md`](docs/roadmap.md): what's planned and what's done. Rules often cite an entry
  by number, like "roadmap 5.61".
- [`docs/maintaining.md`](docs/maintaining.md): development commands, releases and keeping pp
  current.
- [`docs/osu-web-fidelity.md`](docs/osu-web-fidelity.md): matching the page to osu!'s own site.

A few worth knowing before you start:

- Where the app has to answer as the Node app did, [`docs/csharp-port.md`](docs/csharp-port.md)
  lists the JavaScript behaviour it keeps (*JavaScript in C#*).
- The app never polls osu!'s API and works with no credentials or network.

## UI text

Option descriptions and hints are short and plain: say what the option does in one sentence, or
in a couple of words. [`AGENTS.md`](AGENTS.md) has examples under "UI text". Add every new string
to `web/i18n/en.json`. Translations in the other files are welcome, and a key missing from one
shows in English.

## README

Please don't edit `README.md` in a pull request unless a maintainer has requested a README change.
If your change should be mentioned there, suggest the text in the pull request's description.

### README diagrams

GitHub renders [Mermaid](https://mermaid.js.org/) diagrams directly in Markdown. Use Mermaid
instead of ASCII-art diagrams when showing a workflow, decision tree or interaction.

- Use a fenced code block with the `mermaid` language identifier.
- Prefer `flowchart TD` for pipelines and decision flows; use `flowchart LR` only when the
  diagram is short enough to remain readable on narrow screens.
- Use `sequenceDiagram` when the important detail is which component sends a message to another.
- Give nodes short, descriptive labels. Put implementation details and long explanations in the
  surrounding README text rather than cramming them into nodes.
- Label decision branches (for example, `Yes` and `No`) and make offline/online boundaries
  explicit when they matter.
- Keep diagrams consistent with the implementation. Update them when the corresponding code path
  changes; remove obsolete nodes rather than leaving stale architecture behind.
- Keep each diagram focused on one workflow. Split unrelated flows into separate diagrams with a
  short heading and introductory sentence.
- Preview Mermaid rendering on GitHub before merging. Keep a plain-text explanation nearby so
  the README remains understandable when diagrams cannot be rendered.

## Licence and third-party material

The project is AGPL-3.0-or-later, and contributions are accepted under the same licence. Anything
you bring in from a third party goes in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Some
material can't be used under any licence: `ppy/osu-resources`, osu!'s Torus and Venera fonts, and
the osu! and ppy logos. osu-web's artwork only arrives through `npm run build:osu-web`, never edited
by hand.

## AI tools

AI-assisted contributions are fine. AI tools read [`AGENTS.md`](AGENTS.md) on their own, and
Claude Code reads it through [`CLAUDE.md`](CLAUDE.md), which imports it. Please review and test
what a tool writes before you submit it.
