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
#   - but launched from a terminal, macOS attributes that run to the TERMINAL
#     (main.ts resolveFdaDragTarget says why), so its grants are the terminal's.
# The first two are always reset. The terminal's are reset only when asked
# (`terminal=yes`), because that takes the terminal's own Full Disk Access and
# Automation grants with it.
#
# Usage: reset-permissions.sh <apphome> [terminal=yes|no] [--dry-run]
set -eu

apphome="${1:?apphome}"
# `just reset-permissions yes` and `just reset-permissions terminal=yes` both
# land here; just passes recipe arguments positionally.
terminal="${2#terminal=}"
terminal="${terminal:-no}"
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
if [ "$terminal" = "yes" ]; then
  case "${TERM_PROGRAM:-}" in
    Apple_Terminal) bundles="$bundles com.apple.Terminal" ;;
    iTerm.app) bundles="$bundles com.googlecode.iterm2" ;;
    vscode) bundles="$bundles com.microsoft.VSCode" ;;
    WarpTerminal) bundles="$bundles dev.warp.Warp-Stable" ;;
    *) echo "terminal=yes, but TERM_PROGRAM='${TERM_PROGRAM:-}' is not one this script knows; add it" ;;
  esac
fi

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
if [ "$terminal" != "yes" ]; then
  echo "A from-source run launched from this terminal is attributed to the TERMINAL; \`just reset-permissions yes\` resets that too."
fi
