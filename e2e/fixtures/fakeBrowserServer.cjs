#!/usr/bin/env node
/**
 * Fake Camoufox server speaking the exact stdio JSON-lines protocol of
 * vendor/browser-server/server.py — ready line, id-tagged responses, url +
 * page_count envelope — with scripted behaviors so tests can exercise the
 * enforcement layer without Python or a browser.
 *
 * Knobs (env):
 *   SLOW_START=ms      delay the ready line
 *   NO_READY=1         never emit the ready line (start-timeout tests)
 *   CRASH_AFTER=n      exit(9) after n commands (crash/restart tests)
 *   GARBAGE=1          print a non-JSON line before every response
 *   FAKE_FILL_LOG=path append "selector\tvalue\tframe" per fill (secret-arrival proof)
 *   FAKE_CARD_FRAME_URL=url  frame_url reported by locate for "#card*" selectors
 *   FAKE_ARGV_LOG=path append this server's argv per launch (window-mode proof)
 *
 * Scripted page behaviors:
 *   click "#popup"    opens a second page on https://popup.example/pay
 *   click "#offsite"  navigates the page to https://offsite.example/lander
 */
"use strict";
const fs = require("node:fs");
const readline = require("node:readline");

const state = {
  pages: [{ url: "about:blank", title: "blank" }],
  active: 0,
  commands: 0,
};

function current() {
  return state.pages[state.active];
}

function envelope(result) {
  return { ...result, url: current().url, page_count: state.pages.length };
}

function respond(obj) {
  if (process.env.GARBAGE === "1") process.stdout.write("firefox noise: not json\n");
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd) {
  const a = cmd.action;
  if (a === "goto") {
    current().url = cmd.url;
    current().title = "page at " + cmd.url;
    return { title: current().title };
  }
  if (a === "pages") {
    return {
      pages: state.pages.map((p, i) => ({ i, url: p.url, title: p.title })),
      active: state.active,
    };
  }
  if (a === "use_page") {
    if (cmd.index < 0 || cmd.index >= state.pages.length) throw new Error("no page " + cmd.index);
    state.active = cmd.index;
    return { ok: true, title: current().title };
  }
  if (a === "back") return { title: current().title, moved: false };
  if (a === "view") {
    return {
      data_b64: Buffer.from("fake-view-jpeg").toString("base64"),
      mime: "image/jpeg",
    };
  }
  if (a === "screenshot") {
    return {
      data_b64: Buffer.from("fake-jpeg-bytes").toString("base64"),
      mime: "image/jpeg",
      path: "/dev/null",
    };
  }
  if (a === "text") return { text: "fake page text of " + current().url };
  if (a === "eval") return { result: "eval:" + cmd.expression };
  if (a === "click") {
    if (cmd.selector === "#popup") {
      state.pages.push({ url: "https://popup.example/pay", title: "popup" });
    } else if (cmd.selector === "#offsite") {
      current().url = "https://offsite.example/lander";
    }
    return { ok: true, frame: 0 };
  }
  if (a === "fill") {
    if (process.env.FAKE_FILL_LOG) {
      fs.appendFileSync(
        process.env.FAKE_FILL_LOG,
        `${cmd.selector}\t${cmd.value}\t${cmd.frame ?? 0}\n`,
      );
    }
    return { ok: true, frame: cmd.frame ?? 0 };
  }
  if (a === "locate") {
    if (String(cmd.selector).startsWith("#card")) {
      return {
        frame: 1,
        frame_url: process.env.FAKE_CARD_FRAME_URL || "https://payframe.example/card",
      };
    }
    return { frame: 0, frame_url: current().url };
  }
  if (a === "scroll") return { ok: true };
  if (a === "wait") return { ok: true, seconds: cmd.seconds }; // echo so tests can see clamping
  if (a === "url") return {};
  if (a === "title") return { title: current().title };
  if (a === "links") return { links: [] };
  if (a === "forms") return { forms: [{ tag: "input", name: "q", frame: 0, frame_url: current().url }] };
  if (a === "tables") return { tables: [] };
  throw new Error("unknown action: " + a);
}

function main() {
  // One line per launch, so a test can see the window mode the host chose —
  // --headed is a spawn flag, invisible on the protocol channel.
  if (process.env.FAKE_ARGV_LOG) {
    fs.appendFileSync(process.env.FAKE_ARGV_LOG, process.argv.slice(2).join(" ") + "\n");
  }
  const start = () => {
    if (process.env.NO_READY !== "1") {
      respond({ status: "ready", pid: process.pid, browser_version: "fake-152.0.4" });
    }
  };
  const delay = Number(process.env.SLOW_START || 0);
  if (delay > 0) setTimeout(start, delay);
  else start();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      respond({ id: null, error: "invalid JSON" });
      return;
    }
    if (cmd.action === "quit") {
      respond({ id: cmd.id, result: { ok: true } });
      process.exit(0);
    }
    state.commands++;
    if (process.env.CRASH_AFTER && state.commands > Number(process.env.CRASH_AFTER)) {
      process.exit(9);
    }
    // HANG_ACTION=<name>: never answer that action, to exercise the host's
    // per-action timeout backstop.
    if (process.env.HANG_ACTION && cmd.action === process.env.HANG_ACTION) return;
    try {
      respond({ id: cmd.id, result: envelope(handle(cmd)) });
    } catch (e) {
      respond({ id: cmd.id, error: String(e.message || e).slice(0, 500) });
    }
  });
  rl.on("close", () => process.exit(0));
}

main();
