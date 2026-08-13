from __future__ import annotations

import argparse
import ipaddress
import json
import os
import stat
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from typing import Iterable

import tldextract

from seed_vault_broker import __version__

_PROG = "seed-vault-broker"
_BW_BIN = os.environ.get("SEED_VAULT_BW", "bw")
_BW_TIMEOUT_S = int(os.environ.get("SEED_VAULT_TIMEOUT", "60"))

# The vault this broker reads, and whose machine it is. Both come from whoever
# starts the broker -- there is no default, because a default here is one
# person's address shipped to everybody else.
_VAULT_URL = os.environ.get("SEED_VAULT_URL", "")
_PERSON = os.environ.get("SEED_VAULT_PERSON", "")
_VAULT_USER = os.environ.get("SEED_VAULT_USER", "")
_VAULT_CA = os.environ.get("SEED_VAULT_CA", "")  # the server has a real certificate
_KEYCHAIN_SERVICE = os.environ.get("SEED_VAULT_KEYCHAIN", "vaultwarden-agent")

_STATE_DIR = os.environ.get("SEED_VAULT_STATE", os.path.expanduser("~/.local/state/vault-broker"))
_BW_DATA_DIR = os.path.join(_STATE_DIR, "bw")
_SESSION_PATH = os.path.join(_STATE_DIR, "session")

_FORMAT_JSON = "json"
_CMD_FILTER_LOGINS = "filter-logins"
_CMD_GET_FIELD = "get-field"
_CMD_STATUS = "status"
_CMD_WHATS_HERE = "whats-here"
_CMD_DESCRIBE = "describe-item"
_AUDIT_PATH = os.environ.get(
    "SEED_VAULT_AUDIT", os.path.expanduser("~/.local/state/vault-broker/audit.log")
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
_USERNAME_FIELDS = frozenset({_FIELD_USERNAME, _FIELD_EMAIL, _FIELD_LOGIN, _FIELD_USER})

_MAX_ENTRIES = 50

_ERR_VAULT_LOCKED = "VaultLocked"
_ERR_VAULT_DENIED = "VaultDenied"
_ERR_VAULT_NOT_FOUND = "VaultNotFound"
_ERR_VAULT_UNAVAILABLE = "VaultUnavailable"
_ERR_INVALID_ARG = "InvalidArgument"
_ERR_VAULT_ERROR = "VaultError"

_LOCKED_PATTERNS = ("not logged in", "vault is locked", "session key", "unauthenticated")
_NOT_FOUND_PATTERNS = ("not found", "no such item", "more than one result", "404")

_HTTP_SCHEMES = frozenset({"http", "https"})

_LOCKED_MSG = "The vault could not be unlocked. Check the agent's stored vault password."
_DENIED_MSG = "The vault refused the request."
_NOT_FOUND_MSG = "No such item in the vault."
_UNAVAILABLE_MSG = (
    "The vault command line tool is not on PATH. Install it with `npm install -g @bitwarden/cli`."
)
_TIMEOUT_MSG = "The vault did not answer in time."
_NO_PASSWORD_MSG = (
    "The agent's vault password is not in the login keychain "
    "(service %r, account %r)." % (_KEYCHAIN_SERVICE, _VAULT_USER)
)

_FILTER_LOGINS_DESC = (
    "List vault Login items whose stored URLs match the given eTLD+1 domain. "
    "Search is by title or URL (case-insensitive); username is returned but "
    "never matched against."
)
_GET_FIELD_DESC = (
    "Read a single field from a vault item. The value is written to stdout "
    "with no trailing newline. Pass --url to bind the release to the page on "
    "screen; without it NO origin check runs and the audit records SEM-URL."
)
_STATUS_DESC = "Probe whether the vault can be reached and unlocked. Always exits 0 unless the tool is missing."

_EXTRACTOR = tldextract.TLDExtract(suffix_list_urls=())

# Vault item types, as the vault reports them, mapped onto the category names the
# browser side already speaks.
_CATEGORY_BY_TYPE = {1: "LOGIN", 2: "SECURE_NOTE", 3: "CREDIT_CARD", 4: "IDENTITY"}


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
        return _ERR_VAULT_LOCKED
    if any(p in lowered for p in _NOT_FOUND_PATTERNS):
        return _ERR_VAULT_NOT_FOUND
    return _ERR_VAULT_ERROR


def _classify_message(error_type: str, fallback: str) -> str:
    return {
        _ERR_VAULT_LOCKED: _LOCKED_MSG,
        _ERR_VAULT_DENIED: _DENIED_MSG,
        _ERR_VAULT_NOT_FOUND: _NOT_FOUND_MSG,
    }.get(error_type, fallback.strip() or "Vault error")


def _emit_error(error_type: str, message: str) -> int:
    sys.stderr.write(json.dumps({"type": error_type, "message": message}) + "\n")
    return 1


class _VaultToolError(Exception):
    def __init__(self, type_name: str, message: str):
        super().__init__(message)
        self.type_name = type_name
        self.message = message


def _state_dir() -> str:
    os.makedirs(_STATE_DIR, mode=0o700, exist_ok=True)
    os.makedirs(_BW_DATA_DIR, mode=0o700, exist_ok=True)
    return _STATE_DIR


def _vault_env(session: str | None) -> dict[str, str]:
    """Environment for the vault tool.

    The session key goes in the environment, never in argv: anything on the command
    line is visible to every process on the machine via `ps`.
    """
    env = os.environ.copy()
    env["BITWARDENCLI_APPDATA_DIR"] = _BW_DATA_DIR
    if os.path.exists(_VAULT_CA):
        env["NODE_EXTRA_CA_CERTS"] = _VAULT_CA
    if session:
        env["BW_SESSION"] = session
    return env


def _read_session() -> str | None:
    try:
        with open(_SESSION_PATH, encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def _write_session(session: str) -> None:
    _state_dir()
    fd = os.open(_SESSION_PATH, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(session)
    os.chmod(_SESSION_PATH, stat.S_IRUSR | stat.S_IWUSR)


def _keychain_read(account: str) -> str:
    try:
        p = subprocess.run(["security", "find-generic-password", "-a", account,
                            "-s", _KEYCHAIN_SERVICE, "-w"],
                           capture_output=True, text=True, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return p.stdout.strip() if p.returncode == 0 else ""


def _keychain_write(account: str, secret: str) -> None:
    subprocess.run(["security", "add-generic-password", "-a", account,
                    "-s", _KEYCHAIN_SERVICE, "-w", secret, "-U"],
                   capture_output=True, timeout=30)


def _fetch_credential() -> tuple[str, str]:
    """Collect this person's agent credential from the vault host, once.

    The person never carries anything across: this machine proves it is ours with a
    token kept in its own keychain, asks for the agent that belongs to its person, and
    remembers the answer locally.
    """
    fleet = _keychain_read("fleet-token")
    if not fleet:
        raise _VaultToolError(_ERR_VAULT_LOCKED, "this machine has no fleet token")
    body = urllib.parse.urlencode({"person": _PERSON}).encode()
    req = urllib.request.Request(_VAULT_URL + "/fleet/agent-credential", data=body,
                                 method="POST",
                                 headers={"Authorization": "Bearer " + fleet,
                                          "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise _VaultToolError(_ERR_VAULT_LOCKED,
                              "the vault host would not release the agent credential (%s)" % e.code)
    except urllib.error.URLError as e:
        raise _VaultToolError(_ERR_VAULT_UNAVAILABLE, "cannot reach the vault host")
    email, password = data.get("agent_email", ""), data.get("agent_password", "")
    if not email or not password:
        raise _VaultToolError(_ERR_VAULT_LOCKED, "the vault host returned no credential")
    _keychain_write(email, password)
    _keychain_write("agent-address-for-" + _PERSON, email)
    return email, password


def _forget_local_state(reason: str) -> None:
    """Drop the vault tool's local copy when the identity changes, or it keeps answering
    as whoever was signed in last."""
    shutil.rmtree(_BW_DATA_DIR, ignore_errors=True)
    try:
        os.remove(_SESSION_PATH)
    except OSError:
        pass


def _remember_identity(email: str) -> None:
    marker = os.path.join(_STATE_DIR, "identity")
    previous = ""
    try:
        with open(marker) as fh:
            previous = fh.read().strip()
    except OSError:
        pass
    if previous != email:
        _forget_local_state("identity changed")
        _state_dir()
        with open(marker, "w") as fh:
            fh.write(email)


def _agent_identity() -> tuple[str, str]:
    """The address and password this machine signs into the vault with.

    Domo hands both in the environment: the vault lives in the app now, so the app
    owns that account and keeps its password in its own secure storage. The keychain
    path below is what a standalone install still uses.
    """
    supplied = os.environ.get("SEED_VAULT_PASSWORD", "")
    if _VAULT_USER and supplied:
        # Same as every other path: if this is a different account than last
        # time, the tool's local copy belongs to the old one and has to go, or
        # it keeps answering for whoever was signed in before.
        _remember_identity(_VAULT_USER)
        return _VAULT_USER, supplied
    if _VAULT_USER:                        # an explicit override still wins
        pw = _keychain_read(_VAULT_USER)
        if pw:
            return _VAULT_USER, pw
    remembered = _keychain_read("agent-address-for-" + _PERSON)
    if remembered:
        pw = _keychain_read(remembered)
        if pw:
            _remember_identity(remembered)
            return remembered, pw
    email, password = _fetch_credential()
    _remember_identity(email)
    return email, password


def _vault_password() -> str:
    """Kept for the explicit-override path: the agent password from the keychain."""
    try:
        probe = subprocess.run(
            ["security", "find-generic-password", "-a", _VAULT_USER,
             "-s", _KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, check=False, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise _VaultToolError(_ERR_VAULT_LOCKED, _NO_PASSWORD_MSG)
    password = probe.stdout.strip()
    if probe.returncode != 0 or not password:
        raise _VaultToolError(_ERR_VAULT_LOCKED, _NO_PASSWORD_MSG)
    return password


def _raw_bw(args: list[str], session: str | None) -> subprocess.CompletedProcess:
    try:
        # --nointeraction + closed stdin: without a TTY, bw otherwise blocks on
        # prompts forever (the "browser crashed" hang on credentials).
        return subprocess.run(
            [_BW_BIN, "--nointeraction", *args],
            capture_output=True, text=True, check=False,
            env=_vault_env(session), timeout=_BW_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        raise _VaultToolError(_ERR_VAULT_UNAVAILABLE, _UNAVAILABLE_MSG)
    except subprocess.TimeoutExpired:
        raise _VaultToolError(_ERR_VAULT_LOCKED, _TIMEOUT_MSG)


def _open_vault() -> str:
    """Log in or unlock, and cache the session for the next call.

    Unlocking costs a key derivation every time, so the session is reused until the
    vault rejects it; that keeps a page fill fast without holding the password.
    """
    _state_dir()
    _point_at_vault()
    status = _raw_bw(["status"], None)
    try:
        if json.loads(status.stdout)["serverUrl"] != _VAULT_URL:
            raise _VaultToolError(_ERR_VAULT_ERROR, "The vault tool is pointed at the wrong server.")
    except (ValueError, KeyError):
        raise _VaultToolError(_ERR_VAULT_ERROR, "Could not read the vault's status.")

    email, password = _agent_identity()
    directory = tempfile.mkdtemp(prefix="vault-broker-")
    pw_path = os.path.join(directory, "p")
    try:
        fd = os.open(pw_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(password)
        for verb in ("unlock", "login"):
            attempt = _raw_bw([verb, *( [] if verb == "unlock" else [email] ),
                               "--passwordfile", pw_path, "--raw"], None)
            session = attempt.stdout.strip()
            if session:
                _write_session(session)
                return session
        raise _VaultToolError(_ERR_VAULT_LOCKED, _LOCKED_MSG)
    finally:
        for name in os.listdir(directory):
            os.remove(os.path.join(directory, name))
        os.rmdir(directory)


_server_set = False


def _point_at_vault() -> None:
    """Aim the vault tool at our vault, but only when it is not already aimed there.

    `config server` is refused outright while the tool is signed in ("Logout
    required before server config update"), so setting it unconditionally works
    exactly once — on a fresh state — and fails on every call after the first
    login. Ask first, and only log out if the address really has to change.
    """
    status = _raw_bw(["status"], None)
    try:
        if json.loads(status.stdout).get("serverUrl") == _VAULT_URL:
            return
    except (ValueError, KeyError, TypeError):
        pass
    cfg = _raw_bw(["config", "server", _VAULT_URL], None)
    if cfg.returncode != 0:
        # Pointed somewhere else and signed in there: that session belongs to
        # the old address, so it goes before the address changes.
        _raw_bw(["logout"], None)
        cfg = _raw_bw(["config", "server", _VAULT_URL], None)
    if cfg.returncode != 0:
        raise _VaultToolError(_ERR_VAULT_ERROR, "Could not point the vault tool at %s." % _VAULT_URL)


def _ensure_identity_and_server() -> None:
    """Point the vault tool at the configured vault, once per run.

    Without this, a command that needs no login (like status) answers from whatever
    server the local state was last configured for, so changing the vault address in
    this file appeared to do nothing.
    """
    global _server_set
    if _server_set:
        return
    # resolve who this machine is for first: a session cached for a different person
    # would otherwise answer, silently, with the wrong vault
    _agent_identity()
    _state_dir()
    _point_at_vault()
    _server_set = True


def _run_vault(args: list[str]) -> tuple[int, str, str]:
    """Run one vault command, unlocking once if the cached session is stale."""
    _ensure_identity_and_server()
    session = _read_session()
    if session:
        result = _raw_bw(args, session)
        if result.returncode == 0:
            return result.returncode, result.stdout, result.stderr
        if _classify(result.stderr + result.stdout) != _ERR_VAULT_LOCKED:
            return result.returncode, result.stdout, result.stderr
    session = _open_vault()
    result = _raw_bw(args, session)
    return result.returncode, result.stdout, result.stderr


def _sync() -> None:
    """Pull the latest items. Without this a credential added a moment ago is invisible."""
    try:
        _run_vault(["sync"])
    except _VaultToolError:
        pass  # a stale local copy still beats failing the whole call


def _normalize(raw: dict) -> dict:
    """One vault item in the shape the matching and reporting code already expects."""
    login = raw.get("login") or {}
    uris = login.get("uris") or []
    urls = [{"href": u.get("uri")} for u in uris if u.get("uri")]
    if urls:
        urls[0]["primary"] = True
    return {
        "id": raw.get("id", ""),
        "title": raw.get("name", ""),
        "category": _CATEGORY_BY_TYPE.get(raw.get("type"), "UNKNOWN"),
        "additional_information": login.get("username") or "",
        "urls": urls,
        "_raw": raw,
    }


def _list_items(logins_only: bool = False) -> list[dict]:
    _sync()
    rc, stdout, stderr = _run_vault(["list", "items"])
    if rc != 0:
        kind = _classify(stderr)
        raise _VaultToolError(kind, _classify_message(kind, stderr))
    try:
        raw_items = json.loads(stdout) if stdout.strip() else []
    except json.JSONDecodeError as exc:
        raise _VaultToolError(_ERR_VAULT_ERROR, "Could not read the vault's item list: %s" % exc)
    items = [_normalize(i) for i in raw_items]
    if logins_only:
        items = [i for i in items if i["category"] == "LOGIN"]
    return items


def _get_item(item_id: str) -> dict:
    rc, stdout, stderr = _run_vault(["get", "item", item_id])
    if rc != 0:
        kind = _classify(stderr)
        raise _VaultToolError(kind, _classify_message(kind, stderr))
    try:
        return _normalize(json.loads(stdout))
    except (json.JSONDecodeError, TypeError) as exc:
        raise _VaultToolError(_ERR_VAULT_ERROR, "Could not read that item: %s" % exc)


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
    """Stable key for "the page I am on": eTLD+1, else the host.

    localhost and bare IPs have no registrable domain, so _etld1 returns None for
    them. Falling back to the host keeps local pages usable without teaching the
    broker anything about any particular site.
    """
    etld1 = _etld1(url)
    if etld1:
        return etld1
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in _HTTP_SCHEMES or not parsed.hostname:
        return None
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


def _field_labels(item: dict) -> list[str]:
    """What this item actually has, by label, so the agent can match the form.

    A vault item keeps the login parts in fixed slots and anything else in named
    custom fields; both are reported, values never are.
    """
    raw = item.get("_raw") or {}
    labels: list[str] = []
    login = raw.get("login") or {}
    if login.get("username"):
        labels.append(_FIELD_USERNAME)
    if login.get("password"):
        labels.append(_FIELD_PASSWORD)
    if login.get("totp"):
        labels.append(_FIELD_TOTP)
    card = raw.get("card") or {}
    for key, label in (("number", "number"), ("code", "code"),
                       ("expMonth", "expiry month"), ("expYear", "expiry year"),
                       ("cardholderName", "cardholder name")):
        if card.get(key):
            labels.append(label)
    for field in raw.get("fields") or []:
        name = field.get("name")
        if name and name not in labels and (field.get("value") is not None or field.get("type") == 1):
            labels.append(name)
    if raw.get("notes"):
        labels.append("notes")
    return labels


def _read_field(item: dict, field: str) -> str | None:
    raw = item.get("_raw") or {}
    login = raw.get("login") or {}
    if field == _FIELD_PASSWORD:
        return login.get("password")
    if field in _USERNAME_FIELDS:
        return login.get("username")
    return None


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
        items = _list_items()
    except _VaultToolError as exc:
        return _emit_error(exc.type_name, exc.message)

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
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


def _cmd_describe_item(args: argparse.Namespace) -> int:
    """Field LABELS of one item -- never their values."""
    try:
        item = _get_item(args.item_id)
    except _VaultToolError as exc:
        return _emit_error(exc.type_name, exc.message)
    _audit(args.item_id, "(labels)", "-", "DESCRIBED")
    sys.stdout.write(json.dumps({
        "id": item.get("id", ""), "title": item.get("title", ""),
        "category": item.get("category", ""), "fields": _field_labels(item),
    }) + "\n")
    return 0


def _cmd_filter_logins(args: argparse.Namespace) -> int:
    if args.format != _FORMAT_JSON:
        return _emit_error(_ERR_INVALID_ARG, f"--format must be {_FORMAT_JSON!r}")
    try:
        items = _list_items(logins_only=True)
    except _VaultToolError as exc:
        return _emit_error(exc.type_name, exc.message)

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
    if args.field not in _ALLOWED_FIELDS:
        return _emit_error(
            _ERR_INVALID_ARG,
            "field %r is not releasable; allowed: %s" % (args.field, ", ".join(sorted(_ALLOWED_FIELDS))),
        )
    page = _host_key(args.url) if args.url else None
    if args.url and not page:
        return _emit_error(_ERR_INVALID_ARG, "could not read a host from %r" % args.url)

    try:
        item = _get_item(args.item_id)
    except _VaultToolError as exc:
        _audit(args.item_id, args.field, page or "SEM-URL", "ERROR %s" % exc.type_name)
        return _emit_error(exc.type_name, exc.message)

    # With a page given: a login is refused off its own site. A card has no URL to
    # match -- it is meant to work at any merchant -- so it is released and logged
    # instead of blocked.
    if page and item.get("category") != "CREDIT_CARD":
        keys = _item_host_keys(item)
        if keys and page not in keys:
            _audit(args.item_id, args.field, page, "DENIED origin mismatch")
            return _emit_error(
                _ERR_VAULT_DENIED,
                "item belongs to %s, not to %s" % (", ".join(keys), page),
            )

    if args.field == _FIELD_TOTP:
        rc, stdout, stderr = _run_vault(["get", "totp", args.item_id])
        if rc != 0 or not stdout.strip():
            kind = _classify(stderr) if rc != 0 else _ERR_VAULT_NOT_FOUND
            _audit(args.item_id, args.field, page or "SEM-URL", "ERROR %s" % kind)
            return _emit_error(kind, _classify_message(kind, stderr))
        value = stdout.rstrip("\n")
    else:
        value = _read_field(item, args.field)
        if value is None:
            _audit(args.item_id, args.field, page or "SEM-URL", "ERROR %s" % _ERR_VAULT_NOT_FOUND)
            return _emit_error(_ERR_VAULT_NOT_FOUND, "item has no %s" % args.field)

    _audit(args.item_id, args.field, page or "SEM-URL", "RELEASED")
    sys.stdout.write(value)
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    try:
        # resolving the identity is what pairs this machine on first use
        _agent_identity()
    except _VaultToolError as exc:
        return _emit_error(exc.type_name, exc.message)
    try:
        rc, stdout, _ = _run_vault(["status"])
    except _VaultToolError as exc:
        if exc.type_name == _ERR_VAULT_UNAVAILABLE:
            return _emit_error(exc.type_name, exc.message)
        sys.stdout.write(json.dumps({"ok": True, "signed_in": False}) + "\n")
        return 0
    try:
        info = json.loads(stdout)
    except json.JSONDecodeError:
        sys.stdout.write(json.dumps({"ok": True, "signed_in": False}) + "\n")
        return 0
    unlocked = info.get("status") == "unlocked"
    payload: dict = {"ok": True, "signed_in": unlocked, "vault": info.get("serverUrl") or _VAULT_URL,
                     "person": _PERSON}
    if info.get("userEmail"):
        payload["account"] = info["userEmail"]
    else:
        remembered = _keychain_read("agent-address-for-" + _PERSON)
        if remembered:
            payload["account"] = remembered
    sys.stdout.write(json.dumps(payload) + "\n")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=_PROG,
        description=(
            "Broker between the seed-browser-usage daemon and the self-hosted vault. "
            "The daemon (and you, as a human) can list Login items for a domain, fetch a "
            "single allowlisted field, and check whether the vault is reachable. "
            "Stderr carries one JSON line {type, message} on every typed failure."
        ),
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_filter = sub.add_parser(
        _CMD_FILTER_LOGINS,
        help="List Login items matching an eTLD+1 domain (and optional query).",
        description=_FILTER_LOGINS_DESC,
        epilog=(
            "Example:\n"
            "  seed-vault-broker filter-logins --etld1 github.com --format json\n"
            "  seed-vault-broker filter-logins --etld1 github.com --query work --format json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_filter.add_argument("--etld1", required=True, help="Registrable domain (e.g. github.com).")
    p_filter.add_argument(
        "--query",
        default=None,
        help="Optional case-insensitive substring matched against title or URL (NEVER username).",
    )
    p_filter.add_argument(
        "--format",
        default=_FORMAT_JSON,
        help="Output format. Only 'json' is supported.",
    )
    p_filter.set_defaults(func=_cmd_filter_logins)

    p_get = sub.add_parser(
        _CMD_GET_FIELD,
        help="Read one allowlisted field from a vault item.",
        description=_GET_FIELD_DESC,
        epilog=(
            "Example:\n"
            "  seed-vault-broker get-field --item-id abc123 --field password\n"
            "  seed-vault-broker get-field --item-id abc123 --field totp"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_get.add_argument("--item-id", required=True, help="Vault item id (`whats-here` to find).")
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
        epilog="Example:\n  seed-vault-broker whats-here --url https://example.com/checkout",
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
        epilog="Example:\n  seed-vault-broker describe-item --item-id abc123",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_desc.add_argument("--item-id", required=True, help="Vault item id.")
    p_desc.set_defaults(func=_cmd_describe_item)

    p_status = sub.add_parser(
        _CMD_STATUS,
        help="Probe whether the vault is reachable and unlocked.",
        description=_STATUS_DESC,
        epilog="Example:\n  seed-vault-broker status",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_status.set_defaults(func=_cmd_status)

    return parser


def _require_config() -> None:
    """Refuse to guess. Without these the broker would have to invent a vault
    address or a person, and inventing either means answering for someone
    else's account."""
    missing = [n for n, v in (("SEED_VAULT_URL", _VAULT_URL), ("SEED_VAULT_PERSON", _PERSON)) if not v]
    if missing:
        raise _VaultToolError(
            _ERR_INVALID_ARG,
            "not configured: %s must be set by whoever starts this." % " and ".join(missing),
        )


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        _require_config()
    except _VaultToolError as exc:
        return _emit_error(exc.type_name, exc.message)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
