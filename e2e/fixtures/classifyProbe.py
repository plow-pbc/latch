#!/usr/bin/env python3
"""Run the REAL classifier in seed_vault_broker/cli.py over the shared table.

The unit tier must pass with no Python at all, so nothing here is required:
`maskClassification.test.ts` skips this probe when python3 is missing. Where a
python3 exists it is run, and then the rule that decides what gets masked is
checked against the actual broker rather than only against the JS fake's copy of
it.

`tldextract` is stubbed rather than installed: cli.py builds an extractor at
import time for the eTLD+1 site check, which the classifier never touches, and
requiring a third-party package would put this probe back out of reach.

Usage: classifyProbe.py <maskClassification.json>
Prints, per case, the descriptors, the label list, and whether each label can
actually be released. Never prints a field value — `releasable` is a bool,
because "did a value come back" is usually the whole question. `released` does
carry values, and carries them only for fields the vault does not conceal, so a
masked one cannot appear here whatever a test asks for.
"""
import json
import os
import sys
import tempfile
import types


def _stub_tldextract() -> None:
    stub = types.ModuleType("tldextract")

    class _Extract:
        def __init__(self, **_kw):
            pass

        def __call__(self, _host):
            return types.SimpleNamespace(domain="", suffix="")

    stub.TLDExtract = _Extract
    sys.modules.setdefault("tldextract", stub)


def _releasable(cli, item: dict, label: str) -> bool:
    """Would `get-field` produce something for this label?

    `_read_field` answers for everything except a TOTP code, which
    `_cmd_get_field` fetches by asking the vault CLI to generate one
    (`bw get totp`) rather than by reading a stored value. That branch cannot run
    here — there is no vault — so the question for `totp` is whether the item has
    a seed for one at all.
    """
    if label == cli._FIELD_TOTP:
        return bool(((item.get("_raw") or {}).get("login") or {}).get("totp"))
    return cli._read_field(item, label) is not None


def _release_shape(cli, item: dict, descriptor: dict) -> dict:
    """What `get-field` actually answers for one label.

    Only the SHAPE is reported — whether the answer carried a concealment flag
    and whether it agreed with the descriptor. The value is read and thrown
    away here; releasing it into a test file would be the very thing the whole
    change exists to prevent.
    """
    import argparse
    import contextlib
    import io

    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        rc = cli._cmd_get_field(argparse.Namespace(item_id=item["id"], field=descriptor["label"], url=None))
    if rc != 0:
        return {"answered": False, "flagged": False, "agrees": False}
    try:
        answer = json.loads(out.getvalue())
    except json.JSONDecodeError:
        return {"answered": True, "flagged": False, "agrees": False}
    flagged = isinstance(answer.get("hidden"), bool)
    return {
        "answered": isinstance(answer.get("value"), str),
        "flagged": flagged,
        "agrees": flagged and answer["hidden"] == descriptor["hidden"],
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: classifyProbe.py <maskClassification.json>\n")
        return 2
    _stub_tldextract()
    # The broker audits every release. Point that at a scratch file rather than
    # the state directory of whoever is running the suite.
    os.environ.setdefault("SEED_VAULT_AUDIT", os.path.join(tempfile.mkdtemp(), "audit.log"))
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "..", "..", "vendor", "browser-server"))
    from seed_vault_broker import cli

    with open(argv[1], encoding="utf-8") as fh:
        table = json.load(fh)

    out = {}
    for case in table["cases"]:
        item = cli._normalize(case["bitwarden"])
        # `get-field` looks the item up for itself; there is no vault here.
        cli._get_item = lambda _id, _item=item: _item
        descriptors = cli._field_descriptors(item)
        out[case["name"]] = {
            "descriptors": descriptors,
            # The releasable set and the "it has:" error message are written
            # against these, so a change to dedup shows up here too.
            "labels": cli._field_labels(item),
            # Listing a field the broker then refuses to hand over is the gap
            # this whole chunk exists to close, so it is measured, not assumed.
            "releasable": {
                d["label"]: _releasable(cli, item, d["label"]) for d in descriptors
            },
            # The value itself, and ONLY for a field the vault does not conceal.
            # A masked value cannot reach this file, which is what lets a test
            # check that a composed field is composed correctly without ever
            # holding a secret.
            # Whether a key the pinned client does not define can be read out
            # anyway. It must not be: an unknown key is refused, not released.
            "unknownKeyReadable": cli._read_field(item, "middleInitial") is not None,
            # One command has to answer both questions, or a caller is back to
            # asking twice and acting on two different moments.
            "release": {
                d["label"]: _release_shape(cli, item, d)
                for d in descriptors
                if d["label"] != cli._FIELD_TOTP
            },
            "released": {
                d["label"]: cli._read_field(item, d["label"])
                for d in descriptors
                if not d["hidden"] and d["label"] != cli._FIELD_TOTP
            },
        }
    sys.stdout.write(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
