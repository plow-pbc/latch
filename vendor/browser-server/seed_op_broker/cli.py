from __future__ import annotations

import argparse
import ipaddress
import json
import os
import subprocess
import sys
import time
import urllib.parse
from typing import Iterable

import tldextract

from seed_op_broker import __version__

_PROG = "seed-op-broker"
_OP_BIN = "op"
_OP_TIMEOUT_S = 30
_SA_TOKEN_VAR = "OP_SERVICE_ACCOUNT_TOKEN"
_sa_vault_cache: str | None = None
_SA_ENV_PATH = os.environ.get(
    "SEED_OP_SA_ENV", os.path.expanduser("~/.config/1p/sa-agents.env")
)
_FORMAT_JSON = "json"
_CMD_FILTER_LOGINS = "filter-logins"
_CMD_GET_FIELD = "get-field"
_CMD_STATUS = "status"
_CMD_WHATS_HERE = "whats-here"
_CMD_DESCRIBE = "describe-item"
_AUDIT_PATH = os.environ.get(
    "SEED_OP_AUDIT", os.path.expanduser("~/.local/state/1p-broker/audit.log")
)

_FIELD_PASSWORD = "password"
_FIELD_TOTP = "totp"
_FIELD_USERNAME = "username"
_FIELD_EMAIL = "email"
_FIELD_LOGIN = "login"
_FIELD_USER = "user"
_ALLOWED_FIELDS = frozenset(
    {_FIELD_PASSWORD, _FIELD_TOTP, _FIELD_USERNAME, _FIELD_EMAIL, _FIELD_LOGIN, _FIELD_USER}
)

_MAX_ENTRIES = 50

_ERR_OP_LOCKED = "OpLocked"
_ERR_OP_DENIED = "OpDenied"
_ERR_OP_NOT_FOUND = "OpNotFound"
_ERR_OP_UNAVAILABLE = "OpUnavailable"
_ERR_INVALID_ARG = "InvalidArgument"
_ERR_OP_ERROR = "OpError"

_LOCKED_PATTERNS = ("signin", "not currently signed in", "session expired", "signed out")
_DENIED_PATTERNS = ("cancelled", "canceled", "user denied", "biometric")
_NOT_FOUND_PATTERNS = ("not found", "isn't an item", "no such item", "404")

_HTTP_SCHEMES = frozenset({"http", "https"})

_LOCKED_MSG = "1Password CLI is signed out. Run `op signin` and retry."
_DENIED_MSG = "1Password CLI denied the request (cancelled or biometric refusal)."
_NOT_FOUND_MSG = "1Password item not found."
_UNAVAILABLE_MSG = "1Password CLI (`op`) is not on PATH. Install with `brew install --cask 1password-cli`."
_TIMEOUT_MSG = "1Password CLI timed out (often a hung biometric prompt)."
_OP_FILTER_LOGINS_DESC = (
    "List 1Password Login items whose stored URLs match the given eTLD+1 domain. "
    "Search is by title or URL href (case-insensitive); username is returned but "
    "never matched against."
)
_OP_GET_FIELD_DESC = (
    "Read a single field from a 1Password item. The value is written to stdout "
    "with no trailing newline. Pass --url to bind the release to the page on "
    "screen; without it NO origin check runs and the audit records SEM-URL."
)
_OP_STATUS_DESC = (
    "Probe `op`'s sign-in status. Always exits 0 unless `op` itself is missing."
)

_EXTRACTOR = tldextract.TLDExtract(suffix_list_urls=())


def _etld1(url: str) -> str | None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in _HTTP_SCHEMES:
        return None
    host = parsed.hostname
    if not host:
        return None
    try:
        ipaddress.ip_address(host)
        return None
    except ValueError:
        pass
    extracted = _EXTRACTOR(host)
    if not extracted.suffix or not extracted.domain:
        return None
    return f"{extracted.domain}.{extracted.suffix}"


def _classify(stderr: str) -> str:
    lowered = stderr.lower()
    if any(p in lowered for p in _LOCKED_PATTERNS):
        return _ERR_OP_LOCKED
    if any(p in lowered for p in _DENIED_PATTERNS):
        return _ERR_OP_DENIED
    if any(p in lowered for p in _NOT_FOUND_PATTERNS):
        return _ERR_OP_NOT_FOUND
    return _ERR_OP_ERROR


def _classify_message(error_type: str, fallback: str) -> str:
    return {
        _ERR_OP_LOCKED: _LOCKED_MSG,
        _ERR_OP_DENIED: _DENIED_MSG,
        _ERR_OP_NOT_FOUND: _NOT_FOUND_MSG,
    }.get(error_type, fallback.strip() or "1Password CLI error")


def _emit_error(error_type: str, message: str) -> int:
    sys.stderr.write(json.dumps({"type": error_type, "message": message}) + "\n")
    return 1


def _op_env() -> dict[str, str]:
    """Environment for `op`.

    With a service-account token present, `op` talks to the 1Password API directly and never
    contacts the desktop app, so a biometric prompt is structurally impossible rather than
    merely absent. Reach is exactly what the token grants (the mirrored vault) — the broker
    cannot see the human's personal vaults even if asked.

    Falls back to the inherited environment, i.e. Swagat's original desktop `op` + Touch ID
    path, when no token is configured.
    """
    env = os.environ.copy()
    if env.get(_SA_TOKEN_VAR):
        return env
    try:
        with open(_SA_ENV_PATH, encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip().removeprefix("export ")
                name, _, value = stripped.partition("=")
                if name.strip() == _SA_TOKEN_VAR:
                    env[_SA_TOKEN_VAR] = value.strip().strip("'\"")
                    break
    except OSError:
        pass  # no token file -> desktop op path, unchanged behaviour
    return env


def _sa_vault(env: dict[str, str]) -> str | None:
    """The vault to scope item reads to, or None when not using a service account.

    `op item get` refuses to run under a service account without an explicit vault
    ("a vault query must be provided when this command is called by a service account").
    A token normally grants exactly one vault, so detect it rather than hardcode a name;
    set SEED_OP_SA_VAULT when a token grants several.
    """
    global _sa_vault_cache
    if not env.get(_SA_TOKEN_VAR):
        return None
    if _sa_vault_cache is not None:
        return _sa_vault_cache or None
    vault = os.environ.get("SEED_OP_SA_VAULT", "")
    if not vault:
        try:
            probe = subprocess.run(
                [_OP_BIN, "vault", "list", "--format", "json"],
                capture_output=True, text=True, check=False, env=env, timeout=_OP_TIMEOUT_S,
            )
            names = [v["name"] for v in json.loads(probe.stdout)] if probe.returncode == 0 else []
            if len(names) == 1:
                vault = names[0]
        except (OSError, subprocess.TimeoutExpired, ValueError, KeyError):
            vault = ""
    _sa_vault_cache = vault
    return vault or None


def _run_op(args: list[str]) -> tuple[int, str, str]:
    env = _op_env()
    if args and args[0] == "item" and "--vault" not in args:
        vault = _sa_vault(env)
        if vault:
            args = [*args, "--vault", vault]
    try:
        result = subprocess.run(
            [_OP_BIN, *args],
            capture_output=True,
            text=True,
            check=False,
            env=env,
            timeout=_OP_TIMEOUT_S,
        )
    except FileNotFoundError:
        raise _OpToolError(_ERR_OP_UNAVAILABLE, _UNAVAILABLE_MSG)
    except subprocess.TimeoutExpired:
        raise _OpToolError(_ERR_OP_LOCKED, _TIMEOUT_MSG)
    return result.returncode, result.stdout, result.stderr


class _OpToolError(Exception):
    def __init__(self, type_name: str, message: str):
        super().__init__(message)
        self.type_name = type_name
        self.message = message


def _urls_for(item: dict) -> list[dict]:
    out = []
    for u in item.get("urls") or ():
        href = u.get("href")
        if not href:
            continue
        entry = {"href": href}
        if u.get("primary"):
            entry["primary"] = True
        out.append(entry)
    return out


def _item_matches_etld1(urls: Iterable[dict], etld1: str) -> bool:
    for u in urls:
        if _etld1(u["href"]) == etld1:
            return True
    return False


def _item_matches_query(item: dict, urls: Iterable[dict], query_lower: str) -> bool:
    if query_lower in (item.get("title") or "").lower():
        return True
    return any(query_lower in u["href"].lower() for u in urls)


def _summarize_item(item: dict, urls: list[dict]) -> dict:
    return {
        "id": item.get("id", ""),
        "title": item.get("title", ""),
        "username": item.get("additional_information") or "",
        "urls": urls,
    }



def _host_key(url: str) -> str | None:
    """Stable key for "the page I am on": eTLD+1, else host:port.

    localhost and bare IPs have no registrable domain, so _etld1 returns None for
    them. Falling back to host:port keeps local pages usable without teaching the
    broker anything about any particular site.
    """
    etld1 = _etld1(url)
    if etld1:
        return etld1
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in _HTTP_SCHEMES or not parsed.hostname:
        return None
    # Host without port: a site's identity is its host, and the port a local mock
    # happens to listen on is not part of who it is.
    return parsed.hostname


def _audit(item_id: str, field: str, page: str, outcome: str) -> None:
    """One line per secret release. Never the value -- that is the whole point."""
    try:
        path = os.path.abspath(_AUDIT_PATH)
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("%s  item=%s  field=%s  page=%s  -> %s\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S"), item_id, field, page, outcome))
    except OSError:
        pass


def _item_host_keys(item: dict) -> list[str]:
    return [k for k in (_host_key(u["href"]) for u in _urls_for(item)) if k]


def _cmd_whats_here(args: argparse.Namespace) -> int:
    """Every item in reach, metadata only. The agent reads the page and chooses.

    Nothing is filtered out by host: a card has no site at all, and a login for
    another host is often the right answer (a store checkout that hands off to
    PayPal wants the PayPal login). Each entry carries its own urls plus
    matches_this_page so the agent can judge. No value of any field is returned
    here -- titles, usernames and urls only.
    """
    page = _host_key(args.url)
    if not page:
        return _emit_error(_ERR_INVALID_ARG, "could not read a host from %r" % args.url)
    try:
        rc, stdout, stderr = _run_op(["item", "list", "--format", "json"])
    except _OpToolError as exc:
        return _emit_error(exc.type_name, exc.message)
    if rc != 0:
        kind = _classify(stderr)
        return _emit_error(kind, _classify_message(kind, stderr))
    try:
        items = json.loads(stdout) if stdout.strip() else []
    except json.JSONDecodeError as exc:
        return _emit_error(_ERR_OP_ERROR, "could not parse `op` output: %s" % exc)

    out: list[dict] = []
    for item in items:
        urls = [u["href"] for u in _urls_for(item)]
        out.append({
            "id": item["id"],
            "title": item.get("title", ""),
            "category": item.get("category", ""),
            "username": item.get("additional_information") or "",
            "urls": urls,
            # Whether this item's own site is the page on screen. Advice, not a
            # filter: the agent decides, and a login for another host is a valid
            # choice (a store checkout that hands off to PayPal).
            "matches_this_page": page in _item_host_keys(item),
        })
    # No cap: the owner asked to see everything, and a silently truncated list
    # would read as "that is all there is".
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


def _cmd_describe_item(args: argparse.Namespace) -> int:
    """Field LABELS of one item -- never their values.

    This is what keeps the agent generic: it does not need to know that a card
    calls its code "verification number". It asks what this item has, looks at the
    form, and matches the two up itself.
    """
    try:
        rc, stdout, stderr = _run_op(["item", "get", args.item_id, "--format", "json"])
    except _OpToolError as exc:
        return _emit_error(exc.type_name, exc.message)
    if rc != 0:
        kind = _classify(stderr)
        return _emit_error(kind, _classify_message(kind, stderr))
    try:
        item = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return _emit_error(_ERR_OP_ERROR, "could not parse `op` output: %s" % exc)

    labels = []
    for f in item.get("fields") or []:
        label = f.get("label") or f.get("id") or ""
        if not label or label in labels:
            continue
        # Report whether a value exists, never the value itself.
        if f.get("value") is not None or f.get("type") == "CONCEALED":
            labels.append(label)
    _audit(args.item_id, "(labels)", "-", "DESCRIBED")
    sys.stdout.write(json.dumps({
        "id": item.get("id", ""), "title": item.get("title", ""),
        "category": item.get("category", ""), "fields": labels,
    }) + "\n")
    return 0


def _cmd_filter_logins(args: argparse.Namespace) -> int:
    if args.format != _FORMAT_JSON:
        return _emit_error(_ERR_INVALID_ARG, f"--format must be {_FORMAT_JSON!r}")
    try:
        rc, stdout, stderr = _run_op(
            ["item", "list", "--categories", "Login", "--format", "json"]
        )
    except _OpToolError as exc:
        return _emit_error(exc.type_name, exc.message)
    if rc != 0:
        kind = _classify(stderr)
        return _emit_error(kind, _classify_message(kind, stderr))
    try:
        items = json.loads(stdout) if stdout.strip() else []
    except json.JSONDecodeError as exc:
        return _emit_error(_ERR_OP_ERROR, f"could not parse `op` output: {exc}")

    target = args.etld1
    query_lower = args.query.lower() if args.query else None
    out: list[dict] = []
    for item in items:
        urls = _urls_for(item)
        if not urls:
            continue
        if not _item_matches_etld1(urls, target):
            continue
        if query_lower is not None and not _item_matches_query(item, urls, query_lower):
            continue
        out.append(_summarize_item(item, urls))
        if len(out) >= _MAX_ENTRIES:
            break
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


def _cmd_get_field(args: argparse.Namespace) -> int:
    # --url is optional by the owner's decision: without it there is NO origin check
    # and the caller takes that on. The audit line says SEM-URL so those releases are
    # obvious in the log rather than blending in.
    page = _host_key(args.url) if args.url else None
    if args.url and not page:
        return _emit_error(_ERR_INVALID_ARG, "could not read a host from %r" % args.url)

    # With a page given: a login is refused off its own site. A card has no URL to
    # match -- it is meant to work at any merchant -- so it is released and logged
    # instead of blocked.
    if page:
        try:
            rc, stdout, _ = _run_op(["item", "get", args.item_id, "--format", "json"])
            meta = json.loads(stdout) if rc == 0 and stdout.strip() else {}
        except (_OpToolError, json.JSONDecodeError):
            meta = {}
        if meta.get("category") != "CREDIT_CARD":
            keys = _item_host_keys(meta)
            if keys and page not in keys:
                _audit(args.item_id, args.field, page, "DENIED origin mismatch")
                return _emit_error(
                    _ERR_OP_DENIED,
                    "item belongs to %s, not to %s" % (", ".join(keys), page),
                )

    op_args = (
        ["item", "get", args.item_id, "--otp"]
        if args.field == _FIELD_TOTP
        else ["item", "get", args.item_id, "--field", args.field, "--reveal"]
    )
    try:
        rc, stdout, stderr = _run_op(op_args)
    except _OpToolError as exc:
        return _emit_error(exc.type_name, exc.message)
    if rc != 0:
        kind = _classify(stderr)
        _audit(args.item_id, args.field, page or "SEM-URL", "ERROR %s" % kind)
        return _emit_error(kind, _classify_message(kind, stderr))
    _audit(args.item_id, args.field, page or "SEM-URL", "RELEASED")
    sys.stdout.write(stdout.rstrip("\n"))
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    try:
        rc, stdout, _ = _run_op(["whoami", "--format", "json"])
    except _OpToolError as exc:
        if exc.type_name == _ERR_OP_UNAVAILABLE:
            return _emit_error(exc.type_name, exc.message)
        sys.stdout.write(json.dumps({"ok": True, "signed_in": False}) + "\n")
        return 0
    if rc != 0:
        sys.stdout.write(json.dumps({"ok": True, "signed_in": False}) + "\n")
        return 0
    try:
        info = json.loads(stdout)
    except json.JSONDecodeError:
        sys.stdout.write(json.dumps({"ok": True, "signed_in": False}) + "\n")
        return 0
    payload: dict = {"ok": True, "signed_in": True}
    email = info.get("email") or info.get("account_email") or info.get("user_email")
    if email:
        payload["account"] = email
    sys.stdout.write(json.dumps(payload) + "\n")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=_PROG,
        description=(
            "Broker between the seed-browser-usage daemon and the 1Password CLI. "
            "Wraps `op` so the daemon (and you, as a human) can list Login items "
            "for a domain, fetch a single allowlisted field, and check sign-in state. "
            "Stderr carries one JSON line {type, message} on every typed failure."
        ),
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_filter = sub.add_parser(
        _CMD_FILTER_LOGINS,
        help="List Login items matching an eTLD+1 domain (and optional query).",
        description=_OP_FILTER_LOGINS_DESC,
        epilog=(
            "Example:\n"
            "  seed-op-broker filter-logins --etld1 github.com --format json\n"
            "  seed-op-broker filter-logins --etld1 github.com --query work --format json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_filter.add_argument("--etld1", required=True, help="Registrable domain (e.g. github.com).")
    p_filter.add_argument(
        "--query",
        default=None,
        help="Optional case-insensitive substring matched against title or URL href (NEVER username).",
    )
    p_filter.add_argument(
        "--format",
        default=_FORMAT_JSON,
        help="Output format. Only 'json' is supported in v2.",
    )
    p_filter.set_defaults(func=_cmd_filter_logins)

    p_get = sub.add_parser(
        _CMD_GET_FIELD,
        help="Read one allowlisted field from a 1Password item.",
        description=_OP_GET_FIELD_DESC,
        epilog=(
            "Example:\n"
            "  seed-op-broker get-field --item-id abc123 --field password\n"
            "  seed-op-broker get-field --item-id abc123 --field totp"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_get.add_argument("--item-id", required=True, help="1Password item id (`op item list` to find).")
    p_get.add_argument(
        "--field", required=True,
        help="Field label to read, as reported by describe-item (or 'totp').",
    )
    p_get.add_argument(
        "--url", default=None,
        help=("URL of the page in the browser right now. Binds the release to it. "
              "WITHOUT --url there is no origin check at all and the value is "
              "released anyway -- the caller takes that responsibility, and the "
              "audit line records SEM-URL."),
    )
    p_get.set_defaults(func=_cmd_get_field)

    p_here = sub.add_parser(
        _CMD_WHATS_HERE,
        help="List everything in the vault (metadata only) for the open page.",
        description=(
            "List every item in reach -- logins and cards alike -- as metadata only: "
            "id, title, category, username, urls, and whether the item's own site is "
            "the page on screen. Nothing is filtered; the agent chooses. Never a secret."
        ),
        epilog="Example:\n  seed-op-broker whats-here --url https://example.com/checkout",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_here.add_argument("--url", required=True, help="URL currently open in the browser.")
    p_here.set_defaults(func=_cmd_whats_here)

    p_desc = sub.add_parser(
        _CMD_DESCRIBE,
        help="List one item's field labels, without any values.",
        description=(
            "Report which fields an item has, by label, so the agent can match them "
            "against the form on screen. Values are never returned here."
        ),
        epilog="Example:\n  seed-op-broker describe-item --item-id abc123",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_desc.add_argument("--item-id", required=True, help="1Password item id.")
    p_desc.set_defaults(func=_cmd_describe_item)

    p_status = sub.add_parser(
        _CMD_STATUS,
        help="Probe op's sign-in status.",
        description=_OP_STATUS_DESC,
        epilog="Example:\n  seed-op-broker status",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_status.set_defaults(func=_cmd_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
