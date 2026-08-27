"""Call one function in scripts/latch-smoke and print what it returned as JSON.

The script is a program, not a package, so it is loaded by path. The two
functions worth pinning are `verdict` — the whole outcome table, pure over
audit records — and `send`'s refusal string, which must never carry the
credential the relay may have echoed back at it.
"""
import importlib.machinery
import importlib.util
import http.client
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

if request["call"] == "read":
    records, problem = smoke.read_log(request["path"], request.get("ssh"))
    print(json.dumps({"count": len(records), "problem": problem or ""}))
elif request["call"] == "remote":
    print(json.dumps(smoke.remote_cat(request["path"])))
elif request["call"] == "split":
    print(json.dumps(smoke.split_command(request["raw"])))
elif request["call"] == "verdict":
    outcome = smoke.verdict(request["events"], request["nonce"], request["expired"], request["since"])
    print(json.dumps(None if outcome is None else
                     {"code": outcome[0], "text": "\n".join(outcome[1]), "arrived": outcome[2]}))
else:
    # The relay answered, and its body repeats the Authorization header back —
    # the case the credential rule exists for. Function-level stub: no socket,
    # no server.
    body = json.dumps({"error": "Bearer " + request["token"]}).encode()
    raises = request.get("raises", "http")

    def urlopen(*_args, **_kwargs):
        # The shapes urllib actually produces, checked against it: a refused
        # connection and a DNS failure come WRAPPED; a read timeout and a peer
        # that drops the socket come BARE.
        if raises == "read-timeout":
            raise TimeoutError("timed out")
        if raises == "reset":
            raise ConnectionResetError(54, "Connection reset by peer")
        if raises == "connect-timeout":
            raise urllib.error.URLError(TimeoutError("timed out"))
        if raises == "refused":
            raise urllib.error.URLError(ConnectionRefusedError(61, "Connection refused"))
        if raises == "bad-scheme":
            raise urllib.error.URLError("unknown url type: htp")
        if raises == "incomplete":
            raise http.client.IncompleteRead(b"")
        if raises == "invalid-url":
            raise http.client.InvalidURL("URL can't contain control characters")
        if raises == "header":
            # What `putheader` actually raises, verified against a real
            # urlopen: the message quotes the header VALUE, i.e. the bearer.
            raise ValueError("Invalid header value %r" % (b"Bearer " + request["token"].encode(),))
        if raises == "http":
            raise urllib.error.HTTPError(request["url"], request["status"], "no", {}, io.BytesIO(body))
        # Exhaustive: a misspelt or renamed `raises` used to fall through to the
        # HTTPError branch with the transport rows' status of 0, which is not
        # >= 500, so a row could pass for a reason unrelated to what it names.
        raise SystemExit(f"unknown raises: {raises}")

    urllib.request.urlopen = urlopen
    sent = smoke.send(request["url"], sys.argv[3], ["/bin/echo", "x"], "goal")
    # `send` returns None when the call went through; the success path has to be
    # representable or the first test that stubs a 200 fails inside the harness.
    print(json.dumps({"reason": None, "unknown": False} if sent is None
                     else {"reason": sent[0], "unknown": sent[1]}))
