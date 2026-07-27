/**
 * Packs the curated sprite manifest into atlases + typed frame maps.
 *
 *   npm run pack-sprites
 *
 * Reads from TempArt/ (untracked, developer-machine only) and writes a
 * src/assets/<name>.png and src/assets/<name>.ts per group in `ATLASES`, all of
 * which ARE committed. That is the deal: the raw pack never enters the repo, the
 * game's slice of it does. See src/assets/ART-CREDITS.md.
 *
 * Fails loudly if TempArt/ is missing rather than emitting an empty atlas — a
 * silently blank atlas would look like a shader bug for an hour.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng } from './png.mjs'
import { ATLASES, ROLE_BY_PREFIX } from './spriteManifest.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ART = join(ROOT, 'TempArt')
const OUT_DIR = join(ROOT, 'src', 'assets')

/**
 * Transparent gutter around every sprite, in atlas pixels.
 *
 * Four, not one. The atlas is mipmapped — it has to be, or a 16 px pickup at
 * strategy altitude turns into crawling static — and each mip level halves the
 * gutter's effective width. The deepest level we actually sample is around mip
 * 2 (a 64 px city occupies roughly a dozen screen pixels at the 'populous'
 * distance), where four pixels is still one. One pixel would be gone by mip 1.
 */
const GUTTER = 4

function fail(message) {
  console.error(`\npack-sprites: ${message}\n`)
  process.exit(1)
}

/**
 * Shrink an image to its opaque bounding box.
 *
 * This is what makes "select by grid cell" work. Sprites are chosen as whole
 * 16px cells, because that is how the art is laid out and picking pixel rects
 * by eye is how a patch of mushrooms once got labelled as a mountain. But the
 * cell is mostly empty: trees are drawn standing on its baseline, litter
 * floating in its middle. Packing the cell as-is would hang every prop above
 * the ground by however much padding it happened to have. Trimming gives the
 * card a sprite whose bottom edge is the art's bottom edge.
 */
function trimToContent(image, label) {
  const { width: W, height: H, data } = image
  let minX = W
  let minY = H
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!data[(y * W + x) * 4 + 3]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) fail(`${label}: cell is empty`)
  return crop(image, [minX, minY, maxX - minX + 1, maxY - minY + 1], label)
}

/** Extract a [x, y, w, h] sub-image. */
function crop(image, [x, y, w, h], label) {
  if (x < 0 || y < 0 || x + w > image.width || y + h > image.height) {
    fail(`${label}: rect [${x},${y},${w},${h}] falls outside ${image.width}x${image.height}`)
  }
  const out = { width: w, height: h, data: Buffer.alloc(w * h * 4) }
  for (let row = 0; row < h; row++) {
    image.data.copy(
      out.data,
      row * w * 4,
      ((y + row) * image.width + x) * 4,
      ((y + row) * image.width + x + w) * 4,
    )
  }
  return out
}

/**
 * Push colour outward from opaque texels into the transparent ones around them,
 * leaving alpha at zero.
 *
 * This is not cosmetic. In the source art a fully transparent texel usually
 * carries RGB (0,0,0) — Castle.png has 836 transparent texels, 596 of them
 * pure black; Lair.png has 312, all black. Mip level 1 averages 2x2 blocks
 * *including* those texels' colour, so without dilation every sprite grows a
 * dark halo at exactly the distances where it is already only a few pixels
 * tall. It reads as "the min filter is wrong" and it is not.
 *
 * Four passes covers the mip levels this atlas is ever sampled at.
 */
function dilateAlpha(image, passes = 4) {
  const { width, height, data } = image
  // Alpha stays untouched; `solid` tracks which texels have usable colour.
  const solid = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) solid[i] = data[i * 4 + 3] > 0 ? 1 : 0

  for (let pass = 0; pass < passes; pass++) {
    const next = solid.slice()
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (solid[i]) continue

        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
            const j = ny * width + nx
            if (!solid[j]) continue
            r += data[j * 4]
            g += data[j * 4 + 1]
            b += data[j * 4 + 2]
            n++
          }
        }
        if (!n) continue

        data[i * 4] = Math.round(r / n)
        data[i * 4 + 1] = Math.round(g / n)
        data[i * 4 + 2] = Math.round(b / n)
        next[i] = 1
      }
    }
    solid.set(next)
  }
}

if (!existsSync(ART)) {
  fail(
    `TempArt/ not found at ${ART}.\n` +
      `  The source art is deliberately not in git. This script only runs on a\n` +
      `  machine that has the pack; the committed atlas is what everyone else uses.`,
  )
}

// --- load -------------------------------------------------------------------

/**
 * A key's role, from its prefix.
 *
 * Fails on a prefix `ROLE_BY_PREFIX` does not declare. That is the point: the
 * game finds sprites by role, so a key with a typo in its prefix would not be a
 * missing sprite — it would be a sprite that packs, ships, and is never picked.
 */
function roleFor(key) {
  const dot = key.indexOf('.')
  const prefix = dot < 0 ? key : key.slice(0, dot)
  const role = ROLE_BY_PREFIX[prefix]
  if (!role) fail(`"${key}": unknown key prefix "${prefix}" — add it to ROLE_BY_PREFIX`)
  return role
}

// Keys are one namespace to the game whatever atlas they live in, so uniqueness
// is checked across every group rather than within each.
const claimed = new Set()

function load(entries) {
  const items = []
  for (const entry of entries) {
    if (claimed.has(entry.key)) fail(`duplicate sprite key "${entry.key}"`)
    claimed.add(entry.key)
    const role = roleFor(entry.key)

    const path = join(ART, entry.src)
    if (!existsSync(path)) fail(`missing source for "${entry.key}": ${entry.src}`)

    let image = decodePng(readFileSync(path), entry.src)
    // `rect` pulls one sprite out of a shared sheet. The tree sheet is a loose
    // collage rather than a grid, so its rects come from a connected-component
    // scan of the alpha channel rather than from arithmetic.
    if (entry.rect) image = crop(image, entry.rect, entry.key)
    if (entry.trim) image = trimToContent(image, entry.key)
    dilateAlpha(image)

    // An animation sheet declares its frame size and the grid is counted off
    // the image, so the two can never disagree. Declaring both is what put
    // `rows: 5` on the 4x6 sheets and made their frames 19.2 px tall.
    let grid = null
    if (entry.frame) {
      const f = entry.frame
      if (image.width % f || image.height % f) {
        fail(`${entry.key}: ${image.width}x${image.height} is not whole ${f}px frames`)
      }
      grid = { cols: image.width / f, rows: image.height / f }
    }

    items.push({ ...entry, role, image, grid })
  }
  return items
}

// --- pack -------------------------------------------------------------------

/**
 * Shelf packer: sort tall-first, lay rows left to right, start a new row when
 * the current one is full. Optimal packing is NP-hard and irrelevant here —
 * the sprites are near-uniform in size, so shelves waste a few percent.
 */
function packInto(items, atlasW, atlasH) {
  const placed = []
  let shelfY = 0
  let shelfH = 0
  let x = 0

  for (const item of items) {
    const w = item.image.width + GUTTER
    const h = item.image.height + GUTTER

    if (x + w > atlasW) {
      shelfY += shelfH
      shelfH = 0
      x = 0
    }
    if (shelfY + h > atlasH) return null

    placed.push({ item, x: x + GUTTER / 2, y: shelfY + GUTTER / 2 })
    x += w
    if (h > shelfH) shelfH = h
  }
  return placed
}

// Powers of two in both axes, but not necessarily square — a group is usually
// wide and shallow, and a square atlas would leave half the texture empty.
// Mipmaps need power-of-two dimensions; they do not need equal ones.
const CANDIDATES = []
for (let w = 256; w <= 4096; w *= 2) for (let h = 256; h <= 4096; h *= 2) CANDIDATES.push([w, h])
CANDIDATES.sort((a, b) => a[0] * a[1] - b[0] * b[1] || a[0] - b[0])

function pack(name, items) {
  // Tall-first keeps shelves uniform: the 64x80 creature sheets all land
  // together rather than each one forcing a tall shelf that 16x16 pickups then
  // waste. Sorted on a copy — the frame map is emitted in manifest order.
  const byHeight = [...items].sort(
    (a, b) => b.image.height - a.image.height || b.image.width - a.image.width,
  )

  for (const [w, h] of CANDIDATES) {
    const placed = packInto(byHeight, w, h)
    if (placed) return { width: w, height: h, placed }
  }
  return fail(`${name}: could not pack into 4096x4096 — trim the manifest`)
}

// --- compose ----------------------------------------------------------------

function compose(width, height, placed) {
  const atlas = { width, height, data: Buffer.alloc(width * height * 4) }

  for (const { item, x, y } of placed) {
    const src = item.image
    for (let row = 0; row < src.height; row++) {
      src.data.copy(
        atlas.data,
        ((y + row) * width + x) * 4,
        row * src.width * 4,
        (row + 1) * src.width * 4,
      )
    }
  }

  // Second dilation pass, now across the whole atlas: the first one filled holes
  // *inside* each sprite's canvas, this one pushes each sprite's edge colour out
  // into its gutter so mipmapping has something better than black to average
  // there. Two passes reach exactly half of a 4px gutter from each side, so
  // neighbouring sprites fill toward each other without ever meeting.
  dilateAlpha(atlas, 2)
  return atlas
}

// --- frame map --------------------------------------------------------------

function emitModule(name, width, height, items, placed) {
  const byKey = new Map(placed.map((p) => [p.item.key, p]))
  const frames = []
  const tags = []
  const roles = new Set()

  for (const entry of items) {
    const { item, x, y } = byKey.get(entry.key)
    const grid = item.grid ? `, cols: ${item.grid.cols}, rows: ${item.grid.rows}` : ''
    frames.push(
      `  '${entry.key}': { x: ${x}, y: ${y}, w: ${item.image.width}, h: ${item.image.height}${grid} },`,
    )

    roles.add(item.role)
    const biomes = entry.tags?.biomes
    const suits = biomes ? `, biomes: [${biomes.map((b) => `'${b}'`).join(', ')}]` : ''
    tags.push(`  '${entry.key}': { role: '${item.role}'${suits} },`)
  }

  const roleUnion = [...roles].sort().map((r) => `'${r}'`).join(' | ')

  return `// GENERATED by tools/packSprites.mjs — do not edit.
// Run \`npm run pack-sprites\` to regenerate (requires TempArt/).
//
// Art: Aleksandr Makarov (@IknowKingRabbit). See ART-CREDITS.md.

export const ATLAS_WIDTH = ${width}
export const ATLAS_HEIGHT = ${height}

export interface SpriteFrame {
  /** Pixel rect within the atlas. */
  x: number
  y: number
  w: number
  h: number
  /** Present on animation sheets: the frame grid within the rect. */
  cols?: number
  rows?: number
}

export const SPRITE_FRAMES = {
${frames.join('\n')}
} as const satisfies Record<string, SpriteFrame>

export type SpriteKey = keyof typeof SPRITE_FRAMES

/** What a sprite *is*, derived from its key prefix by the packer. */
export type SpriteRole = ${roleUnion}

export interface SpriteTags {
  role: SpriteRole
  /**
   * Biome ids whose palette this sprite suits. Absent means it suits any —
   * either because it is palette-neutral, or because its key already carries
   * the biome's ground sheet and callers build the key rather than search for it.
   */
  biomes?: readonly string[]
}

export const SPRITE_TAGS = {
${tags.join('\n')}
} as const satisfies Record<SpriteKey, SpriteTags>

const ALL_KEYS = Object.keys(SPRITE_TAGS) as SpriteKey[]

/**
 * Every sprite of a role, in manifest order, optionally narrowed to those whose
 * palette suits a biome.
 *
 * This is what lets placement code ask for "a settlement building that suits the
 * Blight" instead of naming files. Manifest order is stable, so a caller that
 * indexes this with a seeded random draws the same sprite on every run — but it
 * shifts when art is added, which is the same contract the biome prop lists
 * already have.
 */
export function spritesWithRole(role: SpriteRole, biome?: string): SpriteKey[] {
  return ALL_KEYS.filter((key) => {
    const tag: SpriteTags = SPRITE_TAGS[key]
    if (tag.role !== role) return false
    return !biome || !tag.biomes || tag.biomes.includes(biome)
  })
}
`
}

// --- run --------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })

for (const { name, entries } of ATLASES) {
  const items = load(entries)
  const { width, height, placed } = pack(name, items)
  const png = encodePng(compose(width, height, placed))

  writeFileSync(join(OUT_DIR, `${name}.png`), png)
  writeFileSync(join(OUT_DIR, `${name}.ts`), emitModule(name, width, height, items, placed))

  const used = placed.reduce((n, p) => n + p.item.image.width * p.item.image.height, 0)
  console.log(
    `pack-sprites: ${name} — ${items.length} sprites → ${width}x${height} ` +
      `(${((used / (width * height)) * 100).toFixed(0)}% filled, ` +
      `${(png.length / 1024).toFixed(0)} KB)`,
  )
}
