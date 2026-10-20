#!/usr/bin/env bash
# Stores the maintenance job's two tokens for its user, then checks that both work. Run as root:
#
#   sudo bash tools/maintenance/set-secrets.sh
#
# - GitHub: a fine-grained token for jonathant09/osu-local-profiles only, with Contents,
#   Pull requests, Issues and Workflows set to read and write (Workflows because a .NET move
#   edits .github/workflows), and Actions and Commit statuses read.
# - Claude: the token `claude setup-token` prints, run as the job user
#   (sudo -iu osubot claude setup-token).
#
# Neither is echoed, and the file is readable by the job user alone.
set -euo pipefail

BOT=osubot
REPO=jonathant09/osu-local-profiles
dir=/home/$BOT/.config/osu-maintenance
[ "$(id -u)" = 0 ] || { echo "run this with sudo" >&2; exit 1; }

# A long token copied from a terminal often carries the space or line break where it wrapped,
# so whitespace is dropped. An empty answer keeps the token already stored.
stored() { [ -f "$dir/env" ] && sed -n "s/^$1=//p" "$dir/env" || true; }
read -rsp "GitHub token (Enter keeps the stored one): " gh_token; echo
read -rsp "Claude token (Enter keeps the stored one): " claude_token; echo
gh_token=$(tr -d '[:space:]' <<<"$gh_token")
claude_token=$(tr -d '[:space:]' <<<"$claude_token")
[ -n "$gh_token" ] || gh_token=$(stored GH_TOKEN)
[ -n "$claude_token" ] || claude_token=$(stored CLAUDE_CODE_OAUTH_TOKEN | tr -d '[:space:]')
[ -n "$gh_token" ] && [ -n "$claude_token" ] || { echo "both tokens are needed" >&2; exit 1; }

install -d -o "$BOT" -g "$BOT" -m 700 "$dir"
(umask 077; printf 'GH_TOKEN=%s\nCLAUDE_CODE_OAUTH_TOKEN=%s\n' "$gh_token" "$claude_token" > "$dir/env")
chown "$BOT:$BOT" "$dir/env"
unset gh_token claude_token

echo "checking the GitHub token..."
sudo -u "$BOT" -H bash -c "set -a; . $dir/env; set +a
  gh api repos/$REPO --jq '\"  repository: \" + .full_name + \", can push: \" + (.permissions.push | tostring)'
  gh issue list -R $REPO --limit 1 >/dev/null && echo '  issues: readable'
  gh pr list -R $REPO --limit 1 >/dev/null && echo '  pull requests: readable'
  gh run list -R $REPO --limit 1 >/dev/null && echo '  actions: readable'"

echo "checking the Claude token..."
sudo -u "$BOT" -H bash -c "set -a; . $dir/env; set +a; cd ~ && ~/.local/bin/claude -p 'Reply with exactly: token OK'" | sed 's/^/  /'
