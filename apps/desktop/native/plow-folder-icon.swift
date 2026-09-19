import AppKit
import CoreImage
import QuickLookThumbnailing
import UniformTypeIdentifiers

private enum IconError: Error, CustomStringConvertible {
    case badArguments
    case missingFolder
    case unreadableBadge
    case applyFailed
    case stampFailed

    var description: String {
        switch self {
        case .badArguments: return "usage: plow-folder-icon <folder-path> <badge-png-path>"
        case .missingFolder: return "folder does not exist"
        case .unreadableBadge: return "badge is not a readable image"
        case .applyFailed: return "could not apply folder icon"
        case .stampFailed: return "could not stamp folder icon"
        }
    }
}

private enum PlowFolderIcon {
    // Shared with plow-mac: changing the renderer must bump both versions.
    private static let iconVersion = 1
    private static let xattrName = "com.plow.folderIconStamp"

    private static var currentStamp: String {
        let os = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        return "v\(iconVersion)-os\(os)"
    }

    static func applyIfNeeded(folder: URL, badge: NSImage) async throws {
        let path = folder.path
        let stamp = currentStamp
        if getXattr(path: path, name: xattrName) == stamp { return }

        let icon = await compositeFolderIcon(badge: badge)
        guard NSWorkspace.shared.setIcon(icon, forFile: path, options: []) else {
            throw IconError.applyFailed
        }
        try setXattr(path: path, name: xattrName, value: stamp)
    }

    private static func getXattr(path: String, name: String) -> String? {
        let length = getxattr(path, name, nil, 0, 0, 0)
        guard length > 0 else { return nil }
        var data = Data(count: length)
        let result = data.withUnsafeMutableBytes {
            getxattr(path, name, $0.baseAddress, length, 0, 0)
        }
        guard result > 0 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func setXattr(path: String, name: String, value: String) throws {
        guard let data = value.data(using: .utf8) else { throw IconError.stampFailed }
        let result = data.withUnsafeBytes {
            setxattr(path, name, $0.baseAddress, data.count, 0, 0)
        }
        guard result == 0 else { throw IconError.stampFailed }
    }

    private static let iconPointSizes: [CGFloat] = [16, 32, 128, 256, 512]
    private static let badgeScale: CGFloat = 0.35
    private static let verticalOffset: CGFloat = 0.56
    private static let badgeTintColor = NSColor(
        srgbRed: 94.0 / 255.0,
        green: 122.0 / 255.0,
        blue: 94.0 / 255.0,
        alpha: 1.0
    )
    private static let voltColor = NSColor(
        srgbRed: 213.0 / 255.0,
        green: 239.0 / 255.0,
        blue: 138.0 / 255.0,
        alpha: 1.0
    )

    private static func compositeFolderIcon(badge: NSImage) async -> NSImage {
        let rawFolder = await systemFolderIcon()
        let folderIcon = recolorToVolt(rawFolder)
        let tintedBadge = tintBadge(badge, color: badgeTintColor)
        let result = NSImage(size: NSSize(width: 512, height: 512))

        for pointSize in iconPointSizes {
            for scaleFactor: CGFloat in [1, 2] {
                let pixelSize = pointSize * scaleFactor
                guard let rep = renderBadgedRep(
                    folder: folderIcon,
                    badge: tintedBadge,
                    pixelSize: pixelSize
                ) else { continue }
                rep.size = NSSize(width: pointSize, height: pointSize)
                result.addRepresentation(rep)
            }
        }
        return result
    }

    private static func systemFolderIcon() async -> NSImage {
        let fm = FileManager.default
        let tmpFolder = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? fm.removeItem(at: tmpFolder) }

        do {
            try fm.createDirectory(at: tmpFolder, withIntermediateDirectories: true)
            try Data().write(to: tmpFolder.appendingPathComponent("placeholder"))
        } catch {
            return NSWorkspace.shared.icon(for: .folder)
        }

        let request = QLThumbnailGenerator.Request(
            fileAt: tmpFolder,
            size: CGSize(width: 1024, height: 1024),
            scale: 1.0,
            representationTypes: .icon
        )

        do {
            let thumbnail = try await withThrowingTaskGroup(of: QLThumbnailRepresentation.self) { group in
                group.addTask {
                    try await QLThumbnailGenerator.shared.generateBestRepresentation(for: request)
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: 5_000_000_000)
                    throw CancellationError()
                }
                let result = try await group.next()!
                group.cancelAll()
                return result
            }
            return thumbnail.nsImage
        } catch {
            return NSWorkspace.shared.icon(for: .folder)
        }
    }

    private static func renderToBitmap(_ image: NSImage) -> NSBitmapImageRep? {
        let px = 1024
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: px, pixelsHigh: px,
            bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0
        ) else { return nil }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(
            in: NSRect(x: 0, y: 0, width: px, height: px),
            from: .zero,
            operation: .copy,
            fraction: 1.0
        )
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    private static func recolorToVolt(_ image: NSImage) -> NSImage {
        guard let bitmap = renderToBitmap(image) else { return image }
        let cx = bitmap.pixelsWide / 2
        let cy = bitmap.pixelsHigh / 2
        guard let sourceColor = bitmap.colorAt(x: cx, y: cy)?.usingColorSpace(.sRGB) else {
            return image
        }

        var srcH: CGFloat = 0, srcS: CGFloat = 0, srcB: CGFloat = 0
        sourceColor.getHue(&srcH, saturation: &srcS, brightness: &srcB, alpha: nil)
        var tgtH: CGFloat = 0, tgtS: CGFloat = 0, tgtB: CGFloat = 0
        voltColor.getHue(&tgtH, saturation: &tgtS, brightness: &tgtB, alpha: nil)

        let hueShift = tgtH - srcH
        let satScale = srcS > 0.01 ? tgtS / srcS : 1.0
        let briScale = srcB > 0.01 ? tgtB / srcB : 1.0
        guard let data = bitmap.bitmapData else { return image }
        let width = bitmap.pixelsWide
        let height = bitmap.pixelsHigh
        let bytesPerRow = bitmap.bytesPerRow

        for y in 0..<height {
            for x in 0..<width {
                let offset = y * bytesPerRow + x * 4
                let red = CGFloat(data[offset]) / 255.0
                let green = CGFloat(data[offset + 1]) / 255.0
                let blue = CGFloat(data[offset + 2]) / 255.0
                if data[offset + 3] == 0 { continue }

                let maxColor = max(red, green, blue)
                let minColor = min(red, green, blue)
                let delta = maxColor - minColor
                var hue: CGFloat = 0
                let saturation: CGFloat = maxColor > 0 ? delta / maxColor : 0
                let brightness: CGFloat = maxColor

                if delta > 0 {
                    if maxColor == red {
                        hue = ((green - blue) / delta).truncatingRemainder(dividingBy: 6)
                    } else if maxColor == green {
                        hue = (blue - red) / delta + 2
                    } else {
                        hue = (red - green) / delta + 4
                    }
                    hue /= 6
                    if hue < 0 { hue += 1 }
                }

                var newHue = (hue + hueShift).truncatingRemainder(dividingBy: 1)
                if newHue < 0 { newHue += 1 }
                let newSaturation = min(max(saturation * satScale, 0), 1)
                let newBrightness = min(max(brightness * briScale, 0), 1)
                let chroma = newBrightness * newSaturation
                let x2 = chroma * (1 - abs((newHue * 6).truncatingRemainder(dividingBy: 2) - 1))
                let match = newBrightness - chroma

                let (r1, g1, b1): (CGFloat, CGFloat, CGFloat)
                switch Int(newHue * 6) % 6 {
                case 0: (r1, g1, b1) = (chroma, x2, 0)
                case 1: (r1, g1, b1) = (x2, chroma, 0)
                case 2: (r1, g1, b1) = (0, chroma, x2)
                case 3: (r1, g1, b1) = (0, x2, chroma)
                case 4: (r1, g1, b1) = (x2, 0, chroma)
                default: (r1, g1, b1) = (chroma, 0, x2)
                }

                data[offset] = UInt8((r1 + match) * 255.0 + 0.5)
                data[offset + 1] = UInt8((g1 + match) * 255.0 + 0.5)
                data[offset + 2] = UInt8((b1 + match) * 255.0 + 0.5)
            }
        }

        let result = NSImage(size: image.size)
        result.addRepresentation(bitmap)
        return result
    }

    private static func tintBadge(_ image: NSImage, color: NSColor) -> NSImage {
        guard let badgeCG = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return image
        }
        let width = badgeCG.width
        let height = badgeCG.height
        guard let context = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return image }

        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        context.draw(badgeCG, in: rect)
        context.setBlendMode(.sourceAtop)
        context.setFillColor(color.cgColor)
        context.fill(rect)
        guard let resultCG = context.makeImage() else { return image }
        let result = NSImage(size: image.size)
        result.addRepresentation(NSBitmapImageRep(cgImage: resultCG))
        return result
    }

    private static func blurLayer(_ image: NSImage, radius: CGFloat) -> NSImage {
        guard let tiffData = image.tiffRepresentation,
              let ciImage = CIImage(data: tiffData),
              let filter = CIFilter(name: "CIGaussianBlur")
        else { return image }

        filter.setValue(ciImage, forKey: kCIInputImageKey)
        filter.setValue(radius, forKey: kCIInputRadiusKey)
        guard let output = filter.outputImage else { return image }
        let rep = NSCIImageRep(ciImage: output.cropped(to: ciImage.extent))
        let result = NSImage(size: image.size)
        result.addRepresentation(rep)
        return result
    }

    private static func renderBadgedRep(
        folder: NSImage,
        badge: NSImage,
        pixelSize: CGFloat
    ) -> NSBitmapImageRep? {
        let pixels = Int(pixelSize)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0
        ) else { return nil }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let fullRect = NSRect(x: 0, y: 0, width: pixelSize, height: pixelSize)
        folder.draw(in: fullRect, from: .zero, operation: .copy, fraction: 1.0)

        let badgeWidth = pixelSize * badgeScale
        let badgeHeight = badgeWidth * badge.size.height / badge.size.width
        let badgeX = (pixelSize - badgeWidth) / 2.0
        let badgeY = pixelSize * (1.0 - verticalOffset) - badgeHeight / 2.0
        let badgeRect = NSRect(x: badgeX, y: badgeY, width: badgeWidth, height: badgeHeight)
        let isTahoe = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
        let bezelOffset = pixelSize * (isTahoe ? 0.006 : 0.003)
        let blurRadius = pixelSize * (isTahoe ? 0.004 : 0.002)
        let layerSize = NSSize(width: pixelSize, height: pixelSize)
        let layerRect = NSRect(origin: .zero, size: layerSize)

        guard let badgeCG = badge.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let darkCG = tintBadge(badge, color: .black).cgImage(forProposedRect: nil, context: nil, hints: nil),
              let lightCG = tintBadge(badge, color: .white).cgImage(forProposedRect: nil, context: nil, hints: nil)
        else {
            NSGraphicsContext.restoreGraphicsState()
            return rep
        }

        let cgBadgeRect = CGRect(x: badgeX, y: badgeY, width: badgeWidth, height: badgeHeight)
        func makeBezel(draw: CGImage, in drawRect: CGRect, erase: CGImage, in eraseRect: CGRect) -> NSImage {
            guard let context = CGContext(
                data: nil, width: pixels, height: pixels,
                bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return NSImage() }
            context.draw(draw, in: drawRect)
            context.setBlendMode(.destinationOut)
            context.draw(erase, in: eraseRect)
            guard let cgImage = context.makeImage() else { return NSImage() }
            let image = NSImage(size: layerSize)
            image.addRepresentation(NSBitmapImageRep(cgImage: cgImage))
            return image
        }

        let bottomBezel = makeBezel(
            draw: lightCG,
            in: cgBadgeRect.offsetBy(dx: 0, dy: -bezelOffset),
            erase: badgeCG,
            in: cgBadgeRect
        )
        let topBezel = makeBezel(
            draw: darkCG,
            in: cgBadgeRect,
            erase: badgeCG,
            in: cgBadgeRect.offsetBy(dx: 0, dy: -bezelOffset)
        )

        blurLayer(bottomBezel, radius: blurRadius).draw(
            in: layerRect,
            from: .zero,
            operation: .sourceOver,
            fraction: isTahoe ? 0.4 : 0.25
        )
        badge.draw(
            in: badgeRect,
            from: .zero,
            operation: .sourceOver,
            fraction: isTahoe ? 0.40 : 0.35
        )
        blurLayer(topBezel, radius: blurRadius).draw(
            in: layerRect,
            from: .zero,
            operation: .sourceOver,
            fraction: isTahoe ? 0.2 : 0.12
        )

        NSGraphicsContext.restoreGraphicsState()
        return rep
    }
}

private func fail(_ error: IconError) -> Never {
    FileHandle.standardError.write(Data("plow-folder-icon: \(error.description)\n".utf8))
    exit(EXIT_FAILURE)
}

guard CommandLine.arguments.count == 3 else { fail(.badArguments) }
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let badgeURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: false)
var isDirectory: ObjCBool = false
guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory),
      isDirectory.boolValue
else { fail(.missingFolder) }
guard let badge = NSImage(contentsOf: badgeURL) else { fail(.unreadableBadge) }

Task {
    do {
        try await PlowFolderIcon.applyIfNeeded(folder: folder, badge: badge)
        exit(EXIT_SUCCESS)
    } catch let error as IconError {
        fail(error)
    } catch {
        fail(.applyFailed)
    }
}
RunLoop.main.run()
