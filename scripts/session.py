#!/usr/bin/env python3
"""Minimal MCP client for driving the Domo stack from the command line.

Spawns the real domo-mcp shim, performs the JSON-RPC handshake, and issues
tool calls SEQUENTIALLY (waiting for each response by id) — the way a real
agent does. The shell-pipe approach can't sequence, and the broker handles
tool calls concurrently, so requests that depend on each other (access before
command) must be ordered here.

Usage:
    session.py --mcp <domo-mcp> --socket <agent.sock> --token <token> \
               --device <id> [demo | run <argv...> | call <tool> <json-args>]
"""
import argparse
import json
import subprocess
import sys
import threading


class MCP:
    def __init__(self, mcp_path, socket, token):
        self.proc = subprocess.Popen(
            [mcp_path],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={"DOMO_AGENT_SOCKET": socket, "DOMO_AGENT_TOKEN": token},
            text=True, bufsize=1,
        )
        self._id = 0
        self._lock = threading.Lock()

    def _send(self, method, params):
        with self._lock:
            self._id += 1
            rid = self._id
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        # Read until the response with our id arrives.
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("connection closed (auth failed or broker gone)")
            msg = json.loads(line)
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", "rpc error"))
                return msg["result"]

    def initialize(self):
        r = self._send("initialize",
                       {"protocolVersion": "2024-11-05", "capabilities": {}})
        return r["serverInfo"]["name"]

    def call(self, tool, args):
        r = self._send("tools/call", {"name": tool, "arguments": args})
        text = r["content"][0]["text"]
        try:
            payload = json.loads(text)
        except ValueError:
            payload = text
        return payload, r.get("isError", False)

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mcp", required=True)
    ap.add_argument("--socket", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--device", required=True)
    ap.add_argument("command", nargs=argparse.REMAINDER)
    args = ap.parse_args()

    mcp = MCP(args.mcp, args.socket, args.token)
    try:
        print("initialize   ->", mcp.initialize())
        cmd = args.command or ["demo"]

        if cmd[0] == "demo":
            status, _ = mcp.call("request_device_access",
                                 {"device": args.device, "goals": "just demo"})
            print("access       ->", status.get("status") if isinstance(status, dict) else status)
            result, is_err = mcp.call("run_command",
                                      {"device": args.device,
                                       "argv": ["/bin/echo", "hello from the sandbox"]})
            _print_run(result, is_err)

        elif cmd[0] == "run":
            mcp.call("request_device_access", {"device": args.device, "goals": "cli run"})
            result, is_err = mcp.call("run_command",
                                      {"device": args.device, "argv": cmd[1:]})
            _print_run(result, is_err)

        elif cmd[0] == "call":
            tool = cmd[1]
            tool_args = json.loads(cmd[2]) if len(cmd) > 2 else {}
            mcp.call("request_device_access", {"device": args.device, "goals": "cli call"})
            result, is_err = mcp.call(tool, tool_args)
            print(("error" if is_err else "result"), "->", json.dumps(result, indent=2))

        else:
            print(f"unknown command: {cmd[0]}", file=sys.stderr)
            sys.exit(2)
    finally:
        mcp.close()


def _print_run(result, is_err):
    if is_err or not isinstance(result, dict):
        print("run_command  -> error:", result)
    else:
        print("run_command  -> exit", result.get("exit_code"),
              "| output:", repr(result.get("output")))


if __name__ == "__main__":
    main()
