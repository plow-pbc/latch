import { el, icon } from "./dom.js";
// The Import sheet lives in its own file (this one is long enough) but works
// the same pane. This module stays the sole owner of the editor seat, the
// busy lock and the toast: the sheet is handed them as callbacks (the `host`
// argument below) and never imports back into here.
import { vimportSheet } from "./vaultImport.js";

/* The Vault tab, built to the design file (vault.html).
   Its own pane, its own file: this screen keeps being redesigned, and it has
   no business churning the window's shared renderer every time.

   The styling is vault.css, scoped to `.vaultui` so no other screen changes.
   Everything here is fed by the real vault: the list, the values, and the
   secrets that are fetched only when the owner asks for one. */

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
        { key: "totp", label: "Authenticator key (TOTP)", secret: true, totp: true,
          placeholder: "Optional — e.g. JBSW Y3DP EHPK 3PXP, or otpauth://…",
          hint: "Paste the setup key the site shows under its QR code, or the whole otpauth:// link. " +
                "Spaces and capitals do not matter. Not the six digits — those change every 30 seconds." },
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
        { key: "birthDate", label: "Date of birth", type: "date", half: true },
        { key: "company", label: "Company", placeholder: "Optional", half: true },
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

/**
 * A card's brand, read off its own number.
 *
 * The issuer identification number IS the brand — the owner retyping it into
 * the Brand box is transcription, not information, so the form does it. The
 * ranges are the published IINs; an unrecognised (or half-typed) number gives
 * "", which is the form saying nothing rather than guessing.
 */
export function cardBrand(number) {
  const d = number.replace(/\D/g, "");
  if (!d) return "";
  const n = (len) => Number(d.slice(0, len));
  if (d[0] === "4") return "Visa";
  if (/^3[47]/.test(d)) return "Amex";
  if ((n(2) >= 51 && n(2) <= 55) || (d.length >= 4 && n(4) >= 2221 && n(4) <= 2720)) return "Mastercard";
  // 622126-622925 is Discover's block inside 62, and it is read before the
  // UnionPay prefix below or those cards come out labelled UnionPay.
  if (/^6(011|5)/.test(d) || (d.length >= 3 && n(3) >= 644 && n(3) <= 649)
      || (d.length >= 6 && n(6) >= 622126 && n(6) <= 622925)) return "Discover";
  if (/^3[689]/.test(d) || (d.length >= 3 && n(3) >= 300 && n(3) <= 305)) return "Diners Club";
  if (d.length >= 4 && n(4) >= 3528 && n(4) <= 3589) return "JCB";
  if (/^62/.test(d)) return "UnionPay";
  return "";
}

/**
 * The Brand box, filled from the number as it is typed.
 *
 * A suggestion, never a lock: the box is ours to rewrite only while it still
 * holds what we put there. The owner typing their own brand — or clearing the
 * box, which is them saying "no brand" — takes it back for good, and the form
 * never touches it again. What the box opens as is the caller's to say
 * (`vformBody`): "" on a new item, whose empty box is ours until they type in
 * it, and null on a saved one, which no box value equals — the owner's brand
 * is theirs however they left it. The brand input is read at event time
 * because it is built after the number.
 */
export function wireCardBrand(numberInput, ctx) {
  numberInput.addEventListener("input", () => {
    const brand = ctx.inputs.brand;
    if (!brand || brand.value !== ctx.derivedBrand) return;
    brand.value = ctx.derivedBrand = cardBrand(numberInput.value);
  });
}

function errText(err) {
  // A throw from the main process arrives wrapped: "Error invoking remote
  // method 'vault:saveItem': Error: the sentence we wrote". The owner should
  // read the sentence, not the plumbing that carried it.
  return (err && err.message ? String(err.message) : String(err))
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^Error:\s*/, "");
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
/*
 * Unsaved edits are decided by COMPARING, not by remembering that a key was
 * pressed. Type Daniel → Carlos → Daniel and there is nothing left to save, so
 * nothing should be asked. `baseline` is what the box held when the form opened.
 */
function vbaseline(input) {
  input.dataset.baseline = input.value;
}

/** Whether this box holds something other than what it opened with. */
const vchanged = (input) => input.value !== input.dataset.baseline;

/*
 * Who owns a pane mutation.
 *
 * vbusy() does, and it is the only thing that does. The invariant is one line:
 * while a vault operation is running, the pane takes no input and nothing else
 * may replace it — and "the operation" means the call AND the pane change it
 * ends with, not the call alone.
 *
 * Everything that touches the pane goes through it: reveal, save, delete, and
 * the reload each of those ends with. A leave question waits on it rather than
 * racing it. Anything added here that mutates the pane belongs inside it too;
 * that is the whole rule, and it is why there is no second coordination seam.
 */

/**
 * Run a vault call with the whole vault PANE inert.
 *
 * Each of these awaits ends by overwriting the form (a reveal) or replacing the
 * entire pane (a save, a delete, and the reload each triggers). Anything typed
 * in between is lost: not stored, not kept, not asked about.
 *
 * The boundary is the pane, not the form's own fields — the reload replaces the
 * pane, so a row saving while another row is opened and edited would take that
 * second row's edits with it. `inert` is the platform saying exactly this: the
 * subtree takes no clicks, no typing and no focus.
 *
 * It comes back only if the call FAILED. On success the caller either replaces
 * the pane or has just overwritten the form, and handing interaction back in
 * between would reopen the window this exists to close.
 */
function vpane() {
  return document.querySelector(".vaultui");
}

/**
 * The vault OPERATION in flight, if any — the call AND the pane change it ends
 * with. A leave question waits for the whole thing: waiting only for the call
 * lets the question resume between the answer arriving and the reload running,
 * which is still under the inert pane and still detached unanswered.
 */
let vinflight = null;

async function vbusy(fn) {
  vpane()?.toggleAttribute("inert", true);
  const done = fn();
  vinflight = done.then(() => {}, () => {}); // settles either way, never rejects
  try {
    return await done;
  } catch (err) {
    vpane()?.toggleAttribute("inert", false);
    throw err;
  } finally {
    vinflight = null;
  }
}

/** True when any box on this form differs from what it opened with. */
function vformDirty(ctx) {
  return [...Object.values(ctx.inputs), ...ctx.urlInputs].some(vchanged);
}

/*
 * The six digits — the only thing about an authenticator key anyone can read.
 *
 * While a key is being pasted, they settle on sight whether the paste was the
 * key at all: "TOTP" means the code to everyone who is not implementing one,
 * the box is masked, and a wrong paste looks exactly like a right one until a
 * site rejects the number. Digits ticking means it was a key; a sentence means
 * it was not, while the box is still open.
 *
 * For a key already IN the vault they are the proof it is saved, so a held key
 * shows its code as soon as the form opens. The KEY itself stays behind the
 * eye; the code is derived from it, dead in half a minute, and cannot be
 * turned back into it.
 */
function vtotp(input, ctx, held) {
  const out = el("div", { class: "totp-read" });
  let showing = null; // { code, expiresAt } — the code on screen, or nothing
  // Answers arrive out of order: a keystroke's request can land after the one
  // that replaced it, describing a key the box no longer holds. Only the
  // newest request may reach the screen.
  let asked = 0;

  /*
   * The one seam. `showing` and the DOM only ever change here, together, so
   * there is no state in which the box says one thing and the variable another
   * — which is how expired digits used to survive on screen while `showing`
   * had already been dropped.
   *
   * Seconds come from the clock rather than a tick count: a backgrounded or
   * throttled renderer gets late, coalesced callbacks, and anything counting
   * its own ticks reads as alive long after the code died.
   */
  const display = (code, message) => {
    showing = code ?? null;
    out.classList.toggle("bad", !code && !!message);
    if (code) {
      const left = Math.max(0, Math.ceil((code.expiresAt - Date.now()) / 1000));
      out.replaceChildren(
        el("span", { class: "totp-code", text: code.code.replace(/^(\d{3})(\d+)$/, "$1 $2") }),
        el("span", { class: "totp-left", text: `${left}s` }),
      );
    } else {
      out.replaceChildren(...(message ? [el("span", { text: message })] : []));
    }
  };

  /**
   * One request, whoever asked.
   *
   * The screen is cleared before the await, not just the variable: whatever
   * was showing is either expired (a rollover) or describes a key the box no
   * longer holds (a keystroke), and a saved key can sit behind the Mac asking
   * who is at the keyboard for as long as it takes. Leaving the old digits up
   * through that would show a dead code as if it were live — the very thing
   * counting against the clock exists to prevent. Clearing also stops the
   * countdown, so it cannot start a second read on top of this one.
   */
  const ask = async (get) => {
    const mine = ++asked;
    display(null);
    try {
      const code = await get();
      if (mine === asked) display(code);
    } catch (err) {
      if (mine === asked) display(null, errText(err));
    }
  };

  /** What the box holds right now, as a code — or why it is not one. */
  const preview = () => {
    const typed = input.value.trim();
    // An emptied box invalidates whatever is still in flight, or its answer
    // would appear under a box holding nothing.
    if (!typed) { asked++; display(null); return Promise.resolve(); }
    return ask(() => window.domo.vaultTotp(null, typed));
  };

  /** The code a SAVED key is showing — asked for, never taken. */
  const fromVault = () => ask(() => window.domo.vaultTotp(ctx.item.id));

  // The countdown owns its own timer and ends with the box it belongs to: a
  // replaced pane detaches the input, and the next tick clears this.
  const timer = setInterval(() => {
    if (!input.isConnected) { clearInterval(timer); return; }
    if (!showing) return;
    if (Date.now() >= showing.expiresAt) void (input.value.trim() ? preview() : fromVault());
    else display(showing);
  }, 1000);

  input.addEventListener("input", preview);
  /*
   * A stored key shows its code the moment the item opens — no reveal, no
   * click. The code is not the secret: it is six digits derived from the key,
   * it is worthless in half a minute, and it cannot be turned back into the
   * key. The KEY stays gated behind the eye, which is the thing worth gating.
   *
   * The cost is honest and deliberate: opening an item that holds a key reads
   * that key, so the vault's audit gets a line for it. That is the owner
   * looking at their own item, which is what the log should say.
   */
  if (held) void fromVault();
  return { node: out, preview };
}

function vfield(spec, ctx) {
  const input = spec.textarea
    ? el("textarea", { class: "inp", attrs: { placeholder: spec.placeholder ?? "" } })
    : el("input", {
        class: "inp",
        attrs: {
          type: spec.type ?? (spec.secret ? "password" : "text"),
          spellcheck: "false",
          placeholder: spec.placeholder ?? "",
          ...(spec.key === "name" ? { "data-name": "1" } : {}),
        },
      });
  const stored = ctx.item ? (spec.key === "notes" ? ctx.item.notes : ctx.item.fields[spec.key]) : "";
  if (!spec.secret && stored) input.value = stored;
  vbaseline(input);
  ctx.inputs[spec.key] = input;

  if (spec.key === "number") wireCardBrand(input, ctx);

  const buttons = [];
  const held = !!(spec.secret && ctx.saved && (ctx.item.secrets || []).includes(spec.key));
  /* Mary drew two states and never let them look alike: a saved secret sat in
     the box (masked, with the eye), and an empty one read "Not set". This app
     never hands a secret back to the window, so both states rendered as the
     same blank box — which is how a key that WAS saved read as dropped.
     Her distinction, kept, in her own alphabet: a stored secret shows the same
     bullets every secret box in this form already shows — the password's
     "••••••••••••", the card number's groups, the CVV's three — painted as
     text rather than as a hint (vault.css, .field.held). A sentence in the box
     said the same thing in a language the rest of the form does not speak.
     A box that already draws its own bullets keeps them, whatever it groups
     them with — a stored card number still reads in its four groups, a social
     security number in its "•••-••-••••". The rest get a fixed run: the value
     never reaches this window, so its true length is not ours to show — this
     is an is-set light and nothing more, and the live code beneath a key is
     what proves the stored value still works.
     An existing item with no secret gets her word. */
  if (held) input.setAttribute("placeholder", /^[•\s-]+$/.test(spec.placeholder ?? "") ? spec.placeholder : "••••••••••••");
  else if (spec.secret && ctx.saved) input.setAttribute("placeholder", "Not set");
  // Built before the buttons so the eye and the code button can drive it.
  const code = spec.totp ? vtotp(input, ctx, held) : null;
  if (spec.secret) {
    const eye = el("button", { class: "mini eye", attrs: { type: "button", title: "Reveal" } }, [icon("eye", { class: "vico", strokeWidth: "1.8" })]);
    eye.addEventListener("click", async () => {
      if (input.getAttribute("type") === "text") {
        input.setAttribute("type", "password");
        eye.replaceChildren(icon("eye", { class: "vico", strokeWidth: "1.8" }));
        return;
      }
      if (held && !input.value) {
        try {
          await vbusy(async () => {
            const revealed = await window.domo.vaultReveal(ctx.item.id, spec.key);
            input.value = revealed;
            // Looking at a secret is not changing it: without re-baselining,
            // merely peeking at a password would ask to save it.
            vbaseline(input);
            // The key is on screen now; so is what it is worth.
            code?.preview();
            // The only call the pane OUTLIVES, so it is the only one that hands
            // interaction back on success.
            vpane()?.toggleAttribute("inert", false);
          });
        } catch (err) {
          vtoast("Could not read it: " + errText(err));
          return;
        }
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
    });
    buttons.push(gen);
  }

  const label = spec.label
    ? el("label", { text: spec.label + " " }, spec.required ? [el("span", { class: "req", text: "*" })] : [])
    : null;
  const hint = spec.hint ? el("span", { class: "gen-hint" }, [icon("generate", { class: "vico", strokeWidth: "1.8" }), el("span", { text: " " + spec.hint })]) : null;
  return el("div", { class: "field" + (spec.secret ? " secret" : "") + (held ? " held" : "") + (spec.half ? "" : " span2") },
    [label, el("div", { class: "inwrap" }, [input, ...buttons]), code?.node, hint].filter(Boolean));
}

/** The website group: one box per URL the item has, her "Add website", and a
    way back off each one. */
function vurls(ctx) {
  // The last remaining site cannot be removed: a login with no URL can never be
  // filled, and the save refuses it — so the form never offers that dead end.
  // That is a fact about this list, and vault.css reads it off :only-child
  // rather than anything here keeping a second copy of it in step.
  const rows = el("div", { class: "url-rows" });
  // `initial` is set BEFORE the baseline is taken: a row drawn from a stored
  // address opens holding it, so that address is what "unchanged" means. Taking
  // the baseline first and assigning after would leave every item that has a
  // website permanently unsaved.
  const add = (initial = "") => {
    const input = el("input", { class: "inp", attrs: { type: "text", spellcheck: "false", placeholder: "https://" } });
    input.value = initial;
    vbaseline(input);
    ctx.urlInputs.push(input);
    const drop = el("button", { class: "mini drop", attrs: { type: "button", title: "Remove this website", "aria-label": "Remove this website" } },
      [icon("close", { class: "vico", strokeWidth: "1.8" })]);
    const row = el("div", { class: "field span2" }, [el("div", { class: "inwrap" }, [input, drop])]);
    drop.addEventListener("click", () => {
      // Emptied in place, not spliced out of urlInputs: the box's position is
      // what tells the save which stored entry this row was drawn from, and
      // two rows can hold the same address.
      input.value = "";
      row.remove();
    });
    rows.appendChild(row);
    return input;
  };
  const existing = ctx.item ? ctx.item.urls || [] : [];
  if (existing.length === 0) add();
  else for (const url of existing) add(url);

  const more = el("button", { class: "add-link", attrs: { type: "button" } }, [icon("plus", { class: "vico", strokeWidth: "2" }), el("span", { text: " Add website" })]);
  more.addEventListener("click", () => add().focus());
  return el("div", { class: "group" }, [
    el("div", { class: "group-h", text: "Website (URI) " }, [el("span", { class: "req", text: "*" })]),
    rows,
    more,
  ]);
}

/** Every group of a type's form, built once and shared by the sheet and the row. */
function vformBody(type, item) {
  const spec = VAULT_TYPES[type];
  const saved = !!(item && item.id);
  // A saved card's Brand box is the owner's, whatever it holds — an empty one
  // is them having cleared it, and the vault kept it cleared. `null` is equal
  // to no box value, so the fill never claims it back. A new item's box opens
  // as ours.
  const ctx = { item, saved, inputs: {}, urlInputs: [], derivedBrand: saved ? null : "" };
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
      payload.urls = ctx.urlInputs.map((i) => i.value.trim());
      continue;
    }
    for (const field of group.fields) {
      const input = ctx.inputs[field.key];
      // A secret box starts blank because the vault never handed the value
      // over, so blank-and-untouched means "leave the stored one alone" —
      // while blank after the owner edited it means they cleared it.
      if (field.secret && !vchanged(input)) continue;
      payload[field.key] = input.value;
    }
  }
  return payload;
}

/** Her confirm card, for the actions that cannot be undone. Resolves the answer. */
function vconfirm(title, body, confirmLabel) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "overlay confirm-overlay show" });
    const answer = (yes) => { overlay.remove(); resolve(yes); };
    const keep = el("button", { class: "btn ghost", attrs: { type: "button" }, text: "Cancel" });
    keep.addEventListener("click", () => answer(false));
    const go = el("button", { class: "btn danger", attrs: { type: "button" }, text: confirmLabel });
    go.addEventListener("click", () => { go.disabled = true; answer(true); });
    overlay.appendChild(el("div", { class: "confirm-card", attrs: { role: "alertdialog" } }, [
      el("div", { class: "confirm-h", text: title }),
      el("p", { class: "confirm-p", text: body }),
      el("div", { class: "confirm-acts" }, [keep, go]),
    ]));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) answer(false); });
    document.querySelector(".vaultui").appendChild(overlay);
  });
}

/*
 * Unsaved edits.
 *
 * A form is dirty when a box DIFFERS from what it opened with — not when a key
 * was pressed in it. Secrets compare too: the box starts blank because the vault
 * hands nothing over, and revealing one re-baselines it, so the comparison is
 * against what is actually stored in both states.
 *
 * ONE editor at a time may hold unsaved edits. The screen can show several open
 * rows, but the moment a second one is edited the first has already been asked
 * about — so every teardown, from a row collapsing to the window closing, has
 * exactly one thing to consult. A set of independent dirty forms cannot give
 * that answer: a save on one reloads the pane and takes the others down with
 * it, which is the silent loss this whole change exists to stop.
 */
let editor = null; // { dirty(), close() } — the one form that may be holding edits

/**
 * True when the current editor's edits may be thrown away. One dialog at a
 * time, whoever asks: a row collapsing and a Cmd-W arriving together are two
 * callers of this, and two stacked overlays over one form is nonsense.
 */
let asking = null;
function vmayDiscard() {
  if (!editor?.dirty()) return Promise.resolve(true);
  asking ??= vconfirm(
    "Discard your changes?",
    "What you typed here has not been saved to the vault. Leaving throws it away.",
    "Discard",
  ).finally(() => { asking = null; });
  return asking;
}

/** Hand the seat to `next`, asking whoever holds it to give up their edits. */
async function vtakeEditor(next) {
  if (editor === next) return true;
  if (!(await vmayDiscard())) return false;
  editor?.close();
  editor = next;
  return true;
}

/** The seat is free — the holder saved, closed, or was torn down. */
function vreleaseEditor(who) {
  if (editor === who) editor = null;
}

/** Asked before anything replaces this pane — a tab switch, or main tearing
    the window down. vmayDiscard() is what keeps it to one dialog. */
export async function vaultConfirmLeave() {
  // Wait for any call in flight before asking. The question is drawn INSIDE the
  // pane, and the pane is inert while a call runs — so a dialog raised now could
  // not be answered, and the reload after a successful save would detach it
  // unanswered, leaving main's no-timeout wait stranded and every later close
  // and quit with it. Waiting also usually removes the question: the save lands,
  // the form is released, and there is nothing left to discard.
  if (vinflight) await vinflight;
  const ok = await vmayDiscard();
  if (ok) {
    // Close it, don't just drop the seat. Quit answers this and then spends
    // seconds shutting the browsers down, and a form left on screen is a form
    // still being typed into — edits nothing is watching for any more.
    editor?.close();
    editor = null;
  }
  return ok;
}

/** One saved item: her row, and the form it opens into. */
function vitem(summary, reload) {
  const type = summary.type || "login";
  // "unsupported": a shape migrated from the old vault that these forms can't
  // edit. It still gets a row — hidden reads as a lost item — that opens into
  // an explanation and a delete button instead of a form.
  const spec = VAULT_TYPES[type] || { icon: "key", label: "Unsupported" };
  const article = el("article", { class: "vitem", attrs: { "data-type": type } });

  const row = el("button", { class: "vrow", attrs: { type: "button" } }, [
    el("span", { class: "vicon" }, [icon(spec.icon, { class: "vico", strokeWidth: "1.8" })]),
    el("span", { class: "vmain" }, [
      el("span", { class: "vtitle", text: summary.title || "(untitled)" }),
      el("span", { class: "vctx", text: [summary.subtitle, (summary.urls || [])[0]].filter(Boolean).join(" · ") }),
    ]),
    el("span", { class: "vchev" }, [icon("chevron", { class: "vico", strokeWidth: "2" })]),
  ]);
  const inner = el("div", { class: "vbody-inner" });
  const body = el("div", { class: "vbody" }, [inner]);

  let loaded = false;
  let form = null; // the ctx of the open form, or null when the row is shut
  const shut = () => {
    // Closing throws the form away, revealed values included. Keeping it
    // would let a second look at a protected item skip the check the first
    // one had to pass.
    article.classList.remove("open");
    inner.replaceChildren();
    loaded = false;
    form = null;
  };
  const seat = { dirty: () => form !== null && vformDirty(form), close: shut };
  const release = () => { form = null; vreleaseEditor(seat); };
  row.addEventListener("click", async () => {
    if (article.classList.contains("open")) {
      // Ask BEFORE anything is torn down, so backing out leaves the form —
      // and whatever was typed into it — exactly as it stood.
      if (!(await vmayDiscard())) return;
      release();
      shut();
      return;
    }
    // Opening this row takes the editor seat from whoever held it, which is
    // where the owner of any unsaved edits gets asked.
    if (!(await vtakeEditor(seat))) return;
    article.classList.add("open");
    if (loaded) return;
    loaded = true;
    if (!VAULT_TYPES[type]) {
      const del = el("button", { class: "btn danger", attrs: { type: "button" }, text: "Delete" });
      del.addEventListener("click", async () => {
        const yes = await vconfirm(
          "Delete this item?",
          `"${summary.title || "(untitled)"}" is permanently deleted — there is no trash and no undo. Agents lose it immediately.`,
          "Delete",
        );
        if (!yes) return;
        try {
          await vbusy(async () => {
            await window.domo.vaultDeleteItem(summary.id);
            release();
            vtoast("Deleted");
            await reload();
          });
        } catch (err) {
          vtoast("Could not delete it: " + errText(err));
        }
      });
      inner.replaceChildren(
        el("p", { class: "use-note", text:
          "This item was saved by the old vault in a shape this app can't edit (an SSH key, for example). " +
          "Agents can still be granted it for filling; here it can only be deleted." }),
        el("div", { class: "row" }, [del]),
      );
      return;
    }
    inner.replaceChildren(el("p", { class: "use-note", text: "Opening…" }));
    try {
      const item = await window.domo.vaultItem(summary.id);
      const { nodes, ctx } = vformBody(type, item);
      form = ctx;
      const del = el("button", { class: "btn danger", attrs: { type: "button" }, text: "Delete" });
      del.addEventListener("click", async () => {
        const yes = await vconfirm(
          "Delete this item?",
          `"${item.name}" is permanently deleted — there is no trash and no undo. Agents lose it immediately, and anything filled with it stops working.`,
          "Delete",
        );
        if (!yes) return;
        try {
          await vbusy(async () => {
            await window.domo.vaultDeleteItem(item.id);
            release(); // it is gone; do not ask about edits to it
            vtoast("Deleted");
            await reload();
          });
        } catch (err) {
          vtoast("Could not delete it: " + errText(err));
        }
      });
      const save = el("button", { class: "btn save", attrs: { type: "button" }, text: "Save" });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          const input = { ...vpayload(type, ctx), itemId: item.id, revision: item.revision };
          await vbusy(async () => {
            await window.domo.vaultSaveItem(input);
            release(); // stored now — the reload below must not ask about it
            vtoast("Saved");
            await reload();
          });
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
      release(); // nothing was ever typed into a form that failed to open
      inner.replaceChildren(el("p", { class: "use-note", text: "Could not open it: " + errText(err) }));
    }
  });

  article.replaceChildren(row, body);
  return article;
}

/** Her sheet: pick a type, fill that type's form, save. */
async function vsheet(reload) {
  const overlay = el("div", { class: "overlay show" });
  let formCtx = null; // the ctx of the form on screen; the picker holds none
  const close = () => { vreleaseEditor(seat); overlay.remove(); };
  const seat = { dirty: () => formCtx !== null && vformDirty(formCtx), close };
  // The sheet is modal, so it holds the seat for its whole life — taking it up
  // front is where an already-dirty row gets asked about, before this covers it.
  if (!(await vtakeEditor(seat))) return;
  /** Every way out except a successful save, which has nothing to discard. */
  const leave = async () => { if (await vmayDiscard()) close(); };

  const title = el("h2", { text: "New item" });
  const tag = el("span", { class: "htag", attrs: { hidden: "" } });
  const back = el("button", { class: "sheet-back", attrs: { type: "button", title: "Back", hidden: "" } }, [icon("chevron", { class: "vico", strokeWidth: "2.2" })]);
  const x = el("button", { class: "sheet-x", attrs: { type: "button", title: "Close" } }, [icon("close", { class: "vico", strokeWidth: "2.2" })]);
  x.addEventListener("click", leave);

  const bodyEl = el("div", { class: "sheet-body" });
  const cancel = el("button", { class: "btn ghost", attrs: { type: "button" }, text: "Cancel" });
  cancel.addEventListener("click", leave);
  const save = el("button", { class: "btn save", attrs: { type: "button" }, text: "Save" });
  const foot = el("div", { class: "sheet-foot", attrs: { hidden: "" } }, [
    el("span", { class: "req-note" }, [el("span", { class: "req", text: "*" }), el("span", { text: " Required" })]),
    cancel,
    save,
  ]);

  const picker = () => {
    formCtx = null; // the picker holds nothing to lose; the sheet keeps the seat
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
    formCtx = ctx;
    bodyEl.replaceChildren(el("form", { class: "sheet-form", attrs: { autocomplete: "off" } }, nodes));
    save.onclick = async () => {
      save.disabled = true;
      try {
        const input = vpayload(type, ctx);
        await vbusy(async () => {
          await window.domo.vaultSaveItem(input);
          formCtx = null; // stored: nothing left to discard
          close();
          vtoast("Saved");
          await reload();
        });
        return;
      } catch (err) {
        vtoast("Could not save it: " + errText(err));
      }
      save.disabled = false;
    };
  };
  back.addEventListener("click", async () => { if (await vmayDiscard()) picker(); });

  overlay.appendChild(el("div", { class: "sheet", attrs: { role: "dialog", "aria-modal": "true" } }, [
    el("div", { class: "sheet-top" }, [back, el("div", { class: "sheet-titlewrap" }, [title, tag]), x]),
    bodyEl,
    foot,
  ]));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) leave(); });
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

/* What the search box holds. Module-level, because a save or delete redraws
   the whole pane: the list the owner had narrowed down should still be
   narrowed down when their item comes back into it. It is never hidden —
   the box shows it — so nothing filters the list silently. */
let vquery = "";

/** One credential-exchange sheet at a time: renders can overlap (the push
 * from main and a tab click land close together), and two sheets fighting
 * over the editor seat would cancel each other's staging. */
let exchangeOpening = false;

export async function renderVault(view, isCurrent = () => true) {
  /** Redraw this same pane — what every action hands to its callers. */
  const renderVaultIn = () => renderVault(view, isCurrent);
  // A redraw detaches every form on the pane, so the seat goes with them. This
  // is safe ONLY because at most one editor can be dirty: the reload is always
  // triggered by that editor's own save or delete, which released the seat just
  // above — there is no second dirty form for this to quietly discard.
  editor = null;
  // Everything the vault holds, edited here. This is why the tab exists: the
  // only other way in is the vault's own web page, and reaching it means a
  // browser warning about the certificate the app issued to itself.
  const pane = el("div", { class: "vaultui" });
  const masthead = el("div", { class: "masthead" }, [
    el("div", {}, [
      el("h2", { text: "Browser Vault" }),
      el("p", { class: "trust" }, [
        el("span", { text: "Logins, credit cards, identities and notes your agents may need while working in the browser. When an agent needs one, this Mac fills it in for them. The values never leave this Mac." }),
      ]),
    ]),
  ]);

  // Paint BEFORE reading the vault. Nothing above this line waits on anything,
  // and the wait below can be long when the vault is slow — this used to leave
  // the previous tab's content on screen for the whole wait, so a stalled vault
  // read as "the Vault tab is broken" instead of "the vault has not answered
  // yet". The same `pane` is filled in below, so this costs one extra paint.
  //
  // This is the only mount: below, `pane` is already the node in `view`, and a
  // render whose pane has since been replaced by a newer one is a render that
  // must not put itself back on screen.
  pane.replaceChildren(masthead, el("div", { class: "col" }, [
    el("div", { class: "empty", text: "Opening the vault…" }),
  ]));
  view.replaceChildren(pane);

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

  if ((items === null || (items && items.locked)) && !failure) {
    // Locked and empty are different facts and get different words. A vault
    // whose key has moved — a Keychain reset, a Mac restored from backup — used
    // to render as "has not started yet", which sent people looking for a
    // server that was running fine.
    const locked = !!(items && items.locked);
    pane.replaceChildren(masthead, el("div", { class: "col" }, [
      el("div", { class: "empty", text: locked
        ? "This Mac can't unlock its vault."
        : "The vault isn't available in this build." }),
      // No invented recovery, and no asserting a cause the code cannot tell
      // apart: `undecryptable` is one answer covering a Keychain key that is
      // gone, a damaged key file, AND an old vault awaiting migration whose
      // account can't be opened — so the copy leads with what is certain,
      // names the likely cause as likely, and gives the remedy, which is the
      // same either way.
      locked
        ? el("p", { class: "use-note", text: items.reason === "no-storage"
            ? "The vault's key is sealed for the app's secure storage, which this build doesn't have. Nothing is lost; a build with secure storage will open it."
            : "The vault's key can't be opened. Usually the key is no longer in this Mac's Keychain — after a Keychain reset or a restore from backup — and it can also mean the key file, or an old vault's account file, is damaged or missing. Either way the key can't be recovered, here or anywhere: the vault would have to be set up again. Nothing has been deleted." })
        : null,
    ].filter(Boolean)));
    return;
  }

  const importBtn = el("button", { class: "btn imp", attrs: { type: "button" } }, [
    icon("intake", { class: "vico", strokeWidth: "2" }),
    el("span", { text: " Import" }),
  ]);
  // `alive` says whether the pane this sheet was opened FROM is still the
  // one on screen — a credential exchange arriving mid-open replaces the
  // pane, and the stale opening must stand down (see vimportSheet).
  const alive = () => isCurrent() && pane.isConnected;
  importBtn.addEventListener("click", () =>
    vimportSheet(renderVaultIn, { errText, vbusy, vtakeEditor, vreleaseEditor, vtoast, alive }));
  const newBtn = el("button", { class: "btn-primary", attrs: { type: "button" } }, [
    icon("plus", { class: "vico", strokeWidth: "2.2" }),
    el("span", { text: " New" }),
  ]);
  newBtn.addEventListener("click", () => vsheet(renderVaultIn));
  masthead.appendChild(el("div", { class: "mast-acts" }, [importBtn, newBtn]));

  // A credential exchange main staged (Apple Passwords' "Export to another
  // app…") opens the Import sheet by itself, straight on its preview — the
  // owner already chose the export in the other app; making them find the
  // Import button would be a second ask. Checked on every render because the
  // pane may be built after the push event fired (window opened by the
  // hand-off itself); pending survives in main until commit or cancel.
  void (async () => {
    if (exchangeOpening) return;
    exchangeOpening = true;
    try {
      const exchange = await window.domo.vaultExchangePending().catch(() => null);
      if (exchange && alive()) {
        await vimportSheet(renderVaultIn, { errText, vbusy, vtakeEditor, vreleaseEditor, vtoast, alive }, exchange);
      }
    } finally {
      exchangeOpening = false;
    }
  })();

  const list = el("div", { class: "vlist" });
  const count = el("span", { class: "lc" });
  const head = [el("span", { class: "lt", text: "Saved items" })];
  if (failure) {
    list.replaceChildren(el("div", { class: "empty", text: "Could not read the vault: " + failure }));
  } else if (items.length === 0) {
    list.replaceChildren(el("div", { class: "empty", text: "Nothing saved yet." }));
  } else {
    // Every row is built once; the search only hides. A row that is hidden
    // is not torn down — an open form under it keeps its edits, and comes back
    // as it was when the query lets it. The MATCHING is the vault's, in main:
    // it reads every field there, secrets included, and only the matching ids
    // come back — so this listing never holds a secret for the sake of a
    // search. An item that asks for the owner first matches on its open
    // fields only; that is decided there too.
    const rows = items.map((summary) => ({ summary, node: vitem(summary, renderVaultIn) }));
    const none = el("div", { class: "empty vnone" });
    list.replaceChildren(...rows.map((r) => r.node), none);
    const search = el("input", { class: "vsearch", attrs: {
      type: "search", placeholder: "Search", "aria-label": "Search saved items",
      autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false",
    } });
    search.value = vquery;
    const show = (q, ids) => {
      let shown = 0;
      for (const { summary, node } of rows) {
        const keep = ids === null || ids.has(summary.id);
        node.hidden = !keep;
        if (keep) shown += 1;
      }
      none.hidden = shown > 0;
      none.textContent = `Nothing matches “${q}”.`;
      count.textContent = q
        ? `${shown} of ${items.length}`
        : `${items.length} item${items.length === 1 ? "" : "s"}`;
    };
    // One query in flight at a time, and only the latest answer applied:
    // keystrokes are debounced, and an answer to a query the box has since
    // moved on from is dropped rather than drawn over the newer one.
    let timer = null;
    let latest = 0;
    const apply = () => {
      vquery = search.value;
      const q = vquery.trim();
      const seq = ++latest;
      if (timer) clearTimeout(timer);
      if (!q) { show(q, null); return; }
      timer = setTimeout(async () => {
        timer = null;
        let ids;
        try {
          ids = new Set(await window.domo.vaultSearch(q));
        } catch (err) {
          if (seq !== latest) return;
          vtoast("Could not search the vault: " + errText(err));
          return;
        }
        if (seq !== latest) return;
        show(q, ids);
      }, 120);
    };
    search.addEventListener("input", apply);
    search.addEventListener("keydown", (e) => {
      // Escape clears the box before it does anything else; an empty box
      // leaves it alone so the key still means what it usually does.
      if (e.key === "Escape" && search.value !== "") {
        e.preventDefault();
        search.value = "";
        apply();
      }
    });
    if (vquery.trim()) {
      // Redrawn with a query still in the box: keep the rows as they were
      // until the vault answers again, rather than flashing the whole list.
      show(vquery.trim(), null);
    }
    apply();
    head.push(el("span", { class: "vsearch-wrap" }, [icon("search", { class: "vico", strokeWidth: "2" }), search]));
  }
  head.push(count);

  pane.replaceChildren(
    masthead,
    el("div", { class: "col" }, [
      el("div", { class: "list-head" }, head),
      list,
    ]),
    el("div", { class: "toast" }),
  );
}
