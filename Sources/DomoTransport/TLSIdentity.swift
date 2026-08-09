import Foundation
import Security

/// Loads the broker's server certificate + private key (a `SecIdentity`) from a
/// PKCS#12 file, for serving `wss://` (runbook Phase 6 hosting). The intended
/// posture is a self-signed cert whose SPKI the app + agent pin — no public CA
/// (see `SPKIPin`). Generate one with `scripts/gen-broker-cert.sh`, which also
/// prints the pin value to embed in the client config.
public enum TLSIdentity {
    public static func load(p12Path: String, password: String) -> SecIdentity? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: p12Path)) else { return nil }
        return load(p12: data, password: password)
    }

    public static func load(p12: Data, password: String) -> SecIdentity? {
        var items: CFArray?
        let options = [kSecImportExportPassphrase as String: password] as CFDictionary
        guard SecPKCS12Import(p12 as CFData, options, &items) == errSecSuccess,
              let array = items as? [[String: Any]],
              let identityAny = array.first?[kSecImportItemIdentity as String] else { return nil }
        return (identityAny as! SecIdentity)
    }
}
