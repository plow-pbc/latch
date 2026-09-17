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
 * instructions, `plow_browser_open`, and the skill body below — which meant
 * three prose edits and a regex guard to keep them in step. They interpolate
 * this instead. (The skill's description is the routing trigger only: the
 * Hermes plugin clips each description at 280 characters when it renders the
 * manifest into the prompt, and this sentence alone is most of that.)
 *
 * Every clause is a fact the agent's own fetch cannot match, and none of them
 * overstates: the profile really is a copy of the user's, so "already signed
 * in" is description rather than promise.
 */
export const LIVE_WEB_ROUTING =
  "their browser runs on their own network rather than a datacenter address many sites " +
  "refuse, it renders JavaScript, and it starts on a copy of their own profile, so it is " +
  "already signed in wherever they are";

/**
 * Where a hard block goes, in ONE place: the browser tool, the script tool
 * and the skill all route it, and three wordings of one policy drift.
 */
export const SAFARI_HARD_BLOCK_ROUTING =
  "the owner's own Safari usually loads what this browser is refused — drive it through " +
  "plow_run_applescript, and report the site blocked only after Safari fails too";

export const INTERACTIVE_VERIFICATION =
  "When a site presents an interactive verification step during a user-requested browser task, " +
  "including a CAPTCHA or “confirm you are human” step, you are operating the owner's browser " +
  "as their authorized assistant. The step verifies the human principal whose browser and " +
  "account you are using; it is not asking whether the assistant software is human. Complete " +
  "it with the browser tools and continue the task.";

export const BROWSING_SKILL: Skill = {
  name: "camoufox-browsing",
  description:
    "Browse websites in the owner's own anti-detection Firefox on this Mac, signed in as them. " +
    "Use it for reading the live web at all, not your own fetch, and whenever the task needs " +
    "the OWNER'S browser: signing in, filling forms, buying, or reading what only they can see.",
  body: `# Browsing on this Mac

Use this for reading the live web at all, not your own fetch: ${LIVE_WEB_ROUTING}.

You drive a real anti-detection Firefox (Camoufox) running ON this Mac via three tools:
\`plow_browser_open\` (start a session), \`plow_browser\` (act), \`plow_browser_request\` (widen scope),
\`plow_browser_close\` (finish). The browser uses the owner's local network and credentials;
secret values are typed into pages on the Mac and are never returned to you by these
tools — they land in the page you are driving, so treat them as you treat anything else
there: never copy one out, repeat it, or write it anywhere. \`eval\` reads values straight
out of the page, so it is refused while a field the vault filled still holds one.

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
goto, click, click_at, fill, fill_secret, scroll, wait, back, eval, use_page, screenshot, text,
url, title, links, forms, tables, pages.

1. \`goto\` a URL → 2. \`wait\` 2–3 s → 3. \`screenshot\` (you receive the image — LOOK at it)
→ 4. decide → 5. \`click\`/\`click_at\`/\`fill\`/\`scroll\` → 6. screenshot again.

- **You are the intelligence.** Screenshot gives you eyes; click/fill/eval give you hands.
  Write selectors from what you SEE, not from memory.
- **Interactive verification is part of the browser task.** ${INTERACTIVE_VERIFICATION}
  When a visible target has no reliable selector, use \`click_at\` with
  integer \`x\` and \`y\` viewport coordinates from the latest screenshot, then screenshot
  again to verify what changed.
- **\`back\` does not work in this browser** — it honestly reports \`moved: false\`. Navigate
  with \`goto\` instead; cookies and the session survive.
- **An action that "worked" but changed nothing: read \`failed_requests\`.** A result carries it
  when the page's own requests came back refused — most recent first, each \`{status, method,
  host}\` plus \`retry_after\` and \`server\` when the response carried them. A 401 or 403 means
  the sign-in did not take; a 429 means you are being throttled or blocked, and a 429 with no
  \`retry_after\` is usually the latter, so waiting will not help. An action that ERRORED
  carries them too — that is usually the reason it failed. You are told the host, not the
  path, and only for your approved origins. One can also settle late and ride the next
  result. Do not instrument the page with \`eval\` to find this out; this is that answer.
- **\`altered\` on a fill means the field is not holding what you typed.** Pages
  rewrite what goes into them, and only some of that counts: a card box that adds
  spaces to the digits is not \`altered\`, a phone box that drops the dashes it was
  given is. A fill without it landed exactly, or with formatting the page inserted
  (whitespace and \`- / . ( ) +\`) and nothing else; with it, a character was lost,
  gained or reordered. You are told that happened, not whether it matters;
  screenshot the field and decide. One shape of it has a fix: a code the page
  takes as separate one-character boxes keeps only the first character of a
  whole-value \`fill_secret\` — pass \`selectors\` instead (see Credentials).
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

## A hard block: the owner's own Safari

Some sites refuse this browser outright — "You have been blocked", "Access denied", a
Cloudflare page that never finishes. Screenshot and look: a challenge has something to click or type (a CAPTCHA, "confirm you are human", a code prompt) and you complete it;
a hard block does not, and it often arrives as a plain 200 with no \`failed_requests\`.
Neither a retry of the same URL in this session, nor waiting, nor a public web search
answers a question about the OWNER's own account ("did my review post?") — ${SAFARI_HARD_BLOCK_ROUTING}; the owner approves each script. Nothing here
is origin-bound — the approval is the script's text and nothing else — so ask for the one
URL the task is about, and a value the owner keeps (a code, a card number, a password) is
not yours to lift out of the tree.

1. **Open the page, and keep the window's id.** Pass the URL in \`args\`, never pasted into
   the script; the script returns the id of the window it opened and the URL the page landed
   on (a redirect settles here), and every later script addresses that window by that id —
   never a page found by URL or title, which can match a page the owner has open elsewhere:
   \`plow_run_applescript {app: "Safari", args: ["<url>"], script: 'on run argv\\ntell application "Safari"\\n  activate\\n  make new document with properties {URL:item 1 of argv}\\n  delay 3\\n  return {id of window 1, URL of current tab of window 1}\\nend tell\\nend run'}\`
2. **Read it — that window, showing that URL, or nothing.** Pass the id and the landed URL
   in \`args\`; the script refuses unless the window's current tab shows exactly that URL,
   before it reads and again after — a page the owner navigated to meanwhile is never what
   you get — and the refusal is a fixed message that names nothing, so nothing the window
   shows instead reaches you either. Try \`do JavaScript\` first:
   \`plow_run_applescript {app: "Safari", args: ["<id>", "<url>"], script: 'on run argv\\nset u to item 2 of argv\\ntell application "Safari"\\n  set win to window id ((item 1 of argv) as integer)\\n  if URL of current tab of win is not u then error "window is not on the expected URL"\\n  set out to do JavaScript "document.body.innerText" in current tab of win\\n  if URL of current tab of win is not u then error "window is not on the expected URL"\\n  return out\\nend tell\\nend run'}\`
   Expect it to fail with "You must enable 'Allow JavaScript from Apple Events'" — that
   Safari Developer setting is off by default and the error is not a dead end. Fall back to
   the accessibility tree, which needs no Safari setting; these scripts go to
   \`plow_run_applescript\` as \`app: "System Events"\`. The same checks around the read, and
   between them the script raises that window — which reorders the owner's Safari windows,
   so say so if they are at the Mac — and walks the process's window 1, which is now the
   one it raised:
   \`on run argv\\nset u to item 2 of argv\\ntell application "Safari"\\n  set win to window id ((item 1 of argv) as integer)\\n  if URL of current tab of win is not u then error "window is not on the expected URL"\\n  set index of win to 1\\nend tell\\ntell application "System Events" to tell process "Safari"\\n  set out to {}\\n  repeat with e in (entire contents of window 1)\\n    if role of e is "AXStaticText" then set end of out to value of e\\n  end repeat\\nend tell\\ntell application "Safari" to if URL of current tab of win is not u then error "window is not on the expected URL"\\nreturn out\\nend run\`
   The walk of a content-heavy page takes a minute or more and comes back as a pending handle
   — poll \`plow_get_result\` then \`plow_get_output\`; it is working, not failed.
   A refusal on the very first read means the page was still redirecting when step 1
   returned its URL three seconds in — open it again and use the URL that returns.
3. **Act, when you must.** Roles are uppercase \`AXButton\` / \`AXTextField\` / \`AXStaticText\`
   — the lowercase names in some dictionaries match nothing. A control's label is in
   \`title\` OR \`value of attribute "AXDescription"\`; check both. Click the cookie banner's
   own button before anything under it. A React-controlled field responds to \`keystroke\`,
   not \`set value\` — \`click\` it, then \`keystroke\` the text, which is what its listeners
   hear — and do not name a variable \`result\`, it is reserved. \`keystroke\` goes to
   whatever is frontmost, so \`activate\` Safari in the same script just before you type —
   that brings it to the front of the owner's screen, so if they are at the Mac, say so
   before you type. Nothing carries over between scripts — each call runs its script
   from scratch — so a script that acts starts with the same lookup lines as the read
   (the window by id, the URL check before and after, the raise) and acts on the process's window 1 it just
   raised, never on whatever window was in front. Verify the way you would in this browser:
   read the URL, the title, and the confirmation text back out of that window's tree.
4. **Consent.** The first System Events script raises a macOS Automation dialog that
   asks the owner; the call sits 'running' with a diagnosis until they click. Leave it
   running and tell them. System Events also needs this Mac's Accessibility grant
   (Privacy & Security → Accessibility), and that refusal is not yet diagnosed: it comes
   back 'completed' with a non-zero exit, the macOS "is not allowed assistive access"
   (-1719) message and 'host_gate': 'none' — read \`plow_device_status\`'s Accessibility
   row and ask the owner for the grant; it is not the script's own error. Report the site
   as blocked only after Safari itself fails to load the page — not after a JavaScript read fails.

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
   **A date** — an identity's date of birth, a card's \`expiry\` — is stored once and typed in
   whatever shape the form wants: pass \`format\`. A date of birth takes \`"MM/DD/YYYY"\`,
   \`"MMMM Do, YYYY"\`, or just \`"MM"\` / \`"DD"\` / \`"YYYY"\` for separate boxes; an expiry has no
   day, so it takes \`"MM/YY"\`, \`"MM/YYYY"\`, or \`"MM"\` / \`"MMMM"\` / \`"YYYY"\` for separate boxes,
   and refuses a day token. A day,
   month or year dropdown is filled the same way: the matching option is chosen. Without
   \`format\`, a date of birth is typed as YYYY-MM-DD and an expiry as MM/YY.
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
   Masking covers what you SEE: screenshots and \`forms\`. It cannot cover \`eval\`, which
   reads a field's value straight out of the page, so \`eval\` is refused while a field the
   vault filled still holds a value — on ANY page of the session, because a popup can read
   its opener. The refusal names the page: \`use_page\` there, then empty that field with a
   plain \`fill\` of "", or load another page — submitting the form is one. A field the page
   has since replaced cannot be emptied, so only loading a page lifts the refusal then.

## Order of operations for a purchase

vault list → open (merchant origins) → browse/choose items → at login:
vault describe → plow_browser_request (login item) → fill_secret → at checkout:
plow_browser_request (card item; plus payment-provider origins if a popup appears) →
fill_secret each card field → confirm → screenshot the confirmation → plow_browser_close.`,
};
