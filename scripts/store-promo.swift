import Foundation
import CoreGraphics
import ImageIO
import CoreText
import UniformTypeIdentifiers

// store-promo.swift <icon.png> <out.png> [bgHex] [textHex] [accentHex] [WxH]
// Renders a Chrome Web Store promo image: solid bg + icon + two-line slogan + brand
// name, centered as a group. Default canvas 440x280 (small tile); pass 1400x560 for
// the marquee. Layout scales with canvas height, so both sizes compose correctly.
// Defaults follow the listing screenshot: white bg, near-black text, logo red.
// Output is opaque RGB PNG (no alpha).
let a = CommandLine.arguments
guard a.count >= 3 else { FileHandle.standardError.write("usage: store-promo <icon.png> <out.png> [bgHex] [textHex] [accentHex] [WxH]\n".data(using:.utf8)!); exit(2) }
let iconPath = a[1], outPath = a[2]
let bgHex     = a.count > 3 ? a[3] : "FFFFFF"   // white, as on the screenshot
let textHex   = a.count > 4 ? a[4] : "16191F"   // near-black headline
let accentHex = a.count > 5 ? a[5] : "E0201B"   // red, matches the broccoli logo
var W = 440, H = 280
if a.count > 6 {
    let parts = a[6].lowercased().split(separator: "x")
    if parts.count == 2, let w = Int(parts[0]), let h = Int(parts[1]) { W = w; H = h }
    else { FileHandle.standardError.write("bad size '\(a[6])', expected WxH e.g. 1400x560\n".data(using:.utf8)!); exit(2) }
}

// slogan: short form of the screenshot headline "Turn lectures into concept maps"
let line1 = "Lectures"
let line2 = "→ concept maps"
let brand = "RedBroccoli"

func rgb(_ h: String) -> (CGFloat,CGFloat,CGFloat) {
    let s = h.hasPrefix("#") ? String(h.dropFirst()) : h
    func v(_ i: Int) -> CGFloat { CGFloat(Int(s[s.index(s.startIndex, offsetBy:i)..<s.index(s.startIndex, offsetBy:i+2)], radix:16) ?? 0)/255.0 }
    return (v(0), v(2), v(4))
}
let (br,bg_,bb) = rgb(bgHex)
let (tr,tg,tb)  = rgb(textHex)
let (ar,ag,ab)  = rgb(accentHex)
// muted brand line: blend text toward bg, so it reads grey on light and dark bgs alike
let muted = (tr*0.55 + br*0.45, tg*0.55 + bg_*0.45, tb*0.55 + bb*0.45)

guard let ctx = CGContext(data:nil, width:W, height:H, bitsPerComponent:8, bytesPerRow:0,
        space:CGColorSpaceCreateDeviceRGB(), bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(1) }
let Hf = CGFloat(H), Wf = CGFloat(W)
let s = Hf / 280.0   // scale factor: layout is authored at 280px tall, scales up for marquee

// background
ctx.setFillColor(CGColor(red:br, green:bg_, blue:bb, alpha:1))
ctx.fill(CGRect(x:0,y:0,width:W,height:H))

// helper: rounded-rect path
func roundedRect(_ r: CGRect, _ radius: CGFloat) -> CGPath {
    let p = CGMutablePath()
    p.move(to: CGPoint(x:r.minX+radius, y:r.minY))
    p.addArc(tangent1End:CGPoint(x:r.maxX,y:r.minY), tangent2End:CGPoint(x:r.maxX,y:r.maxY), radius:radius)
    p.addArc(tangent1End:CGPoint(x:r.maxX,y:r.maxY), tangent2End:CGPoint(x:r.minX,y:r.maxY), radius:radius)
    p.addArc(tangent1End:CGPoint(x:r.minX,y:r.maxY), tangent2End:CGPoint(x:r.minX,y:r.minY), radius:radius)
    p.addArc(tangent1End:CGPoint(x:r.minX,y:r.minY), tangent2End:CGPoint(x:r.maxX,y:r.minY), radius:radius)
    p.closeSubpath()
    return p
}

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath:iconPath) as CFURL, nil),
      let icon = CGImageSourceCreateImageAtIndex(src, 0, nil) else { FileHandle.standardError.write("cannot read icon\n".data(using:.utf8)!); exit(1) }

// measure a text line without drawing (to center the icon+text group horizontally)
func makeLine(_ str: String, size: CGFloat, color:(CGFloat,CGFloat,CGFloat), bold: Bool) -> CTLine {
    let font = CTFontCreateWithName((bold ? "HelveticaNeue-Bold" : "HelveticaNeue-Medium") as CFString, size, nil)
    let attrs: [CFString:Any] = [
        kCTFontAttributeName: font,
        kCTForegroundColorAttributeName: CGColor(red:color.0, green:color.1, blue:color.2, alpha:1)
    ]
    return CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, str as CFString, attrs as CFDictionary)!)
}
func width(_ l: CTLine) -> CGFloat { CTLineGetTypographicBounds(l, nil, nil, nil) }

// build the three lines, scaled to canvas height
let l1 = makeLine(line1, size:30*s, color:(tr,tg,tb), bold:true)
let l2 = makeLine(line2, size:30*s, color:(ar,ag,ab), bold:true)
let l3 = makeLine(brand, size:16*s, color:muted,      bold:false)

let chipSize = 140*s
let gap = 18*s
let textW = max(width(l1), width(l2), width(l3))
let groupW = chipSize + gap + textW
let groupX = (Wf - groupW)/2        // center the whole icon+text group

// icon on a white rounded chip: assets/icon.png has a solid white bg, so the chip
// reads as an app tile on a dark bg and simply disappears on the default white one
let chipX = groupX
let chipY = (Hf - chipSize)/2
let chipRect = CGRect(x:chipX, y:chipY, width:chipSize, height:chipSize)
ctx.saveGState()
ctx.addPath(roundedRect(chipRect, 26*s))
ctx.setFillColor(CGColor(red:1,green:1,blue:1,alpha:1))
ctx.fillPath()
ctx.addPath(roundedRect(chipRect, 26*s))
ctx.clip()
ctx.draw(icon, in: chipRect)
ctx.restoreGState()

// text lines, baseline positions authored at 280px then scaled
let textX = chipX + chipSize + gap
func draw(_ l: CTLine, y: CGFloat) { ctx.textPosition = CGPoint(x:textX, y:y*s); CTLineDraw(l, ctx) }
draw(l1, y:166)
draw(l2, y:128)
draw(l3, y:94)

guard let img = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath:outPath) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, img, nil)
if !CGImageDestinationFinalize(dest) { exit(1) }
