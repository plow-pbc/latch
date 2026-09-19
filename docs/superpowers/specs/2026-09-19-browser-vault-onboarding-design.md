# Browser Vault Onboarding Design

## Goal

Make the last setup screen explain the credential boundary visually: agents ask
for browser work above the Gatekeeper line, while Latch keeps the password below
that line and inserts it directly into the website. At the same time, make the
examples one canonical data set and start every installed plugin on during first
setup.

## Approved finish screen

Use the browser-cutaway direction selected during design review.

- Title: **Your agent asks. Plow signs in.**
- Subtitle: **Latch takes care of logging in, so your agent never sees your passwords.**
- Above a horizontal Gatekeeper beam, show a compact overlapping stack of the
  Claude, OpenAI, and Cursor marks followed by the selected real task prompt.
  Match the local treatment at <https://plow.co/build>: 25 px marks, later marks
  overlapping the prior mark by 6 px, with outlined circles for Claude/OpenAI
  and a black rounded-square Cursor tile. Copy the SVG paths into the sandboxed
  renderer; do not load remote assets.
- Put the `GATEKEEPER ✓` chip on the beam.
- Below the beam, put Browser Vault on the left and a large browser cutaway on
  the right. Connect Vault to the password field with one straight, one-way
  line. There is no credential path back above the beam.
- The browser names the selected site and shows a masked password plus
  `✓ Signed in`; it does not name the Amazon credit or claim the task itself is
  complete.
- Actions are only **Import passwords** and **Not now**. If Browser is off in an
  existing setup, the primary action remains **Enable Browser & import passwords**.
- Respect `prefers-reduced-motion`; the meaning cannot depend on animation.

## Canonical example registry

Create one typed registry that owns IDs, labels/prompts, icons, and representative
operations. The two fixed Gatekeeper decks and the password-screen candidates
refer to registry IDs.

### Personal Gatekeeper deck

1. Check the family calendar
2. Text Mary “Running late”
3. Sign in to Instacart with your password
4. Post your tax return publicly
5. Copy all your saved passwords

### Executive Gatekeeper deck

1. Find unread email from your team
2. Draft a reply to a customer
3. Find a free hour next week
4. Review a pull request on GitHub
5. Read your personal WhatsApp

### Real outcome prompts

1. Pay the mortgages on my rental properties.
2. Amazon overcharged me for a solar panel—can you get a refund?
3. Sign in to Kaiser and arrange a dermatology follow-up.
4. Reschedule my Hipcamp reservations.
5. Plan dinner with everyone: find a free night, send invitations, book around
   travel and parking constraints, update the invite, and remove only duplicate
   reservations.

The first four real outcomes are credential-fill candidates. Dinner remains in
the shared library but is not a password-screen candidate because its
representative operation does not require a saved credential.

## Example selection

When the Done screen is entered, main reads the saved agent purpose and tries the
credential-fill candidates in stable order: Amazon, mortgages, Kaiser, Hipcamp.
For each candidate it submits the registry's representative operation to the
same adversarial reviewer used by Gatekeeper preview, with `humanAvailable:
false`, empty history, and the same preview-only agent identity.

- Return the first `allow` as `{ id, prompt, site }`.
- Continue after an ordinary deny or ask verdict.
- Stop and return `null` on reviewer infrastructure failures such as no credits
  or unavailable service; repeated calls cannot repair those failures.
- Return `null` if every candidate is refused.
- The renderer treats `null` as a truthful generic state: it keeps the logo
  stack and security diagram but omits the prompt and site-specific brand.
- Selection is presentation only. It creates no audit record, stored rule,
  permission, or operation.

## Plugin defaults

Browser already exists as a first-class Plugins row. Preserve that implementation.
Remove onboarding's behavior that disables every plugin with unmet setup
requirements. A fresh settings file has no disabled plugin names, so every
staged plugin and Browser starts on; Access then walks the unmet grants. Preserve
explicit off choices already stored for an existing owner—"default on" must not
overwrite a prior choice during re-setup.

## Verification

- Unit-test the registry's exact 15 strings, deck membership, candidate order,
  and credential-fill filter.
- Unit-test reviewer selection: first allow wins, denied candidates are skipped,
  infrastructure failure returns `null`, and no allow returns `null`.
- Update renderer fixtures for the exact title, subtitle, selected prompt, site,
  two actions, and absence of the old four-card outcome grid and Text-agent action.
- Test that the onboarding state machine no longer invokes a plugin-disabling
  default hook.
- Run the repository's canonical `just test` gate.
- Run `just onboarding-screenshots` on the M4 per `docs/TESTING-THE-APP.md`, then
  inspect the Done screenshot for overlap, clipping, beam hierarchy, logo-stack
  fidelity, and both Browser-on and Browser-off actions.
