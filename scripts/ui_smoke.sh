#!/usr/bin/env bash
# Real-input UI smoke test for Domo.app. Uses genuine CGEvent mouse clicks
# (not AX actuation, which fires even when real clicks don't route), so it
# catches hit-testing / first-mouse / activation regressions that scripted
# AXPress would miss. Requires Accessibility permission for the controlling
# terminal.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/.build/Domo.app"
CLICK=/tmp/domoclick
FAILURES=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

swiftc -O "$ROOT/scripts/click.swift" -o "$CLICK" 2>/dev/null || { echo "cannot build clicker"; exit 1; }
pkill -f DomoApp 2>/dev/null; pkill domo-broker 2>/dev/null; sleep 1
rm -rf "$HOME/Library/Application Support/Domo"
"$ROOT/scripts/bundle.sh" debug >/dev/null
open "$APP"
for _ in $(seq 1 40); do
  osascript -e 'tell application "System Events" to exists (process "DomoApp")' 2>/dev/null | grep -q true && break
  sleep 0.25
done
sleep 3

ax() { osascript -e "tell application \"System Events\" to tell process \"DomoApp\" $1" 2>/dev/null; }

echo "UI smoke test:"

# 1. Window is present and frontmost.
if [ "$(ax 'to return frontmost as string')" = "true" ]; then
  pass "app launched and is frontmost"
else
  fail "app not frontmost (bundle/activation problem)"
fi

# 2. Goals table has the premade goals.
ROWS=$(ax 'to return count of rows of table 1 of scroll area 1 of tab group 1 of window 1')
[ "${ROWS:-0}" -ge 3 ] && pass "goals table populated ($ROWS rows)" || fail "goals table empty"

# 3. THE regression: a genuine click on a goal row populates the editor.
COORDS=$(osascript <<'EOF' 2>/dev/null
tell application "System Events" to tell process "DomoApp"
    set rp to position of row 1 of table 1 of scroll area 1 of tab group 1 of window 1
    return ((item 1 of rp) + 40 as integer) & " " & ((item 2 of rp) + 10 as integer)
end tell
EOF
)
read GX GY <<< "$(echo "$COORDS" | tr -s ', ' '  ')"
"$CLICK" "$GX" "$GY"; sleep 1
# Assert via selected-row count (robust) and editor length (bound to a var to
# avoid AppleScript's flaky "length of value of ..." coercion).
SEL=$(osascript <<'EOF' 2>/dev/null
tell application "System Events" to tell process "DomoApp"
    return count of (rows of table 1 of scroll area 1 of tab group 1 of window 1 whose selected is true)
end tell
EOF
)
ELEN=$(osascript <<'EOF' 2>/dev/null
tell application "System Events" to tell process "DomoApp"
    set v to value of text area 1 of scroll area 2 of tab group 1 of window 1
    return length of v
end tell
EOF
)
if [ "${SEL:-0}" -ge 1 ] && [ "${ELEN:-0}" -gt 0 ]; then
    pass "clicking a goal selects it (sel=$SEL) and populates the editor (len=$ELEN)"
else
    fail "clicking a goal did nothing (sel=${SEL:-?}, editorLen=${ELEN:-?}) — first-mouse/hit-test regression"
fi

# 4. Tabs switch on a real click (Audit shows live device events).
TC=$(osascript <<'EOF' 2>/dev/null
tell application "System Events" to tell process "DomoApp"
    set rb to radio button "Audit" of tab group 1 of window 1
    set p to position of rb
    set s to size of rb
    return ((item 1 of p)+((item 1 of s) div 2) as integer) & " " & ((item 2 of p)+((item 2 of s) div 2) as integer)
end tell
EOF
)
read AX_X AX_Y <<< "$(echo "$TC" | tr -s ', ' '  ')"
"$CLICK" "$AX_X" "$AX_Y"; sleep 0.5
AUDIT=$(ax 'to return value of text area 1 of scroll area 1 of tab group 1 of window 1')
echo "$AUDIT" | grep -q "device_started" && pass "Audit tab shows live events" || fail "Audit tab empty/not switched"

pkill -f DomoApp 2>/dev/null; pkill domo-broker 2>/dev/null
echo ""
if [ "$FAILURES" -eq 0 ]; then echo "UI smoke: all checks passed"; else echo "UI smoke: $FAILURES failure(s)"; exit 1; fi
