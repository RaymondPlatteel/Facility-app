#!/bin/sh
# Build the web app, sync into the iOS project, then build + install + launch
# on an iPhone (must be connected and unlocked). Ray's by default; pass part
# of another paired phone's name to target it instead:
#   npm run phone -- abram
set -e

# CocoaPods crashes with an encoding error when no UTF-8 locale is set
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Capacitor CLI 8 needs Node >=22; prefer homebrew's node over /usr/local's v20
export PATH="/opt/homebrew/bin:$PATH"

RAY_UDID="00008130-001629EC0A62001C"            # Ray's iPhone (hardware UDID)
DEVICE_NAME="${1:-}"
# devicectl's id for a phone differs from Mac to Mac (and drifts when the
# wireless pairing is redone), so a hardcoded one kept breaking whichever
# Mac didn't write it last. Both ids are looked up here: by hardware UDID
# for Ray's phone, by name for anyone else's. Prints
# "<hardware udid> <devicectl id>".
DEVICES_JSON="$(mktemp)"
xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null 2>&1
IDS="$(python3 -c '
import json, sys
path, udid, name = sys.argv[1:4]
for d in json.load(open(path))["result"]["devices"]:
    hw = d.get("hardwareProperties", {})
    label = d.get("deviceProperties", {}).get("name", "").replace("\u2019", "'"'"'").lower()
    if hw.get("platform") != "iOS":
        continue
    if (name and name.lower() in label) or (not name and hw.get("udid") == udid):
        print(hw.get("udid"), d["identifier"])
        break
' "$DEVICES_JSON" "$RAY_UDID" "$DEVICE_NAME")"
rm -f "$DEVICES_JSON"
XCODE_UDID="${IDS%% *}"                          # xcodebuild destination id
DEVICECTL_UDID="${IDS#* }"
if [ -z "$IDS" ]; then
  echo "No paired iPhone matching \"${DEVICE_NAME:-$RAY_UDID}\" — is it paired with this Mac?" >&2
  exit 1
fi
# Must match PRODUCT_BUNDLE_IDENTIFIER in ios/App/App.xcodeproj, which is
# NOT capacitor.config.ts's appId (com.raymondplatteel.facilityapp) — the
# install step succeeds either way, but the launch step looks the app up by
# this id and fails with "is not installed" when it disagrees with Xcode.
BUNDLE_ID="com.raymondplatteel.facilityapp"

cd "$(dirname "$0")/.."

npm run build
npx cap sync ios

cd ios/App
xcodebuild -workspace App.xcworkspace -scheme App \
  -destination "platform=iOS,id=$XCODE_UDID" \
  -allowProvisioningUpdates build

APP_PATH="$(xcodebuild -workspace App.xcworkspace -scheme App \
  -destination "platform=iOS,id=$XCODE_UDID" -showBuildSettings 2>/dev/null \
  | awk -F' = ' '/ BUILT_PRODUCTS_DIR/ { print $2; exit }')/App.app"

xcrun devicectl device install app --device "$DEVICECTL_UDID" "$APP_PATH"
xcrun devicectl device process launch --device "$DEVICECTL_UDID" "$BUNDLE_ID"
