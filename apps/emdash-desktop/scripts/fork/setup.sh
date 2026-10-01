#!/usr/bin/env bash
# One-time setup of the fork on a Mac (Apple silicon or Intel): puts the `emdash-update`
# and `emdash-android` commands on PATH, creates the personal settings file
# (~/.config/emdash-fork/config), then offers to build and install Emdash Fork.
#   setup.sh              set up, then ask before installing
#   setup.sh --yes        set up and install without asking
#   setup.sh --uninstall  remove the two commands (the app, its data and this checkout stay)
# Run it again at any time: every step is skipped when already done.
set -euo pipefail

script="$(readlink -f "${BASH_SOURCE[0]}")"
fork_dir="$(dirname "$script")"
repo_root="$(cd "$fork_dir/../../../.." && pwd)"
bin_dir="${EMDASH_FORK_BIN:-$HOME/.local/bin}"
config_dir="$HOME/.config/emdash-fork"
commands=(
  "emdash-update:$fork_dir/update.sh"
  "emdash-android:$repo_root/apps/emdash-android/build.sh"
)

mode=setup
case "${1:-}" in
  '') ;;
  -y | --yes) mode=yes ;;
  --uninstall) mode=uninstall ;;
  -h | --help)
    sed -n '2,8p' "$script" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    exit 2
    ;;
esac

if [ "$mode" = uninstall ]; then
  for entry in "${commands[@]}"; do
    name="${entry%%:*}"
    link="$bin_dir/$name"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "${entry#*:}" ]; then
      rm "$link" && echo "Removed $link"
    fi
  done
  echo "The app stays in /Applications/Emdash Fork.app and its data in"
  echo "~/Library/Application Support/emdash-fork; delete them by hand to remove them too."
  exit 0
fi

# ── What has to be installed first ───────────────────────────────────────────
missing=0
if [ "$(uname)" != Darwin ]; then
  echo "This setup is for macOS." >&2
  exit 1
fi
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Missing Xcode Command Line Tools (git, codesign): run  xcode-select --install" >&2
  missing=1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Missing pnpm: run  brew install pnpm  (or see https://pnpm.io/installation)." >&2
  echo "  pnpm fetches the Node.js version this project pins by itself." >&2
  missing=1
fi
[ "$missing" = 0 ] || exit 1

case "$(uname -m)" in
  arm64) echo "Mac: Apple silicon (builds arm64)" ;;
  x86_64)
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
      echo "Mac: Apple silicon, but this Terminal runs under Rosetta (builds x64)."
      echo "  For a native build, quit Terminal, untick Get Info → Open using Rosetta, rerun."
    else
      echo "Mac: Intel (builds x64)"
    fi
    ;;
esac

# ── Commands ─────────────────────────────────────────────────────────────────
mkdir -p "$bin_dir"
for entry in "${commands[@]}"; do
  name="${entry%%:*}"
  target="${entry#*:}"
  link="$bin_dir/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "Kept $link: a file of yours already has that name." >&2
    continue
  fi
  ln -sfn "$target" "$link"
  echo "Command $name → $target"
done

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    case "${SHELL:-}" in
      */bash) rc="$HOME/.bash_profile" ;;
      *) rc="$HOME/.zshrc" ;;
    esac
    line="export PATH=\"$bin_dir:\$PATH\""
    if ! grep -qF "$line" "$rc" 2>/dev/null; then
      printf '\n# Added by Emdash Fork setup\n%s\n' "$line" >>"$rc"
      echo "Added $bin_dir to PATH in $rc (takes effect in new terminals)."
    fi
    export PATH="$bin_dir:$PATH"
    ;;
esac

# ── Personal settings ────────────────────────────────────────────────────────
mkdir -p "$config_dir"
if [ ! -f "$config_dir/config" ]; then
  cat >"$config_dir/config" <<'EOF'
# Emdash Fork personal settings, read by emdash-update and emdash-android.
# Shell syntax; uncomment a line to use it.

# Sign each build with a stable certificate, so macOS keeps the app's permissions and
# keychain access across updates (unsigned builds ask again after every update).
# List yours with:  security find-identity -v -p codesigning
#EMDASH_FORK_SIGN_IDENTITY="Apple Development: you@example.com (ABCDE12345)"

# Android SDK and JDK 17+ for emdash-android (defaults: Android Studio's locations).
#ANDROID_HOME="$HOME/Library/Android/sdk"
#JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
EOF
  echo "Created $config_dir/config (personal settings, all optional)"
fi

# The official repository: the fork's build number counts the commits on top of it.
if ! git -C "$repo_root" remote get-url upstream >/dev/null 2>&1; then
  git -C "$repo_root" remote add upstream https://github.com/generalaction/emdash.git
  echo "Added the official repository as remote 'upstream'"
fi

# ── Install ──────────────────────────────────────────────────────────────────
echo
if [ "$mode" != yes ]; then
  read -r -p "Build and install Emdash Fork now (about 5 minutes)? [Y/n] " answer
  case "$answer" in
    n | N | no)
      echo "Later, run:  emdash-update"
      exit 0
      ;;
  esac
fi
exec "$fork_dir/update.sh" -y
