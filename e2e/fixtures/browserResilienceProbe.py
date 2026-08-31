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
    def __init__(self, page):
        self.pages = [page]

    def on(self, _event, _handler):
        pass


class Page:
    def __init__(self, token="doc-new", wait_error=False):
        self.token = token
        self.wait_error = wait_error
        self.waited = []
        self.evaluated = False
        self.context = Context(self)

    def wait_for_load_state(self, state, timeout=None):
        self.waited.append([state, timeout])
        if self.wait_error:
            raise TimeoutError("document did not settle")

    def evaluate(self, _script):
        self.evaluated = True
        return self.token


def main():
    real_stdout = os.fdopen(os.dup(1), "w")
    server = load_server()

    stuck_page = Page(wait_error=True)
    stuck = server.Session(stuck_page)
    stuck.seen_document[stuck_page] = "doc-old"
    stuck.masked[stuck_page] = {("doc-old", "#secret")}
    stuck._forget_navigated()

    moved_page = Page()
    moved = server.Session(moved_page)
    moved.seen_document[moved_page] = "doc-old"
    moved.masked[moved_page] = {("doc-old", "#secret")}
    moved._forget_navigated()

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
        "stuck": {
            "waited": stuck_page.waited,
            "evaluated": stuck_page.evaluated,
            "masked": bool(stuck.masked.get(stuck_page)),
        },
        "moved": {
            "waited": moved_page.waited,
            "evaluated": moved_page.evaluated,
            "masked": bool(moved.masked.get(moved_page)),
        },
        "ubo_excluded": launched.get("exclude_addons") == [DefaultAddons.UBO],
    }))
    real_stdout.flush()


if __name__ == "__main__":
    main()
