// Posts a genuine hardware-level mouse click at global screen coordinates.
// Usage: click <x> <y>
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count == 3, let x = Double(args[1]), let y = Double(args[2]) else {
    FileHandle.standardError.write(Data("usage: click <x> <y>\n".utf8))
    exit(2)
}
let pt = CGPoint(x: x, y: y)
let src = CGEventSource(stateID: .hidSystemState)
CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(80_000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(80_000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
