#!/usr/bin/env bash
# The weekly maintenance job (docs/automated-maintenance.md), run by osu-maintenance.service as
# the VM's unprivileged job user. setup-vm.sh installs this file as ~/osu-maintenance/run.sh.
#
# Clones the repository fresh, asks tools/maintenance/check.mjs whether anything is due, and
# only then starts Claude Code on the procedure in docs/automated-maintenance.md. Both of those
# are read from the clone, so changing them on main changes the next run; this file only
# changes when setup-vm.sh is run again.
#
# Testing, by hand:
#   OSU_MAINT_BRANCH=<branch>     clone that branch instead of main
#   OSU_MAINT_DRY_RUN=1           do the work in the clone, publish nothing, open no issue
#   OSU_MAINT_FORCE_DUMP=<date>   rebuild the rank curves from that dump even if it isn't new
#   OSU_MAINT_FORCE_PP=1          price the current osu! version against itself as if it were new
set -euo pipefail

REPO=jonathant09/osu-local-profiles
BRANCH=${OSU_MAINT_BRANCH:-main}
DRY_RUN=${OSU_MAINT_DRY_RUN:-0}
FORCE_DUMP=${OSU_MAINT_FORCE_DUMP:-}
FORCE_PP=${OSU_MAINT_FORCE_PP:-0}
BASE=$HOME/osu-maintenance
STATE_DIR=$HOME/.local/state/osu-maintenance
ISSUE_TITLE="Automated maintenance failed"

mkdir -p "$BASE/logs" "$BASE/work" "$STATE_DIR"
[ -f "$STATE_DIR/state.json" ] || echo '{"ppNotRework":[]}' > "$STATE_DIR/state.json"

# GH_TOKEN (fine-grained, this repository only) and CLAUDE_CODE_OAUTH_TOKEN, from set-secrets.sh.
set -a
. "$HOME/.config/osu-maintenance/env"
set +a
export DOTNET_ROOT=$HOME/.dotnet DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
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

report_failure() {
  local summary=$1
  echo "FAILED: $summary"
  [ "$DRY_RUN" = 1 ] && return 0
  local body
  body=$(printf '%s\n\nRun `%s` on the maintenance VM. Its log is `~/osu-maintenance/logs/%s.log`, and the clone it worked in is kept in `~/osu-maintenance/work/%s` for 60 days.\n\nThe job keeps running weekly. Close this issue once it is dealt with.' \
    "$summary" "$stamp" "$stamp" "$stamp")
  local existing
  existing=$(gh issue list -R "$REPO" --state open --search "in:title \"$ISSUE_TITLE\"" --json number --jq '.[0].number // empty' || true)
  if [ -n "$existing" ]; then
    gh issue comment "$existing" -R "$REPO" --body "$body" || true
  else
    gh issue create -R "$REPO" --title "$ISSUE_TITLE" --body "$body" || true
  fi
}

trap 'report_failure "The job script stopped at line $LINENO before the work was finished."' ERR

git clone -q --branch "$BRANCH" "https://github.com/$REPO.git" "$clone"
cd "$clone"

check=$(node tools/maintenance/check.mjs --state "$STATE_DIR/state.json")
echo "$check"
if [ -n "$FORCE_DUMP" ]; then
  check=$(jq --arg d "$FORCE_DUMP" '.rank.latest = $d | .rank.due = true | .due = true' <<<"$check")
fi
if [ "$FORCE_PP" = 1 ]; then
  check=$(jq '.pp.latest = .pp.current | .pp.due = true | .due = true' <<<"$check")
fi
if [ "$(jq -r .due <<<"$check")" != true ]; then
  echo "nothing new"
  cd "$BASE" && rm -rf "$clone"
  exit 0
fi
mode=publish
[ "$DRY_RUN" = 1 ] && mode=dry-run

prompt="You are this repository's weekly maintenance job, running unattended on the owner's VM.
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
setsid timeout 5h claude -p "$prompt" --dangerously-skip-permissions --output-format stream-json --verbose \
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
  report_failure "The agent finished (exit $status) without writing its result file."
  exit 1
fi
cat "$result"

outcome=$(jq -r '.status // "missing"' "$result")
summary=$(jq -r '.summary // "No summary."' "$result")

# A version priced and found to change no pp is skipped until a newer one appears.
not_rework=$(jq -r 'select(.ppRework == false) | .ppEvaluated // empty' "$result")
if [ -n "$not_rework" ] && [ "$outcome" != failed ] && [ "$DRY_RUN" != 1 ]; then
  jq --arg v "$not_rework" '.ppNotRework = ((.ppNotRework + [$v]) | unique)' "$STATE_DIR/state.json" \
    > "$STATE_DIR/state.json.new" && mv "$STATE_DIR/state.json.new" "$STATE_DIR/state.json"
fi

case "$outcome" in
  released | nothing | dry-run)
    echo "done: $outcome. $summary"
    [ "$DRY_RUN" = 1 ] || { cd "$BASE" && rm -rf "$clone"; }
    ;;
  *)
    report_failure "$summary"
    exit 1
    ;;
esac
