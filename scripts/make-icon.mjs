#!/usr/bin/env node
// Generate the placeholder extension icon (assets/icon.png, 512x512 RGBA).
//
// Dependency-free on purpose: a raw PNG encoder over node:zlib, so the icon is
// reproducible on any machine with Node and needs no image tooling. Plasmo
// derives the 16/32/48/64/128 sizes from this file at build time.
//
// The glyph is a tiny concept tree — one root node linked to three children —
// on a rounded square. No YouTube marks (brand policy, see docs/store/listing.md).
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const SIZE = 512
const BG = [37, 99, 235] // blue-600
const FG = [255, 255, 255]

const px = new Float32Array(SIZE * SIZE * 4) // straight RGBA, 0..1 alpha

function blend(x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return
  const i = (y * SIZE + x) * 4
  const da = px[i + 3]
  const oa = a + da * (1 - a)
  for (let c = 0; c < 3; c++) {
    px[i + c] = (rgb[c] * a + px[i + c] * da * (1 - a)) / (oa || 1)
  }
  px[i + 3] = oa
}

// Signed-distance coverage with 1px anti-aliasing.
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d))

function roundedRect(r) {
  const h = SIZE / 2
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const qx = Math.abs(x + 0.5 - h) - (h - r)
      const qy = Math.abs(y + 0.5 - h) - (h - r)
      const d =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
      blend(x, y, BG, cover(d))
    }
}

function circle(cx, cy, r) {
  for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; y++)
    for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++)
      blend(x, y, FG, cover(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r))
}

function line(x1, y1, x2, y2, w) {
  const minX = Math.floor(Math.min(x1, x2) - w)
  const maxX = Math.ceil(Math.max(x1, x2) + w)
  const minY = Math.floor(Math.min(y1, y2) - w)
  const maxY = Math.ceil(Math.max(y1, y2) + w)
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const px0 = x + 0.5
      const py0 = y + 0.5
      const t = Math.max(0, Math.min(1, ((px0 - x1) * dx + (py0 - y1) * dy) / len2))
      const d = Math.hypot(px0 - (x1 + t * dx), py0 - (y1 + t * dy)) - w / 2
      blend(x, y, FG, cover(d))
    }
}

roundedRect(110)
const root = [256, 150]
const kids = [
  [130, 370],
  [256, 380],
  [382, 370],
]
for (const [x, y] of kids) line(root[0], root[1], x, y, 22)
circle(root[0], root[1], 62)
for (const [x, y] of kids) circle(x, y, 46)

// --- PNG encode -----------------------------------------------------------
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    const o = y * (SIZE * 4 + 1) + 1 + x * 4
    raw[o] = Math.round(px[i])
    raw[o + 1] = Math.round(px[i + 1])
    raw[o + 2] = Math.round(px[i + 2])
    raw[o + 3] = Math.round(px[i + 3] * 255)
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png')
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)
