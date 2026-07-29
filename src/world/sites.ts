/**
 * Map sites: the things that stand on the terrain.
 *
 * Pure TypeScript, no three.js — same rule as the rest of `world/`. Placement
 * rules come next; for now this holds the terrain edit that every site needs.
 */

import { spritesWithRole } from '../assets/sprites'
import type { SpriteKey } from '../assets/sprites'
import { spriteWidthOf } from '../assets/spriteScale'
import type { Heightmap } from './heightmap'
import { sampleHeightAndGradient } from './heightmap'
import { BIOMES, sampleBiomeAt } from './biome'
import type { BiomeField } from './biome'
import type { City } from './cities'
import { fbm, makeNoise2D } from './noise'
import { makeRng } from './prng'

/** A levelled patch of ground for one site to stand on. */
export interface SitePad {
  /** World XZ of the site. */
  x: number
  z: number
  /** World-unit radius of the flat area. Should cover the card's footprint. */
  radius: number
}

/** One scattered prop: a world position and which sprite to draw there. */
export interface DecoSpot {
  x: number
  z: number
  /** Sprite key, chosen from the owning territory's scatter set. */
  sprite: string
  /** 0..1 size jitter, so a stand of trees isn't a row of clones. */
  size: number
}

/** Everything the scatter needs to know about the terrain it is dressing. */
export interface ScatterTerrain {
  hm: Heightmap
  cellSize: number
  heightScale: number
  seaLevel: number
}

/**
 * Pick a sprite from whichever territory owns this point.
 *
 * `r` is a single 0..1 roll cut into three bands: the bottom `litterShare`
 * selects ground clutter, the next `reliefShare` selects the territory's
 * mountain, and the rest selects canopy — rescaled in each case to index that
 * list. One roll rather than three keeps the random stream, and so the whole
 * map, from shifting whenever the split changes.
 *
 * Both lists are indices into the territory's own sheets rather than sprite
 * keys, so the key is built from `ground` at the last moment and litter and
 * canopy can never drift onto a sheet the ground did not come from. A canopy
 * entry that is already a string is one the sheet does not draw — see
 * `Biome.canopy`.
 */
function spriteFor(field: BiomeField | null, x: number, z: number, r: number): string {
  const b = field ? BIOMES[sampleBiomeAt(field, x, z).a] : BIOMES[0]
  const pick = <T>(set: readonly T[], t: number): T =>
    set[Math.min(set.length - 1, Math.floor(t * set.length))]

  if (b.litter.length > 0 && r < b.litterShare) {
    const i = pick(b.litter, r / b.litterShare)
    return `prop.${b.ground}.${i}`
  }

  const afterLitter = r - b.litterShare
  if (afterLitter < b.reliefShare) return b.relief

  const rest = 1 - b.litterShare - b.reliefShare
  const t = rest > 0 ? (afterLitter - b.reliefShare) / rest : 0
  if (b.canopy.length === 0) return `prop.${b.ground}.${pick(b.litter, t)}`
  const c = pick(b.canopy, t)
  return typeof c === 'number' ? `tree.${b.ground}.${c}` : c
}

/** How much this territory grows, 0..1. */
function densityFor(field: BiomeField | null, x: number, z: number): number {
  return field ? BIOMES[sampleBiomeAt(field, x, z).a].density : 0.5
}

/**
 * Dress the whole island, not just the sites.
 *
 * This art has no ground texture — every sheet in the overworld pack is flat
 * colour plus discrete props — so scatter *is* the terrain detail, and it is
 * what makes one territory look different from another at a glance. Colour
 * alone reads as a tint; a wildwood you cannot see through next to an ashland
 * with three rocks in it reads as two places.
 *
 * Candidates come from a jittered grid rather than random points: random
 * scatter clumps and leaves bald patches, which on open ground looks like a
 * bug rather than like nature.
 */
export function scatterDecorations(
  terrain: ScatterTerrain,
  field: BiomeField | null,
  seed: string,
  opts: {
    spacing: number
    avoid: readonly SitePad[]
    maxCount: number
    /** World units across a typical stand of vegetation. */
    blobScale: number
  },
): DecoSpot[] {
  const { hm, cellSize, heightScale, seaLevel } = terrain
  const cells = hm.size - 1
  const worldSize = cells * cellSize
  const half = worldSize / 2
  const rng = makeRng(seed, 'scatter')
  const step = Math.max(1, opts.spacing)
  const out: DecoSpot[] = []

  // Where the woodland is, as opposed to how dense it is once you are in it.
  //
  // Three octaves, not one. A single smooth octave thresholded at a high
  // coverage is nearly always above the line, so the stands merge into one mass
  // and the result reads as an even sprinkle — which is exactly what one octave
  // produced. Layering breaks the level set into ragged patches of varied size
  // with real gaps between them, and it is the ragged *edge* that makes a wood
  // look like a place rather than a fill pattern.
  const blob = makeNoise2D(makeRng(seed, 'scatterBlob'))
  const blobFreq = 1 / Math.max(8, opts.blobScale)

  let ix = 0
  let iz = 0
  for (let z = -half + step * 0.5; z < half; z += step, iz++) {
    ix = 0
    for (let x = -half + step * 0.5; x < half; x += step, ix++) {
      // Diagonal checkerboard: keep every other cell, offset row by row.
      //
      // This is how the tileset itself draws a wood — its clumps are diamond
      // lattices, not square grids — and it is why dense vegetation in this art
      // style reads as canopy rather than as a printed grid. It also halves the
      // instance count for free.
      if (((ix + iz) & 1) === 1) continue
      // Draw every random value for this candidate up front, before any
      // branching, or the stream desynchronises and the same seed stops
      // producing the same island.
      const jx = rng()
      const jz = rng()
      const keep = rng()
      const pick = rng()
      const size = rng()

      const px = x + (jx - 0.5) * step
      const pz = z + (jz - 0.5) * step

      // Grid space, clamped clear of the last cell for the bilinear sampler.
      const gx = Math.min(cells - 1.001, Math.max(0, (px + half) / cellSize))
      const gz = Math.min(cells - 1.001, Math.max(0, (pz + half) / cellSize))
      const g = sampleHeightAndGradient(hm.data, hm.size, gx, gz)

      // Nothing grows in the sea, and the margin keeps props out of the
      // shoreline fade where they would appear to be standing in the surf.
      if (g.height <= seaLevel + 0.012) continue

      // Nor on a cliff. Same slope metric the colour ramp bands on, so scatter
      // stops exactly where the terrain starts being painted as bare rock.
      const dx = (g.gradX * heightScale) / cellSize
      const dz = (g.gradZ * heightScale) / cellSize
      const slope = 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz)
      if (slope > 0.55) continue

      // Inside a stand or out in the open? `density` is the fraction of the
      // territory its vegetation covers, so a wildwood is nearly closed canopy
      // and an ashland is a few things clinging on.
      const cover = densityFor(field, px, pz)
      const b = (fbm(blob, px * blobFreq, pz * blobFreq, 3, 1, 2.1, 0.55) + 1) * 0.5
      // Only a whisper of per-point jitter. More than this and the stand's edge
      // dissolves into the same even scatter the octaves were added to avoid;
      // this is just enough that the treeline is not a drawn contour.
      if (b + (keep - 0.5) * 0.1 > cover) continue

      // Keep clear of the levelled site pads — a building wants its clearing.
      let blocked = false
      for (const pad of opts.avoid) {
        if (pad.radius <= 0) continue
        const ax = pad.x - px
        const az = pad.z - pz
        if (ax * ax + az * az < pad.radius * pad.radius) {
          blocked = true
          break
        }
      }
      if (blocked) continue

      out.push({ x: px, z: pz, sprite: spriteFor(field, px, pz, pick), size })
      if (out.length >= opts.maxCount) return out
    }
  }

  return out
}

/**
 * Points walked evenly around a circle — or around an arc of one — jittered
 * within their own step.
 *
 * Even angular steps rather than fully random angles: pure random clumps and
 * leaves bald arcs, which reads as a mistake rather than as nature. `skip` is
 * the chance of dropping a step, so the result never closes into a suspiciously
 * neat hedge — or, for a settlement, a ring of teeth.
 *
 * `start` and `sweep` cover the arc, defaulting to the whole circle. A
 * settlement uses them to leave the arc its town already occupies alone, which
 * is the difference between houses beside the keep and houses inside it.
 *
 * An open arc puts its first and last point *on* its ends rather than half a
 * step inside them. A closed ring has no ends and must not — its first and last
 * points are neighbours, and seating them both on the seam would double up
 * there. The distinction matters: spacing an arc as though it were closed
 * leaves half a step of nothing at each end, which around a settlement reads as
 * the town having been shouldered out of its own circle.
 *
 * All three values for a step are drawn before anything is decided, so the
 * stream does not depend on which steps survive.
 */
function ringPoints(
  cx: number,
  cz: number,
  count: number,
  rng: () => number,
  opts: { inner: number; outer: number; skip: number; start?: number; sweep?: number },
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []
  if (count <= 1) return out

  const start = opts.start ?? 0
  const sweep = opts.sweep ?? Math.PI * 2
  const closed = sweep >= Math.PI * 2 - 1e-6
  const step = sweep / (closed ? count : count - 1)
  for (let i = 0; i < count; i++) {
    const drop = rng()
    const spin = rng()
    const reach = rng()
    if (drop < opts.skip) continue

    const angle = start + i * step + (spin - 0.5) * step * 0.8
    const r = opts.inner + (opts.outer - opts.inner) * reach
    out.push({ x: cx + Math.cos(angle) * r, z: cz + Math.sin(angle) * r })
  }
  return out
}

/**
 * The village ring, as multiples of the town card's own width.
 *
 * These live here rather than in `main.ts` because two things read them and
 * they have to agree: `settlementLayout` places the houses on the ring, and
 * `capitalClearing` levels the ground the ring stands on. When the two were
 * derived separately, the terrace was cut to one radius and the houses seated
 * on another, which shows as the tallest card in the game standing half off
 * its own terrace.
 */
export const VILLAGE_INNER = 0.92
export const VILLAGE_OUTER = 1.16
/** Slack beyond the outer ring, so the far edge of a house is still on flat ground. */
export const VILLAGE_MARGIN = 1.06

/**
 * How much flat ground a capital needs: its whole village ring, plus the half
 * card-width the outermost building overhangs by, plus the margin.
 *
 * A function of the atlas rather than a constant, so that rescaling the art
 * cannot silently leave every town on a terrace that no longer fits it. Pure
 * arithmetic over generated data — `world/` still imports no three.js, and a
 * headless tool gets the same number the renderer does.
 */
export function capitalClearing(pixelScale?: number): number {
  const townWidth = spriteWidthOf('city.castle', pixelScale)
  return (townWidth * VILLAGE_OUTER + townWidth * 0.5) * VILLAGE_MARGIN
}

/**
 * How much flat ground a lone building needs — its own footprint and no more.
 *
 * Every non-capital site used to be terraced to its `radius`, which is not a
 * measure of the building at all: it is the defender leash and the ownership
 * disc, and it runs from 24 at a camp to 48 at a city. A lair's card is
 * **five world units wide**, so it was levelling a 40-unit disc and grading a
 * skirt to 80 for something the size of a cart — a 160-unit scar around a
 * building you can barely see, which is most of why the island read as bare.
 * The clearings were also what forced the placement gaps apart, so this is the
 * change that lets the map carry real content density.
 *
 * A capital is the exception and keeps `capitalClearing`, because it genuinely
 * has a village standing around it.
 */
export function siteClearing(sprite: SpriteKey, pixelScale?: number): number {
  const width = spriteWidthOf(sprite, pixelScale)
  // Half the card, plus the same margin the village ring uses. Half a width is
  // the real footprint: a card is centred on its site, so it overhangs by half
  // in every direction and nothing beyond that is standing on the terrace.
  return width * 0.5 * VILLAGE_MARGIN
}

/** A capital and the village drawn around it. */
export interface Settlement {
  /** The capital this village belongs to. */
  city: City
  /**
   * Where the town card stands — on the ring, not in the middle of it. The
   * capital's own coordinate stays the *plaza* centre, which is what the
   * territory, the terrace and the fog are all anchored to.
   */
  town: { x: number; z: number }
  /** The lesser buildings, completing the circle the town starts. */
  buildings: DecoSpot[]
}

/**
 * Which way round the ring the town sits, as an angle in the same convention
 * `ringPoints` uses — so -90° is -Z, due north of the plaza.
 *
 * North is the far side of the board: the camera rests due south of its target
 * and eases back to north-up whenever it is let go, so the northern arc is the
 * one that draws behind everything else in the village. That makes the town the
 * back wall of the circle from the resting view, with its houses curving toward
 * the camera on both sides.
 */
const TOWN_BEARING = -Math.PI / 2

/**
 * How far a town may drift off due north, in radians either side.
 *
 * Every capital squared to the same bearing makes fifteen villages that are
 * visibly one village stamped fifteen times. A fifth of a radian — about 11° —
 * is enough that no two rings line up, and far short of enough to stop the town
 * reading as the back of its own circle.
 */
const TOWN_LEAN = 0.2

/**
 * Clear space either side of the town, as a multiple of its half-width.
 *
 * The town is a card that yaw-billboards, so it sweeps its full width as the
 * camera orbits; the houses have to start outside that sweep or they will pass
 * through it from some bearings. The extra quarter is about one house-width of
 * gap — enough that the town keeps its own silhouette, close enough that the
 * arc still reads as continuing into it rather than as stopping short of it.
 */
const TOWN_CLEARANCE = 1.25

/**
 * Spacing between houses around the ring, as a multiple of the town's width.
 *
 * A house is about a fifth of a town wide, so this is roughly a house-and-a-half
 * of pitch: neighbours nearly touch, which is what makes the arc read as a
 * street rather than as scattered sheds. Derived from the town's width rather
 * than fixed in world units so that rescaling the art keeps the ring equally
 * crowded instead of quietly thinning it into a dotted line.
 */
const HOUSE_PITCH = 0.28

/**
 * Grow a village around each capital.
 *
 * A 64px town alone on open ground reads as a sprite that was dropped there.
 * The same town with a dozen huts around it reads as a place, and the huts are
 * what actually catch the eye from strategy altitude — one large silhouette is a
 * marker, a cluster of small ones is a settlement.
 *
 * The town stands *on* the ring rather than inside it. Centring it was the
 * earlier arrangement, and it defended itself on billboarding grounds — a
 * rearward offset reads correctly from one bearing and puts the town in front of
 * its own houses from the opposite one. True, but it costs the thing the layout
 * is actually for: a town in the middle fills the middle, and the middle is
 * where an army has to be able to stand. So the town takes the northern arc of
 * the circle, the houses take the rest of it, and what is left is an empty plaza
 * with a wall of buildings all the way round it.
 *
 * Buildings are chosen by role and biome affinity out of the generated manifest
 * rather than from a list here, so the Frostmark gets its snow-roofed set and
 * the Ashlands their tents without this function knowing either exists.
 */
export function settlementLayout(
  cities: readonly City[],
  seed: string,
  opts: {
    /** Innermost radius a house may stand at. */
    inner: number
    /** The ring proper: where the town stands, and the outer edge of the houses. */
    outer: number
    /** World width of the town card, which sets its arc and the house pitch. */
    townWidth: number
  },
): Settlement[] {
  const rng = makeRng(seed, 'settlement')
  const out: Settlement[] = []

  for (const city of cities) {
    // Drawn before anything is decided, so a biome with no building kit does not
    // desynchronise the stream for every village after it.
    const lean = (rng() * 2 - 1) * TOWN_LEAN
    const kit = spritesWithRole('settlement', BIOMES[city.biome].id)

    const bearing = TOWN_BEARING + lean
    const town = {
      x: city.x + Math.cos(bearing) * opts.outer,
      z: city.z + Math.sin(bearing) * opts.outer,
    }
    if (kit.length === 0) {
      out.push({ city, town, buildings: [] })
      continue
    }

    // The arc the town itself takes out of the circle, measured at the radius it
    // stands on — a wide card close in blocks far more of the ring than the same
    // card further out, and the houses have to know which.
    const blocked = Math.atan2(opts.townWidth * 0.5 * TOWN_CLEARANCE, opts.outer)
    const sweep = Math.PI * 2 - blocked * 2

    // Count follows the arc that is actually free, so the ring keeps its density
    // whether the town is hogging a fifth of it or a tenth.
    const mid = (opts.inner + opts.outer) * 0.5
    const count = Math.max(3, Math.round((sweep * mid) / (opts.townWidth * HOUSE_PITCH)))

    const buildings: DecoSpot[] = []
    for (const pt of ringPoints(city.x, city.z, count, rng, {
      inner: opts.inner,
      outer: opts.outer,
      // Barely any. The old ring was decoration around a town and could afford
      // gaps; this one is the wall of the plaza, and a hole in it reads as a
      // missing building rather than as a lane.
      skip: 0.08,
      start: bearing + blocked,
      sweep,
    })) {
      const pick = rng()
      const size = rng()
      buildings.push({
        x: pt.x,
        z: pt.z,
        sprite: kit[Math.floor(pick * kit.length)],
        size,
      })
    }

    out.push({ city, town, buildings })
  }

  return out
}

/**
 * Scatter props in a loose ring around each site's clearing.
 *
 * A building alone on open grass reads as a sprite dropped on the terrain. The
 * same building inside a ragged ring of trees reads as a clearing someone made
 * — and the ring is what actually catches the eye from strategy altitude, since
 * a broken circle of dark green against open ground is a far stronger signal
 * than a small building is on its own.
 *
 * Deterministic from the world seed, so the same map always grows the same
 * trees. Props are placed in the annulus *outside* the levelled pad: inside it
 * they would crowd the building, and the pad edge is exactly where the ground
 * stops being flat, which is a natural treeline.
 */
export function ringDecorations(
  rings: SitePad[],
  seed: string,
  field: BiomeField | null,
  opts: { spacing: number },
): DecoSpot[] {
  const rng = makeRng(seed, 'deco')
  const out: DecoSpot[] = []

  for (const pad of rings) {
    if (pad.radius <= 0) continue

    // Count follows circumference over the caller's spacing, so the ring stays
    // as dense when everything is scaled down. Deriving it from a fixed world
    // distance instead would silently thin a treeline into two shrubs the
    // moment the sprites shrank.
    const count = Math.round((2 * Math.PI * pad.radius) / Math.max(0.5, opts.spacing))

    for (const pt of ringPoints(pad.x, pad.z, count, rng, {
      inner: pad.radius * 1.08,
      outer: pad.radius * 1.63,
      skip: 0.18,
    })) {
      const pick = rng()
      const size = rng()
      // The ring belongs to whichever territory the site stands in, so a
      // Blight outpost is fringed with dead stumps and a Wildwood one with
      // mushroom-capped mangrove.
      out.push({ x: pt.x, z: pt.z, sprite: spriteFor(field, pt.x, pt.z, pick), size })
    }
  }

  return out
}

/**
 * Level the ground under each site.
 *
 * A card is a flat quad standing on a heightfield, so on any real slope its
 * bottom edge either floats clear at one end or drives into the hill at the
 * other — and because the card yaw-billboards, which end does which changes as
 * you orbit. Sampling tricks only trade one artefact for the other.
 *
 * Flattening removes the problem instead of hiding it, and it earns its keep
 * twice: a levelled terrace with a graded skirt is what a built place actually
 * looks like, so towns and mines read as sited rather than dropped.
 *
 * Mutates `hm` in place, so it must run on a freshly generated or freshly
 * eroded heightmap — never twice over the same data, or the skirts compound.
 */
export function flattenSitePads(hm: Heightmap, cellSize: number, pads: SitePad[]): void {
  const size = hm.size
  const half = ((size - 1) * cellSize) / 2
  // The graded skirt runs out to this multiple of the flat radius. Without it
  // the pad is a mesa with vertical walls, which the terrain's slope-driven
  // rock colouring then paints as a cliff ring. Kept at 2 rather than higher:
  // the skirt should read as the cut-and-fill around a terrace, and once it is
  // several times the pad it starts smoothing the hill the terrace sits on.
  const SKIRT = 2.0

  for (const pad of pads) {
    // A zero radius means "sits in the landscape, don't reshape it" — scattered
    // decoration rather than a built site.
    if (pad.radius <= 0) continue
    const outer = pad.radius * SKIRT
    // World XZ to grid space; the grid starts at 0 where the world starts at -half.
    const cx = (pad.x + half) / cellSize
    const cz = (pad.z + half) / cellSize
    const rFlat = pad.radius / cellSize
    const rOuter = outer / cellSize

    const x0 = Math.max(0, Math.floor(cx - rOuter))
    const x1 = Math.min(size - 1, Math.ceil(cx + rOuter))
    const z0 = Math.max(0, Math.floor(cz - rOuter))
    const z1 = Math.min(size - 1, Math.ceil(cz + rOuter))
    if (x0 > x1 || z0 > z1) continue

    // Target height is the mean over the flat area rather than the height at the
    // centre point: on a slope the mean sits half in cut and half in fill, so
    // the terrace looks cut into the hill instead of perched on top of it.
    let sum = 0
    let n = 0
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx
        const dz = z - cz
        if (dx * dx + dz * dz > rFlat * rFlat) continue
        sum += hm.get(x, z)
        n++
      }
    }
    if (n === 0) continue
    const target = sum / n

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx
        const dz = z - cz
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d > rOuter) continue

        // 1 inside the pad, easing to 0 at the outer edge of the skirt.
        let w: number
        if (d <= rFlat) {
          w = 1
        } else {
          const t = (d - rFlat) / Math.max(1e-5, rOuter - rFlat)
          const s = 1 - t
          w = s * s * (3 - 2 * s) // smoothstep, falling
        }

        const h = hm.get(x, z)
        hm.set(x, z, h + (target - h) * w)
      }
    }
  }
}
