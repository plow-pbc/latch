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
 *   FAKE_CSP_BLOCKS_MASK=1   answer every masked fill "unmasked" and type
 *                            nothing, the way a page whose style-src omits
 *                            'unsafe-inline' defeats the mask
 *   FAKE_FRAME_MOVED=1       answer every masked fill "moved", the way the real
 *                            server does when the resolved node is in a
 *                            different document than the one approved
 *   FAKE_NEST_FAILURES=1     put failed_requests inside `result` instead of on the
 *                            reply, the way a mismatched vendored server.py would —
 *                            the device must drop it rather than pass it through
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
 *   click "#popup"    opens a second page on https://popup.example/pay
 *   click "#offsite"  navigates the page to https://offsite.example/lander, one
 *                     of whose requests was refused — and another that settles
 *                     while parked there
 *   click "#refuses"  throws, and the refusals it saw ride the error reply
 *   click "#blocked"  the page's own requests come back refused: seven 4xx
 *                     responses, the way the real server reports the ones it
 *                     saw during the action (already query-stripped there —
 *                     one here keeps its query, to prove the device strips too),
 *                     plus one that settles late and rides the next result
 *   click "#refused-goto"  the navigation shape: the page itself came back 429
 *   click "#unattributed"  a refusal the browser could not attribute to a document
 *   click "#malformed"   a failed_requests the device cannot read: not a list
 *   click "#malformed-entries"  a list whose entries are not objects
 */
"use strict";
const fs = require("node:fs");
const readline = require("node:readline");

const state = {
  pages: [{ url: "about:blank", title: "blank" }],
  active: 0,
  commands: 0,
  // Refused requests waiting for the next envelope, most recent first, exactly
  // as the real server hands them over. `failedNext` is one that settles after
  // the action answered — a real XHR does, and it rides the result after.
  failed: [],
  failedNext: [],
};

function current() {
  return state.pages[state.active];
}

function envelope(result) {
  return { ...result, url: current().url, page_count: state.pages.length };
}

/** Every reply carries what the page's requests did, exactly as server.py's
 * reply_with_failures does — a result, an error, or the answer to quit. */
function withFailures(reply) {
  const failed = state.failed;
  state.failed = state.failedNext;
  state.failedNext = [];
  if (failed.length === 0) return reply;
  if (process.env.FAKE_NEST_FAILURES === "1" && reply.result) {
    return { ...reply, result: { ...reply.result, failed_requests: failed } };
  }
  return { ...reply, failed_requests: failed };
}

function respond(obj, flushed) {
  if (process.env.GARBAGE === "1") process.stdout.write("firefox noise: not json\n");
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
    if (cmd.selector === "#popup") {
      state.pages.push({ url: "https://popup.example/pay", title: "popup" });
    } else if (cmd.selector === "#offsite") {
      current().url = "https://offsite.example/lander";
      state.failed = [{
        status: 403, method: "GET",
        url: "https://offsite.example/api/who", frame_url: "https://offsite.example/lander",
      }];
      // One from the page it left, one from the approved page whose XHR was
      // still in flight — the sign-in-redirect shape — and one the unapproved
      // page aimed AT the approved origin, which is that page's business.
      state.failedNext = [
        {
          status: 429, method: "GET",
          url: "https://offsite.example/api/late", frame_url: "https://offsite.example/lander",
        },
        {
          status: 401, method: "POST",
          url: "https://pizza.example/api/signin", frame_url: "https://pizza.example/",
        },
        {
          status: 403, method: "GET",
          url: "https://pizza.example/api/probed-by-offsite", frame_url: "https://offsite.example/lander",
        },
      ];
    } else if (cmd.selector === "#blocked") {
      state.failed = [
        {
          status: 429,
          method: "POST",
          url: "https://pizza.example/api/order?tx=StateProperties=SECRET",
          frame_url: "https://pizza.example/",
          bytes: 1180,
          retry_after: "30",
        },
        ...Array.from({ length: 6 }, (_, i) => ({
          status: 403,
          method: "GET",
          url: `https://pizza.example/api/x${i}`,
          frame_url: "https://pizza.example/",
        })),
      ];
      state.failedNext = [
        {
          status: 401,
          method: "GET",
          url: "https://pizza.example/api/whoami",
          frame_url: "https://pizza.example/",
        },
      ];
    } else if (cmd.selector === "#refuses") {
      // The action that failed BECAUSE its request was refused: the reply is an
      // error, and the refusal has to ride it.
      state.failed = [{
        status: 403, method: "POST",
        url: "https://pizza.example/api/submit", frame_url: "https://pizza.example/",
      }];
      throw new Error("locator.click: Timeout 3000ms exceeded.");
    } else if (cmd.selector === "#refused-goto") {
      // A navigation is its own document, so url and frame_url are the same.
      state.failed = [{
        status: 429, method: "GET",
        url: "https://pizza.example/checkout", frame_url: "https://pizza.example/checkout",
        retry_after: "",
      }];
    } else if (cmd.selector === "#unattributed") {
      state.failed = [{
        status: 503, method: "GET",
        url: "https://pizza.example/api/sw", frame_url: "",
      }];
    } else if (cmd.selector === "#malformed") {
      // Not a list at all — a browser process that is not behaving is exactly
      // what the device's own re-strip is for.
      state.failed = "https://pizza.example/api/order?tx=StateProperties=SECRET";
    } else if (cmd.selector === "#malformed-entries") {
      state.failed = ["https://pizza.example/api/order?tx=StateProperties=SECRET"];
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
      // Exit only once the reply is actually out: stdout to a pipe is async on
      // macOS, and exiting on top of the write discards it — the real server
      // ends by falling out of its loop, so the fixture must not model a
      // truncated goodbye.
      respond(withFailures({ id: cmd.id, result: { ok: true } }), () => process.exit(0));
      return;
    }
    if (process.env.FAKE_CMD_LOG) {
      // Redacted here, at the point of writing, so no reader has to remember to
      // do it and no failure diff can print the value.
      const line = typeof cmd.value === "string" ? { ...cmd, value: `<${cmd.value.length} chars>` } : cmd;
      fs.appendFileSync(process.env.FAKE_CMD_LOG, JSON.stringify(line) + "\n");
    }
    state.commands++;
    if (process.env.CRASH_AFTER && state.commands > Number(process.env.CRASH_AFTER)) {
      process.exit(9);
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
