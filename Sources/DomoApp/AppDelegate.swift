import AppKit
import DomoProtocol
import DomoTransport
import DomoDeviceCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var mainWindowController: MainWindowController?
    private let policy = UIPolicy()
    private(set) var device: DeviceAgent?
    private(set) var goals: GoalsLibrary?

    /// Where this app stores its own state (identity, goals, audit, rules) and
    /// which broker to connect to. Both come from launch args (`--home`,
    /// `--broker-socket`, e.g. from `just app`), then env, then defaults. The
    /// app connects to the broker but never launches one — the broker is a
    /// separate process (see justfile `app`/`broker` recipes).
    let home: URL
    let deviceSocketPath: String

    override init() {
        let args = AppDelegate.parseArgs(CommandLine.arguments)
        let env = ProcessInfo.processInfo.environment
        home = URL(fileURLWithPath: args["home"] ?? DomoPaths.defaultHome)
        deviceSocketPath = args["broker-socket"] ?? env["DOMO_BROKER_SOCKET"]
            ?? DomoPaths.deviceSocket(home: home.path)
        super.init()
    }

    /// Parse `--key value` pairs from argv, ignoring anything else (macOS may
    /// inject its own flags).
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
        do {
            // Connect to an already-running broker. We do NOT launch one — the
            // broker is a separate process (`just app` starts it and passes us
            // --broker-socket).
            let device = try DeviceAgent(home: home,
                                         name: Host.current().localizedName ?? "Mac",
                                         delegate: policy)
            try device.connect(brokerSocket: deviceSocketPath)
            self.device = device
        } catch {
            let alert = NSAlert()
            alert.messageText = "Domo could not reach the broker"
            alert.informativeText = """
                No broker is listening at:
                \(deviceSocketPath)

                Start Domo with `just app` (which launches the broker), or run a \
                broker yourself with `just broker`, then relaunch the app.
                """
            alert.runModal()
        }
        showMainWindow()

        // Debug: render the window's own view hierarchy to a PNG (no screen-
        // recording permission needed) so rendering can be verified headlessly.
        if let dumpPath = ProcessInfo.processInfo.environment["DOMO_DUMP_UI"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                guard let view = self?.mainWindowController?.window?.contentView,
                      let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) {
                    try? data.write(to: URL(fileURLWithPath: dumpPath))
                }
            }
        }
    }

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "shield.lefthalf.filled",
                                   accessibilityDescription: "Domo")
        }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Domo", action: #selector(openMainWindow),
                                keyEquivalent: "o"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Domo", action: #selector(NSApplication.terminate(_:)),
                                keyEquivalent: "q"))
        item.menu = menu
        statusItem = item
    }

    private func setUpMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit Domo", action: #selector(NSApplication.terminate(_:)),
                                   keyEquivalent: "q"))
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

    @objc private func openMainWindow() {
        showMainWindow()
    }

    private func showMainWindow() {
        if mainWindowController == nil {
            mainWindowController = MainWindowController(app: self)
        }
        NSApp.activate(ignoringOtherApps: true)
        mainWindowController?.showWindow(nil)
        mainWindowController?.window?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // stay resident in the menu bar
    }
    // Note: the app no longer owns the broker, so it does not stop one on quit.
    // The broker is managed separately (justfile `app`/`broker`/`app-down`).
}
