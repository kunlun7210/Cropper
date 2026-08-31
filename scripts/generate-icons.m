#import <Foundation/Foundation.h>
#import <CoreText/CoreText.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

// One outlined glyph is shared by browser, Apple Web Clip, PWA and preview icons.
// clang -fno-modules -framework Foundation -framework CoreText -framework CoreGraphics \
//   -framework ImageIO scripts/generate-icons.m -o /tmp/luban-generate-icons
// /tmp/luban-generate-icons  (run from the project root)
static void appendPath(void *info, const CGPathElement *e) {
    NSMutableString *d = (__bridge NSMutableString *)info;
    CGPoint *p = e->points;
    switch (e->type) {
        case kCGPathElementMoveToPoint: [d appendFormat:@"M%.3f %.3f ", p[0].x, p[0].y]; break;
        case kCGPathElementAddLineToPoint: [d appendFormat:@"L%.3f %.3f ", p[0].x, p[0].y]; break;
        case kCGPathElementAddQuadCurveToPoint: [d appendFormat:@"Q%.3f %.3f %.3f %.3f ", p[0].x, p[0].y, p[1].x, p[1].y]; break;
        case kCGPathElementAddCurveToPoint: [d appendFormat:@"C%.3f %.3f %.3f %.3f %.3f %.3f ", p[0].x, p[0].y, p[1].x, p[1].y, p[2].x, p[2].y]; break;
        case kCGPathElementCloseSubpath: [d appendString:@"Z "]; break;
    }
}
static void appendLE(NSMutableData *data, NSUInteger value, int count) {
    for (int i = 0; i < count; i++) { uint8_t byte = (value >> (i * 8)) & 255; [data appendBytes:&byte length:1]; }
}
int main(void) { @autoreleasepool {
    NSURL *output = [NSURL fileURLWithPath:[NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:@"icons"]];
    NSError *error = nil;
    if (![NSFileManager.defaultManager createDirectoryAtURL:output withIntermediateDirectories:YES attributes:nil error:&error]) return 1;
    CTFontRef font = CTFontCreateWithName(CFSTR("PingFangSC-Regular"), 512, NULL);
    UniChar character = [@"裁" characterAtIndex:0];
    CGGlyph glyph;
    if (!CTFontGetGlyphsForCharacters(font, &character, &glyph, 1)) return 2;
    CGPathRef original = CTFontCreatePathForGlyph(font, glyph, NULL);
    CGRect bounds = CGPathGetPathBoundingBox(original);
    CGFloat scale = 512 * 0.56 / MAX(bounds.size.width, bounds.size.height);
    CGAffineTransform transform = CGAffineTransformMake(scale, 0, 0, -scale,
        256 - CGRectGetMidX(bounds) * scale, 256 + CGRectGetMidY(bounds) * scale);
    CGPathRef outline = CGPathCreateCopyByTransformingPath(original, &transform);
    NSMutableString *d = [NSMutableString string];
    CGPathApply(outline, (__bridge void *)d, appendPath);
    NSString *svg = [NSString stringWithFormat:@"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\">\n  <title>裁</title>\n  <rect width=\"512\" height=\"512\" fill=\"#0b1220\"/>\n  <path fill=\"#f6f8fb\" d=\"%@\"/>\n</svg>\n", d];
    if (![svg writeToURL:[output URLByAppendingPathComponent:@"icon-cai-v1.svg"] atomically:YES encoding:NSUTF8StringEncoding error:&error]) return 3;
    NSMutableDictionary<NSNumber *, NSData *> *pngs = [NSMutableDictionary dictionary];
    for (NSNumber *dimension in @[@16, @32, @48, @180, @192, @512]) {
        size_t size = dimension.unsignedIntegerValue;
        CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
        CGContextRef context = CGBitmapContextCreate(NULL, size, size, 8, size * 4, colorSpace, kCGImageAlphaPremultipliedLast);
        CGContextSetRGBFillColor(context, 11.0/255, 18.0/255, 32.0/255, 1);
        CGContextFillRect(context, CGRectMake(0, 0, size, size));
        CGContextTranslateCTM(context, 0, size);
        CGContextScaleCTM(context, size/512.0, -(CGFloat)size/512.0);
        CGContextAddPath(context, outline);
        CGContextSetRGBFillColor(context, 246.0/255, 248.0/255, 251.0/255, 1);
        CGContextFillPath(context);
        CGImageRef image = CGBitmapContextCreateImage(context);
        NSMutableData *png = [NSMutableData data];
        CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png, CFSTR("public.png"), 1, NULL);
        CGImageDestinationAddImage(destination, image, NULL);
        if (!CGImageDestinationFinalize(destination)) return 4;
        NSString *name = [NSString stringWithFormat:@"icon-cai-v1-%@.png", dimension];
        if (![png writeToURL:[output URLByAppendingPathComponent:name] atomically:YES]) return 5;
        pngs[dimension] = png;
        CFRelease(destination); CGImageRelease(image); CGContextRelease(context); CGColorSpaceRelease(colorSpace);
    }
    // Retain old URLs for already-saved bookmarks, but serve the same 裁 artwork.
    NSDictionary *legacy = @{@"favicon-qu-32.png": @32, @"favicon-qu-48.png": @48,
        @"apple-touch-icon-qu.png": @180, @"icon-qu-192.png": @192, @"icon-qu-512.png": @512};
    for (NSString *name in legacy) {
        if (![pngs[legacy[name]] writeToURL:[[output URLByDeletingLastPathComponent] URLByAppendingPathComponent:name] atomically:YES]) return 7;
    }
    NSMutableData *ico = [NSMutableData data];
    appendLE(ico, 0, 2); appendLE(ico, 1, 2); appendLE(ico, 3, 2);
    NSUInteger offset = 6 + 3 * 16;
    for (NSNumber *dimension in @[@16, @32, @48]) {
        NSUInteger size = dimension.unsignedIntegerValue;
        NSData *png = pngs[dimension];
        appendLE(ico, size, 1); appendLE(ico, size, 1); appendLE(ico, 0, 2);
        appendLE(ico, 1, 2); appendLE(ico, 32, 2);
        appendLE(ico, png.length, 4); appendLE(ico, offset, 4);
        offset += png.length;
    }
    for (NSNumber *dimension in @[@16, @32, @48]) [ico appendData:pngs[dimension]];
    if (![ico writeToURL:[output URLByAppendingPathComponent:@"favicon-cai-v1.ico"] atomically:YES]) return 6;
    CGPathRelease(outline); CGPathRelease(original); CFRelease(font);
    puts("Generated 裁: outlined SVG, ICO and 16/32/48/180/192/512px PNGs");
    return 0;
} }
