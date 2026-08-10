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
  goalsList: () => ipcRenderer.invoke("goals:list"),
  goalsAdd: (title: string, text: string) => ipcRenderer.invoke("goals:add", title, text),
  goalsRemove: (id: string) => ipcRenderer.invoke("goals:remove", id),
  goalsStartAgent: (goal: string) => ipcRenderer.invoke("goals:startAgent", goal),
  goalsRestoreDefaults: () => ipcRenderer.invoke("goals:restoreDefaults"),
  rulesList: () => ipcRenderer.invoke("rules:list"),
  rulesRemove: (key: string) => ipcRenderer.invoke("rules:remove", key),
  agentsList: () => ipcRenderer.invoke("agents:list"),
  agentsRevoke: (agentId: string) => ipcRenderer.invoke("agents:revoke", agentId),
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSet: (brokerConnection: string) => ipcRenderer.invoke("settings:set", brokerConnection),
  statusGet: () => ipcRenderer.invoke("status:get"),
  onAuditChanged: (cb: () => void) => ipcRenderer.on("audit:changed", cb),
  onStatusChanged: (cb: () => void) => ipcRenderer.on("status:changed", cb),

  // Approval window.
  approvalGet: () => ipcRenderer.invoke("approval:get"),
  approvalDecide: (id: string, decision: string) =>
    ipcRenderer.send("approval:decide", id, decision),
});
