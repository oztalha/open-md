#!/bin/sh
# Install or update OpenMD (Apple Silicon) from the latest GitHub release.
#
# Downloading with gh or curl (not a browser) means macOS doesn't mark the app
# as downloaded from the internet, so it opens without the "Apple could not
# verify" warning. Uses gh when it's installed and signed in (works for a
# private repo), else curl.
#
#   curl -fsSL https://raw.githubusercontent.com/oztalha/open-md/main/scripts/install.sh | sh
set -eu

REPO="oztalha/open-md"
ASSET="OpenMD_aarch64.dmg"
APP="/Applications/OpenMD.app"

[ "$(uname -s)" = "Darwin" ] || { echo "OpenMD is a macOS app." >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || echo "Note: this build is for Apple Silicon; it may not run on this Mac." >&2

tmp=$(mktemp -d)
trap 'hdiutil detach -quiet "$tmp/mnt" 2>/dev/null || true; rm -rf "$tmp"' EXIT

echo "Downloading the latest OpenMD…"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh release download --repo "$REPO" --pattern "$ASSET" --dir "$tmp"
else
  curl -fL --progress-bar -o "$tmp/$ASSET" "https://github.com/$REPO/releases/latest/download/$ASSET"
fi

mkdir "$tmp/mnt"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$tmp/mnt" "$tmp/$ASSET"

if pgrep -x OpenMD >/dev/null 2>&1; then
  echo "Quitting OpenMD to update it (it asks about unsaved changes)…"
  osascript -e 'tell application "OpenMD" to quit' >/dev/null 2>&1 || true
  i=0
  while pgrep -x OpenMD >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 120 ] || { echo "OpenMD is still running; quit it and run this again." >&2; exit 1; }
    sleep 1
  done
fi

rm -rf "$APP"
ditto "$tmp/mnt/OpenMD.app" "$APP"
# In case an earlier browser download left the mark on it.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

version=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
echo "Installed OpenMD $version in /Applications."
open "$APP"
