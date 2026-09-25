#!/bin/bash
# Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
# Proprietary software. See LICENSE, or the Licence page inside the app.
#
# release.sh - build Cube Clubhouse for the App Store in one step, on a Mac with Xcode.
#
#   TEAM_ID=ABCDE12345 ios/release.sh            archive, then write a signed .ipa to ios/build/export
#   TEAM_ID=ABCDE12345 ios/release.sh --upload   archive, then send the build to App Store Connect
#
# TEAM_ID is the 10-character Team ID from developer.apple.com > Account > Membership.
# Signing is automatic: Xcode must be signed in to an Apple ID on that team (Xcode >
# Settings > Accounts), or, for --upload without Xcode's account, set an App Store Connect
# API key with ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID.
#
# Optional:
#   BUNDLE_ID=com.you.app     use a different bundle identifier from the project's
#   VERSION=1.0.1             the version people see (MARKETING_VERSION)
#   BUILD_NUMBER=2            the build number (CURRENT_PROJECT_VERSION); on upload App
#                             Store Connect raises it for you if it has seen this one
#   --skip-tests              do not run the unit tests first
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD="$HERE/build"
ARCHIVE="$BUILD/CubeClubhouse.xcarchive"
UPLOAD=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --upload) UPLOAD=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown option $arg (try --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }

# ---- checks before anything slow ----
[ "$(uname)" = "Darwin" ] || fail "this needs a Mac with Xcode; the App Store only accepts builds made by Xcode"
command -v xcodebuild >/dev/null || fail "xcodebuild not found: install Xcode from the Mac App Store, then run: sudo xcode-select -s /Applications/Xcode.app"
[ -n "${TEAM_ID:-}" ] || fail "set TEAM_ID to your 10-character Apple Developer Team ID, e.g. TEAM_ID=ABCDE12345 $0"
[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "TEAM_ID '$TEAM_ID' does not look like a Team ID (10 capital letters and digits)"
if [ -n "${BUNDLE_ID:-}" ] && [[ "$BUNDLE_ID" == com.example.* ]]; then
  fail "com.example identifiers cannot be registered with Apple; choose your own"
fi
echo "Xcode: $(xcodebuild -version | head -1)"

if [ "$SKIP_TESTS" = 0 ]; then
  if command -v node >/dev/null; then
    echo "==> unit tests"
    node "$ROOT/tests/run-tests.js" | tail -1
  else
    echo "note: node is not installed, so the unit tests were skipped (install Node.js, or pass --skip-tests to silence this)"
  fi
fi

SETTINGS=(DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic)
[ -n "${BUNDLE_ID:-}" ] && SETTINGS+=(PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID")
[ -n "${VERSION:-}" ] && SETTINGS+=(MARKETING_VERSION="$VERSION")
[ -n "${BUILD_NUMBER:-}" ] && SETTINGS+=(CURRENT_PROJECT_VERSION="$BUILD_NUMBER")

AUTH=()
if [ -n "${ASC_KEY_PATH:-}" ]; then
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] || fail "ASC_KEY_PATH needs ASC_KEY_ID and ASC_ISSUER_ID too"
  AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

# ---- archive ----
rm -rf "$BUILD"
mkdir -p "$BUILD"
echo "==> archiving (Release, any iOS device)"
xcodebuild \
  -project "$HERE/CubeClubhouse.xcodeproj" \
  -scheme CubeClubhouse \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} \
  "${SETTINGS[@]}" \
  archive | tee "$BUILD/archive.log" | grep -E '^(\*\*|error:|warning: .*signing|note: copied)' || true
[ -d "$ARCHIVE" ] || fail "the archive failed; see $BUILD/archive.log"

# ---- check what is inside before it goes anywhere ----
APP="$ARCHIVE/Products/Applications/CubeClubhouse.app"
[ -f "$APP/Web/index.html" ] || fail "the web app is missing from the archive ($APP/Web/index.html)"
[ -f "$APP/PrivacyInfo.xcprivacy" ] || fail "the privacy manifest is missing from the archive"
PLISTBUDDY="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"
plist() { "$PLISTBUDDY" -c "Print :$1" "$APP/Info.plist" 2>/dev/null || echo "?"; }
BID="$(plist CFBundleIdentifier)"
[[ "$BID" == com.example.* ]] && fail "the bundle identifier is still $BID; set BUNDLE_ID or change it in the project"
[ "$(plist ITSAppUsesNonExemptEncryption)" = "false" ] || fail "ITSAppUsesNonExemptEncryption is not NO in the built Info.plist"
echo "    $BID  version $(plist CFBundleShortVersionString) ($(plist CFBundleVersion))  iOS $(plist MinimumOSVersion)+"

# ---- export or upload ----
if [ "$UPLOAD" = 1 ]; then
  echo "==> uploading to App Store Connect"
  OPTIONS="$HERE/ExportOptions-Upload.plist"
else
  echo "==> exporting a signed .ipa"
  OPTIONS="$HERE/ExportOptions.plist"
fi
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$BUILD/export" \
  -exportOptionsPlist "$OPTIONS" \
  -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} \
  | tee "$BUILD/export.log" | grep -E '^(\*\*|error:)' || true
grep -q 'EXPORT SUCCEEDED' "$BUILD/export.log" || fail "the export failed; see $BUILD/export.log"

if [ "$UPLOAD" = 1 ]; then
  echo "Done. The build is on its way to App Store Connect; it shows under TestFlight once Apple"
  echo "has processed it (usually 5 to 30 minutes). Then choose it on the version page and submit."
else
  echo "Done: $(ls "$BUILD"/export/*.ipa)"
  echo "Upload it with the Transporter app, or run this script again with --upload."
fi
