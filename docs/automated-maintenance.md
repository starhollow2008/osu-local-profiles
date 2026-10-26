# Automated maintenance

The two things this app has to keep up with, the rank curves and osu!'s pp, are followed by a
weekly job on the owner's VM. It publishes a release when either changes, with nobody involved.
This page is how it works and, from [The procedure](#the-procedure) on, the instructions the
job's agent follows. Doing either by hand is still in `docs/maintaining.md`.

## How it runs

`osu-maintenance.timer` starts `osu-maintenance.service` every Monday at 14:00 UTC (and at the
next boot when the VM was off then). That runs `tools/maintenance/run.sh` as `osubot`, a user
with no sudo, holding a GitHub token for this repository only and a Claude Code token.

1. `run.sh` checks both tokens every week, so one that stops working is reported within a week
   rather than the month an update is next due. A refused Claude Code token opens the issue
   *Maintenance: Claude Code can't sign in* with the steps to renew it, and the first check that
   signs in again closes it. An expired GitHub token can't open an issue; GitHub emails the owner
   a week before a token expires.
2. It clones `main` and runs `tools/maintenance/check.mjs`, which compares the newest
   data.ppy.sh dump and the newest osu! NuGet packages with the checkout, and looks for a release
   an earlier run merged but never tagged. Nothing to do means it stops there, with no agent
   started.
3. Otherwise it starts Claude Code in the clone with what the check found, and the agent follows
   the procedure below: a branch, a pull request, every CI check passed, a rebase merge, a tag.
   The tag's `release.yml` run builds and publishes the release as for any other.
4. The agent writes a result file. A failure, or no result at all, opens an issue titled
   *Automated maintenance failed* (or comments on the open one), which GitHub emails the owner.
   An agent that stopped because it couldn't sign in opens the sign-in issue instead. A release
   is also emailed, through the VM's own alerts (`vm-alert`, from the owner's `oracle-vm` setup)
   when it has them.

The agent runs on the newest Opus at high effort (`--model opus --effort high`), and the token
checks on the newest Sonnet at medium. Both names are aliases that move to each new release, and
Claude Code's background calls are pointed at Sonnet (`ANTHROPIC_DEFAULT_HAIKU_MODEL=sonnet`), so
nothing runs on Haiku.

On the VM:

```
sudo systemctl start osu-maintenance            # run now
journalctl -u osu-maintenance -e                # the last run
ls ~osubot/osu-maintenance/logs                 # every run's log and agent transcript
systemctl list-timers osu-maintenance.timer     # when it runs next
sudo systemctl disable --now osu-maintenance.timer
```

A test run, as `osubot`: `OSU_MAINT_BRANCH=<branch> OSU_MAINT_DRY_RUN=1 ~/osu-maintenance/run.sh`
does the work in a clone and publishes nothing. `OSU_MAINT_FORCE_DUMP=2026_09_01` makes the rank
refresh due against a dump already used, which rewrites the same curves, and `OSU_MAINT_FORCE_PP=1`
prices the current osu! version against itself, which must come out identical (not a rework).

Setting the VM up, or after changing `run.sh` or the units: `sudo bash
tools/maintenance/setup-vm.sh`, then `sudo bash tools/maintenance/set-secrets.sh` for the tokens.

## The procedure

You are running unattended. Nobody will answer a question, so never ask one. When something
isn't covered here, or doesn't look the way this page says it should, stop and report a failure
with what you found. A late release is fine. A wrong one goes to every user's updater.

The prompt gives you the mode (`publish` or `dry-run`), the result file's path and the check's
JSON: `release.due` with `release.version`, `rank.due` with `rank.latest` (a dump date such as
`2026_10_01`), and `pp.due` with `pp.current` and `pp.latest` (osu! versions such as
`2026.1020.0`).

### Rules

- CLAUDE.md applies. This job is the owner's standing decision to refresh the rank curves and
  follow pp reworks without asking, which is the exception to "never run it automatically" in
  `docs/maintaining.md`.
- Change only what these steps name. Fix nothing else you notice; mention it in the summary.
- Never push to `main`, force-push it, delete or move a tag, or edit or delete a release. Never
  commit dumps, `.sql` files, replays or beatmaps. Never print the tokens in `GH_TOKEN` and
  `CLAUDE_CODE_OAUTH_TOKEN`.
- Don't open issues: `run.sh` does, from your result.
- Wait for a command you ran in the background through its own output or notification, never by
  looping on `pgrep -f` (the loop's own command line matches, so it never ends). Leave nothing
  running when you write the result: `run.sh` stops you 10 minutes after it appears.
- In `dry-run` mode, do everything up to and including the local commits and `npm run check`,
  then skip [Publish](#6-publish) and [Tag](#7-tag) and write the result with status `dry-run`.

### 0. An unfinished release, when `release.due`

An earlier run merged `v<release.version>` and stopped before tagging it. Do [Tag](#7-tag) for
that version now (in `dry-run` mode, only say you would). If nothing else is due, write the
result as `released` with that version. Otherwise carry on from step 1 for a new release, and
name both versions in the summary.

### 1. Branch and build

```
git switch -c bot/maintenance-<today>
npm ci
npm run build:pp
```

### 2. pp, when `pp.due`

A new osu! version is only shipped when it changes pp. Prove which by asking the old and new
helpers the same questions:

Runs never overlap, so the two helpers go in fixed folders beside the clone:

1. `rm -rf ~/osu-maintenance/work/pp-old ~/osu-maintenance/work/pp-new`, then
   `node scripts/build-pp-helper.mjs ~/osu-maintenance/work/pp-old --full` builds the current
   version.
2. Set all five `PackageReference` versions in `tools/PpCalculator/PpCalculator.csproj` to
   `pp.latest`. If the build reports `NU1202 ... supports: net<N>`, osu! moved to a newer .NET:
   install it with `~/dotnet-install.sh --channel <N>.0 --install-dir ~/.dotnet` and make every
   change step 1 of *Keeping pp current* in `docs/maintaining.md` lists.
3. `node scripts/build-pp-helper.mjs ~/osu-maintenance/work/pp-new --full` builds the new one.
4. `node scripts/pp-parity.mjs ~/osu-maintenance/work/pp-old ~/osu-maintenance/work/pp-new`.
   It prints that the two versions differ and leaves out the `version` field every answer
   carries; everything else must match exactly.
   - **Exit 0, every answer identical:** not a rework. Undo every change from this section
     (`git checkout -- .` before anything else is changed) and record `ppEvaluated` as
     `pp.latest` with `ppRework: false`.
   - **Exit 1 with pp, star rating or difficulty values different:** a rework. Keep the changes
     and record `ppRework: true`.
   - **Anything else** (only errors or ranked mods differ, a helper won't start): stop and
     report a failure.

For a rework, find what to call it: osu!'s news post announcing the deployment
(https://osu.ppy.sh/home/news), and the ppy/osu release tag for the version (`<version>` or
`<version>-lazer`). Its month is the month osu! deployed it, from the news post, or the
release's month when there is none. Read the `osu.Game.Rulesets.*/Difficulty` diff between the
two tags so the changelog can say what changed.

### 3. Rank curves, when `rank.due`

```
node scripts/build-rank-table.mjs all --dump <rank.latest>
```

This streams roughly 1GB per mode and takes a while. Afterwards, each of
`src/calc/rank-tables/*.json` must name the new dump, with about as many points as before and
rank falling as pp rises. Set `DEFAULT_DUMP` in `scripts/build-rank-table.mjs` and the dump named
in `docs/maintaining.md` (the examples and "All four modes currently use ...") to it. Nothing of
the download may be left behind: check that `git status` shows only those files changed.

### 4. README, CHANGELOG and version

In `README.md`:

- A rework: the `pp version` badge's month and year (`pp%20version-<Month>%20<Year>`), and the
  **pp:** line under *Last Updated*: the version, its release link, and "which includes the
  <Month Year> pp rework".
- A refresh: the **Global rank estimate:** line, as the dump's month and year
  (`2026_10_01` is October 2026), still linking to https://data.ppy.sh/.

In `CHANGELOG.md`, a new section above the newest one, in its style (a bold lead saying what
changed on its own, then a plain sentence or two):

- A rework: `**pp is calculated by osu! <version>, with the <Month Year> pp rework.**`, what it
  changed for players, and that every score is recalculated on the first launch after updating.
  Put `<!-- important -->` on its own line in the section.
- A refresh: `**Global rank estimates use osu!'s <Month Year> ranking data.**`
- Every commit since the last `v*` tag that changes the app (`feat`, `fix`, `perf`) and has no
  entry yet gets one, written from its commit and diff, keeping any `Reported in` and
  `Thanks to` lines its commit names. Docs, tests and chores get none. They ship in this release.

The version: the next minor (`1.31.0` to `1.32.0`) for a rework or when any unreleased commit is
a `feat`, otherwise the next patch. If the newest CHANGELOG section is already a version newer
than `package.json`'s, it's unreleased: add to it and use its version.

### 5. Commit and check

Commits, each ending in a `Co-Authored-By:` trailer for the model you are, as earlier commits do:

- a rework: `feat(pp): osu! <version>, with the <Month Year> pp rework`
- a refresh: `chore: rank curves from data.ppy.sh's <dump> dump`
- `docs: README and changelog for <version>`
- `npm version <version> --no-git-tag-version`, committed as `chore: release v<version>`

After a rework, `npm run build:pp` again, so the tests use the new helper. Then `npm run check`
must pass, and `node src/main.ts --check-only` must print both
`No osu! installation found` and `pp: osu!'s official calculator` (this VM has no osu!). If
either fails because of this run's changes, fix it once; otherwise, or if that fails too, stop
and report a failure.

### 6. Publish

```
git push -u origin HEAD
gh pr create --base main --title "Maintenance: <what changed>, v<version>" --body "<what changed and why>"
gh pr checks <number> --watch --interval 60
```

If it says no checks are reported yet, wait a minute and run it again; it exits 8 while any is
still pending. Every check must pass: CI on three systems, and `pp helper` when a rework changed the csproj (the
slim helper's parity, which a release would otherwise quietly fall back from). A failure: leave
the pull request open, comment on it with what failed, and report a failure.

When they pass, `gh pr merge <number> --rebase --delete-branch`. If it can't merge because
`main` moved on: `git fetch origin`, `git rebase origin/main`, `npm run check`, `git push
--force-with-lease`, and wait for the checks again. A second time, report a failure.

### 7. Tag

```
git fetch origin main --tags
git log origin/main -1 --format=%H --grep="^chore: release v<version>$"
git tag v<version> <that commit>
git push origin v<version>
```

Then wait for that tag's `Release` run (`gh run list --workflow release.yml --limit 3`, then
`gh run watch <id> --interval 60`) and check that `gh release view v<version> --json assets`
lists four zips. A failed run: report a failure with its link. Don't delete the tag.

### 8. Result

Always write the result file, even when stopping early:

```json
{
  "status": "released | nothing | dry-run | failed",
  "version": "1.32.0 or null",
  "ppEvaluated": "the version priced in step 2, or null",
  "ppRework": true,
  "rankDump": "the dump the curves now use, or null",
  "summary": "Two or three plain sentences: what was found, what was done, links to the pull request and release. For a failure, what failed and where to look."
}
```

`nothing` is a run where pp turned out not to be a rework and no refresh was due. `run.sh`
records a `ppRework: false` version so it isn't priced again, and opens an issue for `failed`.
