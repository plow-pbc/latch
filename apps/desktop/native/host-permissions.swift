// host-permissions — answers, without prompting, what macOS has decided about
// this app's permissions where an API exists to ask.
//
// The one piece of the host-gate diagnosis (device-core's hostGate/) that
// Node cannot do: three TCC services are QUERYABLE — Automation (Apple
// events, per target app), Accessibility, and Screen Recording — but only
// through C APIs, and every one of them has a variant that raises the
// consent dialog. This helper calls the non-prompting variant only: a
// diagnosis of "the owner is not here to click" must never itself put a
// dialog on the screen nobody is looking at.
//
// TCC attributes a child process to the app that spawned it (the
// "responsible process" — see settings-window-frame.swift's --responsible),
// so every answer here is the app's answer, not the helper's. Full Disk
// Access and the folder gates have no query API at all and are probed by
// opening a file (device-core's hostGate/fullDiskAccess.ts); they are
// deliberately not here.
//
// Protocol: one JSON object on stdout, exit 0.
//   --automation <target>   {"status":"granted"|"denied"|"not_asked"|"target_not_running"}
//                           <target> is a bundle id ("com.apple.MobileSMS")
//                           or the app's name as it runs ("Messages"). The
//                           API can only decide for a RUNNING target, which
//                           is why the fourth answer exists.
//   --accessibility         {"status":"granted"|"denied"}
//   --screen-recording      {"status":"granted"|"denied"}
// Anything else: usage on stderr, exit 2.
//
// Compiled by scripts/build-native.mjs into dist/native/, shipped as an
// extraResource. No run loop, no NSApplication.

import AppKit
import CoreServices
import Foundation

func emit(_ status: String) -> Never {
    print("{\"status\":\"\(status)\"}")
    exit(0)
}

func usage() -> Never {
    FileHandle.standardError.write(
        "usage: host-permissions --automation <bundle-id|app name> | --accessibility | --screen-recording\n"
            .data(using: .utf8)!)
    exit(2)
}

/// The running application the target names. Bundle ids contain a dot; a
/// bare name is matched against what the app calls itself while running
/// (the name an AppleScript `tell application "Messages"` uses).
func runningTarget(_ target: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications
    if target.contains(".") {
        return apps.first { $0.bundleIdentifier == target }
    }
    let wanted = target.lowercased()
    return apps.first { app in
        if app.localizedName?.lowercased() == wanted { return true }
        // "Messages" is com.apple.MobileSMS; the executable name is the last
        // path component of the bundle and is the other name a person uses.
        if let url = app.bundleURL {
            return url.deletingPathExtension().lastPathComponent.lowercased() == wanted
        }
        return false
    }
}

let args = CommandLine.arguments.dropFirst()

if let flag = args.first, flag == "--automation" {
    guard args.count >= 2 else { usage() }
    let target = args[args.startIndex + 1]
    guard let app = runningTarget(target), let bundleId = app.bundleIdentifier else {
        emit("target_not_running")
    }
    // An address by bundle id — the same way osascript resolves a `tell` —
    // and a wildcard event class/id: the consent is per target app, not per
    // event. `askUserIfNeeded: false` is the whole point of this helper.
    var address = AEAddressDesc()
    let bytes = Array(bundleId.utf8)
    let made = bytes.withUnsafeBufferPointer { buffer -> OSErr in
        AECreateDesc(typeApplicationBundleID, buffer.baseAddress, buffer.count, &address)
    }
    guard made == noErr else { emit("target_not_running") }
    defer { AEDisposeDesc(&address) }
    let status = AEDeterminePermissionToAutomateTarget(&address, typeWildCard, typeWildCard, false)
    switch status {
    case noErr:
        emit("granted")
    case OSStatus(errAEEventNotPermitted):
        emit("denied")
    case OSStatus(errAEEventWouldRequireUserConsent):
        emit("not_asked")
    case OSStatus(procNotFound):
        emit("target_not_running")
    default:
        // Some other failure — say so rather than guess; the caller treats
        // any unlisted status as unknown.
        emit("unknown")
    }
}

if args.first == "--accessibility" {
    // The non-prompting check. AXIsProcessTrustedWithOptions with the prompt
    // key is what would raise the dialog, and is not used here.
    emit(AXIsProcessTrusted() ? "granted" : "denied")
}

if args.first == "--screen-recording" {
    // CGPreflightScreenCaptureAccess asks; CGRequestScreenCaptureAccess would
    // prompt. 10.15+, and the helper targets 13.
    emit(CGPreflightScreenCaptureAccess() ? "granted" : "denied")
}

usage()
