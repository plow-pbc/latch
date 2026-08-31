#!/usr/bin/env python3
"""Probe browser-server launch and pre-action navigation handling with stubs."""
import importlib.util
import io
import json
import os
import sys
import tempfile
import types


def load_server():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "..", "vendor", "browser-server", "server.py")
    spec = importlib.util.spec_from_file_location("domo_browser_server", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
        self.page.page_evaluated = True
        if self.page.driver_error:
            raise RuntimeError("document token getter threw")
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
        self.driver_calls = []
        self.page_evaluated = False
        self.goto_args = []
        self.back_args = []
        self.settles = []
        self.brought_to_front = False
        self.url = url
        self.context = Context(self)

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
        raise AssertionError("bounded actions must not make an untimed title call")


def main():
    real_stdout = os.fdopen(os.dup(1), "w")
    server = load_server()

    # The cancelled-navigation shape: the root cannot resolve, so the token
    # script never executes and the old safety ledger stays intact.
    wedge_page = Page(driver_token="doc-old", driver_timeout=True)
    wedge = server.Session(wedge_page)
    wedge.seen_document[wedge_page] = "doc-old"
    wedge.masked[wedge_page] = {("doc-old", "#secret")}
    wedge._forget_navigated()

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

    throwing_page = Page(driver_token="doc-old", driver_error=True)
    throwing = server.Session(throwing_page)
    throwing.seen_document[throwing_page] = "doc-old"
    throwing.masked[throwing_page] = {("doc-old", "#secret")}
    throwing._forget_navigated()

    goto_page = Page()
    goto_session = server.Session(goto_page)
    goto_result = goto_session.handle(
        {"action": "goto", "url": "https://example.test/"}, "/tmp"
    )

    back_page = Page()
    back_session = server.Session(back_page)
    back_result = back_session.handle({"action": "back"}, "/tmp")

    first_page = Page(url="https://example.test/first")
    second_page = Page(url="https://example.test/second")
    shared_context = Context(first_page, second_page)
    first_page.context = shared_context
    second_page.context = shared_context
    use_page_session = server.Session(first_page)
    use_page_result = use_page_session.handle(
        {"action": "use_page", "index": 1}, "/tmp"
    )

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
        "throwing_getter": {
            "masked": bool(throwing.masked.get(throwing_page)),
            "seen": throwing.seen_document.get(throwing_page),
        },
        "goto": {
            "driver_calls": goto_page.driver_calls,
            "page_evaluated": goto_page.page_evaluated,
            "goto_args": goto_page.goto_args,
            "settles": goto_page.settles,
            "result": goto_result,
        },
        "back": {
            "driver_calls": back_page.driver_calls,
            "back_args": back_page.back_args,
            "settles": back_page.settles,
            "result": back_result,
        },
        "use_page": {
            "driver_calls": first_page.driver_calls,
            "brought_to_front": second_page.brought_to_front,
            "result": use_page_result,
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
