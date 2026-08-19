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
  goalsList: () => ipcRenderer.invoke("goals:list"),
  goalsAdd: (title: string, text: string) => ipcRenderer.invoke("goals:add", title, text),
  goalsRemove: (id: string) => ipcRenderer.invoke("goals:remove", id),
  goalsRestoreDefaults: () => ipcRenderer.invoke("goals:restoreDefaults"),
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
  apiKeyGet: () => ipcRenderer.invoke("settings:getApiKey"),
  apiKeySet: (key: string) => ipcRenderer.invoke("settings:setApiKey", key),
  // Availability booleans and the active model — never a credential.
  inferenceGet: () => ipcRenderer.invoke("settings:getInference"),
  inferenceSet: (provider: string) => ipcRenderer.invoke("settings:setInference", provider),
  statusGet: () => ipcRenderer.invoke("status:get"),
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
  // A client NAME, not a URL: main owns the table of what may be opened.
  connectOpenClient: (client: string) => ipcRenderer.invoke("connect:openClient", client),
  onConnectChanged: (cb: () => void) => ipcRenderer.on("connect:changed", cb),

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
