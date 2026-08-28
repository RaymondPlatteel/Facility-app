#!/bin/sh
# Build the web app, sync into the iOS project, then build + install + launch
# on Ray's iPhone (must be connected and unlocked).
set -e

# CocoaPods crashes with an encoding error when no UTF-8 locale is set
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Capacitor CLI 8 needs Node >=22; prefer homebrew's node over /usr/local's v20
export PATH="/opt/homebrew/bin:$PATH"

XCODE_UDID="00008130-001629EC0A62001C"          # xcodebuild destination id
DEVICECTL_UDID="B31F79AD-E46B-50B5-AC98-455E33FF44EA"  # devicectl device id
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
