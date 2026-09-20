# Audit, Gatekeeper, and Denial Recovery Design

## Summary

Move Gatekeeper policy, stored rules, and Gatekeeper-denial recovery into the
Audit tab. Remove the Rules tab and remove the one-time denial override from the
product and policy engine.

The Audit tab gains a prominent Gatekeeper card above the existing activity
toolbar. The card shows a title-level status control, the owner-authored prompt,
and an entry point to a rules preview. Gatekeeper denials remain audit events;
selecting the denied row shows recovery in the existing right-hand detail pane.
A compact notice on other tabs links to that row in Audit.

## Product decisions

- Remove **Allow one retry** everywhere. A denied operation never gains a
  transient authorization path.
- Remove the **Rules** navigation tab. Gatekeeper settings live at the top of
  Audit, and stored always-allow rules open in a modal from that card.
- Keep **Suggest revised instructions**. It produces an editable full
  replacement and never changes policy until the owner saves it.
- A denial is not presented as an error. Amber identifies the denied row and
  its recovery panel as something worth reviewing; the global notice uses a
  neutral blue-gray treatment.
- Dismissing denial attention does not change Gatekeeper policy, authorize a
  retry, or delete the audit event.

## Audit layout

The existing Audit master-detail layout remains the owner of the activity
table, selection, filters, pagination, and right-side detail pane. A Gatekeeper
card is inserted above the existing Audit toolbar.

### Gatekeeper card

The header is:

- `Gatekeeper`
- a clickable `Enabled` status pill/dropdown immediately beside the title
- `View N rules` at the right

The dropdown contains four choices with a short consequence under each:

1. **Enabled** — AI Reviewer decides using the instructions.
2. **Ask every time** — the owner decides every request in an approval window.
3. **Approve everything** — every request runs without review.
4. **Deny everything** — every request is refused.

The selected option is checked. `Approve everything` uses the existing warning
treatment because it grants the broadest behavior; changing modes otherwise
uses the current settings persistence path and redraws from the stored value.

Below the header, a single sentence explains the current state. For Enabled it
reads: `AI Reviewer decides each request using your instructions.`

The owner-authored Gatekeeper prompt is always visible in a full-width textarea,
including when a different mode is selected. In non-Enabled modes, helper copy
states that the saved instructions will be used again when Gatekeeper is
Enabled. Keeping the editor visible makes the important policy inspectable
without implying that it currently participates in decisions.

The prompt autosaves after typing pauses. The status at the upper-right of the
field moves through:

- no decoration while idle before an edit;
- a spinner and `Saving…` during the write;
- a check and `Saved` after main returns the stored value;
- `Couldn’t save. Try again.` with a retry action on failure.

Autosave is debounced, serial: a write in flight is never raced by an older
draft, and a newer draft is saved immediately after the current write returns.
Navigating away does not silently discard a pending draft; tab navigation waits
for the pending save to settle, while a failed draft remains visible with its
error.

### Stored rules modal

`View N rules` opens a modal over Audit using the existing `rules:list` and
`rules:remove` paths. It lists the same agent and capability information as the
former Rules pane and retains per-rule **Revoke Rule** behavior and its failure
message. The modal has an empty state when no rules exist and updates in place
on `rules:changed`.

The modal is a preview/management surface, not a new tab. Closing it returns to
the same Audit selection and scroll position.

### Removed Rules tab

The Rules button and renderer route are removed. A persisted legacy `rules` tab
selection migrates to `audit`, as the existing retired-tab mappings do. Links,
notifications, and internal events that formerly selected Rules select Audit
instead.

## Denial attention and recovery

### Global notice

When the latest AI Reviewer denial needs attention, every non-Audit tab shows a
compact neutral notice at the top of its page content:

- `Gatekeeper denied a request`
- the denied request, truncated to one line
- `Review in Audit →`
- a dismiss `×`

The notice is renderer-level chrome rather than duplicated inside each tab
implementation. It updates immediately when a denial arrives or is dismissed.

`Review in Audit →`, a notification click, and the tray recovery action all:

1. select Audit;
2. select and reveal the matching audit activity;
3. focus its right-side recovery panel.

Audit does not show the global notice above the Gatekeeper card. The selected
amber row and recovery detail are its equivalent, avoiding two representations
of the same denial at the top of the page.

The notice `×` clears attention without changing the selected tab. A subsequent
new Gatekeeper denial creates new attention.

### Audit row and detail pane

A Gatekeeper-denied activity uses an amber row selection/accent. Amber means
`review available`, not `unsafe` or `failed`; the audit decision remains
`Denied` regardless of whether attention has been dismissed.

When the selected activity is the current actionable Gatekeeper denial, the
existing right-side detail pane adds an amber recovery card above the ordinary
command, metadata, capability bounds, and timeline:

- title: `Gatekeeper denied this request`
- dismiss `×` at the upper-right
- the reviewer reason, when present
- copy: `Revise Gatekeeper’s instructions if requests like this should be allowed.`
- primary action: **Suggest revised instructions**

There is no **Keep as-is** button. The `×` dismisses the recovery card and the
global notice together. The underlying audit row, detail, and Denied decision
remain.

Dismissal and a successful instruction update both resolve the current
attention. Dismissal is in-memory, matching the current latest-denial recovery
lifetime; it does not add an audit event because no policy or authorization
changed.

### Suggested-instructions modal

**Suggest revised instructions** opens a focused modal immediately. While the
existing coach request runs, the modal shows the denied request and a loading
state. On success it shows:

- the denied request and reviewer reason;
- current Gatekeeper instructions;
- the coach's editable full replacement;
- **Save instructions** and **Cancel**.

Saving uses the same owner-purpose setter as the main editor. Success updates
the Gatekeeper card, marks it Saved, closes the modal, and resolves denial
attention. Cancel changes nothing. A coach failure stays in the modal with its
safe existing error message and a retry action. A newer denial invalidates an
older in-flight suggestion exactly as today.

## One-time override removal

Delete the one-time retry mechanism rather than merely hiding its button:

- remove `DeniedIntentState` values `armed` and `consumed` and the `state`
  field from denial presentation;
- remove `oneTimeOverrides`, its fingerprinting helper, the arm/consume branch,
  the `owner_override` grant path, and override events from `PolicyEngine`;
- remove `mayGrantFromOwnerOverride` from `PolicyDelegate` and implementations;
- remove the `gatekeeperRecovery:allowOnce` IPC/preload API;
- remove desktop listeners and audit-copy paths used only by override arm or
  consumption;
- update notifications, device denial reasons, MCP server instructions, and
  documentation so they direct the owner only to review the denial or revise
  Gatekeeper instructions.

Historical audit parsing may continue to display an existing
`owner_override` source for backward compatibility, but no new grant can be
created with that source.

The policy engine may continue retaining the latest reviewer-denied intent in
memory because the revision coach needs the original bounded capabilities. It
retains no authorization state.

## State and events

`gatekeeperRecovery:get` continues to return the latest actionable denial, but
its view no longer contains override state. Add a dismiss IPC operation that
requires the current intent id and clears `gatekeeperAttention` only when it
still matches; this prevents an old `×` click from dismissing a newer denial.

`gatekeeperRecovery:changed` remains the single notification for the global
notice and selected Audit detail. Audit refreshes recovery presentation in
place without rebuilding the search box, table, or prompt editor.

The renderer owns pending autosave state. Main remains the authority for stored
mode and prompt values and returns what was actually persisted.

## Error and race handling

- Agent-, request-, reviewer-, and capability-derived text is inserted through
  `textContent`, never HTML.
- An old suggestion response cannot replace a modal opened for a newer denial.
- An old dismiss request cannot clear newer attention.
- A failed prompt autosave leaves the draft visible and does not claim Saved.
- A failed rule revoke leaves the rule visible.
- If the audit row for attention is unavailable after log clearing, Audit still
  opens and shows a non-destructive `This denied request is no longer in the
  audit log` state; the owner may dismiss it.
- If the coach cannot run because the account is signed out or out of credits,
  existing specific safe copy remains visible and policy is unchanged.

## Verification

Automated coverage must prove:

- the policy engine has no one-time override path and an unchanged retry is
  denied again;
- agent- and MCP-facing denial copy no longer promises a retry override;
- Rules is absent from navigation and a legacy saved Rules selection opens
  Audit;
- the Gatekeeper dropdown exposes and persists all four modes with their
  consequence copy;
- prompt autosave shows Saving, Saved, and failure states without stale writes;
- the rules modal lists, live-refreshes, and revokes rules;
- denial attention appears across non-Audit tabs, dismisses safely, and routes
  to the exact Audit row/detail;
- the Audit recovery panel keeps **Suggest revised instructions**, has no
  **Keep as-is** or retry action, and its `×` does not alter the audit record;
- saving a suggested replacement updates the main prompt and clears attention;
- a newer denial fences stale dismiss and suggestion responses.

Run the repository's canonical `just test` gate, the desktop preload/UI probe,
and the screenshot harness covering Audit, the global notice, the rules modal,
and the suggested-instructions modal. Inspect the rendered screenshots at the
supported window size for clipping, wrapping, focus, and master-detail spacing.
