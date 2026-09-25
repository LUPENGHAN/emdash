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
codesign --force --deep --sign - "$bundle"

# Match the process name exactly: a -f pattern would also match this script's own shell.
if pgrep -x "Emdash Fork" >/dev/null; then
  osascript -e 'tell application id "com.emdash.fork" to quit' || true
  while pgrep -x "Emdash Fork" >/dev/null; do sleep 1; done
fi
rm -rf "/Applications/Emdash Fork.app"
ditto "$bundle" "/Applications/Emdash Fork.app"
# Leave a single registered copy so Launch Services opens the installed one.
rm -rf "$app_dir/release/mac-arm64"
open "/Applications/Emdash Fork.app"
echo "Installed and launched /Applications/Emdash Fork.app"
