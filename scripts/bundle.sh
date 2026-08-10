#!/usr/bin/env bash
# Assemble a proper Domo.app bundle from the built binaries. An unbundled
# SwiftPM executable has no Dock presence and won't reliably activate, so the
# app must be a real .app to behave like one.
set -euo pipefail

CONFIG="${1:-debug}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/.build/$CONFIG"
APP="$ROOT/.build/Domo.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The app and the helper binaries it launches must sit together in MacOS/,
# because the app resolves domo-broker / domo-mcp next to its own executable.
cp "$BIN/DomoApp" "$APP/Contents/MacOS/DomoApp"
cp "$BIN/domo-broker" "$APP/Contents/MacOS/domo-broker"
cp "$BIN/domo-mcp" "$APP/Contents/MacOS/domo-mcp"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>Domo</string>
    <key>CFBundleDisplayName</key>     <string>Domo</string>
    <key>CFBundleIdentifier</key>      <string>com.tumult.domo</string>
    <key>CFBundleExecutable</key>      <string>DomoApp</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>CFBundleShortVersionString</key> <string>0.1.0</string>
    <key>CFBundleVersion</key>         <string>1</string>
    <key>CFBundleInfoDictionaryVersion</key> <string>6.0</string>
    <key>LSMinimumSystemVersion</key>  <string>13.0</string>
    <key>NSPrincipalClass</key>        <string>NSApplication</string>
    <key>NSHighResolutionCapable</key> <true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>    <string>com.tumult.domo.connect</string>
            <key>CFBundleURLSchemes</key> <array><string>domo</string></array>
        </dict>
    </array>
</dict>
</plist>
PLIST

# Ad-hoc sign so macOS treats it as a stable app identity (TCC, activation).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "$APP"
