#!/usr/bin/env bash
# The daily maintenance job (docs/automated-maintenance.md), run by osu-maintenance.service as
# the VM's unprivileged job user. setup-vm.sh installs this file as ~/osu-maintenance/run.sh.
#
# Clones the repository fresh, asks tools/maintenance/check.mjs whether anything is due, prices
# a new osu! version against the current one itself, and only then starts Claude Code on the
# procedure in docs/automated-maintenance.md. Those are read from the clone, so changing them on
# main changes the next run; this file only changes when setup-vm.sh is run again.
#
# Testing, by hand:
#   OSU_MAINT_BRANCH=<branch>     clone that branch instead of main
#   OSU_MAINT_DRY_RUN=1           do the work in the clone, publish nothing, open no issue
#   OSU_MAINT_CHECK_ONLY=1        stop where the agent would start, and say what it would do
#   OSU_MAINT_FORCE_DUMP=<date>   rebuild the rank curves from that dump even if it isn't new
#   OSU_MAINT_FORCE_PP=1          price the current osu! version against itself as if it were new
#                                 (identical, so the run ends here without the agent)
#   OSU_MAINT_TEST_BAD_CLAUDE_TOKEN=1   use a token Claude Code refuses, to see the sign-in report
#   OSU_MAINT_STALE_DAYS=<days>   how old a source's newest release may get before an issue (90)
set -euo pipefail

REPO=jonathant09/osu-local-profiles
BRANCH=${OSU_MAINT_BRANCH:-main}
DRY_RUN=${OSU_MAINT_DRY_RUN:-0}
FORCE_DUMP=${OSU_MAINT_FORCE_DUMP:-}
FORCE_PP=${OSU_MAINT_FORCE_PP:-0}
CHECK_ONLY=${OSU_MAINT_CHECK_ONLY:-0}
STALE_DAYS=${OSU_MAINT_STALE_DAYS:-90}
BASE=$HOME/osu-maintenance
STATE_DIR=$HOME/.local/state/osu-maintenance
ISSUE_TITLE="Automated maintenance failed"
AUTH_TITLE="Maintenance: Claude Code can't sign in"
RANK_STALE_TITLE="Maintenance: no new rank dump on data.ppy.sh"
PP_STALE_TITLE="Maintenance: no new osu! version on NuGet"

mkdir -p "$BASE/logs" "$BASE/work" "$STATE_DIR"
[ -f "$STATE_DIR/state.json" ] || echo '{"ppNotRework":[]}' > "$STATE_DIR/state.json"

# GH_TOKEN (fine-grained, this repository only) and CLAUDE_CODE_OAUTH_TOKEN, from set-secrets.sh.
set -a
. "$HOME/.config/osu-maintenance/env"
set +a
[ "${OSU_MAINT_TEST_BAD_CLAUDE_TOKEN:-0}" = 1 ] && CLAUDE_CODE_OAUTH_TOKEN=invalid-test-token
export DOTNET_ROOT=$HOME/.dotnet DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# The owner's model rule: work on the app is the newest Opus at high effort, anything else the
# newest Sonnet at medium, and never Haiku. `opus` and `sonnet` are aliases that move to each new
# release; Claude Code's own background calls use whatever the `haiku` alias names.
AGENT_MODEL=(--model opus --effort high)
CHECK_MODEL=(--model sonnet --effort medium)
export ANTHROPIC_DEFAULT_HAIKU_MODEL=sonnet
export PATH=$HOME/.local/bin:$HOME/.dotnet:$HOME/.dotnet/tools:$PATH

exec 9>"$STATE_DIR/lock"
flock -n 9 || { echo "another maintenance run is in progress"; exit 0; }

stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
log=$BASE/logs/$stamp.log
transcript=$BASE/logs/$stamp.agent.jsonl
result=$STATE_DIR/result-$stamp.json
clone=$BASE/work/$stamp
exec > >(tee -a "$log") 2>&1
echo "maintenance run $stamp (branch $BRANCH, dry run $DRY_RUN${FORCE_DUMP:+, forced dump $FORCE_DUMP}, forced pp $FORCE_PP)"

# Clones and logs older than 60 days go; a failed run's clone is kept until then for a look.
find "$BASE/work" -mindepth 1 -maxdepth 1 -mtime +60 -exec rm -rf {} +
find "$BASE/logs" "$STATE_DIR" -name '*-*Z*' -mtime +60 -delete

open_issue_number() {
  { gh issue list -R "$REPO" --state open --search "in:title \"$1\"" --json number,title || echo '[]'; } |
    jq -r --arg t "$1" '[.[] | select(.title == $t)][0].number // empty'
}

# Opens an issue with this title, or comments on the open one, which GitHub emails the owner.
raise_issue() {
  local title=$1 body=$2
  [ "$DRY_RUN" = 1 ] && { echo "(dry run: no issue \"$title\")"; return 0; }
  local existing
  existing=$(open_issue_number "$title")
  if [ -n "$existing" ]; then
    gh issue comment "$existing" -R "$REPO" --body "$body" || true
  else
    gh issue create -R "$REPO" --title "$title" --body "$body" || true
  fi
}

report_failure() {
  local summary=$1
  echo "FAILED: $summary"
  raise_issue "$ISSUE_TITLE" "$(printf '%s\n\nRun `%s` on the maintenance VM. Its log is `~/osu-maintenance/logs/%s.log`, and the clone it worked in is kept in `~/osu-maintenance/work/%s` for 60 days.\n\nThe job keeps checking daily. When it was the agent that failed, the agent is started again only a week later while this issue is open. Close it once it is dealt with, and the next run tries at once.' \
    "$summary" "$stamp" "$stamp" "$stamp")"
}

# A failure of the agent's own, which a daily retry would most likely repeat at the cost of a
# full agent run each day. While its issue is open, the agent waits a week (see below).
report_agent_failure() {
  report_failure "$1"
  [ "$DRY_RUN" = 1 ] || touch "$STATE_DIR/agent-failed"
}

# A source that stops publishing, or renames what it publishes, looks like a quiet day to the
# check, forever. Once its newest release is over $STALE_DAYS days old (or nothing it lists is
# recognised), this opens an issue, once, and closes it when the source has something newer.
watch_source() {
  local key=$1 title=$2 body=$3 open
  if [ "$(jq -r ".$key.stale" <<<"$check")" = true ]; then
    echo "WARNING: $title ($(jq -r ".$key.latest // \"nothing recognised\"" <<<"$check"))"
    [ "$DRY_RUN" = 1 ] && { echo "(dry run: no issue \"$title\")"; return 0; }
    [ -n "$(open_issue_number "$title")" ] || gh issue create -R "$REPO" --title "$title" --body "$body" || true
  elif [ "$DRY_RUN" != 1 ]; then
    open=$(open_issue_number "$title")
    [ -z "$open" ] || gh issue close "$open" -R "$REPO" --comment "The daily check found $(jq -r ".$key.latest" <<<"$check") on $stamp." || true
  fi
}

watch_sources() {
  # What the check found: the newest release and its age, or that nothing matched.
  local found='if .KEY.latest then "is \(.KEY.latest), over \($d) days old" else "is none: nothing listed matches the names it expects" end'
  local rank_found pp_found
  rank_found=$(jq -r --arg d "$STALE_DAYS" "${found//KEY/rank}" <<<"$check")
  pp_found=$(jq -r --arg d "$STALE_DAYS" "${found//KEY/pp}" <<<"$check")
  watch_source rank "$RANK_STALE_TITLE" "$(printf 'The newest complete rank dump the daily check finds on https://data.ppy.sh/ %s. Dumps normally come monthly, so ppy may have renamed the files, moved them or stopped publishing them, and the rank curves will not be refreshed until this is looked at.\n\nThe check expects `<YYYY_MM_DD>_performance_<mode>_random_10000.tar.bz2` for all four modes (`latestCompleteDump` in `tools/maintenance/check.mjs`, and `scripts/build-rank-table.mjs`). This issue closes itself when a newer dump is found.' \
    "$rank_found")"
  watch_source pp "$PP_STALE_TITLE" "$(printf 'The newest stable osu! version the daily check finds on NuGet, published for all five packages, %s. osu! normally releases far more often, so its packages may have been renamed or stopped, and pp reworks will not be followed until this is looked at.\n\nThe check reads `ppy.osu.Game` and its four `ppy.osu.Game.Rulesets.*` packages (`PACKAGES` in `tools/maintenance/check.mjs`, and `tools/PpCalculator/PpCalculator.csproj`). This issue closes itself when a newer version is found.' \
    "$pp_found")"
}

report_claude_auth() {
  local error=$1
  echo "FAILED: Claude Code can't sign in: $error"
  rm -f "$STATE_DIR/claude-ok"
  raise_issue "$AUTH_TITLE" "$(printf 'The maintenance job'"'"'s Claude Code token was refused (`%s`), so updates can'"'"'t be made until it is renewed. On the VM:\n\n```\nsudo -iu osubot claude setup-token\ngit clone -q https://github.com/%s.git /tmp/olp && sudo bash /tmp/olp/tools/maintenance/set-secrets.sh; rm -rf /tmp/olp\n```\n\nAt the GitHub token prompt, press Enter to keep it, and paste the new Claude token. The next check closes this issue when it can sign in again.' \
    "$error" "$REPO")"
}

# The agent's last word: its result event's text when that is an error, else nothing.
agent_error() {
  [ -s "$1" ] || return 0
  jq -rR 'fromjson? | select(.type == "result" and .is_error == true) | .result // empty' "$1" | tail -1
}

has_result() {
  [ -s "$1" ] && jq -R 'fromjson? | select(.type == "result")' "$1" | grep . >/dev/null
}

is_auth_error() {
  grep -qiE 'Failed to authenticate|Invalid bearer token|OAuth token|Not logged in|authentication_error' <<<"$1"
}

# A version priced and found to change no pp is skipped until a newer one appears.
record_not_rework() {
  jq --arg v "$1" '.ppNotRework = ((.ppNotRework + [$v]) | unique)' "$STATE_DIR/state.json" \
    > "$STATE_DIR/state.json.new" && mv "$STATE_DIR/state.json.new" "$STATE_DIR/state.json"
}

# Step 2 of the procedure's comparison, without the agent: the current helper and one built at
# osu! $1, asked the same questions. Returns 0 only when every answer is identical, so the new
# version changes no pp. Anything else (pp differs, a build or helper fails, osu! moved to a newer
# .NET) is the agent's to look into. Always leaves the clone as it found it.
pp_unchanged() {
  local latest=$1 csproj=tools/PpCalculator/PpCalculator.csproj built=0
  rm -rf "$BASE/work/pp-old" "$BASE/work/pp-new"
  npm ci --no-audit --no-fund --loglevel=error || return 2
  node scripts/build-pp-helper.mjs "$BASE/work/pp-old" --full || return 2
  sed -i -E "s|(Include=\"ppy\.osu\.Game[A-Za-z.]*\" Version=\")[^\"]*\"|\1$latest\"|" "$csproj"
  if [ "$(grep -c "Version=\"$latest\"" "$csproj")" != 5 ]; then
    echo "PpCalculator.csproj doesn't have the five osu! packages it should"
    built=2
  elif ! node scripts/build-pp-helper.mjs "$BASE/work/pp-new" --full; then
    built=2
  fi
  git checkout -q -- "$csproj"
  [ "$built" = 0 ] || return 2
  node scripts/pp-parity.mjs "$BASE/work/pp-old" "$BASE/work/pp-new"
}

# Both tokens are checked, so one that stopped working is reported within a week, not the month
# an update is next due. A dead GitHub token can't open an issue to say so; GitHub itself emails
# the owner a week before a token expires. The GitHub check is free and runs every time.
if [ "$(gh api "repos/$REPO" --jq .permissions.push 2>/dev/null)" != true ]; then
  echo "FAILED: the GitHub token can't push to $REPO (expired or revoked?), so no issue can be opened"
  exit 1
fi
# Asking Claude Code costs a little each time, so it's asked once a week (and every run while it
# isn't answering). vm-ops' daily health check tests the same token on the owner's VM.
claude_ok=$STATE_DIR/claude-ok
if [ -n "$(find "$claude_ok" -mtime -6 2>/dev/null)" ] && [ "${OSU_MAINT_TEST_BAD_CLAUDE_TOKEN:-0}" != 1 ]; then
  echo "Claude Code token: signed in within the last 6 days"
else
  probe=$BASE/logs/$stamp.probe.jsonl
  (cd "$BASE" && timeout 180 claude -p "Reply with exactly: OK" "${CHECK_MODEL[@]}" --output-format stream-json --verbose \
    > "$probe" 2>&1) || true
  probe_error=$(agent_error "$probe")
  if is_auth_error "$probe_error"; then
    report_claude_auth "$probe_error"
    exit 1
  elif [ -n "$probe_error" ] || ! has_result "$probe"; then
    # Not a sign-in problem (an outage, say): carry on, and let a run with work report what fails.
    echo "warning: the Claude Code check didn't answer: ${probe_error:-no result}"
  else
    echo "Claude Code token: OK"
    touch "$claude_ok"
    [ "$DRY_RUN" = 1 ] || {
      signed_in=$(open_issue_number "$AUTH_TITLE")
      [ -z "$signed_in" ] || gh issue close "$signed_in" -R "$REPO" --comment "The check signed in again on $stamp." || true
    }
  fi
  rm -f "$probe"
fi

trap 'report_failure "The job script stopped at line $LINENO before the work was finished."' ERR

git clone -q --branch "$BRANCH" "https://github.com/$REPO.git" "$clone"
cd "$clone"

check=$(node tools/maintenance/check.mjs --state "$STATE_DIR/state.json" --stale-days "$STALE_DAYS")
echo "$check"
watch_sources
if [ -n "$FORCE_DUMP" ]; then
  check=$(jq --arg d "$FORCE_DUMP" '.rank.latest = $d | .rank.due = true | .due = true' <<<"$check")
fi
if [ "$FORCE_PP" = 1 ]; then
  check=$(jq '.pp.latest = .pp.current | .pp.due = true | .due = true' <<<"$check")
fi
# Most osu! versions change no pp, and finding that out needs no agent.
if [ "$(jq -r .pp.due <<<"$check")" = true ]; then
  pp_latest=$(jq -r .pp.latest <<<"$check")
  echo "pricing osu! $pp_latest against $(jq -r .pp.current <<<"$check")"
  if pp_unchanged "$pp_latest"; then
    echo "osu! $pp_latest changes no pp"
    if [ "$DRY_RUN" = 1 ]; then
      echo "(dry run: $pp_latest not recorded)"
    else
      record_not_rework "$pp_latest"
    fi
    check=$(jq '.pp.due = false | .pp.knownNotRework = true | .due = (.release.due or .rank.due)' <<<"$check")
  else
    echo "osu! $pp_latest may change pp, or couldn't be compared here: the agent prices it"
  fi
fi
if [ "$(jq -r .due <<<"$check")" != true ]; then
  echo "nothing new"
  cd "$BASE" && rm -rf "$clone"
  exit 0
fi
# After the agent failed, it isn't started again for a week while that failure's issue is open:
# the job checks daily, and the same failure every day would cost a full agent run each time.
# Closing the issue lets the next run try at once.
if [ "$DRY_RUN" != 1 ] && [ -n "$(find "$STATE_DIR/agent-failed" -mtime -7 2>/dev/null)" ]; then
  failed_issue=$(open_issue_number "$ISSUE_TITLE")
  if [ -n "$failed_issue" ]; then
    echo "the agent failed less than a week ago and issue #$failed_issue is still open: not starting it again yet"
    cd "$BASE" && rm -rf "$clone"
    exit 0
  fi
fi
if [ "$CHECK_ONLY" = 1 ]; then
  echo "check only: the agent would start for $(jq -c '{release: .release.due, rank: .rank.due, pp: .pp.due}' <<<"$check")"
  cd "$BASE" && rm -rf "$clone"
  exit 0
fi
mode=publish
[ "$DRY_RUN" = 1 ] && mode=dry-run

prompt="You are this repository's daily maintenance job, running unattended on the owner's VM.
Nobody will answer questions: decide from the documents, or stop and report a failure.

Follow docs/automated-maintenance.md exactly, from \"The procedure\" on. CLAUDE.md applies too.

Mode: $mode
Result file: $result
Today (UTC): $(date -u +%Y-%m-%d)

What tools/maintenance/check.mjs found:
$check"

trap - ERR
status=0
# Its own process group, so everything it started can be stopped with it.
setsid timeout 5h claude -p "$prompt" "${AGENT_MODEL[@]}" --dangerously-skip-permissions --output-format stream-json --verbose \
  > "$transcript" &
agent=$!
# The agent can finish and still not exit, waiting on a background command of its own that never
# ends. Ten minutes after it writes its result, it and whatever it left running are stopped.
while kill -0 "$agent" 2>/dev/null; do
  if [ -s "$result" ] && [ $(($(date +%s) - $(stat -c %Y "$result"))) -gt 600 ]; then
    echo "the agent wrote its result 10 minutes ago and is still running; stopping it"
    kill -TERM -- "-$agent" 2>/dev/null || true
    break
  fi
  sleep 15
done
wait "$agent" || status=$?
echo "agent exited with $status; transcript in $transcript"

if [ ! -s "$result" ]; then
  last_error=$(agent_error "$transcript")
  if is_auth_error "$last_error"; then
    report_claude_auth "$last_error"
  else
    report_agent_failure "The agent finished (exit $status) without writing its result file.${last_error:+ Its last error: \`$last_error\`}"
  fi
  exit 1
fi
cat "$result"

outcome=$(jq -r '.status // "missing"' "$result")
summary=$(jq -r '.summary // "No summary."' "$result")

not_rework=$(jq -r 'select(.ppRework == false) | .ppEvaluated // empty' "$result")
if [ -n "$not_rework" ] && [ "$outcome" != failed ] && [ "$DRY_RUN" != 1 ]; then
  record_not_rework "$not_rework"
fi

case "$outcome" in
  released | nothing | dry-run)
    echo "done: $outcome. $summary"
    # An email too, through the VM's own alerts (github.com/jonathant09/oracle-vm) when it has them.
    if [ "$outcome" = released ] && command -v vm-alert >/dev/null; then
      vm-alert --subject "osu! local profiles v$(jq -r '.version // "?"' "$result") released" --body "$summary" || true
    fi
    [ "$DRY_RUN" = 1 ] || { cd "$BASE" && rm -rf "$clone"; }
    ;;
  *)
    report_agent_failure "$summary"
    exit 1
    ;;
esac
