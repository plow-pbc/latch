import AppKit
import DomoProtocol
import DomoDeviceCore

/// Approval prompts as NSAlerts. Device handler threads block on the user's
/// answer (they run off the socket read loop, so the connection stays live).
/// Prompts are serialized so concurrent intents queue up rather than stack.
final class UIPolicy: PolicyDelegate {
    private let promptQueue = DispatchQueue(label: "domo.ui.prompts")

    func decideAccess(agentId: String, agentDisplay: String, goals: String,
                      completion: @escaping (Bool) -> Void) {
        promptQueue.async {
            let semaphore = DispatchSemaphore(value: 0)
            var approved = false
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "“\(agentDisplay)” wants to use this Mac"
                alert.informativeText = "Agent id: \(agentId)\n\nStated goals:\n\(goals)"
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Allow")
                alert.addButton(withTitle: "Deny")
                NSApp.activate(ignoringOtherApps: true)
                approved = alert.runModal() == .alertFirstButtonReturn
                semaphore.signal()
            }
            semaphore.wait()
            completion(approved)
        }
    }

    func decideIntent(_ intent: Intent, completion: @escaping (Decision) -> Void) {
        promptQueue.async {
            let semaphore = DispatchSemaphore(value: 0)
            var decision = Decision.deny
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "\(intent.agentDisplay): \(intent.request)"
                var details = ""
                if let goal = intent.goal, !goal.isEmpty {
                    details += "Goal: \(goal)\n"
                }
                if let plan = intent.planContext, !plan.isEmpty {
                    details += "Session: \(plan)\n"
                }
                details += "\nThis will allow exactly:\n"
                details += intent.capabilities.map { "  • \($0.display)" }.joined(separator: "\n")
                details += "\n\n“Always Allow” stores a rule for this exact capability set only."
                alert.informativeText = details
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Allow Once")
                alert.addButton(withTitle: "Always Allow")
                alert.addButton(withTitle: "Deny")
                NSApp.activate(ignoringOtherApps: true)
                switch alert.runModal() {
                case .alertFirstButtonReturn: decision = .allowOnce
                case .alertSecondButtonReturn: decision = .alwaysAllow
                default: decision = .deny
                }
                semaphore.signal()
            }
            semaphore.wait()
            completion(decision)
        }
    }
}
