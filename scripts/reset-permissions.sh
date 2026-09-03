#!/bin/sh
# Reset every macOS privacy grant (TCC) this app can hold, so the Capabilities
# tab can be exercised from a clean slate: Full Disk Access, the three
# folders, Contacts, Calendars, Reminders, Photos, Accessibility, Screen
# Recording, Automation, the volumes. `tccutil reset All <bundle id>` takes all
# of them; the named services follow anyway, because `All` has skipped one on
# some macOS versions and a reset that quietly leaves a grant behind is the
# one thing this script must not do.
#
# Which bundle id? TCC keys a grant on the RESPONSIBLE process, and that is
# not the same thing for every way of running this app:
#   - the packaged install is co.plow.domo-desktop (electron-builder.yml appId);
#   - a from-source `just app` runs node_modules/electron's Electron.app,
#     bundle id com.github.Electron — every worktree's the same;
#   - launched from Terminal or iTerm, macOS attributes that run to the
#     TERMINAL (main.ts resolveFdaDragTarget says why), so its grants are the
#     terminal's — and resetting them takes the terminal's own Full Disk
#     Access and Automation grants along.
#   - launched from Termic, it is attributed to Electron.app after all: Termic
#     disclaims responsibility for the tasks it spawns, so each is its own
#     TCC client. (Verified with the responsibility SPI: a Termic task's shell
#     is responsible for itself, not for Termic — though it still inherits
#     Termic's __CFBundleIdentifier, which is why that variable must not be
#     trusted for this.)
# The first two are always reset. The launcher is found by asking the same
# SPI TCC keys on, through the settings-window-frame helper's --responsible
# mode, run from this shell: an app bundle back means the shell is that
# app's and it is reset too; nothing back means the shell is its own client
# and nothing else needs resetting. `host=no` skips the launcher outright;
# `host=<bundle id>` names one.
#
# Usage: reset-permissions.sh <apphome> [host=auto|no|<bundle id>] [--dry-run]
set -eu

apphome="${1:?apphome}"
# `just reset-permissions no` and `just reset-permissions host=no` both land
# here; just passes recipe arguments positionally.
host="${2#host=}"
host="${host:-auto}"
dry="${3:-}"

run() {
  if [ "$dry" = "--dry-run" ]; then echo "+ $*"; return 0; fi
  echo "+ $*"
  # Most resets need no privilege; a few services refuse for the user on some
  # versions, and `sudo` is the documented answer there.
  if ! "$@" 2>/dev/null; then
    sudo "$@" || echo "  (could not reset — $* )"
  fi
}

SERVICES="All SystemPolicyAllFiles SystemPolicyDesktopFolder SystemPolicyDocumentsFolder \
SystemPolicyDownloadsFolder SystemPolicyRemovableVolumes SystemPolicyNetworkVolumes \
AddressBook Calendar Reminders Photos Accessibility ScreenCapture AppleEvents"

bundles="co.plow.domo-desktop com.github.Electron"

# The app this shell is attributed to, by the SPI TCC keys on. Empty when the
# shell is its own client (Termic, a plain ssh session) or when there is no
# compiled helper to ask — in which case nothing is guessed: resetting a
# terminal's grants on a guess is the one wrong outcome here.
helper="${RESET_PERMISSIONS_HELPER:-$(dirname "$0")/../apps/desktop/dist/native/settings-window-frame}"
launcher() {
  if [ ! -x "$helper" ]; then
    echo "?"
    return 0
  fi
  bundle="$("$helper" --responsible 2>/dev/null || true)"
  if [ -n "$bundle" ] && [ -f "$bundle/Contents/Info.plist" ]; then
    /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$bundle/Contents/Info.plist" 2>/dev/null || true
  fi
}

case "$host" in
  no) ;;
  auto)
    found="$(launcher)"
    if [ "$found" = "?" ]; then
      echo "No compiled helper at $helper (run \`just build\`), so the app this shell is attributed to is not guessed; only the app's own bundle ids are reset. Pass host=<bundle id> to name one."
      found=""
    elif [ -n "$found" ]; then
      echo "This shell is attributed to $found; a from-source run is too, so its grants are reset as well (host=no to skip)."
      bundles="$bundles $found"
    else
      echo "This shell is its own TCC client (Termic disclaims its tasks; so does ssh): a from-source run is attributed to Electron.app, which is reset. Pass host=<bundle id> to name another app."
    fi
    ;;
  *) bundles="$bundles $host" ;;
esac

for bundle in $bundles; do
  echo "== $bundle"
  for service in $SERVICES; do
    run tccutil reset "$service" "$bundle"
  done
done

# The app's own memos of what macOS said (automation consent per app, the
# folders, the "not now"s and the banner) would otherwise show yesterday's
# answers over today's clean slate. The credential and everything else in
# settings.json stay exactly as they are.
settings="$apphome/app/settings.json"
if [ -f "$settings" ]; then
  if [ "$dry" = "--dry-run" ]; then
    echo "+ (would clear automation/folderConsent/capabilityDismissals/blockedBannerSeenAt in $settings)"
  else
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const k of ["automation", "folderConsent", "capabilityDismissals", "blockedBannerSeenAt"]) delete s[k];
      fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    ' "$settings"
    echo "cleared the app's permission memos in $settings"
  fi
fi

echo
echo "Done. Quit and reopen the app: macOS keeps enforcing a running process's old answers."
