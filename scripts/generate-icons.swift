import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Opaque, full-bleed artwork; iOS applies its own Home Screen corner mask.
let output = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let font = CTFontCreateWithName("PingFangSC-Regular" as CFString, 100, nil)
var character: UniChar = 0x53BB // 去
var glyph: CGGlyph = 0
guard CTFontGetGlyphsForCharacters(font, &character, &glyph, 1),
      let path = CTFontCreatePathForGlyph(font, glyph, nil) else { fatalError("Missing glyph") }
let bounds = path.boundingBoxOfPath
for (filename, size) in [("favicon-qu-32.png", 32), ("favicon-qu-48.png", 48), ("apple-touch-icon-qu.png", 180), ("icon-qu-192.png", 192), ("icon-qu-512.png", 512)] {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
        bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("Canvas") }
    context.setFillColor(red: 11 / 255, green: 18 / 255, blue: 32 / 255, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    let scale = CGFloat(size) * 0.58 / max(bounds.width, bounds.height)
    context.translateBy(x: CGFloat(size) / 2, y: CGFloat(size) / 2)
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.midX, y: -bounds.midY)
    context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    context.addPath(path)
    context.fillPath()
    guard let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { fatalError("Pixels") }
    var left = size, right = -1, top = size, bottom = -1
    for y in 0..<size {
        for x in 0..<size {
            let offset = y * size * 4 + x * 4
            guard pixels[offset] > 150 else { continue }
            left = min(left, x); right = max(right, x)
            top = min(top, y); bottom = max(bottom, y)
        }
    }
    precondition(abs(left + right + 1 - size) <= 2 && abs(top + bottom + 1 - size) <= 2)
    precondition((0.54...0.62).contains(Double(max(right - left + 1, bottom - top + 1)) / Double(size)))
    guard let image = context.makeImage(), let destination = CGImageDestinationCreateWithURL(
        output.appendingPathComponent(filename) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("Output") }
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination))
    print("Validated \(filename): \(size)x\(size), opaque and centered")
}
