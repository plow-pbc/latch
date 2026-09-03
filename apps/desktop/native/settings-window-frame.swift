// settings-window-frame — streams the System Settings window frame to stdout;
// with --responsible, instead prints the TCC-responsible app bundle and exits.
//
// The one piece of the PermissionFlow port (see src/permissionFlow.ts) that
// Node cannot do: reading another app's window geometry. Window BOUNDS come
// from the window server with no TCC permission at all — only names and
// contents are gated (behind Screen Recording) — so this needs no prompt,
// no entitlement, and no Accessibility trust. PermissionFlow's own tracker
// uses the same CGWindowList poll as its permissionless tier; its AX-observer
// tier is deliberately not ported, because that tier is the one that needs a
// permission, inside a flow whose whole point is fewer permission hurdles.
//
// Protocol: one JSON object per line, only when the frame or frontmost state
// changes —
//   {"x":..,"y":..,"width":..,"height":..,"front":..}
//       global top-left coordinates, in points, matching Electron's screen
//       space on macOS; "front" says whether System Settings is the frontmost
//       app — the panel only belongs on screen while it is.
//   {"gone":true}                            System Settings closed (or never
//                                            appeared); the helper then exits.
// The parent kills the process to stop tracking; SIGPIPE (parent died and the
// pipe closed) is left at its default action for the same effect.
//
// Compiled by scripts/build-native.mjs into dist/native/, shipped as an
// extraResource. Pure poll loop — no run loop, no NSApplication.

import AppKit
import CoreGraphics

let settingsBundleId = "com.apple.systempreferences"
let pollInterval = 1.0 / 15.0
// Lookup misses are routine while System Settings opens or swaps panes, so a
// single miss must not read as "closed" (PermissionFlow requires 12 too). A
// launch that never produces a window at all gets a longer grace: the deep
// link is racing app startup.
let missesWhileTracking = 12
let missesBeforeFirstWindow = 150

signal(SIGPIPE, SIG_DFL)

/// The process TCC will actually attribute a grant to. Private SPI, the very
/// one TCC keys on: a terminal-launched dev run is *responsible to the
/// terminal app*, so the drag target must be the terminal's bundle — dragging
/// Electron.app in would grant nothing the run can use. Responsibility is
/// inherited, so asking about this helper answers for the app that spawned it.
///
/// Asked first, trusted only when it names some OTHER process: on recent
/// macOS it answers the queried pid for every process — Electron's own GPU
/// helper included, which is certainly Electron's — so a "self" answer is
/// no answer, and the ancestry walk below decides instead.
@_silgen_name("responsibility_get_pid_responsible_for_pid")
func responsibility_get_pid_responsible_for_pid(_ pid: pid_t) -> pid_t

/// The parent of a process, from the kernel's process table; nil at launchd
/// or for a pid that is gone.
func parentPid(of pid: pid_t) -> pid_t? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
    let ppid = info.kp_eproc.e_ppid
    return ppid > 0 ? ppid : nil
}

/// The `.app` bundle an executable path sits inside — the SHALLOWEST one, so
/// a helper nested in a framework inside the app never names the framework.
func bundle(ofExecutable path: String) -> String? {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    guard let i = parts.dropLast().firstIndex(where: { $0.hasSuffix(".app") && $0 != ".app" }) else { return nil }
    return parts[...i].joined(separator: "/")
}

func executablePath(of pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    let n = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    return n > 0 ? String(cString: buffer) : nil
}

/// The app TCC attributes this helper's caller to.
///
/// Responsibility flows down from the app launchd started: a shell inside
/// Termic, iTerm or Terminal is that app's, and so is everything the shell
/// runs — `just app`'s Electron.app included. So the answer is the TOPMOST
/// `.app` ancestor of this process: the terminal for a from-source run, the
/// app itself for a packaged one launched from the Dock (its parent is
/// launchd, and it is its own topmost bundle).
func responsibleAppBundle() -> String? {
    let rpid = responsibility_get_pid_responsible_for_pid(getpid())
    if rpid > 0, rpid != getpid(), let path = executablePath(of: rpid), let app = bundle(ofExecutable: path) {
        return app
    }
    var topmost: String? = nil
    var pid: pid_t? = parentPid(of: getpid())
    var hops = 0
    while let p = pid, p > 1, hops < 64 {
        if let path = executablePath(of: p), let app = bundle(ofExecutable: path) { topmost = app }
        pid = parentPid(of: p)
        hops += 1
    }
    return topmost
}

// One-shot mode: print a file's Finder icon as base64 PNG and exit. Electron's
// app.getFileIcon hands back the generic app icon for bundles; NSWorkspace
// resolves the real one. 128px: 2x the panel's 32pt tile and the 56pt drag
// image, so both stay crisp on retina.
if let flag = CommandLine.arguments.firstIndex(of: "--icon"),
   CommandLine.arguments.count > flag + 1 {
    let icon = NSWorkspace.shared.icon(forFile: CommandLine.arguments[flag + 1])
    let side = 128
    guard
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ),
        let context = NSGraphicsContext(bitmapImageRep: rep)
    else { exit(1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    icon.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
    print(png.base64EncodedString())
    exit(0)
}

// One-shot mode: print the responsible app's bundle path and exit. The parent
// (main.ts) uses it to name the right drag target; a failure just means the
// caller falls back to the executable's own bundle.
if CommandLine.arguments.contains("--responsible") {
    if let app = responsibleAppBundle(), FileManager.default.fileExists(atPath: app + "/Contents/Info.plist") {
        print(app)
        exit(0)
    }
    exit(1)
}

// One-shot mode: wait for the left mouse button to come back up, print one
// line, exit. Electron's startDrag on macOS begins the drag session and
// returns immediately (beginDraggingSession under the hood), so the parent
// has no signal for when the session ends — the button state IS that signal.
// Read from the window server's combined session state: no event tap, no
// Accessibility trust, no prompt, same permissionless tier as the frame poll.
if CommandLine.arguments.contains("--drag-end") {
    while CGEventSource.buttonState(.combinedSessionState, button: .left) {
        Thread.sleep(forTimeInterval: 0.03)
    }
    print("{\"up\":true}") // exit flushes stdout; emit() is declared below us
    exit(0)
}

func settingsPid() -> pid_t? {
    // Prefer a UI-capable instance over prohibited activation-policy helpers.
    NSRunningApplication.runningApplications(withBundleIdentifier: settingsBundleId)
        .max(by: { ($0.activationPolicy == .prohibited ? 0 : 1) < ($1.activationPolicy == .prohibited ? 0 : 1) })?
        .processIdentifier
}

func onScreenWindows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
}

func settingsFrame(for pid: pid_t, in windows: [[String: Any]]) -> CGRect? {
    // The largest visible layer-0 window maps to the main document-sized
    // window; the size floor drops toasts and sheets.
    windows
        .filter { window in
            guard let owner = window[kCGWindowOwnerPID as String] as? pid_t, owner == pid else { return false }
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
            return layer == 0 && alpha > 0
        }
        .compactMap { window -> CGRect? in
            guard
                let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                let rect = CGRect(dictionaryRepresentation: bounds),
                rect.width > 320, rect.height > 240
            else { return nil }
            return rect
        }
        .max(by: { $0.width * $0.height < $1.width * $1.height })
}

/// Whether System Settings owns the frontmost NORMAL window. Decided from the
/// window list itself — it is ordered front to back — rather than
/// NSWorkspace.frontmostApplication, whose value only updates when a run loop
/// pumps AppKit's notifications, which this poll-loop process never does (it
/// froze at the launch-time answer; the panel then never hid). The floating
/// panel itself lives above layer 0, so it never counts, and the size floor
/// drops cursor-sized overlay windows some apps keep on screen.
func settingsIsFrontmost(_ pid: pid_t, in windows: [[String: Any]]) -> Bool {
    for window in windows {
        guard
            (window[kCGWindowLayer as String] as? Int ?? 0) == 0,
            (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
            let bounds = window[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds),
            rect.width >= 64, rect.height >= 64,
            let owner = window[kCGWindowOwnerPID as String] as? pid_t
        else { continue }
        return owner == pid
    }
    return false
}

func emit(_ line: String) {
    print(line)
    fflush(stdout)
}

var lastFrame: CGRect?
var lastFront: Bool?
var misses = 0

while true {
    let windows = onScreenWindows()
    if let pid = settingsPid(), let frame = settingsFrame(for: pid, in: windows) {
        misses = 0
        let front = settingsIsFrontmost(pid, in: windows)
        if frame != lastFrame || front != lastFront {
            lastFrame = frame
            lastFront = front
            emit(
                "{\"x\":\(Int(frame.minX)),\"y\":\(Int(frame.minY))," +
                "\"width\":\(Int(frame.width)),\"height\":\(Int(frame.height))," +
                "\"front\":\(front)}"
            )
        }
    } else {
        misses += 1
        if misses >= (lastFrame == nil ? missesBeforeFirstWindow : missesWhileTracking) {
            emit("{\"gone\":true}")
            exit(0)
        }
    }
    Thread.sleep(forTimeInterval: pollInterval)
}
