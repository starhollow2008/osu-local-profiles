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
#   OSU_MAINT_TEST_BAD_CLAUDE_TOKEN=1   use a token Claude Code refuses, to see the sign-in report
set -euo pipefail

REPO=jonathant09/osu-local-profiles
BRANCH=${OSU_MAINT_BRANCH:-main}
DRY_RUN=${OSU_MAINT_DRY_RUN:-0}
FORCE_DUMP=${OSU_MAINT_FORCE_DUMP:-}
FORCE_PP=${OSU_MAINT_FORCE_PP:-0}
BASE=$HOME/osu-maintenance
STATE_DIR=$HOME/.local/state/osu-maintenance
ISSUE_TITLE="Automated maintenance failed"
AUTH_TITLE="Maintenance: Claude Code can't sign in"

mkdir -p "$BASE/logs" "$BASE/work" "$STATE_DIR"
[ -f "$STATE_DIR/state.json" ] || echo '{"ppNotRework":[]}' > "$STATE_DIR/state.json"

# GH_TOKEN (fine-grained, this repository only) and CLAUDE_CODE_OAUTH_TOKEN, from set-secrets.sh.
set -a
. "$HOME/.config/osu-maintenance/env"
set +a
[ "${OSU_MAINT_TEST_BAD_CLAUDE_TOKEN:-0}" = 1 ] && CLAUDE_CODE_OAUTH_TOKEN=invalid-test-token
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
  raise_issue "$ISSUE_TITLE" "$(printf '%s\n\nRun `%s` on the maintenance VM. Its log is `~/osu-maintenance/logs/%s.log`, and the clone it worked in is kept in `~/osu-maintenance/work/%s` for 60 days.\n\nThe job keeps running weekly. Close this issue once it is dealt with.' \
    "$summary" "$stamp" "$stamp" "$stamp")"
}

report_claude_auth() {
  local error=$1
  echo "FAILED: Claude Code can't sign in: $error"
  raise_issue "$AUTH_TITLE" "$(printf 'The maintenance job'"'"'s Claude Code token was refused (`%s`), so updates can'"'"'t be made until it is renewed. On the VM:\n\n```\nsudo -iu osubot claude setup-token\ngit clone -q https://github.com/%s.git /tmp/olp && sudo bash /tmp/olp/tools/maintenance/set-secrets.sh; rm -rf /tmp/olp\n```\n\nAt the GitHub token prompt, press Enter to keep it, and paste the new Claude token. The next weekly check closes this issue when it can sign in again.' \
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

# Both tokens are checked every week, so one that stopped working is reported within a week, not
# the month an update is next due. A dead GitHub token can't open an issue to say so; GitHub
# itself emails the owner a week before a token expires.
if [ "$(gh api "repos/$REPO" --jq .permissions.push 2>/dev/null)" != true ]; then
  echo "FAILED: the GitHub token can't push to $REPO (expired or revoked?), so no issue can be opened"
  exit 1
fi
probe=$BASE/logs/$stamp.probe.jsonl
(cd "$BASE" && timeout 180 claude -p "Reply with exactly: OK" --model haiku --output-format stream-json --verbose \
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
  [ "$DRY_RUN" = 1 ] || {
    signed_in=$(open_issue_number "$AUTH_TITLE")
    [ -z "$signed_in" ] || gh issue close "$signed_in" -R "$REPO" --comment "The weekly check signed in again on $stamp." || true
  }
fi
rm -f "$probe"

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
  last_error=$(agent_error "$transcript")
  if is_auth_error "$last_error"; then
    report_claude_auth "$last_error"
  else
    report_failure "The agent finished (exit $status) without writing its result file.${last_error:+ Its last error: \`$last_error\`}"
  fi
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
