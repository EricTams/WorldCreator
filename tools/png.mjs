/**
 * Minimal PNG read/write, RGBA8 only.
 *
 * Deliberately hand-rolled rather than pulling in `pngjs` or `sharp`: this runs
 * once, offline, on a developer machine, and the alternative is a native
 * dependency in a repo that currently has three. Every source sprite in the art
 * pack is 8-bit RGBA and non-interlaced (verified), so the decoder only has to
 * cover colour type 6, bit depth 8, interlace 0 — and it refuses anything else
 * loudly rather than guessing.
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** Paeth predictor, straight from the PNG spec. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * @returns {{ width: number, height: number, data: Buffer }} data is RGBA8,
 *   width * height * 4 bytes, top row first.
 */
export function decodePng(buffer, label = '<buffer>') {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`${label}: not a PNG`)
  }

  let width = 0
  let height = 0
  const idat = []
  let pos = 8

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const body = buffer.subarray(pos + 8, pos + 8 + length)

    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const bitDepth = body[8]
      const colourType = body[9]
      const interlace = body[12]
      if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
        throw new Error(
          `${label}: unsupported PNG (bitDepth ${bitDepth}, colourType ${colourType}, ` +
            `interlace ${interlace}). This packer only reads 8-bit RGBA, non-interlaced.`,
        )
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }

    pos += 12 + length
  }

  if (!width || !height) throw new Error(`${label}: no IHDR`)

  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = (y * (stride + 1)) + 1
    const dst = y * stride
    const up = dst - stride

    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]
      const a = x >= bpp ? out[dst + x - bpp] : 0
      const b = y > 0 ? out[up + x] : 0
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0

      let recon
      switch (filter) {
        case 0: recon = value; break
        case 1: recon = value + a; break
        case 2: recon = value + b; break
        case 3: recon = value + ((a + b) >> 1); break
        case 4: recon = value + paeth(a, b, c); break
        default: throw new Error(`${label}: bad filter ${filter} on row ${y}`)
      }
      out[dst + x] = recon & 0xff
    }
  }

  return { width, height, data: out }
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'ascii')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

/** @param {{ width: number, height: number, data: Buffer }} image RGBA8. */
export function encodePng({ width, height, data }) {
  const stride = width * 4
  // Filter type 0 on every row. Pixel art is mostly flat colour and large
  // transparent runs, which deflate handles well on its own; adaptive filtering
  // buys a few percent for a lot more code.
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
