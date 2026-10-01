#!/usr/bin/env bash
# Builds the Emdash Android app into apps/emdash-android/Emdash.apk.
#   --install  also installs it on the phones adb sees (USB or wireless debugging)
#   --serve    also serves it over HTTP, to download in the phone's browser
# Needs the Android SDK (ANDROID_HOME, or Android Studio's default location) and JDK 17+.
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

install=0
serve=0
for arg in "$@"; do
  case "$arg" in
    --install) install=1 ;;
    --serve) serve=1 ;;
    -h | --help)
      sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ ! -d "$ANDROID_HOME/platforms" ]; then
  echo "No Android SDK at $ANDROID_HOME; set ANDROID_HOME." >&2
  exit 1
fi
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17+ 2>/dev/null || true)"
  export JAVA_HOME
fi

./gradlew --quiet assembleDebug
cp app/build/outputs/apk/debug/app-debug.apk Emdash.apk
echo "Built $(pwd)/Emdash.apk"

if [ "$install" = 1 ]; then
  adb="$ANDROID_HOME/platform-tools/adb"
  devices="$("$adb" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  if [ -z "$devices" ]; then
    echo "No phone connected to adb." >&2
    exit 1
  fi
  for device in $devices; do
    "$adb" -s "$device" install -r Emdash.apk >/dev/null
    echo "Installed on $device"
  done
fi

if [ "$serve" = 1 ]; then
  port=7790
  # Only the APK is served, from a folder of its own.
  dir="$(mktemp -d)"
  cp Emdash.apk "$dir/"
  echo "On the phone, open one of these and install the download (Ctrl-C to stop):"
  ifconfig | awk '/inet / && $2 != "127.0.0.1" { print "  http://" $2 ":'"$port"'/Emdash.apk" }'
  exec python3 -m http.server "$port" --bind 0.0.0.0 --directory "$dir"
fi
