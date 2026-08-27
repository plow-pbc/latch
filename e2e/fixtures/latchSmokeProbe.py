"""Call one function in scripts/latch-smoke and print what it returned as JSON.

The script is a program, not a package, so it is loaded by path. The two
functions worth pinning are `verdict` — the whole outcome table, pure over
audit records — and `send`'s refusal string, which must never carry the
credential the relay may have echoed back at it.
"""
import importlib.util
import io
import json
import sys
import urllib.error
import urllib.request

spec = importlib.util.spec_from_loader(
    "latch_smoke", importlib.machinery.SourceFileLoader("latch_smoke", sys.argv[1])
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

request = json.loads(sys.argv[2])

if request["call"] == "split":
    print(json.dumps(smoke.split_command(request["raw"])))
elif request["call"] == "verdict":
    outcome = smoke.verdict(request["events"], request["nonce"], request["expired"])
    print(json.dumps(None if outcome is None else {"code": outcome[0], "text": "\n".join(outcome[1])}))
else:
    # The relay answered, and its body repeats the Authorization header back —
    # the case the credential rule exists for. Function-level stub: no socket,
    # no server.
    body = json.dumps({"error": "Bearer " + request["token"]}).encode()

    def urlopen(*_args, **_kwargs):
        raise urllib.error.HTTPError(request["url"], request["status"], "no", {}, io.BytesIO(body))

    urllib.request.urlopen = urlopen
    print(json.dumps({"reason": smoke.send(request["url"], sys.argv[3], ["/bin/echo", "x"], "goal")}))
