import AppKit
import CoreImage
import DomoProtocol

/// First-run connect screen: the user pastes ONE connection string (from the
/// broker) and hits Connect. No separate URL / pin / path fields — the string
/// carries all of it. If the broker requires enrollment, "Pair this Mac" shows a
/// code (and QR) to approve on the broker — no pubkey copy-paste.
final class OnboardingWindowController: NSWindowController, NSTextViewDelegate {
    /// Returns an error message to show, or nil on success (window then closes).
    private let onConnect: (DomoConnection) -> String?
    /// Submit a pairing request for `code`; returns true if the broker ack'd.
    private let onPair: (DomoConnection, String) -> Bool
    private let deviceId: String
    private let publicKey: String

    private var inputView: NSTextView!
    private var errorLabel: NSTextField!
    private var connectButton: NSButton!
    private var pairButton: NSButton!
    private var pairingBox: NSStackView!
    private var codeLabel: NSTextField!
    private var qrView: NSImageView!
    private var pairStatus: NSTextField!

    init(deviceId: String, publicKey: String,
         onConnect: @escaping (DomoConnection) -> String?,
         onPair: @escaping (DomoConnection, String) -> Bool) {
        self.onConnect = onConnect
        self.onPair = onPair
        self.deviceId = deviceId
        self.publicKey = publicKey
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 480),
                              styleMask: [.titled, .closable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = "Connect Domo"
        window.center()
        super.init(window: window)
        buildContent()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    private func buildContent() {
        guard let window else { return }
        let content = NSView(frame: window.contentView!.bounds)
        content.autoresizingMask = [.width, .height]

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])

        let title = NSTextField(labelWithString: "Connect this Mac to your Domo broker")
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        stack.addArrangedSubview(title)

        let subtitle = NSTextField(wrappingLabelWithString:
            "Paste the connection string your broker gave you. It contains everything needed — the address and the security pin.")
        subtitle.textColor = .secondaryLabelColor
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.preferredMaxLayoutWidth = 472
        stack.addArrangedSubview(subtitle)

        // Paste field
        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let tv = NSTextView()
        tv.isRichText = false
        tv.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.delegate = self
        tv.textContainerInset = NSSize(width: 6, height: 6)
        scroll.documentView = tv
        inputView = tv
        stack.addArrangedSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48),
            scroll.heightAnchor.constraint(equalToConstant: 78),
        ])

        errorLabel = NSTextField(wrappingLabelWithString: "")
        errorLabel.textColor = .systemRed
        errorLabel.font = .systemFont(ofSize: 12)
        errorLabel.isHidden = true
        errorLabel.preferredMaxLayoutWidth = 472
        stack.addArrangedSubview(errorLabel)

        let buttonRow = NSStackView()
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        connectButton = NSButton(title: "Connect", target: self, action: #selector(connectTapped))
        connectButton.bezelStyle = .rounded
        connectButton.keyEquivalent = "\r"
        buttonRow.addArrangedSubview(connectButton)
        pairButton = NSButton(title: "Pair this Mac…", target: self, action: #selector(pairTapped))
        pairButton.bezelStyle = .rounded
        buttonRow.addArrangedSubview(pairButton)
        stack.addArrangedSubview(buttonRow)

        // Pairing panel (hidden until "Pair this Mac"): a code + QR to approve
        // on the broker.
        pairingBox = NSStackView()
        pairingBox.orientation = .vertical
        pairingBox.alignment = .leading
        pairingBox.spacing = 6
        pairingBox.isHidden = true
        codeLabel = NSTextField(labelWithString: "")
        codeLabel.font = .monospacedSystemFont(ofSize: 26, weight: .semibold)
        pairingBox.addArrangedSubview(codeLabel)
        qrView = NSImageView()
        qrView.translatesAutoresizingMaskIntoConstraints = false
        qrView.imageScaling = .scaleProportionallyUpOrDown
        NSLayoutConstraint.activate([
            qrView.widthAnchor.constraint(equalToConstant: 120),
            qrView.heightAnchor.constraint(equalToConstant: 120),
        ])
        pairingBox.addArrangedSubview(qrView)
        pairStatus = NSTextField(wrappingLabelWithString: "")
        pairStatus.font = .systemFont(ofSize: 11)
        pairStatus.textColor = .secondaryLabelColor
        pairStatus.preferredMaxLayoutWidth = 472
        pairingBox.addArrangedSubview(pairStatus)
        stack.addArrangedSubview(pairingBox)

        // Divider
        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(divider)
        divider.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true

        // Device identity (for enrollment on the broker)
        let idTitle = NSTextField(labelWithString: "This Mac's identity")
        idTitle.font = .systemFont(ofSize: 12, weight: .semibold)
        stack.addArrangedSubview(idTitle)

        let idHint = NSTextField(wrappingLabelWithString:
            "If your broker requires enrollment, authorize this Mac there first:\n  domo-broker enroll-device --pubkey <copied below>")
        idHint.textColor = .secondaryLabelColor
        idHint.font = .systemFont(ofSize: 11)
        idHint.preferredMaxLayoutWidth = 472
        stack.addArrangedSubview(idHint)

        let idRow = NSStackView()
        idRow.orientation = .horizontal
        idRow.spacing = 8
        let idField = NSTextField(labelWithString: "device \(deviceId)")
        idField.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        idField.textColor = .tertiaryLabelColor
        idRow.addArrangedSubview(idField)
        let copyBtn = NSButton(title: "Copy public key", target: self, action: #selector(copyKey))
        copyBtn.bezelStyle = .rounded
        copyBtn.controlSize = .small
        idRow.addArrangedSubview(copyBtn)
        stack.addArrangedSubview(idRow)

        window.contentView = content
    }

    @objc private func connectTapped() {
        let text = inputView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let connection = DomoConnection.parse(text) else {
            showError("That doesn't look like a Domo connection string. Ask your broker admin for one (it starts with “domo1.” or “wss://”).")
            return
        }
        guard connection.isNetworked, URL(string: connection.url) != nil else {
            showError("The connection string has an invalid broker address.")
            return
        }
        if let error = onConnect(connection) {
            showError(error)
        } else {
            close()
        }
    }

    @objc private func pairTapped() {
        let text = inputView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let connection = DomoConnection.parse(text), connection.isNetworked else {
            showError("Paste your broker's connection string first, then pair.")
            return
        }
        errorLabel.isHidden = true
        // A short, unambiguous code the user reads to whoever approves.
        let code = String((0..<6).map { _ in "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".randomElement()! })
        codeLabel.stringValue = code
        qrView.image = Self.qrImage(code, side: 120)
        pairStatus.stringValue = "Submitting…"
        pairingBox.isHidden = false
        pairButton.isEnabled = false
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let ok = self.onPair(connection, code)
            DispatchQueue.main.async {
                self.pairButton.isEnabled = true
                self.pairStatus.stringValue = ok
                    ? "Approve this code on your broker:\n  domo-broker approve-pairing --code \(code)\nThen click Connect."
                    : "Could not reach the broker to pair. Check the connection string."
            }
        }
    }

    @objc private func copyKey() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(publicKey, forType: .string)
    }

    /// Render `string` as a QR code image (CoreImage). Used for the pairing code.
    static func qrImage(_ string: String, side: CGFloat) -> NSImage? {
        guard let data = string.data(using: .utf8),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scale = side / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    private func showError(_ message: String) {
        errorLabel.stringValue = message
        errorLabel.isHidden = false
    }

    func present() {
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }
}
