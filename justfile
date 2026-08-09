# Domo Desktop — task runner.
# Run `just` with no arguments to list everything.

bin  := justfile_directory() / ".build/debug"
# Throwaway home for the local demo stack. Kept under /tmp so Unix socket
# paths stay under the ~104-char limit.
home := "/tmp/domo-demo"

_default:
    @just --list

# ---------------------------------------------------------------------------
# Build & test
# ---------------------------------------------------------------------------

# Build all binaries (debug).
build:
    swift build

# Build the optimized release binaries.
build-release:
    swift build -c release

# Full test suite (unit + full-stack E2E).
test:
    swift test

# Fast inner-loop tests only (no process spawning).
unit:
    swift test --filter DomoProtocolTests --filter DomoDeviceCoreTests

# Full-stack E2E tests only (real broker + device + MCP client).
e2e: build
    swift test --filter DomoE2ETests

# Assemble Domo.app from the built binaries (into .build/Domo.app).
bundle: build
    @scripts/bundle.sh debug

app-home := env_var('HOME') / "Library/Application Support/Domo"

# The app no longer launches its own broker. This relaunches the app fresh and
# ensures a broker is up: it REUSES one already listening (e.g. from `just
# broker`), otherwise starts one in the background. The app is told which broker
# to use via --broker-socket.
#
# Build, bundle, ensure a broker, then launch Domo.app wired to it.
app: bundle
    #!/usr/bin/env bash
    set -euo pipefail
    HOME_D="{{app-home}}"; SOCK="$HOME_D/run/device.sock"
    mkdir -p "$HOME_D/run"
    pkill -9 -f "Domo.app/Contents/MacOS/DomoApp" 2>/dev/null || true
    if python3 -c "import socket,sys;s=socket.socket(socket.AF_UNIX);s.settimeout(0.5);s.connect(sys.argv[1])" "$SOCK" 2>/dev/null; then
        echo "Reusing broker already listening at $SOCK"
    else
        ( nohup "{{bin}}/domo-broker" --home "$HOME_D" >"$HOME_D/broker.log" 2>&1 & echo $! > "$HOME_D/broker.pid" )
        for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.1; done
        if [ ! -S "$SOCK" ]; then echo "broker failed to start; see $HOME_D/broker.log" >&2; exit 1; fi
        echo "Started broker (pid $(cat "$HOME_D/broker.pid"), log: $HOME_D/broker.log)"
    fi
    open -n .build/Domo.app --args --home "$HOME_D" --broker-socket "$SOCK"
    echo "App launched, pointed at $SOCK"

# Ctrl-C to stop. Then `just app` will reuse this broker instead of starting one.
#
# Run a broker for the app's home in the FOREGROUND with live logs (run-it-yourself).
broker: build
    "{{bin}}/domo-broker" --home "{{app-home}}"

# A foreground `just broker` is stopped with Ctrl-C instead.
#
# Quit Domo.app and stop the background broker that `just app` started.
app-down:
    #!/usr/bin/env bash
    HOME_D="{{app-home}}"
    pkill -9 -f "Domo.app/Contents/MacOS/DomoApp" 2>/dev/null || true
    if [ -f "$HOME_D/broker.pid" ]; then
        kill "$(cat "$HOME_D/broker.pid")" 2>/dev/null || true
        rm -f "$HOME_D/broker.pid"
    fi
    echo "app + broker stopped"

# Needs Accessibility permission for the controlling terminal; opens the app.
#
# Real-input UI smoke test: genuine mouse clicks assert the app actually works.
test-ui: bundle
    @chmod +x scripts/ui_smoke.sh && scripts/ui_smoke.sh

# ---------------------------------------------------------------------------
# Local demo stack: a broker + one auto-approving headless device
# ---------------------------------------------------------------------------

# A demo agent is minted BEFORE the broker starts, because the broker loads
# its agent registry once at startup — agents added afterward by a separate
# `create-agent` process would be invisible to the running broker.
#
# Start the local stack (broker + headless device). Idempotent.
up: build
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f "{{home}}/broker.pid" ] && kill -0 "$(cat {{home}}/broker.pid)" 2>/dev/null; then
        echo "stack already up (home={{home}})"; exit 0
    fi
    mkdir -p "{{home}}"
    echo '{"access":"allow","intent":"allow_once"}' > "{{home}}/policy.json"

    "{{bin}}/domo-broker" create-agent --home "{{home}}" --name "Demo Agent" \
        | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])" \
        > "{{home}}/agent.token"

    ( nohup "{{bin}}/domo-broker" --home "{{home}}" \
        --agent-socket "{{home}}/a.sock" --device-socket "{{home}}/d.sock" \
        >"{{home}}/broker.log" 2>&1 & echo $! > "{{home}}/broker.pid" )
    for _ in $(seq 1 50); do [ -S "{{home}}/d.sock" ] && break; sleep 0.1; done

    ( nohup "{{bin}}/domo-device" --home "{{home}}/dev" --broker "{{home}}/d.sock" \
        --policy "{{home}}/policy.json" \
        >"{{home}}/device.log" 2>&1 & echo $! > "{{home}}/device.pid" )
    for _ in $(seq 1 50); do [ -f "{{home}}/dev/device/identity.json" ] && break; sleep 0.1; done

    echo "stack up  (home={{home}}, device=$(just --justfile {{justfile()}} device-id))"

# Stop the local stack.
down:
    #!/usr/bin/env bash
    set -uo pipefail
    for name in device broker; do
        pid_file="{{home}}/${name}.pid"
        if [ -f "$pid_file" ]; then
            kill "$(cat "$pid_file")" 2>/dev/null || true
            rm -f "$pid_file"
        fi
    done
    echo "stack down"

# Show whether the stack is running.
status:
    #!/usr/bin/env bash
    for name in broker device; do
        pid_file="{{home}}/${name}.pid"
        if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
            echo "$name: up (pid $(cat "$pid_file"))"
        else
            echo "$name: down"
        fi
    done

# Tail the broker + device logs.
logs:
    tail -n +1 -F "{{home}}/broker.log" "{{home}}/device.log"

# Print the running device's id.
device-id:
    @python3 -c "import json;print(json.load(open('{{home}}/dev/device/identity.json'))['deviceId'])"

# Print the demo agent's token (minted by `up`).
token:
    @cat "{{home}}/agent.token" 2>/dev/null || { echo "no token — run 'just up'" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Drive the stack
# ---------------------------------------------------------------------------

# End-to-end demo: grant access, run a sandboxed command, print the result.
demo: up
    #!/usr/bin/env bash
    set -euo pipefail
    echo "--- session (device=$(just --justfile {{justfile()}} device-id)) ---"
    python3 "{{justfile_directory()}}/scripts/session.py" \
        --mcp "{{bin}}/domo-mcp" --socket "{{home}}/a.sock" \
        --token "$(just --justfile {{justfile()}} token)" \
        --device "$(just --justfile {{justfile()}} device-id)" demo
    echo "--- audit tail ---"
    just --justfile {{justfile()}} audit

# Example:  just run /bin/echo hi   (sandbox grants no fs/network access by default)
#
# Run an arbitrary command on the device through the full stack.
run *argv: up
    @python3 "{{justfile_directory()}}/scripts/session.py" \
        --mcp "{{bin}}/domo-mcp" --socket "{{home}}/a.sock" \
        --token "$(just --justfile {{justfile()}} token)" \
        --device "$(just --justfile {{justfile()}} device-id)" run {{argv}}

# Register this stack with Claude Code as an MCP server.
claude-add: up
    #!/usr/bin/env bash
    set -euo pipefail
    token="$(just --justfile {{justfile()}} token)"
    if command -v claude >/dev/null 2>&1; then
        claude mcp add domo \
            -e "DOMO_AGENT_SOCKET={{home}}/a.sock" \
            -e "DOMO_AGENT_TOKEN=$token" \
            -- "{{bin}}/domo-mcp"
        echo "Added MCP server 'domo'. In Claude Code, ask it to list_devices."
    else
        echo "Claude Code CLI not found. Run this manually:"
        echo "  claude mcp add domo -e DOMO_AGENT_SOCKET={{home}}/a.sock -e DOMO_AGENT_TOKEN=$token -- {{bin}}/domo-mcp"
    fi

# Requires the real Domo.app running (`just app`). Mints a throwaway agent,
# passes it via --mcp-config --strict-mcp-config, and cleans up on exit — so
# NOTHING is written to your Claude config and no other MCP servers load.
# Optional one-shot prompt:  just agent "check my disk space"
#
# Talk to the running Domo.app for a single, trace-free Claude session.
agent prompt="": build
    #!/usr/bin/env bash
    set -euo pipefail
    HOME_D="$HOME/Library/Application Support/Domo"
    if ! pgrep -f "Domo.app/Contents/MacOS/DomoApp" >/dev/null; then
        echo "Domo.app isn't running. Start it first:  just app" >&2; exit 1
    fi
    if [ ! -S "$HOME_D/run/agent.sock" ]; then
        echo "No broker socket yet at $HOME_D/run/agent.sock — give the app a moment." >&2; exit 1
    fi
    if ! command -v claude >/dev/null 2>&1; then
        echo "Claude Code CLI (claude) not found on PATH." >&2; exit 1
    fi
    token="$("{{bin}}/domo-broker" create-agent --home "$HOME_D" --name "Ephemeral agent" \
        | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")"
    # Throwaway config file (0600), removed when this session exits. Passed as a
    # file (not inline JSON) so the token never appears in `ps`.
    cfgbase="$(mktemp -t domo-mcp)"; cfg="$cfgbase.json"; mv "$cfgbase" "$cfg"; chmod 600 "$cfg"
    trap 'rm -f "$cfg"' EXIT
    printf '{"mcpServers":{"domo":{"type":"stdio","command":"%s","env":{"DOMO_AGENT_SOCKET":"%s","DOMO_AGENT_TOKEN":"%s"}}}}' \
        "{{bin}}/domo-mcp" "$HOME_D/run/agent.sock" "$token" > "$cfg"
    if [ -n "{{prompt}}" ]; then
        claude --strict-mcp-config --mcp-config "$cfg" --allowedTools mcp__domo -p "{{prompt}}"
    else
        claude --strict-mcp-config --mcp-config "$cfg" --allowedTools mcp__domo
    fi

# Show the device's audit log (the record of everything that happened).
audit:
    @cat "{{home}}/dev/device/audit.ndjson" 2>/dev/null || echo "(no audit log yet — run 'just demo')"

# ---------------------------------------------------------------------------
# Networked / hosted broker (see docs/network-security-runbook.md)

# Generate a self-signed broker cert + print its SPKI pin (Phase 2/6).
gen-cert dir="./tls" cn="domo-broker" pass="domo":
    @scripts/gen-broker-cert.sh "{{dir}}" "{{cn}}" "{{pass}}"

# Run the broker over wss:// with enrollment required (Phase 6). Pass a p12 from
# `just gen-cert`. Ports: agent 8443, device 8444.
broker-wss p12 pass="domo" home=home: build
    .build/debug/domo-broker --home "{{home}}" \
        --agent-listen wss://0.0.0.0:8443/ --device-listen wss://0.0.0.0:8444/ \
        --tls-p12 "{{p12}}" --tls-password "{{pass}}" --require-enrollment

# ---------------------------------------------------------------------------

# Stop the stack and delete the demo home.
clean: down
    rm -rf "{{home}}"

# Remove all build artifacts too.
clean-all: clean
    swift package clean
    rm -rf .build
