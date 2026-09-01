/**
 * The built-in browsing skill — the operator manual a remote agent reads
 * before driving this Mac's Camoufox browser. Adapted from
 * plow-pbc/camoufox-cli SKILL.md for the Domo tool surface (see
 * vendor/browser-server/UPSTREAM.md).
 */
import { Skill } from "../skills.js";
import { MAX_CLICK_TIMEOUT_MS } from "./browserSessions.js";

/**
 * Why this Mac's browser is the one that answers a live-web question, in ONE
 * place. Three surfaces said it in three independent wordings — the server
 * instructions, `plow_browser_open`, and the skill description below — which
 * meant three prose edits and a regex guard to keep them in step. They
 * interpolate this instead.
 *
 * Every clause is a fact the agent's own fetch cannot match, and none of them
 * overstates: the profile really is a copy of the user's, so "already signed
 * in" is description rather than promise.
 */
export const LIVE_WEB_ROUTING =
  "their browser runs on their own network rather than a datacenter address many sites " +
  "refuse, it renders JavaScript, and it starts on a copy of their own profile, so it is " +
  "already signed in wherever they are";

export const BROWSING_SKILL: Skill = {
  name: "camoufox-browsing",
  description:
    "Browse websites on this Mac with a real anti-detection Firefox browser, using the " +
    "owner's local credentials (their vault): a secret is typed into the page rather than "
    + `returned to you. Use it for reading the live web at all — ${LIVE_WEB_ROUTING} — and ` +
    "whenever the task needs the OWNER'S browser rather than any browser: signing in as them, " +
    "filling forms, buying things, or reading a page only their session can see.",
  body: `# Browsing on this Mac

You drive a real anti-detection Firefox (Camoufox) running ON this Mac via three tools:
\`plow_browser_open\` (start a session), \`plow_browser\` (act), \`plow_browser_request\` (widen scope),
\`plow_browser_close\` (finish). The browser uses the owner's local network and credentials;
secret values are typed into pages on the Mac and are never returned to you by these
tools — they land in the page you are driving, so treat them as you treat anything else
there: never copy one out, repeat it, or write it anywhere. \`eval\` can read them out of
the page; that is the one way round it, and it is not one you have any reason to take.

## Sessions and scope

- \`plow_browser_open {origins: ["dominos.com", "*.dominos.com"], goal}\`
  asks the owner to approve a browsing session bound to those site origins. List every
  domain you expect up front — the apex and the wildcard are separate entries.
- The window is **hidden by default** — the browser runs in the background and does not
  take over the owner's screen. If they ask to watch it ("show me", "open it where I can
  see it"), open with \`headed: true\`; otherwise say nothing or pass \`headed: false\`.
  Your screenshots are identical either way — only their view changes.
  The choice lasts the session; a new mode means a new \`plow_browser_open\`.
- Every \`plow_browser\` action is checked against the approved origins. If a click or popup
  lands outside them, page content locks: you can only \`url\`, \`pages\`, \`use_page\`, or
  \`goto\` back in scope. To follow the flow (e.g. a payment popup went to paypal.com),
  call \`plow_browser_request {session, origins: ["paypal.com", "*.paypal.com"]}\` and continue
  after approval.
- Sessions idle out after 15 minutes. \`plow_browser_close\` when done.

## Acting: always screenshot first

**Your session id says which browser.** Pass the one \`plow_browser_open\` gave you on
every call and you keep the same window; several browsers can be open at once, each with
its own id, and when the Mac is already running as many as it will, the open says so.

**You are the user, already signed in.** Every session starts on a copy of their own
browser profile — their cookies, their logins — so check whether a site is already signed
in before signing in again. What you sign into is merged back into their profile when the
session closes, so it is still signed in for the next browser — and browsers open at the
same time do not overwrite each other. When you do have to sign in, use \`fill_secret\`.

\`plow_browser {session, action, ...}\` — actions:
goto, click, fill, fill_secret, scroll, wait, back, eval, use_page, screenshot, text,
url, title, links, forms, tables, pages.

1. \`goto\` a URL → 2. \`wait\` 2–3 s → 3. \`screenshot\` (you receive the image — LOOK at it)
→ 4. decide → 5. \`click\`/\`fill\`/\`scroll\` → 6. screenshot again.

- **You are the intelligence.** Screenshot gives you eyes; click/fill/eval give you hands.
  Write selectors from what you SEE, not from memory.
- **\`back\` reports whether the URL changed** as \`moved: true\` or \`moved: false\`.
  When it returns false, use \`goto\` instead; cookies and the session survive.
- **An action that "worked" but changed nothing: read \`failed_requests\`.** A result carries it
  when the page's own requests came back refused — most recent first, each \`{status, method,
  host}\` plus \`retry_after\` and \`server\` when the response carried them. A 401 or 403 means
  the sign-in did not take; a 429 means you are being throttled or blocked, and a 429 with no
  \`retry_after\` is usually the latter, so waiting will not help. An action that ERRORED
  carries them too — that is usually the reason it failed. You are told the host, not the
  path, and only for your approved origins. One can also settle late and ride the next
  result. Do not instrument the page with \`eval\` to find this out; this is that answer.
- **\`altered\` on a fill means the field is not holding what you typed.** Pages
  rewrite what goes into them — a card box adds spaces to the digits, a phone box
  drops the dashes — and that is usually fine. It is not fine when the value had
  to arrive intact. You are told the difference happened, not whether it matters;
  screenshot the field and decide. A fill without it landed exactly. One shape of
  it has a fix: a code the page takes as separate one-character boxes keeps only
  the first character of a whole-value \`fill_secret\` — pass \`selectors\` instead
  (see Credentials).
- **A popup is not the active page.** Every result includes \`page_count\`; when it grows,
  run \`pages\` and switch with \`use_page\`.
- \`eval\` runs a JS expression in the top frame — use it to extract structured data after
  you've seen the page. \`forms\` lists every input across frames with labels; \`fill\`
  searches all frames (pass \`frame\` to target one).
- **A click that fails is not a reason to reach for \`eval\`.** A click \`eval\` synthesizes
  arrives with \`isTrusted: false\`, which is exactly what a site's bot defenses look for —
  and the click you route around is usually the one that gets the session flagged. Give the
  click a longer \`timeout_ms\` instead (up to ${MAX_CLICK_TIMEOUT_MS}) when the page is
  still settling.
- **A click nothing can reach is telling you something.** When a cookie banner or a modal
  backdrop is over the element, the failure names it ("<div class=\"modal-backdrop show\">
  intercepts pointer events") — and no click gets through it, because a person's would not
  either. Screenshot, then click the banner's or modal's own button: a real click on
  whatever is on top lands.
- Captcha/blocked: tell the user; try an alternative site.

## Credentials (logins, cards, identities) — the value is never handed back to you

**This machine has its own password vault — do not go looking for 1Password or ask the
owner to paste anything.** \`plow_vault {action: "list"}\` answers at any time, with no browser
session: every item the owner keeps — logins, cards, identities, secure notes, custom
fields — with titles, usernames and sites, never a value. \`plow_vault {action: "describe"}\` names an
identity's fields (first name, address, email, passport number…) exactly like any other
item's, and \`fill_secret\` types them into the page the same way.

1. \`plow_vault {action: "list"}\` to see what is there; \`plow_vault {action: "describe", item: "<id>"}\`
   names the fields that item holds.
2. Open the session on the merchant's origins.
3. Pick the right item by reading the page.
4. Ask for fill rights: \`plow_browser_request {session, credential_items: ["<item-id>"]}\` —
   the owner approves the named items.
5. \`plow_browser {action: "fill_secret", selector: "#password", item: "<item-id>", field: "password"}\`
   types the value on the Mac. You get \`{ok: true}\` — never the value itself, and it is not
   yours to carry anywhere: do not restate it, and do not put it in a goal or a plan. Use it
   for EVERY field that comes out of the vault, not only the secret ones: an address, a
   cardholder name and a username are vault fields too, and \`fill_secret\` is the only way to
   put one in a page. Plain \`fill\` is for text you already have, not for anything the vault
   holds. Cards may fill on any approved origin; logins only on their own site.
   **A code split across single-character boxes** — a 2FA screen's six one-digit
   inputs, a PIN pad — cannot be filled as one field: pass \`selectors\` in place of
   \`selector\`, naming every box in the order the code is read:
   \`{action: "fill_secret", selectors: ["#code-1", ..., "#code-6"], item, field: "totp"}\`.
   The value is split on the Mac, one character per box; every box must be in the
   same frame, and a fill that fails part-way erases what it already typed so no
   partial code is left sitting in the form.
   **A destination in the bundled v1 bank registry needs a separate owner payment
   approval.** When the page you are filling matches that registry, \`fill_secret\` needs
   more than item rights: the owner
   must ALSO approve the payment out of band — a link in their Plow thread, or a 👍. The
   fill proceeds only once that approval is granted; until then \`fill_secret\` returns an
   error saying the owner's payment approval was not found, and NOTHING is typed. That is
   not a bug to work around — ask the owner to approve the payment, then try the fill again.
   Do not try to \`fill\` a bank credential by hand to dodge it; you do not have the value.
6. What is hidden afterwards is what the vault itself hides: a password, a card number and
   security code, an ssn, a Hidden custom field. Those render as dots and \`forms\` reports
   them present without their characters. Everything else the vault holds — addresses,
   names, expiry dates — fills as ordinary text you can read back with \`screenshot\` or
   \`forms\` to check you put it in the right box.
   One exception to that rule: a generated \`totp\` code is hidden from you even though the
   vault's own app shows it. You do not need to read it — fill it and submit — and it is a
   working credential for the half-minute it lasts.
   Masking covers what you SEE: screenshots and \`forms\`. It does not cover \`eval\`, which
   reads a field's value straight out of the page. Never use \`eval\` to inspect a field you
   filled — you have no reason to, and the mask is there because that value is not yours.

## Order of operations for a purchase

vault list → open (merchant origins) → browse/choose items → at login:
vault describe → plow_browser_request (login item) → fill_secret → at checkout:
plow_browser_request (card item; plus payment-provider origins if a popup appears) →
fill_secret each card field → confirm → screenshot the confirmation → plow_browser_close.`,
};
