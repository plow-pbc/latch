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
  relaySignOut: () => ipcRenderer.invoke("settings:signOut"),
  onboardingOpen: () => ipcRenderer.invoke("onboarding:open"),
  approvalModeSet: (mode: string) => ipcRenderer.invoke("settings:setApprovalMode", mode),
  showSuggestionsGet: () => ipcRenderer.invoke("settings:getShowSuggestions"),
  showSuggestionsSet: (on: boolean) => ipcRenderer.invoke("settings:setShowSuggestions", on),
  // The vault's own contents, edited here instead of on its web page.
  vaultItems: () => ipcRenderer.invoke("vault:items"),
  vaultItem: (itemId: string) => ipcRenderer.invoke("vault:item", itemId),
  vaultReveal: (itemId: string, field: string) => ipcRenderer.invoke("vault:reveal", itemId, field),
  vaultSaveItem: (input: unknown) => ipcRenderer.invoke("vault:saveItem", input),
  vaultDeleteItem: (itemId: string) => ipcRenderer.invoke("vault:deleteItem", itemId),
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
  // Launch at Login: one whole-state shape per read. macOS owns the bit
  // (System Settings can flip it behind the app's back), so every read
  // re-asks the OS, and set answers with what the OS then holds.
  launchGet: () => ipcRenderer.invoke("launch:get"),
  launchSet: (on: boolean) => ipcRenderer.invoke("launch:set", on),
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
  // The renderer is sandboxed and cannot open a URL; main owns the `sms:` one,
  // so the renderer never has to build it or be trusted with it.
  onboardingOpenMessages: () => ipcRenderer.invoke("onboarding:openMessages"),
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
  onConnectChanged: (cb: () => void) => ipcRenderer.on("connect:changed", cb),

  // Cloud agents (same tab, same state shape, same change channel). Exactly
  // four calls, and none of them is a poll: provisioning is watched in the main
  // process, and the renderer just re-reads when told the state changed.
  // `cloudCreate` answers as soon as the row is on screen in `provisioning`.
  cloudCreate: (chatUid: string, name: string) =>
    ipcRenderer.invoke("cloud:create", chatUid, name),
  cloudDelete: (agentId: string) => ipcRenderer.invoke("cloud:delete", agentId),
  // Delete then re-create in the same chat; the replacement has a new agent id.
  cloudRetry: (agentId: string) => ipcRenderer.invoke("cloud:retry", agentId),
  // Local-only per-agent settings, keyed on the agent id. No restart, no server.
  cloudSettingsSet: (agentId: string, settings: { adversarialReview: boolean }) =>
    ipcRenderer.invoke("cloud:settingsSet", agentId, settings),
  // Apply changes: the whole settings panel in one call. Relay access and
  // inference go to Plow and restart the agent; adversarial review is local and
  // applies at once — and a save that touched only it makes no call at all.
  cloudApply: (
    agentId: string,
    controls: { relay: boolean; inference: boolean; adversarialReview: boolean },
  ) => ipcRenderer.invoke("cloud:apply", agentId, controls),

  // Any web page the app links to (client connector cards, Settings' Support
  // section). A KEY, not a URL: main owns the table of what may be opened.
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
