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
  approvalModeGet: () => ipcRenderer.invoke("settings:getApprovalMode"),
  approvalModeSet: (mode: string) => ipcRenderer.invoke("settings:setApprovalMode", mode),
  showSuggestionsGet: () => ipcRenderer.invoke("settings:getShowSuggestions"),
  showSuggestionsSet: (on: boolean) => ipcRenderer.invoke("settings:setShowSuggestions", on),
  vaultGet: () => ipcRenderer.invoke("vault:get"),
  vaultSet: (email: string, password: string) => ipcRenderer.invoke("vault:set", email, password),
  vaultOpen: () => ipcRenderer.invoke("vault:open"),
  apiKeyGet: () => ipcRenderer.invoke("settings:getApiKey"),
  apiKeySet: (key: string) => ipcRenderer.invoke("settings:setApiKey", key),
  reviewerInfoGet: () => ipcRenderer.invoke("settings:getReviewerInfo"),
  statusGet: () => ipcRenderer.invoke("status:get"),
  onAuditChanged: (cb: () => void) => ipcRenderer.on("audit:changed", cb),
  onStatusChanged: (cb: () => void) => ipcRenderer.on("status:changed", cb),

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
  onboardingCreateAgent: (name: string) => ipcRenderer.invoke("onboarding:createAgent", name),
  onboardingDismissAgent: () => ipcRenderer.invoke("onboarding:dismissAgent"),
  onboardingFinish: () => ipcRenderer.invoke("onboarding:finish"),
  onOnboardingChanged: (cb: () => void) => ipcRenderer.on("onboarding:changed", cb),

  // Approval window.
  approvalGet: () => ipcRenderer.invoke("approval:get"),
  approvalDecide: (id: string, decision: string) =>
    ipcRenderer.send("approval:decide", id, decision),
  onApprovalSuggestion: (cb: (data: { id: string; decision: string | null }) => void) =>
    ipcRenderer.on("approval:suggestion", (_e, data) => cb(data)),
});
