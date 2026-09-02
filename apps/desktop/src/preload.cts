/**
 * Preload — the ONLY bridge between the sandboxed renderer and the privileged
 * main process. It exposes a narrow, typed API over contextBridge; the
 * renderer has no direct access to Node, ipcRenderer, or the filesystem.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("domo", {
  // Main window data.
  auditList: () => ipcRenderer.invoke("audit:list"),
  auditActivities: () => ipcRenderer.invoke("audit:activities"),
  auditClear: () => ipcRenderer.invoke("audit:clear"),
  approvalsPending: () => ipcRenderer.invoke("approvals:pending"),
  rulesList: () => ipcRenderer.invoke("rules:list"),
  rulesRemove: (key: string) => ipcRenderer.invoke("rules:remove", key),
  uiGetTab: () => ipcRenderer.invoke("ui:getTab"),
  uiSetTab: (tab: string) => ipcRenderer.invoke("ui:setTab", tab),
  relayGet: () => ipcRenderer.invoke("settings:getRelay"),
  // Sign out. Also the "Sign out and re-activate" button on the chat-list
  // error: signing out IS re-activating, because main tears the window down
  // and opens setup in its place. One channel, because it is one behaviour —
  // a second name for it would be a second thing to keep in step.
  relaySignOut: () => ipcRenderer.invoke("settings:signOut"),
  onboardingOpen: () => ipcRenderer.invoke("onboarding:open"),
  approvalModeSet: (mode: string) => ipcRenderer.invoke("settings:setApprovalMode", mode),
  // The vault's own contents, edited here instead of on its web page.
  vaultItems: () => ipcRenderer.invoke("vault:items"),
  // The ids matching a search, decided in main so no secret comes here for it.
  vaultSearch: (query: string) => ipcRenderer.invoke("vault:search", query),
  vaultItem: (itemId: string) => ipcRenderer.invoke("vault:item", itemId),
  vaultReveal: (itemId: string, field: string) => ipcRenderer.invoke("vault:reveal", itemId, field),
  // The code the key produces — with `key` set, for one being typed.
  vaultTotp: (itemId: string | null, key?: string) => ipcRenderer.invoke("vault:totp", itemId, key),
  vaultSaveItem: (input: unknown) => ipcRenderer.invoke("vault:saveItem", input),
  vaultDeleteItem: (itemId: string) => ipcRenderer.invoke("vault:deleteItem", itemId),
  // Importing passwords. Inspect stages the parsed logins in MAIN and answers
  // with a secret-free preview; commit imports whatever is staged. The file
  // path never touches the renderer either — main runs the open dialog and
  // reads the file itself.
  vaultImportSources: () => ipcRenderer.invoke("vault:importSources"),
  vaultImportInspect: (text: string) => ipcRenderer.invoke("vault:importInspect", text),
  vaultImportFile: () => ipcRenderer.invoke("vault:importFile"),
  vaultImportCommit: (selected?: number[]) => ipcRenderer.invoke("vault:importCommit", selected),
  vaultImportCancel: () => ipcRenderer.invoke("vault:importCancel"),
  // What the owner says agents are for. The renderer's only route to the text
  // in either direction — it is device-owner data, so nothing else may write it.
  // The setter answers with what was stored, not what was sent.
  agentPurposeGet: () => ipcRenderer.invoke("settings:getAgentPurpose"),
  agentPurposeSet: (purpose: string) => ipcRenderer.invoke("settings:setAgentPurpose", purpose),
  // Availability booleans and the active model — never a credential.
  inferenceGet: () => ipcRenderer.invoke("settings:getInference"),
  statusGet: () => ipcRenderer.invoke("status:get"),
  // macOS permission ceilings (today just Full Disk Access). Read-only: the
  // grant itself happens in System Settings, via openExternal("fullDiskSettings").
  capabilitiesGet: () => ipcRenderer.invoke("capabilities:get"),
  // The Full Disk Access grant flow (permissionFlow.ts, ported from
  // PermissionFlow). dragInfo/dragStart serve the floating panel's drag tile:
  // dragInfo is display data only — name and icon; the drag payload never
  // crosses the bridge, main starts the native drag itself.
  fullDiskDragInfo: () => ipcRenderer.invoke("fullDisk:dragInfo"),
  fullDiskDragStart: () => ipcRenderer.send("fullDisk:dragStart"),
  // The panel's rasterized drag tile (a PNG data URL + backing scale): main
  // uses it as the drag image so the item under the cursor is exactly the
  // tile the panel shows. Display data only, like dragInfo — never a path.
  fullDiskTileImage: (dataUrl: string, scale: number) =>
    ipcRenderer.send("fullDisk:tileImage", dataUrl, scale),
  // The drag session ended (dropped or cancelled): the tile, hidden while its
  // image rode with the cursor, comes back.
  onFullDiskDragEnd: (cb: () => void) => ipcRenderer.on("fullDisk:dragEnd", cb),
  // Start the grant flow: main opens the pane and floats the drag panel next
  // to System Settings (fdaGrantFlow.ts owns the whole lifecycle).
  fullDiskGrantFlow: () => ipcRenderer.invoke("fullDisk:grantFlow"),
  // The floating panel's close button; main owns the panel's lifecycle.
  fullDiskDismiss: () => ipcRenderer.send("fullDisk:dismiss"),
  // Mid-gesture guard: while the pointer is down on the drag tile, the panel
  // must not hide on a frontmost flicker — hiding the drag source aborts the
  // drag. Main releases the hold itself when the drag session ends.
  fullDiskPanelHold: (on: boolean) => ipcRenderer.send("fullDisk:panelHold", on),
  // Launch at Login: one whole-state shape per read. macOS owns the bit
  // (System Settings can flip it behind the app's back), so every read
  // re-asks the OS, and set answers with what the OS then holds.
  launchGet: () => ipcRenderer.invoke("launch:get"),
  launchSet: (on: boolean) => ipcRenderer.invoke("launch:set", on),
  // Keep Mac Awake: the opt-in behind an AC-only sleep blocker (keepAwake.ts).
  // set answers with what actually took — an acquire the OS refuses reverts
  // to off, and the toggle shows that rather than a hold that isn't held.
  keepAwakeGet: () => ipcRenderer.invoke("power:getKeepAwake"),
  keepAwakeSet: (on: boolean) => ipcRenderer.invoke("power:setKeepAwake", on),
  // Usage statistics + error reporting opt-out (telemetry.ts).
  telemetryGet: () => ipcRenderer.invoke("telemetry:get"),
  telemetrySet: (on: boolean) => ipcRenderer.invoke("telemetry:set", on),
  onAuditChanged: (cb: () => void) => ipcRenderer.on("audit:changed", cb),
  onStatusChanged: (cb: () => void) => ipcRenderer.on("status:changed", cb),

  // Software updates: one whole-state shape per read (see updates:get).
  updatesGet: () => ipcRenderer.invoke("updates:get"),
  updatesCheck: () => ipcRenderer.invoke("updates:check"),
  updatesRestart: () => ipcRenderer.invoke("updates:restart"),
  updatesDismiss: () => ipcRenderer.invoke("updates:dismiss"),
  updatesSetAutoCheck: (on: boolean) => ipcRenderer.invoke("updates:setAutoCheck", on),
  updatesSetAutoInstall: (on: boolean) => ipcRenderer.invoke("updates:setAutoInstall", on),
  onUpdatesChanged: (cb: () => void) => ipcRenderer.on("updates:changed", cb),
  // The menu-bar "Check for Updates…" lands the window on the Settings tab.
  onShowSettings: (cb: () => void) => ipcRenderer.on("ui:showSettings", cb),
  // Main asks before it tears the window down; the renderer answers once the
  // owner has had their say about anything unsaved.
  onConfirmLeave: (cb: () => void) => ipcRenderer.on("ui:confirmLeave", cb),
  confirmLeaveReply: (ok: boolean) => ipcRenderer.send("ui:confirmLeaveReply", ok),

  // First-run setup window. Every call returns the whole state, so the screen
  // renders from one shape and never has to reconcile two.
  onboardingGet: () => ipcRenderer.invoke("onboarding:get"),
  onboardingBegin: () => ipcRenderer.invoke("onboarding:begin"),
  onboardingAdvance: () => ipcRenderer.invoke("onboarding:advance"),
  onboardingBack: () => ipcRenderer.invoke("onboarding:back"),
  onboardingSetTelemetry: (on: boolean) => ipcRenderer.invoke("onboarding:setTelemetry", on),
  // The renderer is sandboxed and cannot open a URL; main owns the `sms:` one,
  // so the renderer never has to build it or be trusted with it.
  onboardingOpenMessages: () => ipcRenderer.invoke("onboarding:openMessages"),
  onboardingOpenAgentMessages: () => ipcRenderer.invoke("onboarding:openAgentMessages"),
  onboardingNewCode: () => ipcRenderer.invoke("onboarding:newCode"),
  onboardingUsePhoneCode: () => ipcRenderer.invoke("onboarding:usePhoneCode"),
  onboardingUseActivation: () => ipcRenderer.invoke("onboarding:useActivation"),
  onboardingRequestCode: (phone: string) => ipcRenderer.invoke("onboarding:requestCode", phone),
  onboardingResendCode: () => ipcRenderer.invoke("onboarding:resendCode"),
  onboardingEditPhone: () => ipcRenderer.invoke("onboarding:editPhone"),
  onboardingSubmitCode: (code: string) => ipcRenderer.invoke("onboarding:submitCode", code),
  onboardingFinish: () => ipcRenderer.invoke("onboarding:finish"),
  onOnboardingChanged: (cb: () => void) => ipcRenderer.on("onboarding:changed", cb),

  // Connect a client (main window). Like the wizard, every call returns the
  // whole state so the screen renders from one shape. The minted credential
  // lives in that state for exactly as long as it is on screen.
  connectGet: () => ipcRenderer.invoke("connect:get"),
  connectCreate: (name: string) => ipcRenderer.invoke("connect:create", name),
  connectDismiss: () => ipcRenderer.invoke("connect:dismiss"),
  // Remove one roster row — a cloud agent, an MCP client or another session.
  // The renderer says WHICH row; main decides which call that row needs, because
  // getting it wrong leaves a live agent nobody can reach.
  rosterRemove: (id: number) => ipcRenderer.invoke("roster:remove", id),
  // Remove a cloud agent by its own id. For the agent whose credential row is
  // missing — an inactive credential on a still-running agent — where there is
  // no roster row to name and none is needed.
  cloudRemove: (agentId: string) => ipcRenderer.invoke("cloud:remove", agentId),
  cloudRefresh: () => ipcRenderer.invoke("cloud:refresh"),
  cloudCreate: (input: { name: string; provider: string; lineUid: string | null }) =>
    ipcRenderer.invoke("cloud:create", input),
  cloudCancelLineFlow: () => ipcRenderer.invoke("cloud:cancelLineFlow"),
  cloudRetryLineFlow: () => ipcRenderer.invoke("cloud:retryLineFlow"),
  cloudRetryFailed: (agentId: string) => ipcRenderer.invoke("cloud:retryFailed", agentId),
  cloudChangeLine: (input: { agentId: string; lineUid: string | null }) =>
    ipcRenderer.invoke("cloud:changeLine", input),
  cloudOpenMessages: (agentId?: string) => ipcRenderer.invoke("cloud:openMessages", agentId),
  onConnectChanged: (cb: () => void) => ipcRenderer.on("connect:changed", cb),

  // Any external destination the app links to. A key, never a URL: main
  // decides what may be opened.
  openExternal: (key: string) => ipcRenderer.invoke("external:open", key),

  // Live browser thumbnail (audit detail pane). One whole-state shape per
  // poll; no push channel — the renderer's own interval is the clock.
  viewerState: () => ipcRenderer.invoke("viewer:state"),

  // Approval window.
  approvalGet: () => ipcRenderer.invoke("approval:get"),
  // Announces that the suggestion listener below is installed. Main holds the
  // adversarial agent's say until this lands, so a review that finished before
  // the window did is still delivered.
  approvalReady: () => ipcRenderer.invoke("approval:ready"),
  approvalDecide: (id: string, decision: string) =>
    ipcRenderer.send("approval:decide", id, decision),
  onApprovalSuggestion: (
    cb: (data: { id: string; decision: string | null; reason: string }) => void,
  ) =>
    ipcRenderer.on("approval:suggestion", (_e, data) => cb(data)),
});
