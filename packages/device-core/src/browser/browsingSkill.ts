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
    "owner's local credentials (their password manager) without ever seeing the secret " +
    "values. Use for any task that requires visiting, reading, or acting on real websites: " +
    "finding information, comparing prices, filling forms, logging in, buying things.",
  body: `# Browsing on this Mac

You drive a real anti-detection Firefox (Camoufox) running ON this Mac via three tools:
\`browser_open\` (start a session), \`browser\` (act), \`browser_request\` (widen scope),
\`browser_close\` (finish). The browser uses the owner's local network and credentials;
secret values are typed into pages on the Mac and are NEVER shown to you.

## Sessions and scope

- \`browser_open {device, origins: ["dominos.com", "*.dominos.com"], credentials_metadata: true, goal}\`
  asks the owner to approve a browsing session bound to those site origins. List every
  domain you expect up front — the apex and the wildcard are separate entries.
- Every \`browser\` action is checked against the approved origins. If a click or popup
  lands outside them, page content locks: you can only \`url\`, \`pages\`, \`use_page\`, or
  \`goto\` back in scope. To follow the flow (e.g. a payment popup went to paypal.com),
  call \`browser_request {session, origins: ["paypal.com", "*.paypal.com"]}\` and continue
  after approval.
- Sessions idle out after 15 minutes. \`browser_close\` when done.

## Acting: always screenshot first

\`browser {device, session, action, ...}\` — actions:
goto, click, fill, fill_secret, scroll, wait, back, eval, use_page, screenshot, text,
url, title, links, forms, tables, pages, credentials, describe_item.

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

## Credentials (logins, cards) — values never reach you

1. Open the session with \`credentials_metadata: true\` (or add it later via browser_request).
2. On a login/checkout page: \`browser {action: "credentials"}\` lists the owner's
   password-manager items (1Password or Apple Passwords, whichever the owner uses) —
   titles, usernames, URLs, and whether each matches the current page. Metadata only.
3. Pick the right item by reading the page. \`describe_item\` shows its field LABELS
   (Apple Passwords logins always expose username/password/otp; \`otp\` fills the
   current one-time code on 2FA prompts).
4. Ask for fill rights: \`browser_request {session, credential_items: ["<item-id>"]}\` —
   the owner approves the named items.
5. \`browser {action: "fill_secret", selector: "#password", item: "<item-id>", field: "password"}\`
   types the value on the Mac. You get \`{ok: true}\` — never the value. Works for card
   number/expiry/CVC fields too (1Password only; cards may fill on any approved origin,
   logins only on their own site).
6. Non-secret fields (username, email you can see in metadata) use plain \`fill\`.

## Order of operations for a purchase

open (merchant origins + credentials_metadata) → browse/choose items → at login:
credentials → describe_item → browser_request (login item) → fill_secret → at checkout:
browser_request (card item; plus payment-provider origins if a popup appears) →
fill_secret each card field → confirm → screenshot the confirmation → browser_close.`,
};
