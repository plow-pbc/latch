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
  goalsStartAgent: (goal: string) => ipcRenderer.invoke("goals:startAgent", goal),
  goalsRestoreDefaults: () => ipcRenderer.invoke("goals:restoreDefaults"),
  rulesList: () => ipcRenderer.invoke("rules:list"),
  rulesRemove: (key: string) => ipcRenderer.invoke("rules:remove", key),
  agentsList: () => ipcRenderer.invoke("agents:list"),
  agentsRevoke: (agentId: string) => ipcRenderer.invoke("agents:revoke", agentId),
  uiGetTab: () => ipcRenderer.invoke("ui:getTab"),
  uiSetTab: (tab: string) => ipcRenderer.invoke("ui:setTab", tab),
  settingsGetBroker: () => ipcRenderer.invoke("settings:getBroker"),
  settingsSetBroker: (url: string, pin: string, mode: string) =>
    ipcRenderer.invoke("settings:setBroker", url, pin, mode),
  approvalModeGet: () => ipcRenderer.invoke("settings:getApprovalMode"),
  approvalModeSet: (mode: string) => ipcRenderer.invoke("settings:setApprovalMode", mode),
  showSuggestionsGet: () => ipcRenderer.invoke("settings:getShowSuggestions"),
  showSuggestionsSet: (on: boolean) => ipcRenderer.invoke("settings:setShowSuggestions", on),
  apiKeyGet: () => ipcRenderer.invoke("settings:getApiKey"),
  apiKeySet: (key: string) => ipcRenderer.invoke("settings:setApiKey", key),
  reviewerInfoGet: () => ipcRenderer.invoke("settings:getReviewerInfo"),
  statusGet: () => ipcRenderer.invoke("status:get"),
  onAuditChanged: (cb: () => void) => ipcRenderer.on("audit:changed", cb),
  onStatusChanged: (cb: () => void) => ipcRenderer.on("status:changed", cb),

  // Approval window.
  approvalGet: () => ipcRenderer.invoke("approval:get"),
  approvalDecide: (id: string, decision: string) =>
    ipcRenderer.send("approval:decide", id, decision),
  onApprovalSuggestion: (cb: (data: { id: string; decision: string | null }) => void) =>
    ipcRenderer.on("approval:suggestion", (_e, data) => cb(data)),
});
