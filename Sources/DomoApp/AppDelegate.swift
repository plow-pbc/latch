import AppKit
import DomoProtocol
import DomoTransport
import DomoDeviceCore

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var mainWindowController: MainWindowController?
    private var onboardingController: OnboardingWindowController?
    private let policy = UIPolicy()
    private(set) var device: DeviceAgent?
    private(set) var goals: GoalsLibrary?

    /// Where this app stores its own state. The broker to connect to is resolved
    /// at launch (see `resolveStartup`): a connection string, a local socket, a
    /// saved connection, or — first run — the onboarding screen. The app never
    /// launches a broker.
    let home: URL

    /// The active network connection (nil for a local Unix socket). Read by the
    /// Goals view to bake the broker pin into a spawned agent's config.
    private(set) var connection: DomoConnection?
    private var networked = false             // true ⇒ ws(s):// with reconnect
    private lazy var knownBrokers = KnownBrokers(url: home.appendingPathComponent("device/known_brokers.json"))

    /// The broker to use when nothing else is configured — so the app connects on
    /// its own (trust-on-first-use), no manual step. Debug points at the local
    /// broker; release is set at ship time. Overridable with `--broker <url>`,
    /// `--connection`, `--broker-socket`, or a saved/pasted connection.
    static var buildDefault: DomoConnection? {
        #if DOMO_RELEASE
        return nil   // TODO: production broker, e.g. DomoConnection(url: "wss://broker.example/")
        #else
        return DomoConnection(url: "ws://127.0.0.1:8444/", name: "Local broker (debug)")
        #endif
    }

    private enum LinkState { case connecting, connected, reconnecting, disconnected, paused, unconfigured }
    private var linkState: LinkState = .unconfigured

    /// Set by the main window's in-app status bar to refresh when link state
    /// changes (so the app doesn't depend on the menu bar).
    var onStateChange: (() -> Void)?

    // Read by the in-app status bar.
    var statusDescription: String { statusText() }
    var isPaused: Bool { linkState == .paused }
    var isConnected: Bool { linkState == .connected }
    var isConfigured: Bool { device != nil }
    /// The broker this Mac is pointed at (shown while connecting so a stale or
    /// mismatched target is visible, not a silent "Connecting…" forever).
    var brokerURL: String? { connection?.url }
    func agentsWithAccess() -> [String] { device?.knownAgentIds() ?? [] }
    var statusColor: NSColor {
        switch linkState {
        case .connected: return .systemGreen
        case .connecting, .reconnecting: return .systemOrange
        case .paused: return .systemYellow
        case .disconnected: return .systemRed
        case .unconfigured: return .systemGray
        }
    }

    override init() {
        let args = AppDelegate.parseArgs(CommandLine.arguments)
        home = URL(fileURLWithPath: args["home"] ?? DomoPaths.defaultHome)
        super.init()
    }

    private static func parseArgs(_ argv: [String]) -> [String: String] {
        var result: [String: String] = [:]
        var i = 1
        while i < argv.count {
            if argv[i].hasPrefix("--"), i + 1 < argv.count, !argv[i + 1].hasPrefix("--") {
                result[String(argv[i].dropFirst(2))] = argv[i + 1]
                i += 2
            } else {
                i += 1
            }
        }
        return result
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setUpStatusItem()
        setUpMainMenu()
        goals = GoalsLibrary(url: home.appendingPathComponent("device/goals.json"))
        resolveStartup()

        let dumpArg = AppDelegate.parseArgs(CommandLine.arguments)["dump-ui"]
        if let dumpPath = dumpArg ?? ProcessInfo.processInfo.environment["DOMO_DUMP_UI"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                let window = NSApp.keyWindow ?? self?.onboardingController?.window
                    ?? self?.mainWindowController?.window
                guard let view = window?.contentView,
                      let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) {
                    try? data.write(to: URL(fileURLWithPath: dumpPath))
                }
            }
        }
    }

    // MARK: - Startup resolution

    private func resolveStartup() {
        let args = AppDelegate.parseArgs(CommandLine.arguments)
        let env = ProcessInfo.processInfo.environment

        // 1) An explicit connection string, or a bare --broker URL (arg or env).
        if let raw = args["connection"] ?? env["DOMO_CONNECTION"], let c = DomoConnection.parse(raw) {
            connectNetwork(c, persist: true); return
        }
        if let broker = args["broker"] ?? env["DOMO_BROKER"], let c = DomoConnection.parse(broker) {
            connectNetwork(c, persist: true); return
        }
        // 2) A local Unix socket (dev / `just app`).
        if let sock = args["broker-socket"] ?? env["DOMO_BROKER_SOCKET"] {
            connectUnix(sock); return
        }
        // 3) A previously-saved connection.
        if let saved = loadSavedConnection() {
            connectNetwork(saved.connection, persist: false, trustSelfSigned: saved.trustSelfSigned); return
        }
        // 4) The build default — connect on our own (trust-on-first-use). No
        // manual step in the common case.
        if let def = Self.buildDefault {
            connectNetwork(def, persist: false); return
        }
        // 5) No default (e.g. release before the broker URL is set) — ask.
        linkState = .unconfigured
        showMainWindow()
        showOnboarding()
    }

    /// Reopen the main window from the Dock when nothing is visible — so the app
    /// is reachable without the menu bar.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { showMainWindow() }
        return true
    }

    // MARK: - Connecting

    private func connectNetwork(_ c: DomoConnection, persist: Bool, trustSelfSigned: Bool = false) {
        guard let url = URL(string: c.url) else {
            presentError("Invalid broker address", c.url)
            showOnboarding()
            return
        }
        device?.pause()   // drop any existing link before repointing
        do {
            let device = try makeDevice()
            wire(device, networked: true)
            // Trust selection for wss:
            //  - explicit pin (from a pasted connection string) → pin it;
            //  - self-signed opt-in → trust-on-first-use;
            //  - otherwise → validate against the system CA store (Let's Encrypt).
            // Plain ws needs no cert trust.
            let trust: PeerTrustEvaluator?
            if let pin = c.pin {
                trust = SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: pin)])
            } else if c.isSecure && trustSelfSigned {
                trust = TOFUTrust(brokerURL: c.url, store: knownBrokers)
            } else {
                trust = nil
            }
            let dialer = WebSocketDialer(url: url, trust: trust)
            linkState = .connecting
            try device.connect(dialer: dialer, reconnect: true, authenticate: c.authenticate)
            self.device = device
            self.connection = c
            self.networked = true
            if persist { saveConnection(c, trustSelfSigned: trustSelfSigned) }
        } catch {
            // The reconnecting path shouldn't throw; this is belt-and-suspenders.
            linkState = .reconnecting
        }
        refreshUI()
        showMainWindow()
    }

    private func connectUnix(_ path: String) {
        device?.pause()
        do {
            let device = try makeDevice()
            wire(device, networked: false)
            linkState = .connecting
            try device.connect(brokerSocket: path)
            self.device = device
            self.networked = false
        } catch {
            linkState = .disconnected
            presentError("Domo could not reach the broker",
                         "No broker is listening at:\n\(path)\n\nStart it with `just broker`, then relaunch — or paste a connection string.")
        }
        refreshUI()
        showMainWindow()
    }

    private func makeDevice() throws -> DeviceAgent {
        try DeviceAgent(home: home, name: Host.current().localizedName ?? "Mac", delegate: policy)
    }

    private func wire(_ device: DeviceAgent, networked: Bool) {
        device.onConnected = { [weak self] in
            DispatchQueue.main.async { self?.linkState = .connected; self?.refreshUI() }
        }
        device.onLinkDown = { [weak self] in
            DispatchQueue.main.async {
                self?.linkState = networked ? .reconnecting : .disconnected
                self?.refreshUI()
            }
        }
        device.onConnectionClosed = { [weak self] in
            DispatchQueue.main.async { self?.linkState = .disconnected; self?.refreshUI() }
        }
    }

    // MARK: - Deep links (domo://connect?c=…)

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "domo" {
            if let c = DomoConnection.parse(url.absoluteString) {
                onboardingController?.close()
                connectNetwork(c, persist: true)
                return
            }
        }
    }

    // MARK: - Onboarding

    private func showOnboarding() {
        linkState = .unconfigured
        refreshStatusButton()
        let identity = try? DeviceIdentity.loadOrCreate(home: home,
                                                        defaultName: Host.current().localizedName ?? "Mac")
        let controller = OnboardingWindowController(
            deviceId: identity?.deviceId ?? "?",
            publicKey: identity?.keyPair.publicKeyBase64 ?? "",
            currentBrokerURL: connection?.url,
            onConnect: { [weak self] c, trustSelfSigned in
                self?.connectNetwork(c, persist: true, trustSelfSigned: trustSelfSigned)
                return nil
            },
            onPair: { [weak self] c, code in
                self?.submitPairing(c, code: code) ?? false
            },
            onDisconnect: connection == nil ? nil : { [weak self] in
                self?.disconnectAndForget()
            })
        onboardingController = controller
        controller.present()
    }

    /// Submit a pairing request for this Mac (blocking; called off the main
    /// thread by the onboarding window). Returns true if the broker ack'd.
    private func submitPairing(_ c: DomoConnection, code: String) -> Bool {
        guard let url = URL(string: c.url) else { return false }
        do {
            let device = try makeDevice()
            let trust = c.pin.map { SPKIPinningEvaluator(pins: [SPKIPin(sha256Base64: $0)]) }
            return try device.pair(dialer: WebSocketDialer(url: url, trust: trust), code: code)
        } catch {
            return false
        }
    }

    // MARK: - Persistence

    private var connectionFileURL: URL { home.appendingPathComponent("device/connection.json") }

    private func saveConnection(_ c: DomoConnection, trustSelfSigned: Bool) {
        let payload: [String: Any] = ["connection": c.compactString(), "tofu": trustSelfSigned]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? FileManager.default.createDirectory(at: connectionFileURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? data.write(to: connectionFileURL)
    }

    private func loadSavedConnection() -> (connection: DomoConnection, trustSelfSigned: Bool)? {
        guard let data = try? Data(contentsOf: connectionFileURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["connection"] as? String,
              let c = DomoConnection.parse(raw) else { return nil }
        return (c, obj["tofu"] as? Bool ?? false)
    }

    // MARK: - Menu bar

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
        refreshStatusButton()
    }

    /// Rebuild the status menu each time it opens so status, the pause/resume
    /// label, and the per-agent revoke list are always current.
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === statusItem?.menu else { return }
        menu.removeAllItems()

        let status = NSMenuItem(title: statusText(), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        menu.addItem(NSMenuItem(title: "Open Domo", action: #selector(openMainWindow), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ""))

        if device != nil {
            let revoke = NSMenuItem(title: "Revoke access", action: nil, keyEquivalent: "")
            let sub = NSMenu()
            let agents = device?.knownAgentIds() ?? []
            if agents.isEmpty {
                let none = NSMenuItem(title: "No agents have access", action: nil, keyEquivalent: "")
                none.isEnabled = false
                sub.addItem(none)
            } else {
                for id in agents {
                    let mi = NSMenuItem(title: "Revoke \(id)", action: #selector(revokeAgent(_:)), keyEquivalent: "")
                    mi.representedObject = id
                    mi.target = self
                    sub.addItem(mi)
                }
            }
            revoke.submenu = sub
            menu.addItem(revoke)
            menu.addItem(NSMenuItem(title: "Disconnect this Mac", action: #selector(disconnectAndForget), keyEquivalent: ""))
        }

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Domo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func statusText() -> String {
        switch linkState {
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting…"
        case .disconnected: return "Not connected"
        case .paused: return "Paused — no agent can reach this Mac"
        case .unconfigured: return "Not set up"
        }
    }

    private func refreshStatusButton() {
        guard let button = statusItem?.button else { return }
        let symbol: String
        switch linkState {
        case .connected: symbol = "shield.lefthalf.filled"
        case .paused: symbol = "pause.circle.fill"
        case .connecting, .reconnecting: symbol = "shield.lefthalf.filled.slash"
        default: symbol = "shield.slash"
        }
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Domo — \(statusText())")
        button.toolTip = "Domo — \(statusText())"
    }

    private func refreshUI() {
        refreshStatusButton()
        onStateChange?()
    }

    @objc private func revokeAgent(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        confirmRevoke(agentId: id)
    }

    /// Confirm-then-revoke, shared by the menu bar and the in-app status bar.
    func confirmRevoke(agentId: String) {
        guard let device else { return }
        let alert = NSAlert()
        alert.messageText = "Revoke access for this agent?"
        alert.informativeText = "Agent \(agentId) will lose access to this Mac immediately. Anything it has in flight is refused."
        alert.addButton(withTitle: "Revoke")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn {
            device.revokeAgent(agentId: agentId)
            refreshUI()
        }
    }

    @objc func openOnboarding() { showOnboarding() }
    @objc func openSettings() { showOnboarding() }

    /// Fully disconnect this Mac and forget the saved broker, returning to the
    /// connect panel. This is device-level (distinct from per-agent Revoke).
    @objc func disconnectAndForget() {
        device?.pause()
        device = nil
        connection = nil
        networked = false
        try? FileManager.default.removeItem(at: connectionFileURL)
        linkState = .unconfigured
        refreshUI()
        showOnboarding()
    }

    // MARK: - Main window / menu

    private func setUpMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit Domo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        NSApp.mainMenu = mainMenu
    }

    @objc private func openMainWindow() { showMainWindow() }

    private func showMainWindow() {
        if mainWindowController == nil {
            mainWindowController = MainWindowController(app: self)
        }
        NSApp.activate(ignoringOtherApps: true)
        mainWindowController?.showWindow(nil)
        mainWindowController?.window?.makeKeyAndOrderFront(nil)
    }

    private func presentError(_ title: String, _ info: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = info
        alert.runModal()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // stay resident in the menu bar
    }
}
