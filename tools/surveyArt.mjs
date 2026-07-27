/**
 * Survey every PNG in TempArt and write down what is in it.
 *
 *   npm run survey-art
 *
 * Emits `tools/ART-SURVEY.md`: a catalogue of every sheet, what kind of sheet it
 * is, and — for the collage sheets — the pixel rect of every distinct sprite in
 * it. That last part is the point. The overworld sheets are not grids; their
 * contents sit at irregular offsets, and every time a sprite was needed the
 * rects had to be rediscovered by hand. Now they are written down once.
 *
 * Read-only. It never touches the atlas, so running it is always safe.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './png.mjs'
import { SPRITES, biomeProps, unitSprites } from './spriteManifest.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ART = join(ROOT, 'TempArt')
const TILE = 16

if (!existsSync(ART)) {
  console.error('\nsurvey-art: TempArt/ not found — this tool needs the source packs.\n')
  process.exit(1)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (entry.toLowerCase().endsWith('.png')) out.push(path)
  }
  return out
}

/** Connected opaque regions, 8-connected, above a noise floor. */
function components(img, minPixels = 12) {
  const { width: W, height: H, data } = img
  const alpha = (x, y) => data[(y * W + x) * 4 + 3]
  const seen = new Uint8Array(W * H)
  const found = []

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (seen[i] || alpha(x, y) === 0) continue
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let count = 0
      const stack = [i]
      seen[i] = 1
      while (stack.length) {
        const j = stack.pop()
        const jx = j % W
        const jy = (j - jx) / W
        count++
        if (jx < minX) minX = jx
        if (jx > maxX) maxX = jx
        if (jy < minY) minY = jy
        if (jy > maxY) maxY = jy
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = jx + dx
            const ny = jy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            const n = ny * W + nx
            if (seen[n] || alpha(nx, ny) === 0) continue
            seen[n] = 1
            stack.push(n)
          }
        }
      }
      if (count >= minPixels) {
        found.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, px: count })
      }
    }
  }
  found.sort((a, b) => a.y - b.y || a.x - b.x)
  return found
}

/**
 * Per-tile report for grid sheets.
 *
 * `wrap` is the mean edge difference between a tile's opposite sides. Near zero
 * means the tile repeats against itself, which is what distinguishes a ground
 * fill from a transition tile that merely looks like one.
 */
function tiles(img) {
  const { width: W, height: H, data } = img
  const out = []
  for (let ty = 0; ty + TILE <= H; ty++) {
    if (ty % TILE) continue
    for (let tx = 0; tx + TILE <= W; tx += TILE) {
      const colours = new Set()
      let opaque = true
      for (let y = 0; y < TILE && opaque; y++) {
        for (let x = 0; x < TILE; x++) {
          const i = ((ty + y) * W + tx + x) * 4
          if (data[i + 3] !== 255) {
            opaque = false
            break
          }
          colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
        }
      }
      if (!opaque) continue

      let dx = 0
      let dy = 0
      for (let y = 0; y < TILE; y++) {
        const a = ((ty + y) * W + tx) * 4
        const b = ((ty + y) * W + tx + TILE - 1) * 4
        dx += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1])
      }
      for (let x = 0; x < TILE; x++) {
        const a = (ty * W + tx + x) * 4
        const b = ((ty + TILE - 1) * W + tx + x) * 4
        dy += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1])
      }
      const i0 = (ty * W + tx) * 4
      out.push({
        col: tx / TILE,
        row: ty / TILE,
        colours: colours.size,
        wrap: +((dx / TILE + dy / TILE) / 2).toFixed(1),
        sample: `${data[i0]},${data[i0 + 1]},${data[i0 + 2]}`,
      })
    }
  }
  return out
}

/**
 * Grid cells that hold exactly one self-contained subject.
 *
 * The rule, and the reason it is a rule rather than a person squinting at a
 * sheet: a cell qualifies when its opaque pixels form a single connected blob,
 * and it touches neither side wall, so it is not a slice of something wider
 * spilling in from the next cell.
 *
 * Deliberately *not* required to reach the cell's baseline. Trees are drawn
 * standing on it, but ground litter — logs, pebbles, tufts — is drawn floating
 * in the middle of its cell, because in a top-down tile map nothing has a base.
 * `gap` reports that space; the packer trims it away, which is what lets a
 * sprite be chosen by grid cell and still plant correctly on 3D ground.
 *
 * Checkable is the point: picking these by eye is how a patch of mushrooms
 * ended up in the manifest labelled as a mountain.
 *
 * `span` scans NxN blocks of cells instead, for subjects like mountains that
 * the artist drew across a 2x2.
 */
function singleSubjectCells(img, span = 1) {
  const { width: W, height: H, data } = img
  const S = TILE * span
  const alpha = (x, y) => data[(y * W + x) * 4 + 3]
  const cells = []

  for (let cy = 0; cy + S <= H; cy += TILE) {
    for (let cx = 0; cx + S <= W; cx += TILE) {
      let count = 0
      let touchesSide = false
      let maxY = -1
      let minY = S
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          if (!alpha(cx + x, cy + y)) continue
          count++
          if (x === 0 || x === S - 1) touchesSide = true
          if (y > maxY) maxY = y
          if (y < minY) minY = y
        }
      }
      // Enough to be a subject, not so much that it is a filled tile.
      //
      // The upper bound is what separates a decoration from a coast or cliff
      // transition. A prop sits in mostly empty space; a transition tile is
      // mostly ground. Flat litter is held to the tighter bound because a
      // half-filled short cell is far more likely to be the edge of something
      // than a pile of pebbles.
      if (count < 10) continue
      if (touchesSide) continue

      // One blob, not several — but only for *tall* subjects.
      //
      // The hazard this guards against is a cell holding two trees drawn at
      // different depths, where only the nearer one is on the baseline: stood
      // upright on 3D ground, the far one hangs in the air. Flat litter has no
      // such depth to get wrong, so a scatter of pebbles is allowed to be
      // several blobs and still count as one decoration.
      const tall = maxY - minY > 8
      if (count > S * S * (tall ? 0.75 : 0.32)) continue
      const seen = new Uint8Array(S * S)
      let blobs = 0
      for (let y = 0; y < S && !(tall && blobs > 1); y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x
          if (seen[i] || !alpha(cx + x, cy + y)) continue
          blobs++
          const stack = [i]
          seen[i] = 1
          while (stack.length) {
            const j = stack.pop()
            const jx = j % S
            const jy = (j - jx) / S
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = jx + dx
                const ny = jy + dy
                if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue
                const n = ny * S + nx
                if (seen[n] || !alpha(cx + nx, cy + ny)) continue
                seen[n] = 1
                stack.push(n)
              }
            }
          }
        }
      }
      if (tall && blobs !== 1) continue

      cells.push({ col: cx / TILE, row: cy / TILE, px: count, gap: S - 1 - maxY })
    }
  }
  return cells
}

function classify(img, name, comps, grid) {
  const { width: W, height: H } = img
  const gridAligned = W % TILE === 0 && H % TILE === 0
  if (/sprite_sheet/i.test(name)) return 'creature animation sheet (4 cols x 5-6 rows of 16px)'
  if (/Animated/i.test(name)) return 'animation strip'
  if (grid.some((t) => t.wrap < 5 && t.colours === 1)) return 'terrain tileset (has flat fill tiles)'
  if (comps.length === 1 && comps[0].px > W * H * 0.25) return 'single sprite'
  if (comps.length > 6) return 'collage of loose sprites'
  if (gridAligned) return 'grid sheet'
  return 'sprite'
}

/**
 * What the game actually pulls in.
 *
 * Imported from the manifest rather than restated, so this cannot drift: adding
 * a sprite moves the coverage numbers on the next run without anyone editing
 * this file.
 */
const entries = [...SPRITES, ...biomeProps(), ...unitSprites()]
const usedBySrc = new Map()
for (const e of entries) usedBySrc.set(e.src, (usedBySrc.get(e.src) ?? 0) + 1)
// The seven LandTilesets are also the source of the terrain ground textures,
// which are packed separately by tools/packGround.mjs.
const GROUND_SHEETS = [
  'GrassBiome/GB-LandTileset.png',
  'SandBiome/SB-LandTileset.png',
  'MarshBiome/MB-LandTileset.png',
  'IceBiome/IB-LandTileset.png',
  'LavaBiome/LB-LandTileset.png',
  'CaveBiome/CB-LandTileset.png',
  'DirtBiome/DB-LandTileset.png',
]

const files = walk(ART)
const lines = []
const coverage = []
lines.push('# Art survey')
lines.push('')
lines.push('GENERATED by `tools/surveyArt.mjs` — run `npm run survey-art` to refresh.')
lines.push('')
lines.push(
  'Every PNG in `TempArt/`, what it is, and where the sprites are inside it. ' +
    'Rects are `[x, y, w, h]` in source pixels and can be pasted straight into ' +
    '`tools/spriteManifest.mjs`.',
)
lines.push('')
lines.push(`Art by Aleksandr Makarov (@IknowKingRabbit). ${files.length} files surveyed.`)
lines.push('')

let lastDir = ''
let creatureCount = 0
let buildingCount = 0

for (const file of files) {
  const rel = relative(ART, file)
  const dir = dirname(rel)
  let img
  try {
    img = decodePng(readFileSync(file), rel)
  } catch (e) {
    lines.push(`- \`${rel}\` — could not decode: ${e.message}`)
    continue
  }

  // The creature sheets and the buildings pack are hundreds of near-identical
  // files; catalogue them in aggregate rather than one heading each.
  if (/sprite_sheet|^icon_/i.test(rel.split('/').pop())) {
    creatureCount++
    continue
  }
  if (rel.startsWith('HAS Buildings Pack') && img.width <= 64 && img.height <= 64) {
    buildingCount++
    continue
  }

  if (dir !== lastDir) {
    lines.push('')
    lines.push(`## ${dir}`)
    lines.push('')
    lastDir = dir
  }

  const comps = components(img)
  const grid = tiles(img)
  const kind = classify(img, rel, comps, grid)
  coverage.push({
    rel,
    used: (usedBySrc.get(rel) ?? 0) + (GROUND_SHEETS.includes(rel) ? 2 : 0),
    candidates: singleSubjectCells(img, 1).length + singleSubjectCells(img, 2).length,
  })

  lines.push(`### \`${rel.split('/').pop()}\``)
  lines.push('')
  lines.push(`${img.width} x ${img.height} — ${kind}`)
  lines.push('')

  const fills = grid.filter((t) => t.wrap < 5)
  if (fills.length) {
    const flat = fills.filter((t) => t.colours === 1)
    const textured = fills.filter((t) => t.colours > 1)
    lines.push('Self-tiling tiles (usable as ground fill):')
    lines.push('')
    if (flat.length) {
      lines.push(
        `- flat: ${flat.map((t) => `(${t.col},${t.row})`).join(' ')} — all \`${flat[0].sample}\``,
      )
    }
    for (const t of textured) {
      lines.push(`- textured: (${t.col},${t.row}) — ${t.colours} colours, wrap ${t.wrap}`)
    }
    lines.push('')
  }

  for (const span of [1, 2]) {
    const cells = singleSubjectCells(img, span)
    if (!cells.length) continue
    lines.push(
      `Single-subject ${span === 1 ? 'cells' : `${span}x${span} blocks`} ` +
        '(safe to scatter — one blob, on the baseline, clear of its neighbours):',
    )
    lines.push('')
    lines.push('```')
    for (const c of cells) lines.push(`cell(${c.col}, ${c.row}${span > 1 ? `, ${span}` : ''})   ${c.px} px, bottom gap ${c.gap}`)
    lines.push('```')
    lines.push('')
  }

  if (comps.length && comps.length <= 120 && kind !== 'single sprite') {
    const small = comps.filter((c) => c.w <= 48 && c.h <= 48)
    if (small.length) {
      lines.push(`Sprites (${small.length} of ${comps.length} components are sprite-sized):`)
      lines.push('')
      lines.push('```')
      for (const c of small) lines.push(`[${c.x}, ${c.y}, ${c.w}, ${c.h}]  ${c.px} px`)
      lines.push('```')
      lines.push('')
    }
  } else if (comps.length > 120) {
    lines.push(`${comps.length} components — too dense to list; a packed grid or a large collage.`)
    lines.push('')
  }
}

lines.push('')
lines.push('## Coverage')
lines.push('')
{
  const usedFiles = new Set(entries.map((e) => e.src))
  for (const g of GROUND_SHEETS) usedFiles.add(g)
  const byPack = new Map()
  for (const file of files) {
    const rel = relative(ART, file)
    const pack = rel.split('/')[0]
    const p = byPack.get(pack) ?? { used: 0, total: 0 }
    p.total++
    if (usedFiles.has(rel)) p.used++
    byPack.set(pack, p)
  }
  lines.push('Files touched, by pack:')
  lines.push('')
  lines.push('| pack | files used | files total | share |')
  lines.push('|---|---:|---:|---:|')
  let tu = 0
  let tt = 0
  for (const [pack, p] of [...byPack].sort((a, b) => b[1].total - a[1].total)) {
    tu += p.used
    tt += p.total
    lines.push(`| ${pack} | ${p.used} | ${p.total} | ${Math.round((100 * p.used) / p.total)}% |`)
  }
  lines.push(`| **all** | **${tu}** | **${tt}** | **${Math.round((100 * tu) / tt)}%** |`)
  lines.push('')
  lines.push(`${entries.length} sprites are packed from those files.`)
  lines.push('')
  lines.push('Within the sheets that are used, how much of the sheet:')
  lines.push('')
  lines.push('| sheet | sprites taken | single-subject candidates |')
  lines.push('|---|---:|---:|')
  for (const c of coverage.filter((c) => c.used > 0).sort((a, b) => b.candidates - a.candidates)) {
    lines.push(`| \`${c.rel}\` | ${c.used} | ${c.candidates} |`)
  }
  lines.push('')
}

lines.push('## Aggregated')
lines.push('')
lines.push(
  `- **${creatureCount}** creature sprite sheets and icons across the faction folders. ` +
    'Sheets are 4 columns x 5 rows of 16px cells (a few have a 6th row); rows are ' +
    'Idle / Walk / Attack / Damage / Death. Two tiers per creature, `_0_` and `_1_`.',
)
lines.push(
  `- **${buildingCount}** individual building, resource and treasure PNGs in ` +
    '`HAS Buildings Pack` — one subject per file, no rect needed.',
)
lines.push('')

writeFileSync(join(ROOT, 'tools', 'ART-SURVEY.md'), lines.join('\n'))
console.log(
  `survey-art: ${files.length} PNGs → tools/ART-SURVEY.md ` +
    `(${creatureCount} creature files and ${buildingCount} building files aggregated)`,
)
