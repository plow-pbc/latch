import Foundation

/// The canonical locations for a Domo install on this machine — one definition
/// of "the standard broker", so the app, broker, device, and MCP shim all agree
/// on where things live without each hardcoding the path.
///
/// All of it honors `DOMO_HOME` (used by tests and alternate stacks); otherwise
/// it falls back to the standard macOS Application Support location.
public enum DomoPaths {
    /// The Domo home directory. `DOMO_HOME` wins; else `~/Library/Application Support/Domo`.
    public static var defaultHome: String {
        if let env = ProcessInfo.processInfo.environment["DOMO_HOME"], !env.isEmpty {
            return env
        }
        return NSHomeDirectory() + "/Library/Application Support/Domo"
    }

    /// Where agents (via the domo-mcp shim) connect.
    public static func agentSocket(home: String = defaultHome) -> String {
        home + "/run/agent.sock"
    }

    /// Where the device (Mac app / headless runner) connects.
    public static func deviceSocket(home: String = defaultHome) -> String {
        home + "/run/device.sock"
    }
}
