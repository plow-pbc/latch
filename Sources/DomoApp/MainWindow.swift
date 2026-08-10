import AppKit
import DomoProtocol
import DomoDeviceCore

/// Creates a properly-configured scrollable text view. A bare `NSTextView()`
/// set as an `NSScrollView.documentView` never sizes its text container to the
/// clip view, so text is stored (and readable via Accessibility) but never
/// rendered — which looks like "clicking does nothing". `scrollableTextView()`
/// wires up the container tracking and autoresizing correctly.
func makeScrollableTextView(editable: Bool, monospaced: Bool) -> (NSScrollView, NSTextView) {
    let scroll = NSTextView.scrollableTextView()
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    scroll.translatesAutoresizingMaskIntoConstraints = false
    let tv = scroll.documentView as! NSTextView
    tv.isEditable = editable
    tv.isSelectable = true
    tv.isRichText = false
    tv.drawsBackground = true
    tv.backgroundColor = .textBackgroundColor
    tv.textColor = .textColor
    tv.font = monospaced ? .monospacedSystemFont(ofSize: 11, weight: .regular)
                         : .systemFont(ofSize: 13)
    tv.textContainerInset = NSSize(width: 4, height: 6)
    return (scroll, tv)
}

/// Main window: Goals (library + agent spin-up), Rules (always-allow rules),
/// Audit (the NDJSON log). All programmatic AppKit.
final class MainWindowController: NSWindowController {
    private unowned let app: AppDelegate

    init(app: AppDelegate) {
        self.app = app
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 580),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Domo"
        window.center()
        super.init(window: window)

        let tabView = NSTabView()
        tabView.translatesAutoresizingMaskIntoConstraints = false

        let goalsTab = NSTabViewItem(identifier: "goals")
        goalsTab.label = "Goals"
        goalsTab.view = GoalsView(app: app)
        tabView.addTabViewItem(goalsTab)

        let rulesTab = NSTabViewItem(identifier: "rules")
        rulesTab.label = "Rules"
        rulesTab.view = RulesView(app: app)
        tabView.addTabViewItem(rulesTab)

        let auditTab = NSTabViewItem(identifier: "audit")
        auditTab.label = "Audit"
        auditTab.view = AuditView(app: app)
        tabView.addTabViewItem(auditTab)

        // In-app status bar with all connection controls — so the app never
        // depends on the macOS menu bar.
        let statusBar = StatusBarView(app: app)
        let container = NSView()
        for v in [statusBar, tabView] { v.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(v) }
        NSLayoutConstraint.activate([
            statusBar.topAnchor.constraint(equalTo: container.topAnchor),
            statusBar.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            statusBar.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            statusBar.heightAnchor.constraint(equalToConstant: 44),
            tabView.topAnchor.constraint(equalTo: statusBar.bottomAnchor),
            tabView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            tabView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            tabView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        window.contentView = container
        self.statusBar = statusBar
        app.onStateChange = { [weak statusBar] in statusBar?.refresh() }
        statusBar.refresh()
    }

    private var statusBar: StatusBarView?

    required init?(coder: NSCoder) { fatalError("not supported") }
}

/// A persistent bar across the top of the window: connection status plus every
/// control (Connect / Pause-Resume / Revoke) so the menu bar is optional.
final class StatusBarView: NSView {
    private unowned let app: AppDelegate
    private let dot = NSView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private let connectButton = NSButton()
    private let pauseButton = NSButton()
    private let revokeButton = NSButton()

    init(app: AppDelegate) {
        self.app = app
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let divider = NSBox(); divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        addSubview(divider)

        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 5
        addSubview(dot)

        statusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        detailLabel.font = .systemFont(ofSize: 11)
        detailLabel.textColor = .secondaryLabelColor
        let labels = NSStackView(views: [statusLabel, detailLabel])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1
        labels.translatesAutoresizingMaskIntoConstraints = false
        addSubview(labels)

        connectButton.title = "Connect…"
        connectButton.bezelStyle = .rounded
        connectButton.target = app
        connectButton.action = #selector(AppDelegate.openOnboarding)

        pauseButton.bezelStyle = .rounded
        pauseButton.target = app
        pauseButton.action = #selector(AppDelegate.toggleLink)

        revokeButton.title = "Revoke access ▾"
        revokeButton.bezelStyle = .rounded
        revokeButton.target = self
        revokeButton.action = #selector(showRevokeMenu)

        let buttons = NSStackView(views: [connectButton, pauseButton, revokeButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        buttons.translatesAutoresizingMaskIntoConstraints = false
        addSubview(buttons)

        NSLayoutConstraint.activate([
            divider.leadingAnchor.constraint(equalTo: leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: bottomAnchor),
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 10),
            dot.heightAnchor.constraint(equalToConstant: 10),
            labels.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            labels.centerYAnchor.constraint(equalTo: centerYAnchor),
            buttons.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            buttons.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    /// Refresh from the app's current link state. Safe to call on the main thread.
    func refresh() {
        dot.layer?.backgroundColor = app.statusColor.cgColor
        statusLabel.stringValue = app.statusDescription
        let agents = app.agentsWithAccess()
        if app.isConnected {
            detailLabel.stringValue = agents.isEmpty ? "No agents have access"
                : "\(agents.count) agent\(agents.count == 1 ? "" : "s") with access"
        } else if let url = app.brokerURL {
            // Surfaces a stale/mismatched target instead of a silent spinner.
            detailLabel.stringValue = "→ \(url)"
        } else {
            detailLabel.stringValue = "Not set up"
        }
        // Always reachable: opens the connect panel to (re)point at a broker.
        connectButton.isHidden = false
        connectButton.title = app.isConfigured ? "Change broker…" : "Connect…"
        pauseButton.isHidden = !app.isConfigured
        pauseButton.title = app.isPaused ? "Resume" : "Pause"
        revokeButton.isHidden = !app.isConfigured
        revokeButton.isEnabled = !agents.isEmpty
    }

    @objc private func showRevokeMenu() {
        let menu = NSMenu()
        for id in app.agentsWithAccess() {
            let item = NSMenuItem(title: "Revoke \(id)", action: #selector(revokePicked(_:)), keyEquivalent: "")
            item.representedObject = id
            item.target = self
            menu.addItem(item)
        }
        if menu.items.isEmpty {
            let none = NSMenuItem(title: "No agents have access", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        let origin = NSPoint(x: 0, y: revokeButton.bounds.height + 4)
        menu.popUp(positioning: nil, at: origin, in: revokeButton)
    }

    @objc private func revokePicked(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        app.confirmRevoke(agentId: id)
        refresh()
    }
}

// MARK: - Goals

/// Selects on the first click even when the window isn't yet key. Without this,
/// NSTableView swallows the activating click (acceptsFirstMouse defaults to
/// false), so a click that both focuses the window and lands on a row selects
/// nothing — which reads to the user as "clicking goals does nothing".
final class ClickThroughTableView: NSTableView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class GoalsView: NSView, NSTableViewDataSource, NSTableViewDelegate {
    private unowned let app: AppDelegate
    private let table = ClickThroughTableView()
    private var goalText: NSTextView!
    private var output: NSTextView!
    private var goals: [Goal] = []

    init(app: AppDelegate) {
        self.app = app
        super.init(frame: .zero)
        buildUI()
        reload()
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    private func buildUI() {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("title"))
        column.title = "Goal"
        column.width = 200
        table.addTableColumn(column)
        table.dataSource = self
        table.delegate = self
        table.headerView = nil

        let tableScroll = NSScrollView()
        tableScroll.documentView = table
        tableScroll.hasVerticalScroller = true
        tableScroll.borderType = .bezelBorder

        let (goalScroll, gt) = makeScrollableTextView(editable: true, monospaced: false)
        goalText = gt
        let (outputScroll, ot) = makeScrollableTextView(editable: false, monospaced: true)
        output = ot

        let saveButton = NSButton(title: "Save as Goal", target: self, action: #selector(saveGoal))
        let startButton = NSButton(title: "Start Agent", target: self, action: #selector(startAgent))
        startButton.bezelColor = .controlAccentColor
        let deleteButton = NSButton(title: "Delete", target: self, action: #selector(deleteGoal))
        let buttons = NSStackView(views: [saveButton, deleteButton, startButton])
        buttons.orientation = .horizontal

        let right = NSStackView(views: [goalScroll, buttons, outputScroll])
        right.orientation = .vertical
        right.alignment = .leading
        goalScroll.heightAnchor.constraint(equalToConstant: 120).isActive = true

        let split = NSStackView(views: [tableScroll, right])
        split.orientation = .horizontal
        split.alignment = .top
        split.translatesAutoresizingMaskIntoConstraints = false
        tableScroll.widthAnchor.constraint(equalToConstant: 220).isActive = true
        addSubview(split)
        NSLayoutConstraint.activate([
            split.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            split.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            split.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            split.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
        ])
    }

    private func reload() {
        goals = app.goals?.all() ?? []
        table.reloadData()
        // Select the first goal on launch so the description is visible
        // immediately, rather than presenting an empty editor.
        if table.selectedRow < 0, !goals.isEmpty {
            table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { goals.count }

    func tableView(_ tableView: NSTableView, objectValueFor tableColumn: NSTableColumn?,
                   row: Int) -> Any? {
        goals[row].title + (goals[row].premade ? "  (premade)" : "")
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        let row = table.selectedRow
        guard row >= 0, row < goals.count else { return }
        goalText.string = goals[row].text
    }

    @objc private func saveGoal() {
        let text = goalText.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let title = String(text.prefix(40))
        app.goals?.add(Goal(title: title, text: text))
        reload()
    }

    @objc private func deleteGoal() {
        let row = table.selectedRow
        guard row >= 0, row < goals.count else { return }
        app.goals?.remove(id: goals[row].id)
        reload()
    }

    /// The full local loop: mint a pre-approved agent identity at the broker,
    /// write an ephemeral MCP config, and open a real Terminal window running an
    /// interactive Claude session seeded with the goal. The temp files clean
    /// themselves up when the Terminal session ends.
    @objc private func startAgent() {
        let goal = goalText.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty else {
            output.string = "Select a goal from the list, or type one above, before starting an agent.\n"
            return
        }
        guard let device = app.device else {
            output.string = "Not connected to a device yet — check that the broker started.\n"
            return
        }
        output.string = "Provisioning agent…\n"
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            do {
                let spawned = try device.requestSpawnAgent(goal: goal)
                guard let token = spawned["token"].str, let socket = spawned["socket"].str else {
                    throw RPCErrorText("broker returned incomplete spawn response")
                }
                let shim = spawned["mcp_command"].str ?? Bundle.main.executableURL!
                    .resolvingSymlinksInPath().deletingLastPathComponent()
                    .appendingPathComponent("domo-mcp").path
                let claude = try self.findClaude()

                // Per-session files under run/: the MCP config, the goal (passed
                // via file so no shell quoting of the goal is needed), and the
                // .command script Terminal will execute.
                let runDir = self.app.home.appendingPathComponent("run")
                try FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)
                let stamp = spawned["agent_id"].str ?? UUID().uuidString
                let cfgURL = runDir.appendingPathComponent("agent-\(stamp).mcp.json")
                let promptURL = runDir.appendingPathComponent("agent-\(stamp).prompt.txt")
                let cmdURL = runDir.appendingPathComponent("agent-\(stamp).command")

                // One connection string carries the broker URL, the pin (so a
                // wss broker works), and the token — no separate env vars.
                let agentConn = DomoConnection(url: socket, pin: self.app.connection?.pin,
                                               token: token, name: "Goal agent")
                let config: JSONValue = ["mcpServers": ["domo": [
                    "type": "stdio",
                    "command": .string(shim),
                    "env": ["DOMO_CONNECTION": .string(agentConn.compactString())],
                ]]]
                try config.encoded().write(to: cfgURL)
                try Data(Self.briefing(goal: goal, deviceId: device.identity.deviceId).utf8).write(to: promptURL)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cfgURL.path)

                // The script cleans up all three temp files (config carries the
                // token) when the session exits, and seeds claude with a briefing
                // that tells it to connect via the domo tools and run the goal.
                // Interactive session with the briefing PRE-FILLED — the user
                // presses Return to send it (interactive claude can't auto-submit
                // a prompt, so pre-fill is the closest option). The prompt MUST
                // come first: --mcp-config and --allowedTools are variadic and
                // would otherwise swallow a trailing positional prompt. cd to
                // $HOME so any folder-trust prompt is against an already-trusted dir.
                let q = GoalsView.shQuote
                let script = """
                #!/bin/bash
                CFG=\(q(cfgURL.path))
                PROMPTFILE=\(q(promptURL.path))
                SELF=\(q(cmdURL.path))
                trap 'rm -f "$CFG" "$PROMPTFILE" "$SELF"' EXIT
                PROMPT="$(cat "$PROMPTFILE")"
                cd "$HOME"
                \(q(claude)) "$PROMPT" --strict-mcp-config --mcp-config "$CFG" --allowedTools mcp__domo

                """
                try script.write(to: cmdURL, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cmdURL.path)

                if ProcessInfo.processInfo.environment["DOMO_AGENT_DRYRUN"] != nil {
                    // Test hook: write the launcher but don't open Terminal.
                    self.appendOutput("[dry-run] wrote launcher: \(cmdURL.path)\n")
                    return
                }
                let open = Process()
                open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                open.arguments = ["-a", "Terminal", cmdURL.path]
                try open.run()
                // Also hand over a ready ephemeral one-liner for running the agent
                // elsewhere (copied to the clipboard) — nothing persists in Claude.
                let ephemeralConfig: JSONValue = ["mcpServers": ["domo": [
                    "type": "stdio",
                    "command": .string(shim),
                    "env": ["DOMO_CONNECTION": .string(agentConn.compactString())],
                ]]]
                let oneLiner = "claude --strict-mcp-config --mcp-config '\(ephemeralConfig.jsonString())' --allowedTools mcp__domo"
                DispatchQueue.main.async {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(oneLiner, forType: .string)
                }
                self.appendOutput("Opened an interactive agent in Terminal.\nGoal: \(goal)\n\n"
                    + "The goal is pre-filled in Terminal — press Return there to start. "
                    + "Approval requests appear here in the app.\n\n"
                    + "To run this agent elsewhere instead (copied to your clipboard):\n"
                    + oneLiner + "\n")
            } catch {
                self.appendOutput("Failed: \(error)\n")
            }
        }
    }

    private struct RPCErrorText: Error, CustomStringConvertible {
        let message: String
        init(_ message: String) { self.message = message }
        var description: String { message }
    }

    /// Wrap a string in single quotes for safe embedding in a shell script.
    static func shQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// The prompt the Terminal agent is seeded with: operate the Mac through the
    /// domo tools on the specific, already-granted device, then carry out the
    /// goal — rather than sitting idle or using local tools.
    static func briefing(goal: String, deviceId: String) -> String {
        """
        You are a Domo remote agent running in a terminal. The "domo" MCP tools are \
        your ONLY way to act on the Mac — do not use local shell, file, or other \
        built-in tools. They run on the target Mac with the owner's approval and \
        sandboxing.

        You already have access to the Mac with device id "\(deviceId)". Do NOT call \
        request_device_access — access is already granted. (You may call list_devices \
        to confirm it is online, or list_device_tools to see extra capabilities, but \
        that is optional.)

        Do this now, without waiting for further input: carry out the goal below using \
        the domo tools with device "\(deviceId)" — run_command (pass the device id and \
        declare read_paths / write_paths for every path you touch), read_file, \
        write_file, or use_tool. The owner approves each operation on the Mac. When \
        done, briefly report what you did.

        Goal:
        \(goal)
        """
    }

    private func findClaude() throws -> String {
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: "/bin/zsh")
        probe.arguments = ["-lc", "command -v claude"]
        let pipe = Pipe()
        probe.standardOutput = pipe
        try probe.run()
        probe.waitUntilExit()
        let path = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !path.isEmpty else {
            throw RPCErrorText("Claude Code CLI not found — install it or add it to PATH")
        }
        return path
    }

    private func appendOutput(_ text: String) {
        DispatchQueue.main.async {
            self.output.textStorage?.append(NSAttributedString(
                string: text,
                attributes: [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                             .foregroundColor: NSColor.textColor]))
            self.output.scrollToEndOfDocument(nil)
        }
    }
}

// MARK: - Rules

final class RulesView: NSView {
    private unowned let app: AppDelegate
    private var text: NSTextView!

    init(app: AppDelegate) {
        self.app = app
        super.init(frame: .zero)
        let (scroll, tv) = makeScrollableTextView(editable: false, monospaced: true)
        text = tv
        let refresh = NSButton(title: "Refresh", target: self, action: #selector(reload))
        let clear = NSButton(title: "Revoke All Rules", target: self, action: #selector(clearRules))
        let buttons = NSStackView(views: [refresh, clear])
        buttons.orientation = .horizontal
        buttons.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        addSubview(buttons)
        NSLayoutConstraint.activate([
            buttons.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            buttons.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            scroll.topAnchor.constraint(equalTo: buttons.bottomAnchor, constant: 8),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
        ])
        reload()
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    @objc private func reload() {
        guard let policy = app.device?.policy else { return }
        let rules = policy.allRules()
        if rules.isEmpty {
            text.string = "No always-allow rules."
            return
        }
        text.string = rules.map { rule in
            "• \(rule.agentDisplay) [\(rule.agentId)]\n" +
                rule.capabilities.map { "    \($0.display)" }.joined(separator: "\n") +
                "\n    key: \(rule.ruleKey.prefix(16))…"
        }.joined(separator: "\n\n")
    }

    @objc private func clearRules() {
        app.device?.policy.removeAllRules()
        reload()
    }
}

// MARK: - Audit

/// Formatting + per-event descriptions shared by the audit table and detail pane.
private enum AuditFormat {
    private static let parser = ISO8601DateFormatter()
    private static let dayTimeFmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "MMM d  h:mm:ss a"; return f
    }()
    private static let clockFmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "h:mm:ss a"; return f
    }()

    static func dayTime(_ ts: String?) -> String {
        guard let ts, let d = parser.date(from: ts) else { return ts ?? "" }
        return dayTimeFmt.string(from: d)
    }
    static func clock(_ ts: String?) -> String {
        guard let ts, let d = parser.date(from: ts) else { return ts ?? "" }
        return clockFmt.string(from: d)
    }

    /// One-line human description of a single raw event (used in the timeline).
    static func describe(_ e: JSONValue) -> String {
        func argv() -> String { (e["argv"].arr ?? []).compactMap { $0.str }.joined(separator: " ") }
        switch e["event"].str ?? "" {
        case "device_started": return "Device started"
        case "access_request": return "Access requested — \(e["goals"].str ?? "")"
        case "access_decision": return (e["approved"].boolValue ?? false) ? "Access granted" : "Access denied"
        case "agent_spawned": return "Agent spawned — \(e["goal"].str ?? "")"
        case "intent_received": return "Request: \(e["request"].str ?? "")"
        case "intent_decision": return "Decision: \(e["decision"].str ?? "") (\(e["source"].str ?? "?"))"
        case "intent_rejected": return "Rejected: \(e["reason"].str ?? "")"
        case "exec_start": return "Run started: \(argv())"
        case "exec_end": return "Run finished (exit \(e["exit_code"].int ?? -1))"
        case "exec_error": return "Run error: \(e["error"].str ?? "")"
        case "file_read": return "File read: \(e["path"].str ?? "") (\(e["bytes"].int ?? 0) bytes)"
        case "file_write": return "File written: \(e["path"].str ?? "") (\(e["bytes"].int ?? 0) bytes)"
        case "denied_operation": return "Blocked: \(e["path"].str ?? "") — \(e["error"].str ?? "")"
        case "tool_invoked": return "Tool used: \(e["tool"].str ?? "")"
        case "tool_error": return "Tool error: \(e["tool"].str ?? "") — \(e["error"].str ?? "")"
        case let other: return other
        }
    }
}

/// A group of related audit events — one logical operation. Intent events are
/// grouped by intentId; an access request + its decision are paired; standalone
/// events (device_started, agent_spawned) are their own activity.
private struct AuditActivity {
    let id: String
    let events: [JSONValue]

    private func entry(_ event: String) -> JSONValue? { events.first { $0["event"].str == event } }
    private func has(_ event: String) -> Bool { events.contains { $0["event"].str == event } }
    private func value(_ event: String, _ key: String) -> String? { entry(event)?[key].str }

    var time: String { AuditFormat.dayTime(events.first?["ts"].str) }

    /// The one-line summary shown in the Activity column.
    var title: String {
        if let req = value("intent_received", "request") { return req }
        if has("access_request") || has("access_decision") {
            return "Access — \(value("access_request", "display") ?? "agent")"
        }
        if has("agent_spawned") { return "Agent spawned" }
        if has("device_started") { return "Device started" }
        return events.first?["event"].str ?? "Activity"
    }

    /// Combined status of the whole operation (decision + outcome), color-coded.
    var status: (text: String, color: NSColor) {
        if entry("intent_rejected") != nil { return ("Rejected", .systemRed) }
        if has("access_request") || has("access_decision") {
            if let d = entry("access_decision") {
                let ok = d["approved"].boolValue ?? false
                return (ok ? "Granted" : "Denied", ok ? .systemGreen : .systemRed)
            }
            return ("Pending", .secondaryLabelColor)
        }
        if has("device_started") { return ("Info", .secondaryLabelColor) }
        if has("agent_spawned") { return ("Spawned", .systemBlue) }
        if let dec = entry("intent_decision") {
            let d = dec["decision"].str ?? ""
            if d == "deny" { return ("Denied", .systemRed) }
            let base = d == "always_allow" ? "Always allowed" : "Allowed once"
            if entry("denied_operation") != nil { return ("\(base) · blocked", .systemRed) }
            if has("exec_error") || has("tool_error") { return ("\(base) · error", .systemRed) }
            if let ee = entry("exec_end") {
                let c = ee["exit_code"].int ?? -1
                return c == 0 ? ("\(base) · finished", .systemGreen)
                              : ("\(base) · failed (exit \(c))", .systemOrange)
            }
            if has("file_write") || has("file_read") || has("tool_invoked") {
                return ("\(base) · done", .systemGreen)
            }
            return (base, .systemGreen)
        }
        if entry("denied_operation") != nil { return ("Blocked", .systemRed) }
        return ("Pending", .secondaryLabelColor)
    }

    /// SF Symbol shown next to the activity title.
    var symbol: String {
        if has("device_started") { return "power" }
        if has("agent_spawned") { return "sparkles" }
        if has("access_request") || has("access_decision") { return "checkmark.shield" }
        let req = value("intent_received", "request") ?? ""
        if has("tool_invoked") || req.hasPrefix("use ") { return "wrench.and.screwdriver" }
        if req.hasPrefix("read file") || req.hasPrefix("write file")
            || has("file_read") || has("file_write") { return "doc.text" }
        return "terminal"
    }

    /// Coarse category for the filter control.
    var category: String {
        let t = status.text.lowercased()
        if t.contains("denied") || t.contains("rejected") { return "denied" }
        if t.contains("blocked") { return "blocked" }
        if t.contains("granted") || t.contains("allowed") || t.contains("finished")
            || t.contains("done") { return "approved" }
        return "other"
    }

    // Structured accessors for the detail pane.
    var command: String? {
        if let a = entry("exec_start")?["argv"].arr, !a.isEmpty {
            return a.compactMap { $0.str }.joined(separator: " ")
        }
        return value("intent_received", "request")
    }
    var agentId: String? {
        value("intent_received", "agent") ?? value("access_request", "agent")
            ?? value("access_decision", "agent") ?? value("agent_spawned", "agent")
    }
    var agentDisplay: String? { value("access_request", "display") }
    var goal: String? {
        value("intent_received", "goal") ?? value("access_request", "goals")
            ?? value("agent_spawned", "goal")
    }
    var intentId: String? { events.first?["intentId"].str }
    var exitCode: Int? { entry("exec_end")?["exit_code"].int }
    var capabilities: [String] {
        (entry("intent_received")?["capabilities"].arr ?? []).compactMap { $0.str }
    }

    enum StepState { case neutral, ok, bad }
    struct Step { let time: String; let text: String; let state: StepState }
    var timeline: [Step] {
        events.map { e in
            let ev = e["event"].str ?? ""
            let state: StepState
            switch ev {
            case "access_decision": state = (e["approved"].boolValue ?? false) ? .ok : .bad
            case "intent_decision": state = e["decision"].str == "deny" ? .bad : .ok
            case "exec_end": state = e["exit_code"].int == 0 ? .ok : .bad
            case "file_write", "file_read", "tool_invoked": state = .ok
            case "denied_operation", "intent_rejected", "exec_error", "tool_error": state = .bad
            default: state = .neutral
            }
            return Step(time: AuditFormat.clock(e["ts"].str), text: AuditFormat.describe(e), state: state)
        }
    }

    func matches(search q: String) -> Bool {
        guard !q.isEmpty else { return true }
        let hay = [title, command ?? "", agentDisplay ?? "", agentId ?? "", goal ?? ""]
            .joined(separator: " ").lowercased()
        return hay.contains(q)
    }
}

/// A soft, rounded status pill (colored dot + label) — the shadcn-style badge.
final class BadgeView: NSView {
    private let dot = NSView()
    private let label = NSTextField(labelWithString: "")
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 9
        layer?.borderWidth = 1
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        dot.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = .systemFont(ofSize: 11.5, weight: .semibold)
        label.lineBreakMode = .byTruncatingTail
        addSubview(dot); addSubview(label)
        setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6),
            dot.heightAnchor.constraint(equalToConstant: 6),
            label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: 20),
        ])
    }
    required init?(coder: NSCoder) { fatalError("not supported") }
    func configure(text: String, color: NSColor) {
        label.stringValue = text
        label.textColor = color
        dot.layer?.backgroundColor = color.cgColor
        layer?.backgroundColor = color.withAlphaComponent(0.13).cgColor
        layer?.borderColor = color.withAlphaComponent(0.30).cgColor
    }
}

private final class BadgeCellView: NSTableCellView {
    let badge = BadgeView()
    override init(frame: NSRect) {
        super.init(frame: frame)
        badge.translatesAutoresizingMaskIntoConstraints = false
        addSubview(badge)
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            badge.centerYAnchor.constraint(equalTo: centerYAnchor),
            badge.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -6),
        ])
    }
    required init?(coder: NSCoder) { fatalError("not supported") }
}

private final class IconTextCellView: NSTableCellView {
    let icon = NSImageView()
    let text = NSTextField(labelWithString: "")
    override init(frame: NSRect) {
        super.init(frame: frame)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.contentTintColor = .secondaryLabelColor
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        text.translatesAutoresizingMaskIntoConstraints = false
        text.font = .systemFont(ofSize: 12.5)
        text.lineBreakMode = .byTruncatingTail
        text.cell?.truncatesLastVisibleLine = true
        addSubview(icon); addSubview(text)
        textField = text
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 18),
            text.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 9),
            text.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            text.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError("not supported") }
}

/// Top-down flipped container for the scrollable detail pane.
private final class FlippedView: NSView { override var isFlipped: Bool { true } }

final class AuditView: NSView, NSTableViewDataSource, NSTableViewDelegate, NSSplitViewDelegate {
    private unowned let app: AppDelegate
    private let table = NSTableView()
    private let countLabel = NSTextField(labelWithString: "")
    private let searchField = NSSearchField()
    private let filter = NSSegmentedControl(labels: ["All", "Approved", "Denied", "Blocked"],
                                            trackingMode: .selectOne, target: nil, action: nil)
    private let split = NSSplitView()
    private let detailContent = FlippedView()
    private var all: [AuditActivity] = []
    private var shown: [AuditActivity] = []
    private var selectedId: String?
    private var didSetDivider = false
    private var observer: NSObjectProtocol?

    init(app: AppDelegate) {
        self.app = app
        super.init(frame: .zero)

        func column(_ id: String, _ title: String, width: CGFloat, min: CGFloat) -> NSTableColumn {
            let c = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            c.title = title; c.width = width; c.minWidth = min
            return c
        }
        table.addTableColumn(column("time", "Time", width: 128, min: 118))
        table.addTableColumn(column("status", "Status", width: 150, min: 120))
        table.addTableColumn(column("activity", "Activity", width: 300, min: 160))
        table.usesAlternatingRowBackgroundColors = true
        table.rowSizeStyle = .medium
        table.style = .inset
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.dataSource = self
        table.delegate = self

        let tableScroll = NSScrollView()
        tableScroll.documentView = table
        tableScroll.hasVerticalScroller = true
        tableScroll.borderType = .noBorder
        tableScroll.translatesAutoresizingMaskIntoConstraints = false

        // Detail pane: a scrollable flipped container we repopulate on selection.
        let detailScroll = NSScrollView()
        detailScroll.hasVerticalScroller = true
        detailScroll.drawsBackground = false
        detailScroll.translatesAutoresizingMaskIntoConstraints = false
        detailContent.translatesAutoresizingMaskIntoConstraints = false
        detailScroll.documentView = detailContent
        NSLayoutConstraint.activate([
            detailContent.topAnchor.constraint(equalTo: detailScroll.contentView.topAnchor),
            detailContent.leadingAnchor.constraint(equalTo: detailScroll.contentView.leadingAnchor),
            detailContent.trailingAnchor.constraint(equalTo: detailScroll.contentView.trailingAnchor),
        ])

        split.isVertical = true              // left table, right detail
        split.dividerStyle = .thin
        split.delegate = self
        split.translatesAutoresizingMaskIntoConstraints = false
        split.addArrangedSubview(tableScroll)
        split.addArrangedSubview(detailScroll)

        // Toolbar: search + filter, no Refresh (auto-refreshes on new audit data).
        searchField.placeholderString = "Search activity, path, agent…"
        searchField.target = self; searchField.action = #selector(filterChanged)
        searchField.translatesAutoresizingMaskIntoConstraints = false
        searchField.widthAnchor.constraint(equalToConstant: 240).isActive = true
        filter.selectedSegment = 0
        filter.target = self; filter.action = #selector(filterChanged)
        countLabel.textColor = .secondaryLabelColor
        countLabel.font = .systemFont(ofSize: 11.5)
        let toolbar = NSStackView(views: [searchField, filter, NSView(), countLabel])
        toolbar.orientation = .horizontal
        toolbar.spacing = 10
        toolbar.translatesAutoresizingMaskIntoConstraints = false

        addSubview(toolbar)
        addSubview(split)
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            toolbar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            toolbar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            split.topAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: 10),
            split.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            split.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            split.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
        ])

        observer = NotificationCenter.default.addObserver(
            forName: .domoAuditDidChange, object: nil, queue: .main) { [weak self] _ in
            self?.reload()
        }
        reload()
    }

    required init?(coder: NSCoder) { fatalError("not supported") }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    override func layout() {
        super.layout()
        if !didSetDivider, split.bounds.width > 200 {
            split.setPosition(split.bounds.width * 0.60, ofDividerAt: 0)
            didSetDivider = true
        }
    }
    func splitView(_ splitView: NSSplitView, constrainMinCoordinate proposedMin: CGFloat,
                   ofSubviewAt i: Int) -> CGFloat { 260 }
    func splitView(_ splitView: NSSplitView, constrainMaxCoordinate proposedMax: CGFloat,
                   ofSubviewAt i: Int) -> CGFloat { splitView.bounds.width - 300 }

    @objc private func filterChanged() { applyFilter() }

    /// Rebuild from the audit log, preserving the current selection and filter.
    @objc private func reload() {
        all = AuditView.group(app.device?.audit.entries() ?? []).reversed()  // newest first
        applyFilter()
    }

    private func applyFilter() {
        let q = searchField.stringValue.lowercased()
        let cat = filter.selectedSegment
        shown = all.filter { a in
            let okCat = cat == 0 || (cat == 1 && a.category == "approved")
                || (cat == 2 && a.category == "denied") || (cat == 3 && a.category == "blocked")
            return okCat && a.matches(search: q)
        }
        countLabel.stringValue = "\(shown.count) activit\(shown.count == 1 ? "y" : "ies")"
        table.reloadData()
        if let sel = selectedId, let idx = shown.firstIndex(where: { $0.id == sel }) {
            table.selectRowIndexes(IndexSet(integer: idx), byExtendingSelection: false)
        } else if !shown.isEmpty {
            table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        } else {
            selectedId = nil
            populateDetail(nil)
        }
    }

    /// Collapse raw events into activities: intent events by intentId, an access
    /// request paired with its decision, everything else standalone.
    private static func group(_ entries: [JSONValue]) -> [AuditActivity] {
        var order: [String] = []
        var map: [String: [JSONValue]] = [:]
        var pendingAccess: [String: String] = [:]
        var counter = 0
        func add(_ id: String, _ e: JSONValue) {
            if map[id] == nil { map[id] = []; order.append(id) }
            map[id]?.append(e)
        }
        for e in entries {
            let ev = e["event"].str ?? ""
            if let iid = e["intentId"].str {
                add("intent:\(iid)", e)
            } else if ev == "access_request" {
                counter += 1; let id = "access:\(counter)"
                add(id, e)
                if let ag = e["agent"].str { pendingAccess[ag] = id }
            } else if ev == "access_decision" {
                let ag = e["agent"].str ?? ""
                if let id = pendingAccess[ag] { add(id, e); pendingAccess[ag] = nil }
                else { counter += 1; add("access:\(counter)", e) }
            } else {
                counter += 1; add("\(ev):\(counter)", e)
            }
        }
        return order.map { AuditActivity(id: $0, events: map[$0] ?? []) }
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { shown.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let tableColumn else { return nil }
        let a = shown[row]
        switch tableColumn.identifier.rawValue {
        case "status":
            let cell = (tableView.makeView(withIdentifier: tableColumn.identifier, owner: self)
                as? BadgeCellView) ?? { let c = BadgeCellView(); c.identifier = tableColumn.identifier; return c }()
            cell.badge.configure(text: a.status.text, color: a.status.color)
            return cell
        case "activity":
            let cell = (tableView.makeView(withIdentifier: tableColumn.identifier, owner: self)
                as? IconTextCellView) ?? { let c = IconTextCellView(); c.identifier = tableColumn.identifier; return c }()
            cell.icon.image = NSImage(systemSymbolName: a.symbol, accessibilityDescription: nil)
            cell.text.stringValue = a.title
            cell.text.font = a.command != nil ? .monospacedSystemFont(ofSize: 12, weight: .regular)
                                              : .systemFont(ofSize: 12.5)
            cell.toolTip = a.title
            return cell
        default:
            let cell = (tableView.makeView(withIdentifier: tableColumn.identifier, owner: self)
                as? NSTableCellView) ?? AuditView.makeTextCell(tableColumn.identifier)
            cell.textField?.stringValue = a.time
            cell.textField?.textColor = .secondaryLabelColor
            cell.textField?.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .regular)
            return cell
        }
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        let r = table.selectedRow
        guard r >= 0, r < shown.count else { return }
        selectedId = shown[r].id
        populateDetail(shown[r])
    }

    private static func makeTextCell(_ id: NSUserInterfaceItemIdentifier) -> NSTableCellView {
        let cell = NSTableCellView()
        cell.identifier = id
        let tf = NSTextField(labelWithString: "")
        tf.translatesAutoresizingMaskIntoConstraints = false
        tf.lineBreakMode = .byTruncatingTail
        cell.addSubview(tf); cell.textField = tf
        NSLayoutConstraint.activate([
            tf.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            tf.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
            tf.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    // MARK: detail pane

    private func populateDetail(_ a: AuditActivity?) {
        detailContent.subviews.forEach { $0.removeFromSuperview() }
        guard let a else {
            let empty = NSTextField(labelWithString: "Select an activity")
            empty.textColor = .tertiaryLabelColor
            stack([empty])
            return
        }
        var rows: [NSView] = []
        let badge = BadgeView(); badge.configure(text: a.status.text, color: a.status.color)
        rows.append(leftAligned(badge))
        if let cmd = a.command { rows.append(commandBox(cmd)) }

        var meta: [(String, String)] = []
        if let id = a.agentId { meta.append(("Agent", (a.agentDisplay.map { "\($0)  " } ?? "") + id)) }
        if let g = a.goal, !g.isEmpty { meta.append(("Goal", g)) }
        if let iid = a.intentId { meta.append(("Intent", iid)) }
        if let ex = a.exitCode { meta.append(("Exit", "\(ex)")) }
        if !meta.isEmpty { rows.append(metaGrid(meta)) }

        if !a.capabilities.isEmpty {
            rows.append(sectionLabel("Approved capability bounds"))
            for c in a.capabilities { rows.append(leftAligned(chip(c))) }
        }
        rows.append(sectionLabel("Timeline"))
        for step in a.timeline { rows.append(timelineRow(step)) }
        stack(rows)
    }

    /// Lay a list of views top-to-bottom, full width, inside the detail container.
    private func stack(_ views: [NSView]) {
        var prev: NSLayoutYAxisAnchor = detailContent.topAnchor
        var gap: CGFloat = 14
        for v in views {
            v.translatesAutoresizingMaskIntoConstraints = false
            detailContent.addSubview(v)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: detailContent.leadingAnchor, constant: 16),
                v.trailingAnchor.constraint(equalTo: detailContent.trailingAnchor, constant: -16),
                v.topAnchor.constraint(equalTo: prev, constant: gap),
            ])
            prev = v.bottomAnchor
            gap = 8
        }
        views.last?.bottomAnchor.constraint(
            equalTo: detailContent.bottomAnchor, constant: -16).isActive = true
    }

    private func leftAligned(_ v: NSView) -> NSView {
        let c = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        c.addSubview(v)
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: c.leadingAnchor),
            v.topAnchor.constraint(equalTo: c.topAnchor),
            v.bottomAnchor.constraint(equalTo: c.bottomAnchor),
            v.trailingAnchor.constraint(lessThanOrEqualTo: c.trailingAnchor),
        ])
        return c
    }

    private func sectionLabel(_ s: String) -> NSTextField {
        let l = NSTextField(labelWithString: s.uppercased())
        l.font = .systemFont(ofSize: 10.5, weight: .semibold)
        l.textColor = .tertiaryLabelColor
        return l
    }

    private func commandBox(_ text: String) -> NSView {
        let box = NSView()
        box.wantsLayer = true
        box.layer?.cornerRadius = 8
        box.layer?.borderWidth = 1
        box.layer?.borderColor = NSColor.separatorColor.cgColor
        box.layer?.backgroundColor = NSColor.textBackgroundColor.withAlphaComponent(0.6).cgColor
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        l.textColor = .labelColor
        l.isSelectable = true
        l.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(l)
        NSLayoutConstraint.activate([
            l.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 10),
            l.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -10),
            l.topAnchor.constraint(equalTo: box.topAnchor, constant: 8),
            l.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -8),
        ])
        return box
    }

    private func metaGrid(_ rows: [(String, String)]) -> NSView {
        let grid = NSGridView()
        grid.rowSpacing = 6
        grid.columnSpacing = 14
        for (k, v) in rows {
            let key = NSTextField(labelWithString: k)
            key.font = .systemFont(ofSize: 12.5)
            key.textColor = .tertiaryLabelColor
            let val = NSTextField(labelWithString: v)
            val.font = .systemFont(ofSize: 12.5)
            val.lineBreakMode = .byTruncatingMiddle
            val.toolTip = v
            grid.addRow(with: [key, val])
        }
        grid.column(at: 0).xPlacement = .leading
        grid.rowAlignment = .firstBaseline
        return grid
    }

    private func chip(_ text: String) -> NSView {
        let box = NSView()
        box.wantsLayer = true
        box.layer?.cornerRadius = 6
        box.layer?.borderWidth = 1
        box.layer?.borderColor = NSColor.separatorColor.cgColor
        box.layer?.backgroundColor = NSColor.textBackgroundColor.withAlphaComponent(0.5).cgColor
        let l = NSTextField(labelWithString: text)
        l.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        l.textColor = .secondaryLabelColor
        l.lineBreakMode = .byTruncatingMiddle
        l.toolTip = text
        l.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(l)
        NSLayoutConstraint.activate([
            l.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 8),
            l.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -8),
            l.topAnchor.constraint(equalTo: box.topAnchor, constant: 3),
            l.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -3),
        ])
        return box
    }

    private func timelineRow(_ s: AuditActivity.Step) -> NSView {
        let row = NSView()
        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        let color: NSColor = s.state == .ok ? .systemGreen
            : (s.state == .bad ? .systemRed : .tertiaryLabelColor)
        dot.layer?.backgroundColor = color.cgColor
        let title = NSTextField(labelWithString: s.text)
        title.font = .systemFont(ofSize: 12.5)
        title.lineBreakMode = .byTruncatingTail
        title.toolTip = s.text
        let time = NSTextField(labelWithString: s.time)
        time.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        time.textColor = .tertiaryLabelColor
        [dot, title, time].forEach { $0.translatesAutoresizingMaskIntoConstraints = false; row.addSubview($0) }
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 2),
            dot.topAnchor.constraint(equalTo: row.topAnchor, constant: 4),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            title.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            title.topAnchor.constraint(equalTo: row.topAnchor),
            time.leadingAnchor.constraint(greaterThanOrEqualTo: title.trailingAnchor, constant: 8),
            time.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            time.firstBaselineAnchor.constraint(equalTo: title.firstBaselineAnchor),
            row.bottomAnchor.constraint(equalTo: title.bottomAnchor, constant: 6),
        ])
        return row
    }
}
