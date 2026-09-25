#!/usr/bin/env bash
# Build the fork as "Emdash Fork", ad-hoc sign it and install it to /Applications.
# The fork has its own bundle id, profile and keychain item, so ad-hoc signing is
# enough: it never needs the official app's keychain entry.
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/../.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
bundle="$app_dir/release/mac-arm64/Emdash Fork.app"

cd "$repo_root"
pnpm run build >/dev/null # workspace packages (desktop output is rebuilt below)

cd "$app_dir"
# Built directly, not via nx, so the cached stable build is never reused.
VITE_BUILD=fork pnpm exec electron-vite build >/dev/null
rm -rf release/mac-arm64
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --arm64 \
  --publish never --config electron-builder.fork.config.ts
# Sign with a stable local identity when one exists, so macOS privacy grants (e.g. the
# Documents access a login shell needs) survive rebuilds; ad-hoc signatures change on
# every build and re-prompt. Create it once in Keychain Access → Certificate Assistant
# → Create a Certificate… (type: Code Signing), named as below.
sign_identity="${EMDASH_FORK_SIGN_IDENTITY:-Emdash Fork Local}"
if security find-identity -v -p codesigning | grep -q "\"$sign_identity\""; then
  codesign --force --deep --sign "$sign_identity" "$bundle"
else
  codesign --force --deep --sign - "$bundle"
fi

# Match the process name exactly: a -f pattern would also match this script's own shell.
if pgrep -x "Emdash Fork" >/dev/null; then
  osascript -e 'tell application id "com.emdash.fork" to quit' || true
  while pgrep -x "Emdash Fork" >/dev/null; do sleep 1; done
fi
rm -rf "/Applications/Emdash Fork.app"
ditto "$bundle" "/Applications/Emdash Fork.app"
# Leave a single registered copy so Launch Services opens the installed one.
rm -rf "$app_dir/release/mac-arm64"
# Launch with a clean environment, as the Dock would: `open` otherwise hands the
# caller's environment (e.g. ANTHROPIC_BASE_URL) to the app and its agents.
env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/open "/Applications/Emdash Fork.app"
echo "Installed and launched /Applications/Emdash Fork.app"
