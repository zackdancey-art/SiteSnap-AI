#!/usr/bin/env bash
#
# One command: measure the Add Signature sheet on the simulator and print a
# PASS/FAIL report. See docs/SIGNATURE-LAYOUT-PROBE.md for what it can and
# cannot see.
#
#   ./Projects/apps/mobile/scripts/signature-probe.sh
#
# Everything it starts, it stops again on exit.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../../.." && pwd)"
APP_ID="nz.getsitesnapai.app"
PREFERRED_DEVICE="${SIGNATURE_PROBE_DEVICE:-iPhone 17 Pro}"
OUT_DIR="${SIGNATURE_PROBE_OUT:-$REPO_ROOT/scratchpad/probe}"
METRO_PORT=8081
API_PORT=4000

mkdir -p "$OUT_DIR"
METRO_LOG="$OUT_DIR/metro.log"
API_LOG="$OUT_DIR/api.log"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

say() { printf '\n==> %s\n' "$1"; }

# --- 1. a booted simulator ------------------------------------------------
UDID="$(xcrun simctl list devices booted -j | python3 -c '
import json,sys
d=json.load(sys.stdin)["devices"]
for rt in d.values():
    for dev in rt:
        print(dev["udid"]); raise SystemExit
' || true)"

if [ -z "$UDID" ]; then
  say "No simulator booted — booting $PREFERRED_DEVICE"
  UDID="$(xcrun simctl list devices available -j | python3 -c "
import json,sys
d=json.load(sys.stdin)['devices']
for rt in d.values():
    for dev in rt:
        if dev['name']=='$PREFERRED_DEVICE':
            print(dev['udid']); raise SystemExit
")"
  [ -n "$UDID" ] || { echo "Could not find a '$PREFERRED_DEVICE' simulator." >&2; exit 1; }
  xcrun simctl boot "$UDID"
fi
say "Simulator: $UDID"

# The software keyboard must be able to appear, or the keyboard-open pass
# cannot run (it is then reported as NOT RUN, never as a pass).
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false || true
/usr/libexec/PlistBuddy -c "Set :DevicePreferences:$UDID:ConnectHardwareKeyboard false" \
  ~/Library/Preferences/com.apple.iphonesimulator.plist 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :DevicePreferences:$UDID:ConnectHardwareKeyboard bool false" \
       ~/Library/Preferences/com.apple.iphonesimulator.plist 2>/dev/null || true
open -a Simulator
# Suppress the dev-menu onboarding overlay, which otherwise covers the sheet.
xcrun simctl spawn "$UDID" defaults write "$APP_ID" EXDevMenuIsOnboardingFinished -bool true || true

if ! xcrun simctl get_app_container "$UDID" "$APP_ID" >/dev/null 2>&1; then
  cat >&2 <<'MSG'
The development build is not installed on this simulator.
Install it first (this is the dev client, not the App Store build):
  cd Projects/apps/mobile && npx eas build --profile development --platform ios
then drag the resulting .app onto the simulator, or use `eas build:run`.
MSG
  exit 1
fi

# --- 2. a local API, so the run does not touch production -----------------
if lsof -ti:"$API_PORT" >/dev/null 2>&1; then
  say "Something is already listening on :$API_PORT — using it"
else
  say "Starting the API on :$API_PORT (in-memory store, no database)"
  ( cd "$REPO_ROOT" && PORT="$API_PORT" pnpm -C Projects --filter services-api run dev ) >"$API_LOG" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://localhost:$API_PORT/api/health" && break
    sleep 1
  done
fi

# --- 3. Metro, with the probe switched on ---------------------------------
say "Starting Metro (cache cleared)"
( cd "$MOBILE_DIR" && \
  EXPO_PUBLIC_API_BASE_URL="http://localhost:$API_PORT" \
  EXPO_PUBLIC_API_URL="http://localhost:$API_PORT" \
  EXPO_PUBLIC_SIGNATURE_PROBE=1 \
  npx expo start --dev-client --port "$METRO_PORT" --clear ) >"$METRO_LOG" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 120); do
  grep -q "Waiting on http://localhost:$METRO_PORT" "$METRO_LOG" 2>/dev/null && break
  sleep 1
done

# --- 4. run it ------------------------------------------------------------
say "Launching the app"
xcrun simctl terminate "$UDID" "$APP_ID" 2>/dev/null || true
sleep 2
xcrun simctl openurl "$UDID" \
  "sitesnap://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$METRO_PORT"

say "Waiting for the measurement (up to 3 minutes)"
for _ in $(seq 1 180); do
  grep -q "SIGPROBE_REPORT_END" "$METRO_LOG" 2>/dev/null && break
  sleep 1
done

if ! grep -q "SIGPROBE_REPORT_END" "$METRO_LOG" 2>/dev/null; then
  echo "The probe did not report. Full Metro output: $METRO_LOG" >&2
  exit 1
fi

awk '/SIGPROBE_REPORT_BEGIN/,/SIGPROBE_REPORT_END/' "$METRO_LOG" \
  | sed 's/^ LOG  //' > "$OUT_DIR/last-run.txt"
xcrun simctl io "$UDID" screenshot "$OUT_DIR/last-run.png" >/dev/null 2>&1 || true

cat "$OUT_DIR/last-run.txt"
echo
echo "Report:     $OUT_DIR/last-run.txt"
echo "Screenshot: $OUT_DIR/last-run.png"

grep -q '^=> GREEN' "$OUT_DIR/last-run.txt"
