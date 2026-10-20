#!/usr/bin/env bash
# Sets up the weekly maintenance job (docs/automated-maintenance.md) on an Ubuntu VM. Run as
# root from a checkout; running it again updates everything in place:
#
#   sudo bash tools/maintenance/setup-vm.sh [--git-identity "Name <email>"] [--enable-timer]
#
# Installs bzip2, jq, Node 24 and the GitHub CLI system-wide, creates the unprivileged job user,
# gives it its own .NET SDK and Claude Code (so the job can install a newer .NET when osu! moves
# without root), installs run.sh and the systemd units, and enables the timer if asked. The two
# tokens are stored separately, by set-secrets.sh.
set -euo pipefail

BOT=osubot
here=$(cd "$(dirname "$0")" && pwd)
identity=
enable_timer=0
while [ $# -gt 0 ]; do
  case "$1" in
    --git-identity) identity=$2; shift 2 ;;
    --enable-timer) enable_timer=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run this with sudo" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq bzip2 git curl jq ca-certificates >/dev/null

if ! node -v 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v gh >/dev/null; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y -qq gh >/dev/null
fi

id "$BOT" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$BOT"

# Everything below runs as the job user, from stdin, since it can't read this checkout.
sudo -u "$BOT" -H bash -s -- "$identity" <<'AS_BOT'
set -euo pipefail
identity=$1

curl -fsSL https://dot.net/v1/dotnet-install.sh -o ~/dotnet-install.sh
chmod +x ~/dotnet-install.sh
~/dotnet-install.sh --channel 10.0 --install-dir ~/.dotnet >/dev/null

[ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash >/dev/null

if ! grep -q 'osu-maintenance PATH' ~/.bashrc; then
  cat >> ~/.bashrc <<'EOF'
# osu-maintenance PATH
export DOTNET_ROOT=$HOME/.dotnet DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export PATH=$HOME/.local/bin:$HOME/.dotnet:$HOME/.dotnet/tools:$PATH
EOF
fi

# git asks gh for credentials, and gh reads GH_TOKEN from the job's environment.
gh auth setup-git --hostname github.com 2>/dev/null || git config --global credential.https://github.com.helper '!gh auth git-credential'
if [ -n "$identity" ]; then
  git config --global user.name "${identity% <*}"
  git config --global user.email "$(sed -E 's/.*<(.*)>.*/\1/' <<<"$identity")"
fi
mkdir -p ~/osu-maintenance/logs ~/osu-maintenance/work ~/.local/state/osu-maintenance ~/.config/osu-maintenance
chmod 700 ~/.config/osu-maintenance
AS_BOT

install -o "$BOT" -g "$BOT" -m 755 "$here/run.sh" "/home/$BOT/osu-maintenance/run.sh"
install -m 644 "$here/osu-maintenance.service" "$here/osu-maintenance.timer" /etc/systemd/system/
systemctl daemon-reload
[ "$enable_timer" = 1 ] && systemctl enable --now osu-maintenance.timer

echo
sudo -u "$BOT" -H bash -c 'echo "node $(node -v), $(~/.dotnet/dotnet --version) .NET SDK, $(~/.local/bin/claude --version), $(gh --version | head -1)"; echo "git identity: $(git config --global user.name) <$(git config --global user.email)>"'
[ -s "/home/$BOT/.config/osu-maintenance/env" ] || echo "Next: store the tokens with  sudo bash $here/set-secrets.sh"
systemctl list-timers osu-maintenance.timer --no-pager || true
