// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "domo-desktop",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "DomoProtocol"),
        .target(name: "DomoTransport", dependencies: ["DomoProtocol"]),
        .target(name: "DomoBrokerCore", dependencies: ["DomoProtocol", "DomoTransport"]),
        .target(name: "DomoDeviceCore", dependencies: ["DomoProtocol", "DomoTransport"]),
        .executableTarget(name: "domo-broker", dependencies: ["DomoBrokerCore"]),
        .executableTarget(name: "domo-device", dependencies: ["DomoDeviceCore"]),
        .executableTarget(name: "domo-mcp", dependencies: ["DomoTransport"]),
        .executableTarget(name: "DomoApp", dependencies: ["DomoProtocol", "DomoTransport", "DomoDeviceCore"]),
        .testTarget(name: "DomoProtocolTests", dependencies: ["DomoProtocol"]),
        .testTarget(name: "DomoDeviceCoreTests", dependencies: ["DomoDeviceCore"]),
        .testTarget(name: "DomoE2ETests", dependencies: ["DomoProtocol", "DomoTransport"]),
        .testTarget(name: "DomoNetworkTests",
                    dependencies: ["DomoProtocol", "DomoTransport", "DomoBrokerCore", "DomoDeviceCore"]),
    ]
)
