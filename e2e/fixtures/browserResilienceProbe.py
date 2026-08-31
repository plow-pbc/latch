#!/usr/bin/env python3
"""Probe browser-server launch and pre-action navigation handling with stubs."""
import importlib.util
import io
import json
import os
import signal
import sys
import tempfile
import time
import types


def load_server():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "..", "vendor", "browser-server", "server.py")
    spec = importlib.util.spec_from_file_location("domo_browser_server", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def interrupt_hang(*_args):
    raise TimeoutError("unbounded page evaluation")


class Context:
    def __init__(self, *pages):
        self.pages = list(pages)

    def on(self, _event, _handler):
        pass


class Locator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    def evaluate(self, _script, timeout=None):
        self.page.driver_calls.append({
            "kind": "token", "selector": self.selector, "timeout": timeout,
        })
        if self.page.driver_timeout:
            raise TimeoutError("driver evaluation timed out")
        if self.page.driver_error:
            raise RuntimeError(self.page.driver_error)
        if self.page.driver_token is None:
            self.page.driver_token = self.page.evaluate_token
        return self.page.driver_token


class Page:
    def __init__(self, driver_token=None, evaluate_token="doc-new",
                 driver_timeout=False, driver_error=None,
                 url="https://example.test/start"):
        self.driver_token = driver_token
        self.evaluate_token = evaluate_token
        self.driver_timeout = driver_timeout
        self.driver_error = driver_error
        self.load_state_waits = []
        self.driver_calls = []
        self.page_evaluated = False
        self.page_evaluate_hangs = False
        self.goto_args = []
        self.back_args = []
        self.settles = []
        self.title_called = False
        self.brought_to_front = False
        self.url = url
        self.context = Context(self)

    def wait_for_load_state(self, state, timeout=None):
        self.load_state_waits.append([state, timeout])

    def evaluate(self, _script):
        self.page_evaluated = True
        if self.page_evaluate_hangs:
            time.sleep(10)
        return self.evaluate_token

    def locator(self, selector):
        return Locator(self, selector)

    def goto(self, url, timeout=None, wait_until=None):
        self.goto_args.append([url, timeout, wait_until])

    def wait_for_timeout(self, timeout):
        self.settles.append(timeout)

    def go_back(self, timeout=None, wait_until=None):
        self.back_args.append([timeout, wait_until])
        self.url = "https://example.test/previous"

    def bring_to_front(self):
        self.brought_to_front = True

    def title(self):
        self.title_called = True
        raise AssertionError("bounded actions must not make an untimed title call")


def main():
    real_stdout = os.fdopen(os.dup(1), "w")
    server = load_server()

    # The cancelled navigation shape: the old document answers load-state
    # immediately, but a direct page evaluation never comes back. The alarm
    # keeps an unfixed server finite; the driver-timed path never reaches it.
    wedge_page = Page(driver_token="doc-old", driver_timeout=True)
    wedge_page.wait_for_load_state("domcontentloaded", timeout=1000)
    wedge_page.page_evaluate_hangs = True
    wedge = server.Session(wedge_page)
    wedge.seen_document[wedge_page] = "doc-old"
    wedge.masked[wedge_page] = {("doc-old", "#secret")}
    previous_handler = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, interrupt_hang)
    signal.setitimer(signal.ITIMER_REAL, 0.05)
    try:
        wedge._forget_navigated()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)

    moved_page = Page()
    moved = server.Session(moved_page)
    moved.seen_document[moved_page] = "doc-old"
    moved.masked[moved_page] = {("doc-old", "#secret")}
    moved._forget_navigated()

    poisoned_page = Page(driver_token="doc-minted-elsewhere")
    poisoned = server.Session(poisoned_page)
    poisoned.seen_document[poisoned_page] = "doc-old"
    poisoned.masked[poisoned_page] = {("doc-old", "#secret")}
    poisoned._forget_navigated()
    poisoned_first = {
        "driver_calls": list(poisoned_page.driver_calls),
        "masked": bool(poisoned.masked.get(poisoned_page)),
        "seen": poisoned.seen_document.get(poisoned_page),
    }
    calls_after_first = len(poisoned_page.driver_calls)
    poisoned._forget_navigated()

    marker_page = Page(
        driver_token="doc-old",
        driver_error="getter threw __domo_document_stamped__",
    )
    marker = server.Session(marker_page)
    marker.seen_document[marker_page] = "doc-old"
    marker.masked[marker_page] = {("doc-old", "#secret")}
    marker._forget_navigated()

    goto_page = Page()
    goto_session = server.Session(goto_page)
    try:
        goto_result = goto_session.handle(
            {"action": "goto", "url": "https://example.test/"}, "/tmp"
        )
        goto_error = None
    except Exception as exc:  # noqa: BLE001 — an untimed title is the old path
        goto_result = None
        goto_error = type(exc).__name__

    back_page = Page()
    back_session = server.Session(back_page)
    try:
        back_result = back_session.handle({"action": "back"}, "/tmp")
        back_error = None
    except Exception as exc:  # noqa: BLE001 — probes the old untimed title path
        back_result = None
        back_error = type(exc).__name__

    first_page = Page(url="https://example.test/first")
    second_page = Page(url="https://example.test/second")
    shared_context = Context(first_page, second_page)
    first_page.context = shared_context
    second_page.context = shared_context
    use_page_session = server.Session(first_page)
    try:
        use_page_result = use_page_session.handle(
            {"action": "use_page", "index": 1}, "/tmp"
        )
        use_page_error = None
    except Exception as exc:  # noqa: BLE001 — probes the old untimed title path
        use_page_result = None
        use_page_error = type(exc).__name__

    launched = {}

    class DefaultAddons:
        UBO = object()

    class Browser:
        version = "fake"

        def __init__(self):
            self.page = Page()

        def new_page(self):
            return self.page

    class Camoufox:
        def __init__(self, **kwargs):
            launched.update(kwargs)
            self.browser = Browser()

        def __enter__(self):
            return self.browser

        def __exit__(self, *_args):
            pass

    camoufox = types.ModuleType("camoufox")
    camoufox.DefaultAddons = DefaultAddons
    sync_api = types.ModuleType("camoufox.sync_api")
    sync_api.Camoufox = Camoufox
    sys.modules["camoufox"] = camoufox
    sys.modules["camoufox.sync_api"] = sync_api

    old_argv, old_stdin = sys.argv, sys.stdin
    try:
        with tempfile.TemporaryDirectory() as screenshots:
            sys.argv = ["server.py", "--screenshots-dir", screenshots]
            sys.stdin = io.StringIO('{"id":1,"action":"quit"}\n')
            server._respond = lambda _message: None
            server.main()
    finally:
        sys.argv, sys.stdin = old_argv, old_stdin

    real_stdout.write(json.dumps({
        "wedge": {
            "load_state_responsive": bool(wedge_page.load_state_waits),
            "driver_calls": wedge_page.driver_calls,
            "page_evaluated": wedge_page.page_evaluated,
            "masked": bool(wedge.masked.get(wedge_page)),
        },
        "moved": {
            "driver_calls": moved_page.driver_calls,
            "page_evaluated": moved_page.page_evaluated,
            "masked": bool(moved.masked.get(moved_page)),
        },
        "poisoned": {
            "first": poisoned_first,
            "later_driver_calls": poisoned_page.driver_calls[calls_after_first:],
            "masked": bool(poisoned.masked.get(poisoned_page)),
            "seen": poisoned.seen_document.get(poisoned_page),
        },
        "marker_getter": {
            "driver_calls": marker_page.driver_calls,
            "masked": bool(marker.masked.get(marker_page)),
            "seen": marker.seen_document.get(marker_page),
        },
        "goto": {
            "driver_calls": goto_page.driver_calls,
            "page_evaluated": goto_page.page_evaluated,
            "goto_args": goto_page.goto_args,
            "settles": goto_page.settles,
            "title_called": goto_page.title_called,
            "result": goto_result,
            "error": goto_error,
        },
        "back": {
            "driver_calls": back_page.driver_calls,
            "back_args": back_page.back_args,
            "settles": back_page.settles,
            "title_called": back_page.title_called,
            "result": back_result,
            "error": back_error,
        },
        "use_page": {
            "driver_calls": first_page.driver_calls,
            "brought_to_front": second_page.brought_to_front,
            "title_called": second_page.title_called,
            "result": use_page_result,
            "error": use_page_error,
        },
        "constants": {
            "navigation_timeout_ms": getattr(server, "NAVIGATION_TIMEOUT_MS", 12000),
            "settle_ms": server.SETTLE_MS,
        },
        "ubo_excluded": launched.get("exclude_addons") == [DefaultAddons.UBO],
    }))
    real_stdout.flush()


if __name__ == "__main__":
    main()
