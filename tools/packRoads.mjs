/**
 * Copy the road tileset into assets and work out what each of its tiles is for.
 *
 *   npm run pack-roads
 *
 * Unlike the sprite and ground packers this one does not rearrange any pixels.
 * The source sheet is already a tidy grid — four road materials, each an 8x5
 * block of 16px tiles, plus four bridge tiles on the bottom row — and it is
 * 11 KB, so the honest thing is to ship it as drawn and spend the effort on the
 * part that is actually missing: which tile to place for which neighbourhood.
 *
 * That is the whole difficulty with an autotile sheet. The art tells you what
 * each tile *looks* like and nothing about when to use it, and a hand-written
 * lookup table for 256 neighbourhoods is both tedious and quietly wrong forever
 * once one entry is mistyped. So this measures instead: for every tile it reads
 * the eight boundary samples that say which way the road leaves the tile, and
 * that byte *is* the neighbourhood the tile draws. The table is then inverted.
 *
 * Two facts about the sheet that the measurement discovered, both worth knowing
 * before changing anything here:
 *
 *   - It is a *reduced* blob set. A full one is 47 tiles; this is 38, and it
 *     covers 33 of the 47 canonical masks. The fourteen absentees are all
 *     wide-area cases — a road two or more tiles thick with one inner corner
 *     open — which a route between two towns essentially never produces, but a
 *     paved town square does. They are filled in by nearest match rather than
 *     left blank, so the worst case is a corner that is rounded where it should
 *     be square, not a hole in the road.
 *
 *   - Five masks are drawn twice, as a thick version and a thin one. Higher
 *     coverage wins, which picks the connected-looking tile every time; the
 *     clearest case is the fully-surrounded mask, drawn once as solid fill and
 *     once as a ring with a hole in the middle.
 *
 * All four blocks measure identically, so the table is shared and a material is
 * just an offset into the sheet.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './png.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'TempArt', 'Universal', 'Universal-Road-Tileset.png')
const OUT_PNG = join(ROOT, 'src', 'assets', 'roads.png')
const OUT_TS = join(ROOT, 'src', 'assets', 'roads.ts')

const TILE = 16
/** Tiles across and down one material's block. */
const BLOCK_W = 8
const BLOCK_H = 5

/**
 * The four materials, in sheet order, named for what they are rather than for
 * where they sit. Colours are the measured mean of each block's solid fill tile
 * and are here so a future re-pack against a different sheet can tell whether
 * the blocks moved.
 */
const MATERIALS = [
  { id: 'dirt', tx: 0, ty: 0, rgb: [244, 210, 156] },
  { id: 'gravel', tx: 8, ty: 0, rgb: [165, 141, 107] },
  { id: 'cobble', tx: 0, ty: 5, rgb: [147, 154, 180] },
  { id: 'brick', tx: 8, ty: 5, rgb: [243, 221, 172] },
]

/**
 * The four bridge tiles, bottom row: two materials, each in two orientations.
 *
 * Not autotiled — a bridge is placed where a road meets water, and which of
 * these to use is decided by the road's direction, not by its neighbourhood.
 *
 * The orientations were measured rather than guessed, because "wide" and
 * "narrow" was the first reading of them and it was wrong. Counting opaque
 * pixels along each edge: 12,10 and 14,10 are solid down their left and right
 * edges and empty top and bottom, so their deck runs east-west; 13,10 and 15,10
 * are the reverse. A bridge tile connects on the two edges its deck reaches.
 */
const BRIDGES = [
  { id: 'stoneEW', tx: 12, ty: 10 },
  { id: 'stoneNS', tx: 13, ty: 10 },
  { id: 'greyEW', tx: 14, ty: 10 },
  { id: 'greyNS', tx: 15, ty: 10 },
]

if (!existsSync(SRC)) {
  console.error(`pack-roads: missing ${SRC}`)
  process.exit(1)
}

const raw = readFileSync(SRC)
const img = decodePng(raw, 'Universal-Road-Tileset.png')

/**
 * Bit order, clockwise from north: N NE E SE S SW W NW.
 *
 * Edges on the even bits, corners on the odd ones, so a corner always sits
 * between the two edges it depends on and the normalisation below reads as the
 * rule it is rather than as bit arithmetic.
 */
const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128

const opaque = (px, py) => (img.data[(py * img.width + px) * 4 + 3] > 128 ? 1 : 0)

/**
 * A corner only counts when both of its edges are also set.
 *
 * Without this every diagonal neighbour would demand its own tile and the sheet
 * would need all 256; with it the 256 collapse to the 47 a blob set draws. It is
 * also just true of the art: a tile cannot show a filled north-east corner while
 * its north side is open, because there would be nothing for the corner to
 * attach to.
 */
function normalise(m) {
  let r = m
  if ((m & (N | E)) !== (N | E)) r &= ~NE
  if ((m & (E | S)) !== (E | S)) r &= ~SE
  if ((m & (S | W)) !== (S | W)) r &= ~SW
  if ((m & (W | N)) !== (W | N)) r &= ~NW
  return r
}

/** What a tile shows, as a neighbourhood mask, plus how much of it is drawn. */
function measure(tx, ty) {
  const ox = tx * TILE
  const oy = ty * TILE
  const mid = TILE >> 1
  const last = TILE - 1

  let fill = 0
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) fill += opaque(ox + x, oy + y)
  }

  const mask =
    (opaque(ox + mid, oy) && N) |
    (opaque(ox + last, oy) && NE) |
    (opaque(ox + last, oy + mid) && E) |
    (opaque(ox + last, oy + last) && SE) |
    (opaque(ox + mid, oy + last) && S) |
    (opaque(ox, oy + last) && SW) |
    (opaque(ox, oy + mid) && W) |
    (opaque(ox, oy) && NW)

  return { mask: normalise(mask), fill }
}

// Measure block 0 and check the other three agree, because "all four blocks are
// the same layout" is the assumption the shared table rests on.
const layout = []
for (let ty = 0; ty < BLOCK_H; ty++) {
  for (let tx = 0; tx < BLOCK_W; tx++) {
    const m = measure(MATERIALS[0].tx + tx, MATERIALS[0].ty + ty)
    if (m.fill === 0) continue
    layout.push({ tx, ty, ...m })
  }
}

for (const mat of MATERIALS.slice(1)) {
  for (const cell of layout) {
    const m = measure(mat.tx + cell.tx, mat.ty + cell.ty)
    if (m.mask !== cell.mask) {
      console.error(
        `pack-roads: material "${mat.id}" tile ${cell.tx},${cell.ty} measures mask ` +
          `${m.mask}, block 0 measures ${cell.mask}. The blocks are no longer the ` +
          `same layout and the shared table is invalid.`,
      )
      process.exit(1)
    }
  }
}

// Invert: best tile per mask the sheet actually draws. Highest coverage wins a tie.
const exact = new Map()
for (const cell of layout) {
  const prev = exact.get(cell.mask)
  if (!prev || cell.fill > prev.fill) exact.set(cell.mask, cell)
}

/**
 * Resolve all 256 neighbourhoods, so nothing at runtime has to normalise, match
 * or fall back — it computes eight bits and indexes an array.
 *
 * Distance is over the normalised masks and counts an edge mismatch as worth
 * four corners. Getting an edge wrong disconnects the road, which is a hole you
 * can see from across the map; getting a corner wrong rounds off a join.
 */
function score(a, b) {
  let d = 0
  for (const bit of [N, E, S, W]) if ((a & bit) !== (b & bit)) d += 4
  for (const bit of [NE, SE, SW, NW]) if ((a & bit) !== (b & bit)) d += 1
  return d
}

const table = new Array(256)
let exactCount = 0
for (let m = 0; m < 256; m++) {
  const want = normalise(m)
  const hit = exact.get(want)
  if (hit) {
    table[m] = hit
    exactCount++
    continue
  }
  let best = null
  let bestScore = Infinity
  for (const cell of exact.values()) {
    const s = score(want, cell.mask)
    if (s < bestScore || (s === bestScore && cell.fill > best.fill)) {
      best = cell
      bestScore = s
    }
  }
  table[m] = best
}

const canonical = []
for (let m = 0; m < 256; m++) if (normalise(m) === m) canonical.push(m)
const covered = canonical.filter((m) => exact.has(m))
const missing = canonical.filter((m) => !exact.has(m))

// The sheet ships as drawn.
writeFileSync(OUT_PNG, raw)

const ts = `// GENERATED by tools/packRoads.mjs — do not edit.
// Run \`npm run pack-roads\` to regenerate (requires TempArt/).
//
// Art: Aleksandr Makarov (@IknowKingRabbit). See ART-CREDITS.md.
//
// The sheet is shipped as the artist drew it: ${MATERIALS.length} road materials, each an
// ${BLOCK_W}x${BLOCK_H} block of ${TILE}px tiles, plus ${BRIDGES.length} bridge tiles on the bottom row.
// What is generated here is the part the art does not carry — which tile to
// place for which neighbourhood.

export const ROAD_TILE = ${TILE}
export const ROAD_SHEET_WIDTH = ${img.width}
export const ROAD_SHEET_HEIGHT = ${img.height}

/** Tiles across and down one material's block. */
export const ROAD_BLOCK_W = ${BLOCK_W}
export const ROAD_BLOCK_H = ${BLOCK_H}

export const ROAD_MATERIALS = [${MATERIALS.map((m) => `'${m.id}'`).join(', ')}] as const
export type RoadMaterial = (typeof ROAD_MATERIALS)[number]

/**
 * Where each material's block starts, in tiles from the sheet's top left.
 *
 * All ${MATERIALS.length} blocks are the same layout — the packer verifies it and refuses to
 * emit if they ever diverge — so a material is only ever an offset.
 */
export const ROAD_BLOCK_ORIGIN: readonly (readonly [number, number])[] = [
${MATERIALS.map((m) => `  [${m.tx}, ${m.ty}], // ${m.id}, fill rgb(${m.rgb.join(',')})`).join('\n')}
]

/** Bridge tiles, in tiles from the sheet's top left. Placed by hand, not autotiled. */
export const ROAD_BRIDGES: Readonly<Record<string, readonly [number, number]>> = {
${BRIDGES.map((b) => `  ${b.id}: [${b.tx}, ${b.ty}],`).join('\n')}
}

/**
 * Tile to draw for each of the 256 neighbourhoods, as (tx, ty) pairs *within* a
 * material's block. Index is the 8-way mask, clockwise from north:
 *
 *   N=1  NE=2  E=4  SE=8  S=16  SW=32  W=64  NW=128
 *
 * Every entry is filled, so a lookup can never miss. Set a bit for each of the
 * eight neighbours that is also road, index this, add the material's origin.
 * No normalisation is needed at the call site — corners that cannot apply are
 * already folded out here.
 *
 * The sheet draws ${layout.length} tiles covering ${covered.length} of the ${canonical.length} canonical blob
 * neighbourhoods. The remaining ${missing.length} resolve to their nearest drawn neighbour,
 * counting an edge mismatch as four times a corner mismatch — a wrong edge
 * leaves a visible gap in the road, a wrong corner only rounds a join.
${missing.length ? ` *\n * Approximated masks: ${missing.join(', ')}.` : ''}
 */
export const ROAD_TILE_FOR_MASK: readonly (readonly [number, number])[] = [
${chunk(table.map((c) => `[${c.tx}, ${c.ty}]`), 8)}
]
`

writeFileSync(OUT_TS, ts)

function chunk(items, per) {
  const lines = []
  for (let i = 0; i < items.length; i += per) {
    lines.push('  ' + items.slice(i, i + per).join(', ') + ',')
  }
  return lines.join('\n')
}

console.log(
  `pack-roads: ${MATERIALS.length} materials x ${layout.length} tiles from a ` +
    `${img.width}x${img.height} sheet → src/assets/roads.png (${(raw.length / 1024).toFixed(1)} KB)\n` +
    `            ${covered.length}/${canonical.length} blob masks drawn, ${missing.length} approximated, ` +
    `${exactCount}/256 lookups exact after normalisation`,
)
