#!/usr/bin/env bash
# Build the fork as "Emdash Fork", ad-hoc sign it and install it to /Applications.
# The fork has its own bundle id, profile and keychain item, so ad-hoc signing is
# enough: it never needs the official app's keychain entry.
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/../.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"

# Personal settings (e.g. the signing identity); see FORK-GUIDE.md.
config="$HOME/.config/emdash-fork/config"
if [ -f "$config" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$config"
  set +a
fi

cd "$repo_root"
# The app is built for the architecture its native modules (better-sqlite3) were
# compiled for by `pnpm install`: that of pnpm's pinned Node, arm64 on Apple silicon
# and x64 on Intel (EMDASH_FORK_ARCH overrides it only for a checkout whose
# dependencies were installed for that architecture). electron-builder names the folder
# mac-arm64 or mac (x64).
arch="${EMDASH_FORK_ARCH:-$(pnpm exec node -p process.arch)}"
case "$arch" in
  arm64) release_dir="$app_dir/release/mac-arm64" ;;
  x64) release_dir="$app_dir/release/mac" ;;
  *)
    echo "Unsupported architecture: $arch (expected arm64 or x64)" >&2
    exit 1
    ;;
esac
if [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  echo "Note: building for Intel (x64) on Apple silicon, so it runs under Rosetta." >&2
  echo "      A Terminal opened with Rosetta runs x64 Node; open it natively for arm64." >&2
fi
bundle="$release_dir/Emdash Fork.app"

pnpm run build >/dev/null # workspace packages (desktop output is rebuilt below)

cd "$app_dir"
# Built directly, not via nx, so the cached stable build is never reused.
# The fork's build number, shown next to the official version: commits on top of the
# official release, the commit itself, and "+dirty" for uncommitted changes.
upstream_ref="$(git rev-parse --verify --quiet upstream/main || true)"
fork_commits="$(git rev-list --count "${upstream_ref:+$upstream_ref..}HEAD")"
fork_version="fork.${fork_commits} ($(git rev-parse --short=7 HEAD)$(test -z "$(git status --porcelain)" || echo '+dirty'))"
echo "Building Emdash Fork $(pnpm exec node -p 'require("./package.json").version') · $fork_version ($arch)"
VITE_BUILD=fork VITE_FORK_VERSION="$fork_version" pnpm exec electron-vite build >/dev/null
rm -rf "$release_dir"
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir "--$arch" \
  --publish never --config electron-builder.fork.config.ts
# Sign with a stable identity when one is configured, so macOS privacy and keychain
# grants (Documents access for the login shell, the fork's Safe Storage item) survive
# rebuilds; ad-hoc signatures change on every build and re-prompt. The identity (name or
# SHA-1, e.g. an "Apple Development" certificate) comes from $EMDASH_FORK_SIGN_IDENTITY
# (also settable in ~/.config/emdash-fork/config), else ~/.config/emdash-fork/sign-identity,
# else a certificate named "Emdash Fork Local".
identity_file="$HOME/.config/emdash-fork/sign-identity"
sign_identity="${EMDASH_FORK_SIGN_IDENTITY:-}"
if [ -z "$sign_identity" ] && [ -s "$identity_file" ]; then
  sign_identity="$(tr -d '[:space:]' < "$identity_file")"
fi
sign_identity="${sign_identity:-Emdash Fork Local}"
if security find-identity -v -p codesigning | grep -qF "$sign_identity"; then
  echo "Signing with a stable identity"
  codesign --force --deep --sign "$sign_identity" "$bundle"
else
  echo "No stable signing identity; signing ad-hoc"
  codesign --force --deep --sign - "$bundle"
fi

# By bundle id: macOS records the process name as the truncated path
# ("/Applications/Em"), so matching "Emdash Fork" by name never finds it.
fork_running() {
  [ "$(osascript -e 'application id "com.emdash.fork" is running' 2>/dev/null)" = true ]
}
if fork_running; then
  # emdash-update sets this once the user agreed to stop what runs in the app (its
  # question, or -y): the marker makes the app quit without asking again.
  marker="$HOME/Library/Application Support/emdash-fork/quit-for-install"
  if [ "${EMDASH_FORK_QUIT_CONFIRMED:-}" = 1 ]; then
    touch "$marker"
  fi
  # Asked again each second: a window opened on another computer is an instance of its own.
  while fork_running; do
    osascript -e 'tell application id "com.emdash.fork" to quit' >/dev/null 2>&1 || true
    sleep 1
  done
  rm -f "$marker"
fi
rm -rf "/Applications/Emdash Fork.app"
ditto "$bundle" "/Applications/Emdash Fork.app"

# The fork's own skills join Emdash's skill library (~/.agentskills) as links into this
# checkout, so pulling updates them. A skill of the user's own by that name is kept.
library="$HOME/.agentskills"
mkdir -p "$library"
# Links to fork skills since renamed or removed.
for link in "$library"/*; do
  if [ -L "$link" ] && [ ! -e "$link" ]; then
    case "$(readlink "$link")" in "$app_dir/scripts/fork/skills/"*) rm "$link" ;; esac
  fi
done
for skill in "$app_dir"/scripts/fork/skills/*/; do
  name="$(basename "$skill")"
  target="$library/$name"
  if [ -L "$target" ] || [ ! -e "$target" ]; then
    ln -sfn "${skill%/}" "$target"
  elif cmp -s "$target/SKILL.md" "$skill/SKILL.md"; then
    # A copy of this very skill (installed by hand before): replace it with the link.
    rm -rf "$target" && ln -sfn "${skill%/}" "$target"
  else
    echo "Kept your own skill $target (the fork's $name was not installed)"
  fi
done
# Leave a single registered copy so Launch Services opens the installed one.
rm -rf "$release_dir"
# Launch with a clean environment, as the Dock would: `open` otherwise hands the
# caller's environment (e.g. ANTHROPIC_BASE_URL) to the app and its agents.
env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/open "/Applications/Emdash Fork.app"
echo "Installed and launched /Applications/Emdash Fork.app"
