import XCTest
@testable import DomoProtocol

final class DomoConnectionTests: XCTestCase {
    func testCompactRoundTrip() {
        let c = DomoConnection(url: "wss://broker.example:8443/", pin: "abc123==",
                               token: "tok-xyz", name: "Broker")
        let parsed = DomoConnection.parse(c.compactString())
        XCTAssertEqual(parsed, c)
    }

    func testDeepLinkRoundTrip() {
        let c = DomoConnection(url: "wss://broker.example:8444/", pin: "PIN", name: "My Mac")
        let parsed = DomoConnection.parse(c.deepLink())
        XCTAssertEqual(parsed, c)
        XCTAssertNil(parsed?.token)
    }

    func testBareURLParses() {
        let parsed = DomoConnection.parse("ws://127.0.0.1:8443/")
        XCTAssertEqual(parsed?.url, "ws://127.0.0.1:8443/")
        XCTAssertNil(parsed?.pin)
        XCTAssertEqual(parsed?.isSecure, false)
        XCTAssertEqual(parsed?.isNetworked, true)
    }

    func testWhitespaceAndGarbage() {
        XCTAssertEqual(DomoConnection.parse("  ws://h:1/  ")?.url, "ws://h:1/")
        XCTAssertNil(DomoConnection.parse(""))
        XCTAssertNil(DomoConnection.parse("not-a-connection"))
        XCTAssertNil(DomoConnection.parse("domo1.@@@not-base64@@@"))
    }

    func testCompactFormShape() {
        let c = DomoConnection(url: "wss://h/", pin: "P", token: "T")
        XCTAssertTrue(c.compactString().hasPrefix("domo1."))
        XCTAssertTrue(c.deepLink().hasPrefix("domo://connect?c="))
    }

    func testBase64URLNoPaddingOrUnsafeChars() {
        let encoded = Base64URL.encode(Data([0xfb, 0xff, 0x00, 0x3e, 0x3f]))
        XCTAssertFalse(encoded.contains("="))
        XCTAssertFalse(encoded.contains("+"))
        XCTAssertFalse(encoded.contains("/"))
        XCTAssertEqual(Base64URL.decode(encoded), Data([0xfb, 0xff, 0x00, 0x3e, 0x3f]))
    }
}
