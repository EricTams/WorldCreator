/**
 * Extract each biome's base ground tile into an embedded texture strip.
 *
 *   npm run pack-ground
 *
 * The overworld tilesets are autotile sheets: props on top, coast and cliff
 * transitions in the middle, and one self-tiling fill tile per biome. That fill
 * tile is the only thing in the pack that is genuinely a *terrain texture*, and
 * it was found rather than guessed — of every 16x16 tile in every sheet, only
 * one is both fully opaque and wraps against itself with zero edge error.
 *
 * Output is a generated TS module rather than a PNG. The whole strip is 7 tiles
 * of 16x16 — under 8 KB raw — so embedding it costs less than the extra HTTP
 * request would, needs no async load before the first terrain build, and keeps
 * the committed binary count at one.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './png.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ART = join(ROOT, 'TempArt')
const TILE = 16

/**
 * The two ground tiles, taken from where the artist put them.
 *
 * Every sheet opens with its two ground surfaces stacked in the second column:
 * the flat fill at (1,0) and the textured alternate directly beneath it at
 * (1,1). They are a matched pair — same palette, same biome — and the alternate
 * is a full-coverage surface (grass thatch, dune ripples, cracked basalt with
 * red seams, cave cobbles), not a motif.
 *
 * Two earlier picks were wrong and are worth recording so they are not
 * rediscovered. (10,7) is a flat cell too, but an incidental one from the middle
 * of the autotile region; it gives the same colour by luck. (11,9) is not ground
 * at all — it is a slice of the stone-ring autotile, and it passed an automated
 * "does it wrap?" test only because the arc it contains happens to be
 * left-right symmetric. Tiled across a territory it stamps a grid of little
 * black arches. Wrap-cleanliness alone does not identify a ground texture; only
 * looking at it does.
 */
const BASE = { tx: 1, ty: 0 }

/**
 * The textured alternate. One, not several: the sheets contain exactly one
 * full-coverage surface per biome. The larger blocks lower down (rows 14-16)
 * are blend and transition patches — they tile against each other rather than
 * against themselves, so they belong to a future edge-blending pass, not here.
 *
 * The wrap seam is not checked for zero. This tile is high-frequency organic
 * grain, so its edge mismatch disappears into its own noise; demanding a clean
 * wrap is what selected the stone arch last time.
 */
const DETAIL = [{ tx: 1, ty: 1 }]

const BIOMES = [
  ['grass', 'GrassBiome/GB-LandTileset.png'],
  ['sand', 'SandBiome/SB-LandTileset.png'],
  ['marsh', 'MarshBiome/MB-LandTileset.png'],
  ['ice', 'IceBiome/IB-LandTileset.png'],
  ['lava', 'LavaBiome/LB-LandTileset.png'],
  ['cave', 'CaveBiome/CB-LandTileset.png'],
  ['dirt', 'DirtBiome/DB-LandTileset.png'],
]

if (!existsSync(ART)) {
  console.error(`\npack-ground: TempArt/ not found at ${ART}\n`)
  process.exit(1)
}

const VARIANTS = DETAIL.length
const W = TILE * BIOMES.length * VARIANTS
const strip = Buffer.alloc(W * TILE * 4)
const bases = []

BIOMES.forEach(([name, rel], i) => {
  const path = join(ART, rel)
  if (!existsSync(path)) {
    console.error(`\npack-ground: missing ${rel}\n`)
    process.exit(1)
  }
  const img = decodePng(readFileSync(path), rel)

  // The flat ground colour, read straight out of a fill cell.
  const bi = (BASE.ty * TILE * img.width + BASE.tx * TILE) * 4
  bases.push([img.data[bi], img.data[bi + 1], img.data[bi + 2]])

  DETAIL.forEach((det, v) => {
    const ox = det.tx * TILE
    const oy = det.ty * TILE

    // Mean luminance of the tile, so the detail can be stored as a ratio around
    // a neutral 1.0 rather than as an absolute brightness.
    let mean = 0
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const s = ((oy + y) * img.width + ox + x) * 4
        mean += 0.299 * img.data[s] + 0.587 * img.data[s + 1] + 0.114 * img.data[s + 2]
      }
    }
    mean = Math.max(1, mean / (TILE * TILE))

    const column = i * VARIANTS + v
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const s = ((oy + y) * img.width + ox + x) * 4
        const d = (y * W + column * TILE + x) * 4
        strip[d] = img.data[s]
        strip[d + 1] = img.data[s + 1]
        strip[d + 2] = img.data[s + 2]
        // Alpha carries luminance relative to the tile mean, encoded so 128 is
        // neutral. The shader multiplies the terrain's band colour by this,
        // which adds the tileset's texture without dragging its hue across
        // bands the biome does not own — grass detail must not tint a snow cap.
        const lum =
          0.299 * img.data[s] + 0.587 * img.data[s + 1] + 0.114 * img.data[s + 2]
        strip[d + 3] = Math.max(0, Math.min(255, Math.round((lum / mean) * 127.5)))
      }
    }
  })

  // Guard the two properties that actually matter, since neither is obvious by
  // eye at 16px: the base must be one flat colour, and the alternate must carry
  // real texture. A flat "alternate" means the cell reference has drifted onto a
  // fill tile and the ground would silently go back to looking painted.
  const spread = (tx, ty) => {
    let min = 255
    let max = 0
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const s = ((ty * TILE + y) * img.width + tx * TILE + x) * 4
        const lum = 0.299 * img.data[s] + 0.587 * img.data[s + 1] + 0.114 * img.data[s + 2]
        if (lum < min) min = lum
        if (lum > max) max = lum
      }
    }
    return max - min
  }

  if (spread(BASE.tx, BASE.ty) > 1) {
    console.warn(`pack-ground: ${name} base tile (${BASE.tx},${BASE.ty}) is not flat`)
  }
  if (spread(DETAIL[0].tx, DETAIL[0].ty) < 20) {
    console.warn(`pack-ground: ${name} alternate tile (${DETAIL[0].tx},${DETAIL[0].ty}) has no texture`)
  }
})

const ts = `// GENERATED by tools/packGround.mjs — do not edit.
// Run \`npm run pack-ground\` to regenerate (requires TempArt/).
//
// Art: Aleksandr Makarov (@IknowKingRabbit). See ART-CREDITS.md.
//
// One self-tiling ground tile per biome, laid out left to right in a single
// strip. RGBA, ${TILE}px square each.

export const GROUND_TILE = ${TILE}
export const GROUND_VARIANTS = ${VARIANTS}
export const GROUND_NAMES = [${BIOMES.map(([n]) => `'${n}'`).join(', ')}] as const
export type GroundName = (typeof GROUND_NAMES)[number]
export const GROUND_WIDTH = ${W}
export const GROUND_HEIGHT = ${TILE}

/**
 * The flat ground colour of each biome, sRGB 0-255, as the artist left it in the
 * sheet's fill cells. This is the terrain's base; the strip below is only the
 * variety sprinkled on top of it.
 */
export const GROUND_BASE: readonly (readonly [number, number, number])[] = [
${bases.map((c, i) => `  [${c.join(', ')}], // ${BIOMES[i][0]}`).join('\n')}
]

/**
 * One *variety* tile per biome, RGBA base64. RGB is the tile as drawn; alpha
 * carries its luminance relative to the tile's own mean, so the shader can use
 * it as a brightness modulation that leaves the base hue alone.
 */
export const GROUND_DATA =
  '${strip.toString('base64')}'
`

writeFileSync(join(ROOT, 'src', 'assets', 'groundTiles.ts'), ts)
console.log(
  `pack-ground: ${BIOMES.length} biomes x ${VARIANTS} variety tiles → ${W}x${TILE} strip ` +
    `(${(strip.length / 1024).toFixed(1)} KB raw, ${(strip.toString('base64').length / 1024).toFixed(1)} KB base64)`,
)
