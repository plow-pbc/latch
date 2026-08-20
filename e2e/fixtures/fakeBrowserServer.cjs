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
 *   CRASH_AFTER=n      after n commands, say one last thing (a 599 refusal),
 *                      then exit(9) a beat later so the parent reads the line
 *                      before the death — collapsing that beat re-opens a race
 *   GARBAGE=1          print a non-JSON line before every response
 *   FAKE_FILL_LOG=path append "selector\tvalue\tframe" per fill (secret-arrival proof)
 *   FAKE_CARD_FRAME_URL=url  frame_url reported by locate for "#card*" selectors
 *   FAKE_CSP_BLOCKS_MASK=1   answer every masked fill "unmasked" and type
 *                            nothing, the way a page whose style-src omits
 *                            'unsafe-inline' defeats the mask
 *   FAKE_FRAME_MOVED=1       answer every masked fill "moved", the way the real
 *                            server does when the resolved node is in a
 *                            different document than the one approved
 *   FAKE_REMASK_FAILS=1      refuse every screenshot/forms, the way the real
 *                            server refuses when a mark will not go back on
 *   FAKE_ARGV_LOG=path append this server's argv per launch (window-mode proof)
 *   FAKE_CMD_LOG=path  append the JSON of every command received, one per line
 *                      (proof of what the device asked the browser to do). The
 *                      `value` a fill carries is replaced with its length
 *                      before the line is written — a credential value never
 *                      reaches a log, a fixture's included.
 *
 * Scripted page behaviors:
 *   click "#blocked"  the page's own requests come back refused — one on the
 *                     approved origin, one on a third party, and one the
 *                     locked-out page aimed AT the approved origin
 *   click "#refuses"  refused AND fails, so the refusal has to ride an error
 *   click "#blocked-later"  the refusal settles after the click answered, so it
 *                     rides whatever reply comes next — a viewer poll, say
 *   click "#frames-fail"  on the NEXT reply: one attributable refusal and five
 *                     frame loads the browser cannot attribute — six for a ring
 *                     that holds five, so the oldest is pushed out
 *   click "#popup"     opens a second page on https://popup.example/pay
 *   click "#offsite"   navigates the page to https://offsite.example/lander
 *   click "#swallowed" fails the way a click something is covering does
 */
"use strict";
const fs = require("node:fs");
const readline = require("node:readline");

/** Refusals waiting for the next reply, most recent first, exactly as
 * server.py's reply_with_failures hands them over. `failedNext` is one that
 * settles after the action answered — a real XHR does, and it then rides
 * whatever reply comes next, including one the device asked for itself. */
let failed = [];
let failedNext = [];

/** How long the crash path waits between its last line and its death. Wide
 * enough that a stalled loop still reads the line first; a flake here means
 * raise it, not that the device regressed. */
const CRASH_LINE_BEAT_MS = 50;

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

/** Every reply carries what the page's requests did — a result or an error. */
function withFailures(reply) {
  const carried = failed;
  failed = failedNext;
  failedNext = [];
  return carried.length === 0 ? reply : { ...reply, failed_requests: carried };
}

function respond(obj, flushed) {
  if (process.env.GARBAGE === "1") process.stdout.write("firefox noise: not json\n");
  // The callback matters on the way out: a pipe write is async on macOS, and
  // exiting on top of one truncates the last thing this server said.
  process.stdout.write(JSON.stringify(obj) + "\n", flushed);
}

function handle(cmd) {
  const a = cmd.action;
  // The real server re-applies every mark before it lets anything be observed
  // and refuses the observation when one will not take. FAKE_REMASK_FAILS is
  // how a test says "it will not take"; which fields are masked is the real
  // server's business, and tracking a copy of it here only invited the two to
  // disagree.
  if ((a === "screenshot" || a === "forms") && process.env.FAKE_REMASK_FAILS === "1") {
    return { ok: false, mask: "unmasked" };
  }
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
    // The shape a real click failure has: the browser names what was over it.
    if (cmd.selector === "#swallowed") {
      throw new Error(
        `Frame.click: Timeout ${cmd.timeout_ms ?? 3000}ms exceeded.\nCall log:\n` +
          `  - <div class="modal-backdrop show"></div> intercepts pointer events\n`,
      );
    }
    if (cmd.selector === "#frames-fail") {
      // Most recent first, so the attributable one is last — the entry the ring
      // drops, and the one the agent could have used.
      failedNext = [
        ...Array.from({ length: 5 }, (_, i) => ({
          status: 414 - i, method: "GET", origin: "https://ads.example", initiator: "",
        })),
        {
          status: 401, method: "GET", origin: "https://pizza.example",
          initiator: "https://pizza.example",
        },
      ];
    }
    if (cmd.selector === "#blocked-later") {
      failedNext = [{
        status: 401, method: "GET", origin: "https://pizza.example",
        initiator: "https://pizza.example",
      }];
    }
    if (cmd.selector === "#blocked" || cmd.selector === "#refuses") {
      // Prepended, not assigned: the real server appends into one ring and
      // drains it reversed, so a late refusal still pending here keeps its
      // place — after the newer pair, being older. Bounding is not modelled;
      // BrowserHost caps what it holds regardless.
      failed = [
        {
          status: 429, method: "POST", origin: "https://pizza.example",
          initiator: "https://pizza.example", retry_after: "30",
          // A field this side does not know: the device rebuilds each entry
          // from what it does, so a vendored server that grew one cannot write
          // it into the owner's durable log.
          url: "https://pizza.example/cart?token=SECRET",
        },
        { status: 403, method: "GET", origin: "https://tracker.example",
          initiator: "https://pizza.example" },
        { status: 404, method: "GET", origin: "https://pizza.example",
          initiator: "https://offsite.example" },
        { status: 503, method: "GET", origin: "https://pizza.example", initiator: "" },
        ...failed,
      ];
      if (cmd.selector === "#refuses") throw new Error("locator.click: Timeout 3000ms exceeded.");
    }
    if (cmd.selector === "#popup") {
      state.pages.push({ url: "https://popup.example/pay", title: "popup" });
    } else if (cmd.selector === "#offsite") {
      current().url = "https://offsite.example/lander";
    }
    return { ok: true, frame: 0 };
  }
  if (a === "fill") {
    // A page that will not let the mark take: nothing is typed, and the caller
    // is told the value would have been legible.
    if (cmd.mask && process.env.FAKE_CSP_BLOCKS_MASK === "1") {
      return { ok: false, mask: "unmasked", frame: cmd.frame ?? 0 };
    }
    // The frame behind the index is no longer the document the device approved.
    if (process.env.FAKE_FRAME_MOVED === "1" && cmd.frame_token) {
      return { ok: false, mask: "moved", frame: cmd.frame ?? 0 };
    }
    // Playwright puts the value it tried to type into its own failure message.
    // Reproduce that shape so the leak this guards against is testable.
    if (String(cmd.selector) === "#nofill") {
      throw new Error(
        `locator.fill: Timeout 5000ms exceeded.\nCall log:\n` +
          `  - waiting for locator("${cmd.selector}")\n` +
          `  - filling "${cmd.value}"\n`,
      );
    }
    if (process.env.FAKE_FILL_LOG) {
      fs.appendFileSync(
        process.env.FAKE_FILL_LOG,
        `${cmd.selector}\t${cmd.value}\t${cmd.frame ?? 0}\n`,
      );
    }
    return {
      ok: true,
      frame: cmd.frame ?? 0,
      ...(cmd.mask ? { mask: "stylesheet" } : {}),
    };
  }
  if (a === "locate") {
    // The token is what the fill is checked against; the url is what the device
    // checks an origin against.
    if (String(cmd.selector).startsWith("#card")) {
      return {
        frame: 1,
        frame_url: process.env.FAKE_CARD_FRAME_URL || "https://payframe.example/card",
        frame_token: "doc-card",
      };
    }
    return { frame: 0, frame_url: current().url, frame_token: "doc-top" };
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
    if (process.env.FAKE_CMD_LOG) {
      // Redacted here, at the point of writing, so no reader has to remember to
      // do it and no failure diff can print the value.
      const line = typeof cmd.value === "string" ? { ...cmd, value: `<${cmd.value.length} chars>` } : cmd;
      fs.appendFileSync(process.env.FAKE_CMD_LOG, JSON.stringify(line) + "\n");
    }
    state.commands++;
    if (process.env.CRASH_AFTER && state.commands > Number(process.env.CRASH_AFTER)) {
      // A last word on the way out: a real browser can answer a request and die
      // before the device has read the line.
      // 599: a status nothing else here emits, so a test can say this line is
      // the one that arrived on the way out. The death comes a beat after it,
      // because the parent reads this pipe on one event and learns of the exit
      // on another, and libuv gives them no relative order — the beat is the
      // margin that keeps the test about the contract rather than the race.
      respond({
        failed_requests: [{
          status: 599, method: "GET", origin: "https://pizza.example",
          initiator: "https://pizza.example",
        }],
      }, () => setTimeout(() => process.exit(9), CRASH_LINE_BEAT_MS));
      return;
    }
    // HANG_ACTION=<name>: never answer that action, to exercise the host's
    // per-action timeout backstop.
    if (process.env.HANG_ACTION && cmd.action === process.env.HANG_ACTION) return;
    let reply;
    try {
      reply = { id: cmd.id, result: envelope(handle(cmd)) };
    } catch (e) {
      reply = { id: cmd.id, error: String(e.message || e).slice(0, 500) };
    }
    respond(withFailures(reply));
  });
  rl.on("close", () => process.exit(0));
}

main();
