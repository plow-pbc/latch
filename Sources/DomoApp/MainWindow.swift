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
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 520),
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

        window.contentView = tabView
    }

    required init?(coder: NSCoder) { fatalError("not supported") }
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
    /// write an MCP config, and launch Claude Code headlessly with the goal.
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
                guard let token = spawned["token"].str,
                      let socket = spawned["socket"].str,
                      let shim = spawned["mcp_command"].str else {
                    throw RPCErrorText("broker returned incomplete spawn response")
                }
                let configURL = self.app.home.appendingPathComponent(
                    "run/agent-\(spawned["agent_id"].str ?? "x").mcp.json")
                let config: JSONValue = ["mcpServers": ["domo": [
                    "command": .string(shim),
                    "env": ["DOMO_AGENT_SOCKET": .string(socket),
                            "DOMO_AGENT_TOKEN": .string(token)],
                ]]]
                try config.encoded().write(to: configURL)

                let claude = try self.findClaude()
                self.appendOutput("Launching \(claude) …\n\n")
                let process = Process()
                // Invoke claude directly with an argument array — never via a
                // shell string — so paths containing spaces (the default home
                // is under "Application Support") are passed intact.
                process.executableURL = URL(fileURLWithPath: claude)
                process.arguments = ["-p", goal,
                                     "--mcp-config", configURL.path,
                                     "--allowedTools", "mcp__domo"]
                // Launched from a bundle, we inherit launchd's minimal PATH;
                // give claude a PATH that can find node and its own helpers.
                var env = ProcessInfo.processInfo.environment
                let extraPaths = ["/opt/homebrew/bin", "/usr/local/bin",
                                  NSHomeDirectory() + "/.local/bin", "/usr/bin", "/bin"]
                env["PATH"] = (extraPaths + [env["PATH"] ?? ""]).joined(separator: ":")
                process.environment = env
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe
                pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                    let chunk = handle.availableData
                    guard !chunk.isEmpty, let text = String(data: chunk, encoding: .utf8) else { return }
                    self?.appendOutput(text)
                }
                process.terminationHandler = { [weak self] proc in
                    pipe.fileHandleForReading.readabilityHandler = nil
                    self?.appendOutput("\n[agent exited: \(proc.terminationStatus)]\n")
                }
                try process.run()
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

final class AuditView: NSView {
    private unowned let app: AppDelegate
    private var text: NSTextView!

    init(app: AppDelegate) {
        self.app = app
        super.init(frame: .zero)
        let (scroll, tv) = makeScrollableTextView(editable: false, monospaced: true)
        text = tv
        let refresh = NSButton(title: "Refresh", target: self, action: #selector(reload))
        refresh.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        addSubview(refresh)
        NSLayoutConstraint.activate([
            refresh.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            refresh.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            scroll.topAnchor.constraint(equalTo: refresh.bottomAnchor, constant: 8),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
        ])
        reload()
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    @objc private func reload() {
        guard let audit = app.device?.audit else { return }
        let entries = audit.entries().suffix(500)
        text.string = entries.map { $0.jsonString() }.joined(separator: "\n")
        text.scrollToEndOfDocument(nil)
    }
}
