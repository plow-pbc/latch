import Foundation
import Security

/// Generates throwaway self-signed certificates with the system `openssl` for
/// the pinning tests. Self-signed is the intended production posture (runbook
/// Phase 2) — no public CA — so the tests must exercise a cert the code pins,
/// not one the system already trusts.
enum TestCerts {
    struct Generated {
        let dir: URL
        let certDER: Data
        let p12: Data
        let opensslPin: String   // canonical SPKI pin, computed by openssl
    }

    /// Generate a fresh EC P-256 self-signed cert. Each call uses a new key, so
    /// two invocations produce two distinct pins (the reject-path needs that).
    static func generate(cn: String = "domo-broker", p12Password: String = "domo") throws -> Generated {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("domo-cert-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let key = dir.appendingPathComponent("key.pem")
        let cert = dir.appendingPathComponent("cert.pem")
        let certDERURL = dir.appendingPathComponent("cert.der")
        let p12 = dir.appendingPathComponent("id.p12")

        try run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key.path])
        try run(["req", "-x509", "-new", "-key", key.path, "-out", cert.path,
                 "-days", "3650", "-subj", "/CN=\(cn)", "-sha256"])
        try run(["x509", "-in", cert.path, "-outform", "der", "-out", certDERURL.path])
        try run(["pkcs12", "-export", "-inkey", key.path, "-in", cert.path,
                 "-out", p12.path, "-passout", "pass:\(p12Password)", "-name", "domo"])

        // Canonical SPKI pin via the documented OpenSSL pipeline.
        let pin = try pipeline(cert: cert)

        return Generated(dir: dir,
                         certDER: try Data(contentsOf: certDERURL),
                         p12: try Data(contentsOf: p12),
                         opensslPin: pin)
    }

    /// Load a `SecIdentity` from a generated p12. Returns nil if import fails
    /// (e.g. a locked/None keychain in a headless run) so tests can skip the
    /// live-handshake variant instead of hanging.
    static func loadIdentity(p12: Data, password: String = "domo") -> SecIdentity? {
        var items: CFArray?
        let options = [kSecImportExportPassphrase as String: password] as CFDictionary
        let status = SecPKCS12Import(p12 as CFData, options, &items)
        guard status == errSecSuccess,
              let array = items as? [[String: Any]],
              let first = array.first,
              let identityAny = first[kSecImportItemIdentity as String] else { return nil }
        return (identityAny as! SecIdentity)
    }

    static func cleanup(_ g: Generated) { try? FileManager.default.removeItem(at: g.dir) }

    // MARK: - openssl plumbing

    @discardableResult
    private static func run(_ args: [String]) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["openssl"] + args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "TestCerts", code: Int(process.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: "openssl \(args.first ?? "") failed"])
        }
        return data
    }

    /// `openssl x509 -pubkey | openssl pkey -pubin -outform der | dgst -sha256 -binary | base64`
    private static func pipeline(cert: URL) throws -> String {
        let pub = try run(["x509", "-in", cert.path, "-pubkey", "-noout"])
        let der = try runPiped(["pkey", "-pubin", "-outform", "der"], input: pub)
        let digest = try runPiped(["dgst", "-sha256", "-binary"], input: der)
        return digest.base64EncodedString()
    }

    private static func runPiped(_ args: [String], input: Data) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["openssl"] + args
        let inPipe = Pipe(); let outPipe = Pipe()
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        inPipe.fileHandleForWriting.write(input)
        inPipe.fileHandleForWriting.closeFile()
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return data
    }
}
