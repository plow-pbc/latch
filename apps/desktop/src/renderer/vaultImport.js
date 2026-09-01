import { el, icon } from "./dom.js";

/* The Import sheet: passwords in from Apple Passwords, 1Password or Chrome —
   and, on macOS 26+, the credential exchange Apple Passwords hands over
   app-to-app ("Export to another app…"). That third door has no steps here at
   all: main staged it before this sheet existed, and the sheet opens straight
   on its preview (the `exchange` parameter below).

   Step one is WHERE FROM: cards wearing the apps' own icons (fetched by main
   from the installed apps, as display-only data URLs). 1Password and Chrome
   only appear when actually installed — with nothing else there is no choice
   to make, and the sheet opens straight onto the Apple guidance. The chosen
   app's walkthrough and inputs render underneath the cards.

   Two doors, matching what those apps can produce. A CSV file, which main
   reads itself behind its own open dialog, so a file of plain-text passwords
   never crosses into this sandboxed window at all. And, for 1Password, a
   paste box for its per-item "Copy item JSON".

   Either way the parsed passwords are STAGED IN MAIN. What comes back here is
   a preview stripped of every secret: titles, usernames, sites, and whether a
   password or a 2FA key is there — plus, for an item the vault already holds,
   which of its secrets changed. Import commits whatever main staged; the
   paste box is emptied the moment its text has been handed over.

   The sheet OWNS NOTHING of the pane's shared state. The editor seat, the
   busy lock and the toast belong to vault.js, which hands them in as `host`
   — the sheet calls them and never reaches back into that module. */

/** Numbered steps under a small header; header optional. */
function steps(head, items) {
  return el("div", {}, [
    head ? el("div", { class: "imp-h", text: head }) : null,
    el("ol", { class: "imp-steps" }, items.map((s) => el("li", { text: s }))),
  ]);
}

/**
 * @param reload redraw the vault pane (called after a commit lands)
 * @param host vault.js's pane seams: { errText, vbusy, vtakeEditor,
 *             vreleaseEditor, vtoast, alive } — `alive` answers whether the
 *             pane this sheet was opened from is still the one on screen
 * @param exchange a credential exchange main already staged (Apple Passwords'
 *                 "Export to another app…"): its secret-free preview. The
 *                 sheet then opens straight on it — the owner already chose
 *                 what to hand over in the other app, so there is no source
 *                 to pick and no file to choose — and commit imports the
 *                 exchange main is holding, like any other staging.
 */
export async function vimportSheet(reload, host, exchange = null) {
  const { errText, vbusy, vtakeEditor, vreleaseEditor, vtoast, alive = () => true } = host;

  // Which apps are here to import from — asked BEFORE the sheet takes the
  // editor seat or puts anything on screen, so nothing can try to close a
  // half-built sheet while this answer is in flight. If the ask fails, the
  // sheet still works: Apple's Passwords app ships with macOS. An exchange
  // sheet never shows the cards, so it skips the ask altogether.
  let sources = { apple: { icon: null }, onePassword: null, chrome: null };
  if (!exchange) {
    try {
      sources = await window.domo.vaultImportSources();
    } catch {
      /* apple-only fallback above */
    }
  }
  // The wait above is the one gap where the world can change under this
  // opening: a credential exchange landing there replaces the pane and opens
  // its own sheet. A stale opening pressing on would take the seat from that
  // sheet — whose close would rightly cancel the one-shot hand-off — so it
  // stands down instead.
  if (!alive()) return;
  // With only one possible source there is nothing to choose: preselected.
  const choices = !!(sources.onePassword || sources.chrome);
  let source = choices ? null : "apple";

  // The staging this sheet is showing, named by the ticket that rode in on
  // its preview (null before one arrives). Quoted on commit and on close, so
  // main only lets this sheet consume or drop its OWN staging — a credential
  // exchange that staged over an open sheet survives that sheet's close and
  // gets its own sheet, instead of being cancelled away by a stale one.
  let ticket = exchange?.ticket ?? null;

  const overlay = el("div", { class: "overlay show" });
  // Hoisted, so close() can be called from the editor seat the moment the
  // seat is taken — a window closing mid-open must find this defined.
  function onKey(e) {
    // Not while a commit is running: the pane is inert, and the work in main
    // finishes either way — closing under it would just hide the outcome.
    if (e.key === "Escape" && !document.querySelector(".vaultui")?.inert) close();
  }
  const close = () => {
    document.removeEventListener("keydown", onKey);
    vreleaseEditor(seat);
    overlay.remove();
    // Main may be holding parsed passwords — staged, or still being parsed
    // by an inspect in flight. Cancel with the ticket this sheet saw: main's
    // epoch guard covers the in-flight case, the ticket says which staging
    // is ours to drop, and cancelling when nothing is held costs nothing.
    void window.domo.vaultImportCancel(ticket);
  };
  // Nothing typed here is worth guarding: the paste box holds a paste, which
  // is still on the clipboard, so dirty() never blocks a close. Taking the
  // seat still matters, because it is what asks about an already-dirty row
  // before this sheet covers it.
  const seat = { dirty: () => false, close };
  if (!(await vtakeEditor(seat))) return;

  /** The sheet closed while an answer was in flight: the answer is stale and
   * only DROPPED. close() already cancelled, and the epoch main captured at
   * the request's start keeps the stale answer from staging — cancelling
   * again here would instead tear down a replacement sheet's staging. */
  const gone = () => !overlay.isConnected;

  const title = el("h2", { text: "Import passwords" });
  const back = el("button", { class: "sheet-back", attrs: { type: "button", title: "Back", hidden: "" } }, [icon("chevron", { class: "vico", strokeWidth: "2.2" })]);
  const x = el("button", { class: "sheet-x", attrs: { type: "button", title: "Close" } }, [icon("close", { class: "vico", strokeWidth: "2.2" })]);
  x.addEventListener("click", close);

  const bodyEl = el("div", { class: "sheet-body" });
  const cancel = el("button", { class: "btn ghost", attrs: { type: "button" }, text: "Cancel" });
  cancel.addEventListener("click", close);
  const go = el("button", { class: "btn save", attrs: { type: "button" }, text: "Import" });
  const foot = el("div", { class: "sheet-foot", attrs: { hidden: "" } }, [cancel, go]);

  /** Step one: pick the app, read its walkthrough, hand its export over. */
  const pick = () => {
    title.textContent = "Import passwords";
    back.setAttribute("hidden", "");
    foot.setAttribute("hidden", "");

    const err = el("p", { class: "imp-err" });
    const oops = (e) => { err.textContent = "Could not read it: " + errText(e); };

    const fileBtn = () => {
      const b = el("button", { class: "btn imp-file", attrs: { type: "button" } }, [
        icon("file", { class: "vico", strokeWidth: "1.8" }),
        el("span", { text: " Choose exported CSV file…" }),
      ]);
      b.addEventListener("click", async () => {
        err.textContent = "";
        b.disabled = true;
        try {
          const found = await window.domo.vaultImportFile();
          if (gone()) return;
          if (found) preview(found);
        } catch (e) {
          oops(e);
        }
        b.disabled = false;
      });
      return b;
    };

    const note = el("div", { class: "imp-note" }, [
      icon("shield", { class: "vico", strokeWidth: "1.8" }),
      el("span", { text:
        "An exported file holds your passwords in plain text. Once the import is done, " +
        "delete the file and empty the Trash." }),
    ]);

    /** The chosen app's walkthrough and inputs, under the cards. */
    const guide = el("div", { class: "imp-body" });
    const renderGuide = () => {
      err.textContent = "";
      if (source === "apple") {
        // On macOS 26.4+, Passwords can hand the items straight across, app
        // to app, no file on disk — main decides whether to offer it (see
        // vault:importSources: a packaged install must actually be able to
        // receive; a from-source run shows the steps on OS alone). That door
        // leads first; the CSV walk stays for every Mac, and is the only
        // door elsewhere. When the hand-off lands, main stages it and this
        // sheet is replaced by the preview — the last step describes that.
        const direct = !!sources.apple?.exchange;
        guide.replaceChildren(...[
          direct
            ? steps("Send them straight across — no file", [
                "In the Passwords app, choose File > Export All Items to App… (or select some items and choose Export Selected Items to App…).",
                "Click Continue on the Export Passwords dialog, and approve with Touch ID or your password.",
                "Select Plow Latch as the destination, click Continue, then Continue in Plow Latch.",
                "What arrived appears right here, to review before anything is saved.",
              ])
            : null,
          steps(direct ? "Or: export a file" : null, [
            "In the Passwords app, choose File > Export All Passwords to File… (or select some items and choose Export Selected Passwords…).",
            "Confirm with Export Passwords…, pick where to save the file (it is named Passwords.csv), and approve with Touch ID or your password.",
            "Choose that file below.",
          ]),
          el("div", { class: "imp-actions" }, [fileBtn()]),
          err,
          note,
        ].filter(Boolean));
        return;
      }
      if (source === "chrome") {
        guide.replaceChildren(
          steps(null, [
            "In Chrome, choose Chrome > Settings…, then click Autofill and passwords in the sidebar.",
            "Click Google Password Manager, then click Settings in the sidebar of the page that appears.",
            "Under Export passwords, click Download File, and enter your computer password when prompted.",
            "Save the file (it is named Chrome Passwords.csv), then choose it below.",
          ]),
          el("div", { class: "imp-actions" }, [fileBtn()]),
          err,
          note,
        );
        return;
      }
      if (source !== "1password") {
        guide.replaceChildren(el("p", { class: "imp-hint", text: "Choose where your passwords are coming from." }));
        return;
      }
      const paste = el("textarea", {
        class: "inp",
        attrs: {
          rows: "5",
          spellcheck: "false",
          placeholder: 'Paste the copied item JSON here',
        },
      });
      const readBtn = el("button", { class: "btn", attrs: { type: "button" }, text: "Import pasted text" });
      readBtn.addEventListener("click", async () => {
        const text = paste.value;
        if (!text.trim()) { err.textContent = "Paste something first."; return; }
        // Emptied at CAPTURE, before the round-trip: the inspect can sit
        // behind a Touch ID ask, and a box of passwords has no business
        // staying on screen for that wait. An error costs a re-paste.
        paste.value = "";
        err.textContent = "";
        readBtn.disabled = true;
        try {
          const found = await window.domo.vaultImportInspect(text);
          if (gone()) return;
          preview(found);
        } catch (e) {
          oops(e);
        }
        readBtn.disabled = false;
      });
      guide.replaceChildren(
        steps("Everything in a vault", [
          "In 1Password, choose File > Export > your vault, and enter your 1Password password.",
          "Pick “CSV (Export only certain fields)” and click Export Data.",
          "When it says Export Finished, click Show File, then choose that file below.",
        ]),
        el("div", { class: "imp-actions" }, [fileBtn()]),
        steps("A single item", [
          "Right-click the item and choose Copy item JSON.",
          "Paste it in the box below.",
        ]),
        el("div", { class: "imp-actions" }, [el("div", { class: "inwrap" }, [paste]), readBtn]),
        err,
        note,
      );
    };

    const cards = [];
    const card = (key, label, iconUrl) => {
      const face = iconUrl
        ? el("img", { class: "src-ic", attrs: { src: iconUrl, alt: "" } })
        : el("span", { class: "src-ic glyph" }, [icon("key", { class: "vico", strokeWidth: "1.8" })]);
      const b = el("button", { class: "imp-src", attrs: { type: "button" } }, [
        face,
        el("span", { class: "sn", text: label }),
      ]);
      b.addEventListener("click", () => {
        source = key;
        for (const c of cards) c.node.classList.toggle("sel", c.key === key);
        renderGuide();
      });
      cards.push({ key, node: b });
      return b;
    };

    // Filtered for the same reason as the preview below: replaceChildren
    // renders a null child as the word "null".
    bodyEl.replaceChildren(...[
      el("p", { class: "sheet-sub", text:
        "This only supports import of passwords; credit cards and identities are not imported." }),
      // Nothing else installed means there is no choice to offer: the sheet
      // opens already on the Apple Passwords guidance, cards and all skipped.
      choices
        ? el("div", { class: "imp-src-grid" }, [
            card("apple", "Apple Passwords", sources.apple?.icon ?? null),
            sources.onePassword ? card("1password", "1Password", sources.onePassword.icon) : null,
            sources.chrome ? card("chrome", "Chrome", sources.chrome.icon) : null,
          ])
        : null,
      guide,
    ].filter(Boolean));
    for (const c of cards) c.node.classList.toggle("sel", c.key === source);
    renderGuide();
  };

  /** What was read, before anything is written: counts, rows, and reasons. */
  const preview = (p) => {
    ticket = p.ticket ?? null;
    title.textContent = "Ready to import";
    // No step to go back to when the passwords arrived by hand-off.
    if (!exchange) back.removeAttribute("hidden");
    foot.removeAttribute("hidden");

    const coming = p.items.filter((i) => !i.duplicate);
    const dups = p.items.length - coming.length;
    const updates = coming.filter((i) => i.changed.length).length;
    const summary = [
      `${coming.length} login${coming.length === 1 ? "" : "s"} from ${p.source}`,
      updates ? `${updates} update${updates === 1 ? "s" : ""} an item you already have` : "",
      dups ? `${dups} already in your vault (left alone)` : "",
      p.skipped.length ? `${p.skipped.length} not imported` : "",
    ].filter(Boolean).join(" · ");

    // Which rows will actually be imported. Everything starts ticked; a
    // duplicate is not offered at all — the commit leaves it alone whatever
    // is sent. The set holds indices into p.items, which is the order main
    // staged the logins in, so it travels to commit as-is. With a single
    // importable row there is nothing to choose and no checkboxes appear.
    const chosen = new Set(p.items.map((i, at) => (i.duplicate ? -1 : at)).filter((at) => at >= 0));
    const total = chosen.size;
    const choosable = total > 1;
    const count = el("span", { class: "sc" });
    const allLink = el("button", { class: "add-link", attrs: { type: "button" } });
    const sync = () => {
      const n = chosen.size;
      count.textContent = `${n} of ${total} selected`;
      allLink.textContent = n === total ? "Select none" : "Select all";
      go.textContent = n === 0 ? "Nothing selected"
        : choosable ? `Import ${n} of ${total}`
        : `Import ${n}`;
      go.disabled = n === 0;
    };
    allLink.addEventListener("click", () => {
      const boxes = bodyEl.querySelectorAll(".imp-row input[type=checkbox]");
      const all = chosen.size === total;
      for (const box of boxes) {
        box.checked = !all;
        box.dispatchEvent(new Event("change"));
      }
    });

    const row = (i, at) => {
      const badges = [];
      if (i.duplicate) badges.push(el("span", { class: "imp-badge dup", text: "already in vault" }));
      else if (i.changed.length) {
        // The row is an UPDATE of an item already in the vault: only the
        // fields named here are written; everything else stays as it is.
        if (i.changed.includes("password")) badges.push(el("span", { class: "imp-badge upd", text: "updated password" }));
        if (i.changed.includes("totp")) badges.push(el("span", { class: "imp-badge upd", text: "updated 2FA key" }));
      } else if (i.hasTotp) badges.push(el("span", { class: "imp-badge ok", text: "2FA" }));
      if (!i.hasPassword) badges.push(el("span", { class: "imp-badge warn", text: "no password" }));
      const tick = !i.duplicate && choosable
        ? el("input", { attrs: { type: "checkbox", checked: "" } })
        : null;
      const node = el("div", { class: "imp-row" + (i.duplicate ? " dup" : "") + (tick ? " pick" : "") }, [
        tick,
        el("span", { class: "vicon" }, [icon("key", { class: "vico", strokeWidth: "1.8" })]),
        el("span", { class: "m" }, [
          el("span", { class: "t", text: i.title }),
          el("span", { class: "c", text: [i.username, i.url].filter(Boolean).join(" · ") }),
          ...i.warnings.map((w) => el("span", { class: "w", text: w })),
        ]),
        ...badges,
      ]);
      if (tick) {
        tick.addEventListener("change", () => {
          if (tick.checked) chosen.add(at);
          else chosen.delete(at);
          node.classList.toggle("off", !tick.checked);
          sync();
        });
        // The whole row is the target — a 15px box is not "easy to turn off".
        node.addEventListener("click", (e) => {
          if (e.target === tick) return; // the box's own click already toggled
          tick.checked = !tick.checked;
          tick.dispatchEvent(new Event("change"));
        });
      }
      return node;
    };

    // replaceChildren stringifies a null into the word "null" on screen, so
    // the conditional children are filtered, not handed over as gaps.
    bodyEl.replaceChildren(...[
      el("p", { class: "sheet-sub", text: summary }),
      choosable ? el("div", { class: "imp-selhead" }, [count, allLink]) : null,
      el("div", { class: "imp-list" }, p.items.map(row)),
      p.skipped.length
        ? el("div", { class: "imp-skip" }, [
            el("div", { class: "group-h", text: "Not imported" }),
            el("ul", {}, p.skipped.map((s) => el("li", { text: `${s.title}: ${s.reason}` }))),
          ])
        : null,
      // The hand-off wrote no file anywhere — that is its whole point — so
      // the cleanup reminder would be an instruction with nothing to do.
      exchange ? null : el("div", { class: "imp-note" }, [
        icon("shield", { class: "vico", strokeWidth: "1.8" }),
        el("span", { text:
          "Remember to delete the exported file and empty the Trash once this is done. " +
          "It holds your passwords in plain text." }),
      ]),
    ].filter(Boolean));

    sync();
    if (total === 0) go.textContent = "Nothing to import";
    go.onclick = async () => {
      go.disabled = true;
      try {
        await vbusy(async () => {
          const res = await window.domo.vaultImportCommit([...chosen], ticket);
          close();
          await reload();
          vtoast([
            `Imported ${res.saved}`,
            res.updated ? `updated ${res.updated}` : "",
            res.failed.length ? `${res.failed.length} failed` : "",
          ].filter(Boolean).join(", "));
        });
        return;
      } catch (e) {
        vtoast("Could not import: " + errText(e));
      }
      go.disabled = false;
    };
  };
  back.addEventListener("click", pick);

  overlay.appendChild(el("div", { class: "sheet", attrs: { role: "dialog", "aria-modal": "true" } }, [
    el("div", { class: "sheet-top" }, [back, el("div", { class: "sheet-titlewrap" }, [title]), x]),
    bodyEl,
    foot,
  ]));
  // No click-outside dismissal, deliberately: a drag-select that starts in
  // the sheet and lets go over the scrim lands a "click" on the overlay, and
  // losing the sheet to a text selection is worse than an extra Escape. Only
  // Escape and the close buttons leave.
  document.addEventListener("keydown", onKey);
  if (exchange) preview(exchange);
  else pick();
  document.querySelector(".vaultui").appendChild(overlay);
}
