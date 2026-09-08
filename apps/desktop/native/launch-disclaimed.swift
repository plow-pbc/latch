// launch-disclaimed — run a program as its OWN TCC client.
//
// macOS attributes a process's privacy requests to the app that launched
// it (the "responsible process"), inherited through every child. A
// from-source `just app` is therefore attributed to the terminal it was
// typed into — Termic, iTerm, Terminal — and every consent dialog, usage
// string and grant is that terminal's, not Electron.app's. For Contacts and
// Calendars that is fatal: their request APIs are refused outright when the
// responsible app's bundle carries no usage string, and no terminal's does.
//
// This launcher does what LaunchServices does for an app opened from the
// Dock: it spawns the program with responsibility DISCLAIMED, so the child
// is responsible for itself. Electron.app then answers for itself — the
// patched dev bundle carries the usage strings (scripts/dev-usage-strings.mjs),
// the dialogs name "Electron", and the drag panel's target is Electron.app,
// which is now exactly right. Everything else is inherited as-is: the
// environment, the working directory, stdin/stdout/stderr (so `just app`
// still prints to the terminal), and the exit status. Ctrl-C reaches the
// child, since it shares the terminal's process group.
//
// `responsibility_spawnattrs_setdisclaim` is private SPI — the same one
// Terminal.app and Chromium's launcher use. Dev only: nothing ships it, and
// the packaged app is launched by LaunchServices, which does this itself.
// DOMO_SELF_RESPONSIBLE=1 is set for the child so main.ts knows not to ask
// which app it belongs to.
//
// Usage: launch-disclaimed <program> [args…]

import Darwin
import Foundation

@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let args = Array(CommandLine.arguments.dropFirst())
guard let program = args.first else {
    FileHandle.standardError.write("usage: launch-disclaimed <program> [args…]\n".data(using: .utf8)!)
    exit(2)
}

var attrs: posix_spawnattr_t? = nil
posix_spawnattr_init(&attrs)
defer { posix_spawnattr_destroy(&attrs) }
if responsibility_spawnattrs_setdisclaim(&attrs, 1) != 0 {
    FileHandle.standardError.write("launch-disclaimed: could not disclaim responsibility; running attributed to this shell's app\n".data(using: .utf8)!)
}

// argv and envp as C strings; the environment gains the marker.
var env = ProcessInfo.processInfo.environment
env["DOMO_SELF_RESPONSIBLE"] = "1"
let cArgs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
let cEnv: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]

var pid: pid_t = 0
let rc = posix_spawnp(&pid, program, nil, &attrs, cArgs, cEnv)
if rc != 0 {
    FileHandle.standardError.write("launch-disclaimed: \(program): \(String(cString: strerror(rc)))\n".data(using: .utf8)!)
    exit(127)
}

// Forward the signals a terminal sends, and mirror the child's end.
for sig in [SIGINT, SIGTERM, SIGHUP] { signal(sig, SIG_IGN) }
let source = DispatchSource.makeSignalSource(signal: SIGINT)
source.setEventHandler { kill(pid, SIGINT) }
source.resume()
let sourceTerm = DispatchSource.makeSignalSource(signal: SIGTERM)
sourceTerm.setEventHandler { kill(pid, SIGTERM) }
sourceTerm.resume()

var status: Int32 = 0
while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
if (status & 0x7f) != 0 { exit(128 + (status & 0x7f)) }
exit((status >> 8) & 0xff)
