/**
 * The Swift shim behind receiving a credential exchange (Apple Passwords'
 * "Export to another app…", macOS 26+). ASCredentialImportManager and every
 * ASImportable* type are Swift-only API, so this is the one place they can be
 * called; the app loads this dylib through @domo/native-credential-import and
 * everything on the other side of the C seam below is TypeScript.
 *
 * Two exports, C ABI:
 *   domo_cx_supported() -> 1 when this OS has the API (macOS 26+), else 0
 *   domo_cx_import(token, ctx, done) -> redeems the import token the system
 *     handed the app and calls `done` exactly once, on an arbitrary thread,
 *     with EITHER the wire JSON OR an error message (never both).
 *
 * The wire JSON is OUR schema, version-stamped, frozen by
 * packages/device-core/test/credentialExchange.test.ts — deliberately NOT
 * JSONEncoder over Apple's types, whose encoding is Apple's to change. This
 * file is a dumb transcription: first basic-authentication credential, first
 * authenticator key, note text, and the NAMES of everything else so the owner
 * can be told what did not come across. Every mapping decision beyond that
 * lives in device-core's parseCredentialExchange, where vitest can reach it.
 *
 * Built by scripts/build-native.mjs with a macOS 13 target: the macOS-26
 * symbols weak-link behind the #available guards, so the dylib itself loads
 * fine on macOS 15 and answers "not supported" instead of crashing.
 *
 * The JSON holds the owner's passwords: it is handed to `done` and nowhere
 * else — never printed, never written, and no error string carries a value.
 */
import AuthenticationServices
import Foundation

// MARK: - Wire schema (version 1)

private struct WireTotp: Encodable {
  let secretBase64: String
  let period: Int
  let digits: Int
  let algorithm: String
  let issuer: String?
  let userName: String?
}

private struct WireItem: Encodable {
  let title: String
  let urls: [String]
  let username: String?
  let password: String?
  let totp: WireTotp?
  let notes: String?
  let unsupported: [String]
}

private struct WirePayload: Encodable {
  let version: Int
  let exporter: String
  let items: [WireItem]
}

private struct WireError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

// MARK: - C entry points

@_cdecl("domo_cx_supported")
public func domo_cx_supported() -> Int32 {
  if #available(macOS 26.0, *) { return 1 }
  return 0
}

@_cdecl("domo_cx_import")
public func domo_cx_import(
  _ token: UnsafePointer<CChar>,
  _ ctx: UnsafeMutableRawPointer?,
  _ done: @escaping @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?, UnsafePointer<CChar>?) -> Void
) {
  let tokenString = String(cString: token)
  guard #available(macOS 26.0, *) else {
    "receiving passwords this way needs macOS 26 or later".withCString { done(ctx, nil, $0) }
    return
  }
  guard let uuid = UUID(uuidString: tokenString) else {
    "the hand-off from the other app carried no readable import token".withCString { done(ctx, nil, $0) }
    return
  }
  Task {
    do {
      // The system's own consent/biometric UI runs inside this call; the
      // token was minted for this app when the owner picked it in Passwords.
      let data = try await ASCredentialImportManager().importCredentials(token: uuid)
      let json = try wireJson(data)
      json.withCString { done(ctx, $0, nil) }
    } catch {
      // A system error description — never a credential value.
      (error as NSError).localizedDescription.withCString { done(ctx, nil, $0) }
    }
  }
}

// MARK: - Transcription

@available(macOS 26.0, *)
private func wireJson(_ data: ASExportedCredentialData) throws -> String {
  var items: [WireItem] = []
  for account in data.accounts {
    for item in account.items {
      var username: String?
      var password: String?
      var totp: WireTotp?
      var notes: [String] = []
      var unsupported: [String] = []
      for credential in item.credentials {
        switch credential {
        case .basicAuthentication(let basic):
          // First one wins; a second is a shape no exporter writes today.
          if username == nil { username = basic.userName?.value }
          if password == nil { password = basic.password?.value }
        case .totp(let key):
          if totp == nil {
            totp = WireTotp(
              secretBase64: key.secret.base64EncodedString(),
              period: Int(key.period),
              digits: Int(key.digits),
              algorithm: key.algorithm.rawValue,
              issuer: key.issuer,
              userName: key.userName)
          }
        case .note(let note):
          notes.append(note.content.value)
        default:
          unsupported.append(caseName(of: credential))
        }
      }
      items.append(WireItem(
        title: item.title,
        urls: (item.scope?.urls ?? []).map { $0.absoluteString },
        username: username,
        password: password,
        totp: totp,
        notes: notes.isEmpty ? nil : notes.joined(separator: "\n\n"),
        unsupported: unsupported))
    }
  }
  let payload = WirePayload(version: 1, exporter: data.exporterDisplayName, items: items)
  guard let json = String(data: try JSONEncoder().encode(payload), encoding: .utf8) else {
    throw WireError(message: "the export could not be transcribed")
  }
  return json
}

/** "basicAuthentication(…)" -> "basicAuthentication" — the enum case's own
 * name as the wire name, so a credential type added in a future OS is still
 * reported by name rather than silently dropped. */
@available(macOS 26.0, *)
private func caseName(of credential: ASImportableCredential) -> String {
  let described = String(describing: credential)
  return String(described.prefix(while: { $0 != "(" }))
}
