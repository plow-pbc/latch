/**
 * The credential-provider extension that exists so this app can RECEIVE
 * credentials, and for no other reason.
 *
 * macOS only lists an app as a credential-exchange destination (Apple
 * Passwords' "Export to another app…") if the app carries an AutoFill
 * credential-provider extension advertising SupportsCredentialExchange — that
 * is the system's registration mechanism, and there is no import-only variant.
 * So the extension is here, and it vends NOTHING: its Info.plist claims no
 * ProvidesPasswords/ProvidesPasskeys capability, and every entry point a
 * future OS might still call cancels straight away. The vault's contents are
 * typed on this Mac by its owner and filled by the browsing subsystem under
 * approvals — never offered to the system AutoFill UI (DESIGN.md §11a).
 *
 * The import itself never runs here: the system hands the token to the APP
 * (an NSUserActivity; see src/main.ts), which redeems it in-process via
 * native/credential-import.swift.
 *
 * Info.plist sets LSMinimumSystemVersion 26.0, so on macOS 15 this bundle is
 * inert bytes — nothing loads it, nothing lists it.
 */
import AuthenticationServices

class CredentialProviderViewController: ASCredentialProviderViewController {
  private func refuse() {
    extensionContext.cancelRequest(
      withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.userCanceled.rawValue))
  }

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    refuse()
  }

  override func prepareInterfaceToProvideCredential(for credentialRequest: ASCredentialRequest) {
    refuse()
  }

  override func provideCredentialWithoutUserInteraction(for credentialRequest: ASCredentialRequest) {
    extensionContext.cancelRequest(
      withError: NSError(
        domain: ASExtensionErrorDomain, code: ASExtensionError.userInteractionRequired.rawValue))
  }

  override func prepareInterfaceForExtensionConfiguration() {
    refuse()
  }
}
