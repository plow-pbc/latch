import { el, icon } from "./dom.js";

/* The Vault tab, built to the design file (vault.html).
   Its own pane, its own file: this screen keeps being redesigned, and it has
   no business churning the window's shared renderer every time.

   The styling is vault.css, scoped to `.vaultui` so no other screen changes.
   Everything here is fed by the real vault: the list, the values, and the
   secrets that are fetched only when the owner asks for one. */

/* ---- The Vault tab, built to Mary's design (vault.html) ----------------
   Her markup and her class names; the styling lives in vault.css, scoped to
   `.vaultui` so no other screen changes. Everything here is fed by the real
   vault: the list, the values, and the secrets that are fetched only when the
   owner asks to see one. */

/* The four types, laid out as her forms lay them out. `secret` is a value the
   vault never hands over with the item — it is fetched one at a time, which is
   what the eye button does. */
const VAULT_TYPES = {
  login: {
    label: "Login", icon: "key", placeholder: "e.g. Notion",
    groups: [
      { head: "Login credentials", fields: [
        { key: "username", label: "Username", placeholder: "you@example.com" },
        { key: "password", label: "Password", secret: true, generate: true, placeholder: "••••••••••••",
          hint: "Use the generator to create a strong, unique password" },
        { key: "totp", label: "Authenticator key (TOTP)", secret: true, placeholder: "Optional — for 2FA codes" },
      ] },
      { head: "Website (URI)", required: true, urls: true },
      { head: "Notes", fields: [{ key: "notes", placeholder: "Optional", textarea: true }] },
    ],
  },
  card: {
    label: "Card", icon: "card", placeholder: "e.g. Visa •••• 4242",
    groups: [
      { head: "Card details", fields: [
        { key: "cardholderName", label: "Cardholder name", placeholder: "Name on card" },
        { key: "number", label: "Number", secret: true, placeholder: "•••• •••• •••• ••••" },
        { key: "brand", label: "Brand", placeholder: "Visa, Mastercard…" },
        { key: "expMonth", label: "Expiration month", placeholder: "MM", half: true },
        { key: "expYear", label: "Expiration year", placeholder: "YYYY", half: true },
        { key: "code", label: "Security code (CVV)", secret: true, placeholder: "•••" },
      ] },
      { head: "Notes", fields: [{ key: "notes", placeholder: "Optional", textarea: true }] },
    ],
  },
  identity: {
    label: "Identity", icon: "user", placeholder: "e.g. Personal identity",
    groups: [
      { head: "Name", fields: [
        { key: "title", label: "Title", placeholder: "Mr, Ms, Dr…", half: true },
        { key: "firstName", label: "First name", half: true },
        { key: "middleName", label: "Middle name", placeholder: "Optional", half: true },
        { key: "lastName", label: "Last name", half: true },
        { key: "company", label: "Company", placeholder: "Optional" },
      ] },
      { head: "Contact", fields: [
        { key: "email", label: "Email", half: true },
        { key: "phone", label: "Phone", half: true },
        { key: "username", label: "Username", placeholder: "Optional" },
      ] },
      { head: "Address", fields: [
        { key: "address1", label: "Address 1" },
        { key: "address2", label: "Address 2", placeholder: "Optional" },
        { key: "address3", label: "Address 3", placeholder: "Optional" },
        { key: "city", label: "City / Town", half: true },
        { key: "state", label: "State / Province", half: true },
        { key: "postalCode", label: "ZIP / Postal code", half: true },
        { key: "country", label: "Country", half: true },
      ] },
      { head: "Numbers", fields: [
        { key: "ssn", label: "Social Security number", secret: true, placeholder: "•••-••-••••" },
        { key: "passportNumber", label: "Passport number", secret: true, placeholder: "Optional" },
        { key: "licenseNumber", label: "License number", secret: true, placeholder: "Optional" },
      ] },
      { head: "Notes", fields: [{ key: "notes", placeholder: "Optional", textarea: true }] },
    ],
  },
  note: {
    label: "Secure note", icon: "note", placeholder: "e.g. Recovery codes",
    groups: [
      { head: "Note", fields: [{ key: "notes", textarea: true,
        placeholder: "Anything you want your agents to be able to reference on approval…" }] },
    ],
  },
};

function errText(err) {
  return err && err.message ? String(err.message).replace(/^Error: /, "") : String(err);
}

/** Her toast: one line, bottom of the pane, gone on its own. */
let toastTimer = null;
function vtoast(message) {
  const node = document.querySelector(".vaultui .toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

/** A password worth generating: 20 characters from the machine's own RNG. */
function generatedPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
  const bytes = new Uint32Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/**
 * One field, her way: label, a wrapping box, and the small buttons that belong
 * to it. A secret starts blank — the vault has not handed it over — and the eye
 * asks for it, which is the request the vault's audit records.
 */
function vfield(spec, ctx) {
  const input = spec.textarea
    ? el("textarea", { class: "inp", attrs: { placeholder: spec.placeholder ?? "" } })
    : el("input", {
        class: "inp",
        attrs: {
          type: spec.secret ? "password" : "text",
          spellcheck: "false",
          placeholder: spec.placeholder ?? "",
          ...(spec.key === "name" ? { "data-name": "1" } : {}),
        },
      });
  const stored = ctx.item ? (spec.key === "notes" ? ctx.item.notes : ctx.item.fields[spec.key]) : "";
  if (!spec.secret && stored) input.value = stored;
  ctx.inputs[spec.key] = input;

  const buttons = [];
  if (spec.secret) {
    const held = ctx.saved && (ctx.item.secrets || []).includes(spec.key);
    const eye = el("button", { class: "mini eye", attrs: { type: "button", title: "Reveal" } }, [icon("eye", { class: "vico", strokeWidth: "1.8" })]);
    eye.addEventListener("click", async () => {
      if (input.getAttribute("type") === "text") {
        input.setAttribute("type", "password");
        eye.replaceChildren(icon("eye", { class: "vico", strokeWidth: "1.8" }));
        return;
      }
      if (held && !input.value) {
        eye.disabled = true;
        try {
          input.value = await window.domo.vaultReveal(ctx.item.id, spec.key);
        } catch (err) {
          vtoast("Could not read it: " + errText(err));
          eye.disabled = false;
          return;
        }
        eye.disabled = false;
      }
      input.setAttribute("type", "text");
      eye.replaceChildren(icon("eyeOff", { class: "vico", strokeWidth: "1.8" }));
    });
    buttons.push(eye);
  }
  if (spec.generate) {
    const gen = el("button", { class: "mini gen", attrs: { type: "button", title: "Generate password" } }, [icon("generate", { class: "vico", strokeWidth: "1.8" })]);
    gen.addEventListener("click", () => {
      input.value = generatedPassword();
      input.setAttribute("type", "text");
      ctx.onChange?.();
    });
    buttons.push(gen);
  }
  // Touched, so an empty box now means "clear this", not "leave it alone".
  input.addEventListener("input", () => { input.dataset.touched = "1"; ctx.onChange?.(); });

  const label = spec.label
    ? el("label", { text: spec.label + " " }, spec.required ? [el("span", { class: "req", text: "*" })] : [])
    : null;
  const hint = spec.hint ? el("span", { class: "gen-hint" }, [icon("generate", { class: "vico", strokeWidth: "1.8" }), el("span", { text: " " + spec.hint })]) : null;
  return el("div", { class: "field" + (spec.secret ? " secret" : "") + (spec.half ? "" : " span2") },
    [label, el("div", { class: "inwrap" }, [input, ...buttons]), hint].filter(Boolean));
}

/** The website group: one box per URL the item has, her "Add website", and a
    way back off each one. */
function vurls(ctx) {
  // The last remaining site cannot be removed: a login with no URL can never be
  // filled, and the save refuses it — so the form never offers that dead end.
  // That is a fact about this list, and vault.css reads it off :only-child
  // rather than anything here keeping a second copy of it in step.
  const rows = el("div", { class: "url-rows" });
  const add = () => {
    const input = el("input", { class: "inp", attrs: { type: "text", spellcheck: "false", placeholder: "https://" } });
    input.addEventListener("input", () => ctx.onChange?.());
    ctx.urlInputs.push(input);
    const drop = el("button", { class: "mini drop", attrs: { type: "button", title: "Remove this website", "aria-label": "Remove this website" } },
      [icon("close", { class: "vico", strokeWidth: "1.8" })]);
    const row = el("div", { class: "field span2" }, [el("div", { class: "inwrap" }, [input, drop])]);
    drop.addEventListener("click", () => {
      // Emptied and detached, never spliced out of urlInputs: vpayload sends the
      // boxes by position, and a shorter list would reconcile every URL below
      // this one against the entry that belongs to the row above it.
      input.value = "";
      row.remove();
      ctx.onChange?.();
    });
    rows.appendChild(row);
    return input;
  };
  const existing = ctx.item ? ctx.item.urls || [] : [];
  if (existing.length === 0) add();
  else for (const url of existing) add().value = url;

  const more = el("button", { class: "add-link", attrs: { type: "button" } }, [icon("plus", { class: "vico", strokeWidth: "2" }), el("span", { text: " Add website" })]);
  more.addEventListener("click", () => add().focus());
  return el("div", { class: "group" }, [
    el("div", { class: "group-h", text: "Website (URI) " }, [el("span", { class: "req", text: "*" })]),
    rows,
    more,
  ]);
}

/** Every group of a type's form, built once and shared by the sheet and the row. */
function vformBody(type, item, onChange) {
  const spec = VAULT_TYPES[type];
  const ctx = { item, saved: !!(item && item.id), inputs: {}, urlInputs: [], onChange };
  const name = vfield(
    { key: "name", label: "Item name", required: true, placeholder: spec.placeholder },
    { ...ctx, item: item ? { ...item, fields: { ...item.fields, name: item.name } } : null },
  );
  const nameInput = name.querySelector("input");
  ctx.inputs.name = nameInput;

  const groups = spec.groups.map((group) =>
    group.urls
      ? vurls(ctx)
      : el("div", { class: "group" }, [
          el("div", { class: "group-h", text: group.head }),
          el("div", { class: "grid2" }, group.fields.map((f) => vfield(f, ctx))),
        ]),
  );
  return { nodes: [name, ...groups], ctx };
}

/** What the form sends: only what it holds, and a secret only when it has one. */
function vpayload(type, ctx) {
  const payload = { type, name: ctx.inputs.name.value.trim() };
  for (const group of VAULT_TYPES[type].groups) {
    if (group.urls) {
      // Positions are kept, blanks included: dropping them here would shift
      // every later URL onto another one's stored entry.
      payload.urls = ctx.urlInputs.map((i) => i.value.trim());
      continue;
    }
    for (const field of group.fields) {
      const input = ctx.inputs[field.key];
      // A secret box starts blank because the vault never handed the value
      // over, so blank-and-untouched means "leave the stored one alone" —
      // while blank after the owner edited it means they cleared it.
      if (field.secret && !input.value && !input.dataset.touched) continue;
      payload[field.key] = input.value;
    }
  }
  return payload;
}

/** Her confirm card, for the one action that cannot be undone here. */
function vconfirm(title, body, confirmLabel, onConfirm) {
  const overlay = el("div", { class: "overlay confirm-overlay show" });
  const close = () => overlay.remove();
  const keep = el("button", { class: "btn ghost", attrs: { type: "button" }, text: "Cancel" });
  keep.addEventListener("click", close);
  const go = el("button", { class: "btn danger", attrs: { type: "button" }, text: confirmLabel });
  go.addEventListener("click", async () => {
    go.disabled = true;
    await onConfirm();
    close();
  });
  overlay.appendChild(el("div", { class: "confirm-card", attrs: { role: "alertdialog" } }, [
    el("div", { class: "confirm-h", text: title }),
    el("p", { class: "confirm-p", text: body }),
    el("div", { class: "confirm-acts" }, [keep, go]),
  ]));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.querySelector(".vaultui").appendChild(overlay);
}

/** One saved item: her row, and the form it opens into. */
function vitem(summary, reload) {
  const type = summary.type || "login";
  const spec = VAULT_TYPES[type];
  const article = el("article", { class: "vitem", attrs: { "data-type": type } });

  const row = el("button", { class: "vrow", attrs: { type: "button" } }, [
    el("span", { class: "vicon" }, [icon(spec.icon, { class: "vico", strokeWidth: "1.8" })]),
    el("span", { class: "vmain" }, [
      el("span", { class: "vtitle", text: summary.title || "(untitled)" }),
      el("span", { class: "vctx", text: [summary.subtitle, (summary.urls || [])[0]].filter(Boolean).join(" · ") }),
    ]),
    el("span", { class: "vtag", text: spec.label }),
    el("span", { class: "vchev" }, [icon("chevron", { class: "vico", strokeWidth: "2" })]),
  ]);
  const inner = el("div", { class: "vbody-inner" });
  const body = el("div", { class: "vbody" }, [inner]);

  let loaded = false;
  row.addEventListener("click", async () => {
    article.classList.toggle("open");
    if (!article.classList.contains("open")) {
      // Closing throws the form away, revealed values included. Keeping it
      // would let a second look at a protected item skip the check the first
      // one had to pass.
      inner.replaceChildren();
      loaded = false;
      return;
    }
    if (loaded) return;
    loaded = true;
    inner.replaceChildren(el("p", { class: "use-note", text: "Opening…" }));
    try {
      const item = await window.domo.vaultItem(summary.id);
      const { nodes, ctx } = vformBody(type, item);
      const del = el("button", { class: "btn danger", attrs: { type: "button" }, text: "Delete" });
      del.addEventListener("click", () =>
        vconfirm(
          "Delete this item?",
          `"${item.name}" goes to the vault's trash. Agents lose it immediately, and anything filled with it stops working.`,
          "Delete",
          async () => {
            try {
              await window.domo.vaultDeleteItem(item.id);
              vtoast("Deleted");
              await reload();
            } catch (err) {
              vtoast("Could not delete it: " + errText(err));
            }
          },
        ),
      );
      const save = el("button", { class: "btn save", attrs: { type: "button" }, text: "Save" });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await window.domo.vaultSaveItem({ ...vpayload(type, ctx), itemId: item.id });
          vtoast("Saved");
          await reload();
          return;
        } catch (err) {
          vtoast("Could not save it: " + errText(err));
        }
        save.disabled = false;
      });
      inner.replaceChildren(...nodes, el("div", { class: "vfoot" }, [
        el("span", { class: "use-note" }, [icon("shield", { class: "vico", strokeWidth: "1.8" }), el("span", { text: " Used by agents on approval" })]),
        el("span", { class: "acts" }, [del, save]),
      ]));
    } catch (err) {
      loaded = false;
      inner.replaceChildren(el("p", { class: "use-note", text: "Could not open it: " + errText(err) }));
    }
  });

  article.replaceChildren(row, body);
  return article;
}

/** Her sheet: pick a type, fill that type's form, save. */
function vsheet(reload) {
  const overlay = el("div", { class: "overlay show" });
  const close = () => overlay.remove();

  const title = el("h2", { text: "New item" });
  const tag = el("span", { class: "htag", attrs: { hidden: "" } });
  const back = el("button", { class: "sheet-back", attrs: { type: "button", title: "Back", hidden: "" } }, [icon("chevron", { class: "vico", strokeWidth: "2.2" })]);
  const x = el("button", { class: "sheet-x", attrs: { type: "button", title: "Close" } }, [icon("close", { class: "vico", strokeWidth: "2.2" })]);
  x.addEventListener("click", close);

  const bodyEl = el("div", { class: "sheet-body" });
  const cancel = el("button", { class: "btn ghost", attrs: { type: "button" }, text: "Cancel" });
  cancel.addEventListener("click", close);
  const save = el("button", { class: "btn save", attrs: { type: "button" }, text: "Save" });
  const foot = el("div", { class: "sheet-foot", attrs: { hidden: "" } }, [
    el("span", { class: "req-note" }, [el("span", { class: "req", text: "*" }), el("span", { text: " Required" })]),
    cancel,
    save,
  ]);

  const picker = () => {
    title.textContent = "New item";
    tag.setAttribute("hidden", "");
    back.setAttribute("hidden", "");
    foot.setAttribute("hidden", "");
    bodyEl.replaceChildren(
      el("p", { class: "sheet-sub", text: "What are you saving to the vault?" }),
      el("div", { class: "picker-grid" }, Object.entries(VAULT_TYPES).map(([key, spec]) => {
        const button = el("button", { class: "ptype", attrs: { type: "button", "data-new": key } }, [
          el("span", { class: "pi" }, [icon(spec.icon, { class: "vico", strokeWidth: "1.8" })]),
          el("span", {}, [
            el("span", { class: "pn", text: spec.label }),
            el("span", { class: "pd", text: PTYPE_BLURB[key] }),
          ]),
        ]);
        button.addEventListener("click", () => form(key));
        return button;
      })),
    );
  };

  const form = (type) => {
    title.textContent = "New " + VAULT_TYPES[type].label.toLowerCase();
    tag.textContent = VAULT_TYPES[type].label;
    tag.removeAttribute("hidden");
    back.removeAttribute("hidden");
    foot.removeAttribute("hidden");
    const { nodes, ctx } = vformBody(type, null);
    bodyEl.replaceChildren(el("form", { class: "sheet-form", attrs: { autocomplete: "off" } }, nodes));
    save.onclick = async () => {
      save.disabled = true;
      try {
        await window.domo.vaultSaveItem(vpayload(type, ctx));
        close();
        vtoast("Saved");
        await reload();
        return;
      } catch (err) {
        vtoast("Could not save it: " + errText(err));
      }
      save.disabled = false;
    };
  };
  back.addEventListener("click", picker);

  overlay.appendChild(el("div", { class: "sheet", attrs: { role: "dialog", "aria-modal": "true" } }, [
    el("div", { class: "sheet-top" }, [back, el("div", { class: "sheet-titlewrap" }, [title, tag]), x]),
    bodyEl,
    foot,
  ]));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  picker();
  document.querySelector(".vaultui").appendChild(overlay);
}

/** Her one-line description of each type, on the picker cards. */
const PTYPE_BLURB = {
  login: "Username, password & 2FA for a site",
  card: "Payment card for checkout",
  identity: "Name, address & contact details",
  note: "Freeform private text",
};

export async function renderVault(view, isCurrent = () => true) {
  /** Redraw this same pane — what every action hands to its callers. */
  const renderVaultIn = () => renderVault(view, isCurrent);
  // Everything the vault holds, edited here. This is why the tab exists: the
  // only other way in is the vault's own web page, and reaching it means a
  // browser warning about the certificate the app issued to itself.
  let items = null;
  let failure = "";
  try {
    items = await window.domo.vaultItems();
  } catch (err) {
    failure = errText(err);
  }

  // The vault answers over HTTPS, so an answer can arrive after the owner has
  // moved to another tab. The view is shared: writing into it then would put
  // this pane on top of theirs.
  if (!isCurrent()) return;

  const pane = el("div", { class: "vaultui" });
  const masthead = el("div", { class: "masthead" }, [
    el("div", {}, [
      el("h1", { text: "Vault" }),
      el("p", { class: "trust" }, [
        el("span", { text: "Your agents can use these to act for you. " }),
        el("span", { class: "lk", text: "The values are typed on this Mac, never handed to them" }),
        el("span", { text: " — every use needs your approval and is logged." }),
      ]),
    ]),
  ]);

  if ((items === null || (items && items.locked)) && !failure) {
    // Locked and empty are different facts and get different words. A vault
    // whose key has moved — a Keychain reset, a Mac restored from backup — used
    // to render as "has not started yet", which sent people looking for a
    // server that was running fine.
    const locked = !!(items && items.locked);
    pane.replaceChildren(masthead, el("div", { class: "col" }, [
      el("div", { class: "empty", text: locked
        ? "This Mac can't unlock its vault account."
        : "The vault has not started yet." }),
      // No invented recovery, and no asserting a cause the code cannot tell
      // apart: `undecryptable` is one `catch` covering a wrong key AND a
      // damaged file, so the copy leads with what is certain, names the likely
      // cause as likely, and gives the remedy — the same either way.
      locked
        ? el("p", { class: "use-note", text: items.reason === "no-storage"
            ? "The encrypted account is on disk, but this build has no secure storage to open it with. Nothing is lost; a build with secure storage will read it."
            : "The account file is present but cannot be opened. Usually that means the key is no longer in this Mac's Keychain — after a Keychain reset, a restore from backup, or a change to how the app identifies itself — and it can also mean the file itself is damaged. Either way the password cannot be recovered, here or anywhere: the vault would have to be set up again. Nothing has been deleted." })
        : null,
    ].filter(Boolean)));
    view.replaceChildren(pane);
    return;
  }

  const newBtn = el("button", { class: "btn-primary", attrs: { type: "button" } }, [
    icon("plus", { class: "vico", strokeWidth: "2.2" }),
    el("span", { text: " New" }),
  ]);
  newBtn.addEventListener("click", () => vsheet(renderVaultIn));
  masthead.appendChild(newBtn);

  const list = el("div", { class: "vlist" });
  if (failure) {
    list.replaceChildren(el("div", { class: "empty", text: "Could not read the vault: " + failure }));
  } else if (items.length === 0) {
    list.replaceChildren(el("div", { class: "empty", text: "Nothing saved yet." }));
  } else {
    list.replaceChildren(...items.map((i) => vitem(i, renderVaultIn)));
  }

  const count = failure ? "" : `${items.length} item${items.length === 1 ? "" : "s"}`;
  pane.replaceChildren(
    masthead,
    el("div", { class: "col" }, [
      el("div", { class: "list-head" }, [
        el("span", { class: "lt", text: "Saved items" }),
        el("span", { class: "lc", text: count }),
      ]),
      list,
    ]),
    el("div", { class: "toast" }),
  );
  view.replaceChildren(pane);
}
