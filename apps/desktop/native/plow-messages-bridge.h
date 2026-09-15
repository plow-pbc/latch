// The one thing plow-messages cannot do in Swift.
//
// `NSUnarchiver` signals a malformed typedstream by RAISING an Objective-C
// exception, not by returning nil. Swift has no `@catch`, so an uncaught
// NSException unwinds past `main` and aborts the process — verified against
// this store's own blobs (2026-09-14): a truncated blob, a byte-flipped one
// and garbage behind a valid `streamtyped` header all terminate with
// "libc++abi: terminating due to uncaught exception of type NSException".
//
// That matters because a message body is attacker-supplied. Anyone who can
// text the owner can put bytes in `attributedBody`, so without this shim one
// crafted message would abort every `plow-messages` query that touches its
// row — search, thread and unreplied alike — permanently, and for the whole
// archive rather than the one bad message.
//
// A `static inline` function in a bridging header is compiled by the Swift
// ClangImporter into the same binary, which is what lets a single-source
// Swift CLI have an ObjC `@try` without a mixed-language build.

#import <Foundation/Foundation.h>

/// Decode a typedstream blob, or return nil if it is malformed IN ANY WAY —
/// including the ways that raise rather than return.
///
/// What this does NOT cover, stated rather than left implied: legacy
/// `NSUnarchiver` has no `requiresSecureCoding` and no class allowlist, so a
/// crafted blob can name a class and have its `initWithCoder:` run during a
/// decode that then "succeeds". The `@try` bounds the crash, not that. Two
/// things bound the rest, and neither is this file: the result is used only
/// when it casts to `NSAttributedString` or `NSString`, and the whole CLI runs
/// under `sandbox-exec` with the Messages store as its only read path. It is
/// the same decoder Messages.app runs over the same bytes, so this is a
/// platform-level residual we accept knowingly — not one nobody noticed.
static inline id PlowMessagesUnarchive(NSData *data) {
    @try {
        return [NSUnarchiver unarchiveObjectWithData:data];
    } @catch (NSException *exception) {
        // Swallowed deliberately, and nothing is logged: the exception's
        // reason string embeds bytes from the blob, which is untrusted
        // message content. The caller's answer for this row is "no decodable
        // body", exactly as for a blob that returns nil.
        return nil;
    }
}
