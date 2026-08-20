/**
 * The built-in browsing skill — the operator manual a remote agent reads
 * before driving this Mac's Camoufox browser. Adapted from
 * plow-pbc/camoufox-cli SKILL.md for the Domo tool surface (see
 * vendor/browser-server/UPSTREAM.md).
 */
import { Skill } from "../skills.js";

export const BROWSING_SKILL: Skill = {
  name: "camoufox-browsing",
  description:
    "Browse websites on this Mac with a real anti-detection Firefox browser, using the " +
    "owner's local credentials (their vault): a secret is typed into the page rather than "
    + "returned to you. Use when " +
    "the task needs the OWNER'S browser rather than any browser: signing in as them, filling " +
    "forms, buying things, or reading a page only their session can see. General web reading " +
    "belongs in your own tools, which are faster at it.",
  body: `# Browsing on this Mac

You drive a real anti-detection Firefox (Camoufox) running ON this Mac via three tools:
\`plow_browser_open\` (start a session), \`plow_browser\` (act), \`plow_browser_request\` (widen scope),
\`plow_browser_close\` (finish). The browser uses the owner's local network and credentials;
secret values are typed into pages on the Mac and are never returned to you by these
tools — they land in the page you are driving, so treat them as you treat anything else
there: never copy one out, repeat it, or write it anywhere. \`eval\` can read them out of
the page; that is the one way round it, and it is not one you have any reason to take.

## Sessions and scope

- \`plow_browser_open {origins: ["dominos.com", "*.dominos.com"], credentials_metadata: true, goal}\`
  asks the owner to approve a browsing session bound to those site origins. List every
  domain you expect up front — the apex and the wildcard are separate entries.
- The window is **visible by default** — the owner watches what is done with their
  credentials. If they ask for it in the background ("don't take over my screen", "run it
  headless"), open with \`headed: false\`; if they ask to watch, say nothing or pass
  \`headed: true\`. Your screenshots are identical either way — only their view changes.
  The choice lasts the session; a new mode means a new \`plow_browser_open\`.
- Every \`plow_browser\` action is checked against the approved origins. If a click or popup
  lands outside them, page content locks: you can only \`url\`, \`pages\`, \`use_page\`, or
  \`goto\` back in scope. To follow the flow (e.g. a payment popup went to paypal.com),
  call \`plow_browser_request {session, origins: ["paypal.com", "*.paypal.com"]}\` and continue
  after approval.
- Sessions idle out after 15 minutes. \`plow_browser_close\` when done.

## Acting: always screenshot first

**Your session id is your browser, and the profile behind it is yours.** Pass the one \`plow_browser_open\` gave you on every
call and you keep the same window, profile and cookies. Other agents drive their own
browsers at the same time: yours is never taken from you, theirs is never visible to
you, and when the Mac is already running as many as it will, the open says so. Closing
is yours alone — another agent holding your id cannot close your browser. Your cookies
and logins outlive the session: the profile belongs to you, not to one open.

\`plow_browser {session, action, ...}\` — actions:
goto, click, fill, fill_secret, scroll, wait, back, eval, use_page, screenshot, text,
url, title, links, forms, tables, pages.

1. \`goto\` a URL → 2. \`wait\` 2–3 s → 3. \`screenshot\` (you receive the image — LOOK at it)
→ 4. decide → 5. \`click\`/\`fill\`/\`scroll\` → 6. screenshot again.

- **You are the intelligence.** Screenshot gives you eyes; click/fill/eval give you hands.
  Write selectors from what you SEE, not from memory.
- **\`back\` does not work in this browser** — it honestly reports \`moved: false\`. Navigate
  with \`goto\` instead; cookies and the session survive.
- **A popup is not the active page.** Every result includes \`page_count\`; when it grows,
  run \`pages\` and switch with \`use_page\`.
- \`eval\` runs a JS expression in the top frame — use it to extract structured data after
  you've seen the page. \`forms\` lists every input across frames with labels; \`fill\`
  searches all frames (pass \`frame\` to target one).
- Cookie banners/modals: \`eval 'document.querySelector("[id*=cookie] button, [class*=consent] button")?.click()'\`.
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
2. Open the session with \`credentials_metadata: true\` (or add it later via plow_browser_request).
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

vault list → open (merchant origins + credentials_metadata) → browse/choose items → at login:
vault describe → plow_browser_request (login item) → fill_secret → at checkout:
plow_browser_request (card item; plus payment-provider origins if a popup appears) →
fill_secret each card field → confirm → screenshot the confirmation → plow_browser_close.`,
};
