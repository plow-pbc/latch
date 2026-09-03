#!/bin/sh
# Reset every macOS privacy grant (TCC) this app can hold, so the Capabilities
# tab can be exercised from a clean slate: Full Disk Access, the three
# folders, Contacts, Calendars, Reminders, Photos, Accessibility, Screen
# Recording, Automation, the volumes. `tccutil reset All <bundle id>` takes all
# of them; the named services follow anyway, because `All` has skipped one on
# some macOS versions and a reset that quietly leaves a grant behind is the
# one thing this script must not do.
#
# Which bundle id? TCC keys a grant on the RESPONSIBLE app, and that is not
# the same thing for every way of running this app:
#   - the packaged install is co.plow.domo-desktop (electron-builder.yml appId);
#   - a from-source `just app` runs node_modules/electron's Electron.app,
#     bundle id com.github.Electron — every worktree's the same;
#   - but launched from a terminal, macOS attributes that run to the app the
#     terminal session belongs to (main.ts resolveFdaDragTarget says why):
#     Termic, iTerm, Terminal, an IDE. Its grants are that app's.
# The first two are always reset. The third is found from where THIS script
# runs — `__CFBundleIdentifier`, which macOS sets on every process launched
# from an app bundle and which survives into a shell's children (Termic sets
# TERM_PROGRAM to iTerm.app for compatibility, so that variable is only the
# fallback) — and reset too, since a from-source run is what the reset is
# usually for. That takes the app's own Full Disk Access and Automation grants
# with it; `host=no` skips it.
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

# The app this shell was launched from — what a from-source run is
# attributed to.
launcher() {
  if [ -n "${__CFBundleIdentifier:-}" ]; then echo "$__CFBundleIdentifier"; return; fi
  # No bundle env (a plain ssh session, say): the helper's --responsible mode
  # asks the same SPI TCC keys on, and the TERM_PROGRAM table is the last
  # resort.
  helper="$(dirname "$0")/../apps/desktop/dist/native/settings-window-frame"
  if [ -x "$helper" ]; then
    bundle="$("$helper" --responsible 2>/dev/null || true)"
    if [ -n "$bundle" ] && [ -f "$bundle/Contents/Info.plist" ]; then
      /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$bundle/Contents/Info.plist" 2>/dev/null && return
    fi
  fi
  case "${TERM_PROGRAM:-}" in
    Apple_Terminal) echo com.apple.Terminal ;;
    iTerm.app) echo com.googlecode.iterm2 ;;
    vscode) echo com.microsoft.VSCode ;;
    WarpTerminal) echo dev.warp.Warp-Stable ;;
    *) echo "" ;;
  esac
}

case "$host" in
  no) ;;
  auto)
    found="$(launcher)"
    if [ -n "$found" ]; then
      echo "This shell was launched from $found; a from-source run is attributed to it, so its grants are reset too (host=no to skip)."
      bundles="$bundles $found"
    else
      echo "Could not tell which app this shell was launched from; only the app's own bundle ids are reset (pass the id as host=<bundle id>)."
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
