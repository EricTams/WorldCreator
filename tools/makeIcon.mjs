/**
 * Draw the home-screen icon, at the sizes each platform actually reads.
 *
 * The favicon is an inline SVG in index.html and iOS will not take one: an
 * `apple-touch-icon` has to be a PNG, and without it a home-screen icon is a
 * blurry screenshot of the page. So the same motif — sky, hill, snowcap — is
 * rasterised here rather than redrawn, which is the only way the two stay the
 * same picture when one of them changes.
 *
 * Written by hand rather than with a library because it is three polygons on a
 * flat background. A PNG is a header, one deflated block of scanlines and a
 * trailer; pulling in a canvas implementation to avoid forty lines of that
 * would cost more than it saves.
 *
 *   node tools/makeIcon.mjs
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

// The favicon's own 16x16 coordinate space, so the two cannot drift apart.
const VIEW = 16
const SKY = [0x2f, 0x6f, 0x9e]
const HILL_COLOUR = [0x4a, 0x7c, 0x3f]
const SNOW_COLOUR = [0xee, 0xf2, 0xf5]

const HILL = [
  [0, 11],
  [4, 6],
  [7, 9],
  [10, 4],
  [16, 11],
  [16, 16],
  [0, 16],
]
const SNOW = [
  [10, 4],
  [13, 7.5],
  [11.4, 8.7],
]

/** Crossing-number test — the polygons are simple, so nothing fancier is owed. */
function inside(poly, x, y) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** 4x4 supersampling, because a diagonal skyline at 180px is all anyone sees. */
const SS = 4

function render(size) {
  // One filter byte per row, then RGB triples.
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)

  for (let py = 0; py < size; py++) {
    raw[py * stride] = 0 // filter: none
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * VIEW
          const y = ((py + (sy + 0.5) / SS) / size) * VIEW
          const c = inside(SNOW, x, y)
            ? SNOW_COLOUR
            : inside(HILL, x, y)
              ? HILL_COLOUR
              : SKY
          r += c[0]
          g += c[1]
          b += c[2]
        }
      }
      const n = SS * SS
      const o = py * stride + 1 + px * 3
      raw[o] = Math.round(r / n)
      raw[o + 1] = Math.round(g / n)
      raw[o + 2] = Math.round(b / n)
    }
  }
  return raw
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  const body = out.subarray(4, 8 + data.length)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

function png(size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const size of [180, 512]) {
  const file = join(OUT, `icon-${size}.png`)
  writeFileSync(file, png(size))
  console.log(`wrote ${file}`)
}
