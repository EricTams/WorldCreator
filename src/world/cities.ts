/**
 * Where the capitals stand — and therefore where the territories are.
 *
 * `biome.ts` argues that a territory should be a region someone drew rather than
 * a climate that fell out of noise, and it seeded those regions at random points
 * inside a disc. That gave controllable territories sitting nowhere in
 * particular: the city belonging to a region was a hardcoded coordinate that had
 * no idea where its own region was, and a territory's centre was as likely to be
 * a cliff face as a plain.
 *
 * This inverts it. Cities are placed first, on ground that suits a city — flat,
 * clear of the tideline, out of the rock bands — and the biome field is then
 * seeded from those points. A territory becomes *the land around its capital*,
 * which is both the thing the map is trying to say and the reason the borders
 * end up somewhere defensible instead of somewhere arbitrary.
 *
 * Placing them well is the hard half, because a capital does not only have to
 * stand somewhere plausible — it has to *carve a sensible territory*, and one
 * good site next to another good site produces two thin slivers while a good
 * site alone in a quarter of the island produces a region the size of a
 * continent. A single scoring pass cannot see that: the score of a spot is a
 * property of the ground under it, and the size of a territory is a property of
 * where all the *other* capitals ended up.
 *
 * So placement is a loop. Site the capitals, rasterise the territories they
 * imply, measure the land each one actually holds, move the capitals that got
 * the balance wrong, and measure again — keeping the best arrangement seen
 * rather than the last one, so a round can never make the map worse.
 *
 * Pure TypeScript, no three.js — same rule as the rest of `world/`.
 */

import { BIOMES } from './biome'
import { makeRng } from './prng'
import type { TerrainFrame } from './terrainQuery'
import { terrainHeightAt, terrainSlopeAt, worldHalfExtent } from './terrainQuery'

/** A capital, and the territory it defines. */
export interface City {
  x: number
  z: number
  /** Index into `BIOMES`. */
  biome: number
  /** True for exactly one city: the territory the avatar starts in. */
  player: boolean
}

export interface CityParams {
  /**
   * How many capitals to place. Not capped at the number of biomes — a faction
   * holds several cities, and its territory is however many of their cells
   * happen to adjoin.
   */
  count: number
  /**
   * World-unit radius of flat ground a capital wants around it. Slope is
   * sampled on a ring at this distance as well as at the centre, because the
   * settlement levels a pad this big and a terrace cut into a hillside reads as
   * a quarry.
   */
  clearing: number
  /**
   * Ground already spoken for, which no capital may stand on.
   *
   * The Points of Power are placed before the cities — they are the victory
   * condition and the most contested ground on the board, so they pick first
   * and everything else fits around them. A capital cannot be moved once it
   * has a village and a territory, so the only way to give the points first
   * refusal is to tell city placement where they went.
   */
  reserved?: readonly { x: number; z: number; radius: number }[]
}

/**
 * How steep the ground under a capital may be, on `terrainSlopeAt`'s scale.
 *
 * Well under the 0.55 the scatter allows itself. A tree on a slope is a tree on
 * a slope; a town on one is a levelled mesa with a graded skirt, and the skirt
 * is what the terrain's slope-driven colouring then paints as a ring of cliff.
 */
const MAX_SLOPE = 0.22

/**
 * The band of the elevation ramp a capital may sit in, in `colorRamp`'s
 * normalised `e` — 0 at the waterline, 1 at the summit.
 *
 * The floor keeps towns off the beach: below 0.03 the ramp paints sand, and a
 * capital in the surf reads as a mistake even when the ground is flat. The
 * ceiling keeps them out of the rock bands, which begin blending at 0.55.
 */
const MIN_BAND = 0.05
const MAX_BAND = 0.5
/** The elevation a capital most wants — low, open country a little above the sea. */
const IDEAL_BAND = 0.14

/**
 * Resolution of the grid this file does all its work on — site scores, the land
 * mask, and the territory areas measured against it.
 *
 * One grid rather than three, because the three have to agree. Measuring area on
 * a finer raster than the one candidate sites were drawn from would let the loop
 * chase a balance it has no move available to reach.
 *
 * 96 across a 2 km island is about 21 world units a cell, comfortably finer than
 * the ~380 unit territories being measured, and 9216 cells is cheap enough to
 * rasterise a dozen times inside a single regenerate.
 */
const GRID = 96

/**
 * How many measure-and-adjust rounds to run.
 *
 * Lloyd relaxation converges quickly — most of the correction lands in the first
 * three or four rounds — but each relocation of a starved capital perturbs its
 * new neighbours and needs a few rounds of settling afterwards. Fourteen leaves
 * room for two or three relocations to settle. It is a ceiling, not a target:
 * the loop stops as soon as the balance is good enough.
 */
const ROUNDS = 14

/**
 * How much more than a fair share the largest territory may hold before the loop
 * keeps working, as a multiple of `land / count`.
 *
 * Not 1.0. Territories are Voronoi cells clipped to a coastline, and a coastline
 * is not a shape that can be divided into fifteen equal parts by points — a
 * peninsula is one region or two, never one and a half. Insisting on exact
 * equality would drag capitals off good ground chasing a target the geometry
 * cannot reach. 1.4 is "no territory is conspicuously bigger than its
 * neighbours", which is what the eye actually reads.
 */
const AREA_TOLERANCE = 1.4

/** Ring offsets used to test whether a *patch* is flat, not just a point. */
const RING = [
  [1, 0],
  [0.707, 0.707],
  [0, 1],
  [-0.707, 0.707],
  [-1, 0],
  [-0.707, -0.707],
  [0, -1],
  [0.707, -0.707],
]

/**
 * How good this spot is for a capital, or -1 for "not one".
 *
 * The two terms are deliberately unequal. Flatness is most of the score because
 * it is what the eye reads — a town on a visibly level plain looks sited, and
 * everything else is a preference. Elevation only breaks ties between flat
 * places, pulling towns down into open country rather than onto the high
 * plateaus that erosion tends to leave conveniently flat.
 */
function scoreSite(frame: TerrainFrame, x: number, z: number, clearing: number): number {
  const seaY = frame.seaLevel * frame.heightScale
  const height = terrainHeightAt(frame, x, z)
  if (height <= seaY) return -1

  // Same normalisation the colour ramp bands on, so "out of the rock" here means
  // out of the rock the player can see.
  const e = (height / frame.heightScale - frame.seaLevel) / (1 - frame.seaLevel)
  if (e < MIN_BAND || e > MAX_BAND) return -1

  // Worst slope over the clearing, not the slope at its centre. A saddle is flat
  // at exactly one point and unusable a step in any direction.
  let worst = terrainSlopeAt(frame, x, z)
  for (const [ox, oz] of RING) {
    const rx = x + ox * clearing
    const rz = z + oz * clearing
    // A clearing that runs into the sea is not a clearing.
    if (terrainHeightAt(frame, rx, rz) <= seaY) return -1
    const s = terrainSlopeAt(frame, rx, rz)
    if (s > worst) worst = s
  }
  if (worst > MAX_SLOPE) return -1

  const flat = 1 - worst / MAX_SLOPE
  const band = 1 - Math.min(1, Math.abs(e - IDEAL_BAND) / 0.4)
  return flat * 0.75 + band * 0.25
}

/**
 * The island, surveyed once: which cells are dry, and which of those a capital
 * could stand on.
 *
 * Deliberately covers the whole map rather than an inner disc. The old placement
 * confined capitals to the middle 62% of the map on the argument that a region
 * centred near the coast spends most of its area in the sea — true, but it left
 * 43% of the island's *land* in a ring no capital could ever occupy, and every
 * cell of that ring fell to whichever inland city happened to be nearest. That
 * one rule was the largest single source of oversized territories.
 *
 * Nothing is lost by dropping it, because the two things it was standing in for
 * are now enforced directly: `scoreSite` already rejects anything within
 * `clearing` of the water, so a capital cannot end up on a spit, and the
 * balancing loop below measures a coastal capital's actual holding and moves it
 * inland if that holding is thin.
 */
interface Survey {
  /** Site quality per cell, -1 where a capital may not stand. */
  score: Float32Array
  /** 1 where the cell is dry land. */
  land: Uint8Array
  landCells: number
  step: number
  half: number
}

function surveyIsland(
  frame: TerrainFrame,
  rng: () => number,
  clearing: number,
  reserved: readonly { x: number; z: number; radius: number }[] = [],
): Survey {
  const half = worldHalfExtent(frame)
  const step = (half * 2) / GRID
  const seaY = frame.seaLevel * frame.heightScale
  const score = new Float32Array(GRID * GRID)
  const land = new Uint8Array(GRID * GRID)
  let landCells = 0

  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const k = j * GRID + i
      const x = -half + (i + 0.5) * step
      const z = -half + (j + 0.5) * step
      // Drawn before the rejection test, not after, so the stream does not
      // depend on the terrain — the same convention the scatter loop follows.
      const jitter = 0.92 + rng() * 0.16
      if (terrainHeightAt(frame, x, z) > seaY) {
        land[k] = 1
        landCells++
      }
      const s = scoreSite(frame, x, z, clearing)
      score[k] = s < 0 ? -1 : s * jitter
      // Ground the Points of Power already took. Marked in `score` rather than
      // filtered later because every stage below — the best-first pick, the
      // relaxation in `siteNear`, the split — reads this one grid, so blocking
      // a cell here blocks it everywhere without teaching three algorithms
      // about points. `land` is deliberately untouched: the territory still
      // covers that ground, no capital may merely stand on it.
      for (const r of reserved) {
        if (Math.hypot(r.x - x, r.z - z) < r.radius) {
          score[k] = -1
          break
        }
      }
    }
  }

  return { score, land, landCells, step, half }
}

function cellX(s: Survey, i: number): number {
  return -s.half + (i + 0.5) * s.step
}

/** What a capital ended up holding, once the land was divided between them. */
interface Holding {
  /** Land cells owned. */
  cells: number
  /** Centre of mass of that land. */
  cx: number
  cz: number
  /** The owned cell furthest from the capital — where a split would go. */
  farX: number
  farZ: number
}

/**
 * Divide the land between the capitals and measure what each one got.
 *
 * Nearest-capital, matching `sampleBiomeAt` — with one deliberate omission. That
 * function displaces the query point through a noise warp before the search, and
 * this does not, because the warp's amplitude is derived from the spacing of the
 * capitals and so cannot be known until placement has finished. The warp is
 * zero-mean and capped well below the cell size, so it moves a border about
 * without changing much area; measuring the unwarped division is close enough
 * for a loop whose job is to catch a territory three times its neighbour's size.
 */
function divide(s: Survey, caps: readonly { x: number; z: number }[]): Holding[] {
  const held: Holding[] = caps.map((c) => ({
    cells: 0,
    cx: 0,
    cz: 0,
    farX: c.x,
    farZ: c.z,
  }))
  const farD = new Float64Array(caps.length)

  for (let j = 0; j < GRID; j++) {
    const z = cellX(s, j)
    for (let i = 0; i < GRID; i++) {
      if (!s.land[j * GRID + i]) continue
      const x = cellX(s, i)

      let best = 0
      let bestD = Infinity
      for (let c = 0; c < caps.length; c++) {
        const dx = caps[c].x - x
        const dz = caps[c].z - z
        const d = dx * dx + dz * dz
        if (d < bestD) {
          bestD = d
          best = c
        }
      }

      const h = held[best]
      h.cells++
      h.cx += x
      h.cz += z
      if (bestD > farD[best]) {
        farD[best] = bestD
        h.farX = x
        h.farZ = z
      }
    }
  }

  for (const h of held) {
    if (h.cells > 0) {
      h.cx /= h.cells
      h.cz /= h.cells
    }
  }
  return held
}

/**
 * The best place to actually build, near where the balance wants a capital.
 *
 * The loop works in the abstract — centres of mass, far corners — and every one
 * of those points is as likely as not to be a lake or a cliff. This is the step
 * that puts the abstraction back on the ground: take the target, look at the
 * buildable cells around it, and pick the one that trades quality against
 * distance best.
 *
 * The distance penalty is what makes the loop converge. Ranking purely on site
 * score would pull every capital toward the island's single flattest plain and
 * the arrangement would oscillate instead of settling.
 */
function siteNear(
  s: Survey,
  x: number,
  z: number,
  radius: number,
  others: readonly { x: number; z: number }[],
  skip: number,
  minGap: number,
): { x: number; z: number } | null {
  const span = Math.ceil(radius / s.step)
  const ci = Math.round((x + s.half) / s.step - 0.5)
  const cj = Math.round((z + s.half) / s.step - 0.5)

  let bestX = 0
  let bestZ = 0
  let best = -Infinity

  for (let j = cj - span; j <= cj + span; j++) {
    if (j < 0 || j >= GRID) continue
    for (let i = ci - span; i <= ci + span; i++) {
      if (i < 0 || i >= GRID) continue
      const q = s.score[j * GRID + i]
      if (q < 0) continue

      const sx = cellX(s, i)
      const sz = cellX(s, j)
      const d = Math.hypot(sx - x, sz - z)
      if (d > radius) continue

      // Never stack two capitals. A pair closer than the gap is a pair of
      // slivers, which is the same failure the loop is trying to remove.
      let blocked = false
      for (let c = 0; c < others.length; c++) {
        if (c === skip) continue
        if (Math.hypot(others[c].x - sx, others[c].z - sz) < minGap) {
          blocked = true
          break
        }
      }
      if (blocked) continue

      const v = q - (d / radius) * 0.9
      if (v > best) {
        best = v
        bestX = sx
        bestZ = sz
      }
    }
  }

  return best === -Infinity ? null : { x: bestX, z: bestZ }
}

/** How badly this arrangement fails: the largest territory, in fair shares. */
function imbalance(held: readonly Holding[], landCells: number): number {
  const fair = landCells / held.length
  let worst = 0
  for (const h of held) {
    const r = h.cells / fair
    if (r > worst) worst = r
  }
  return worst
}

/**
 * Give each capital a faction, with no two neighbours sharing one.
 *
 * This replaces a shuffled deal, which was even *in count* — fifteen cities over
 * six factions gave everyone two or three — and disastrous in *layout*. Whenever
 * two same-faction cells happened to adjoin they fused into one territory, and
 * on a fifteen-city map that happened constantly: measured across seeds, the
 * six factions were resolving into around a dozen blobs of which the largest ran
 * to 15% of the island, with one faction holding 27%. The map that was meant to
 * read as fifteen territories read as six, which is precisely the outcome
 * `biome.ts` set out to avoid.
 *
 * So it is a graph colouring instead. Capitals are coloured in descending order
 * of how many neighbours they have — the constrained ones first, while there are
 * still colours free for them — and each takes the least-used faction its
 * neighbours have not already claimed. Least-used keeps the even spread the
 * shuffle gave; the exclusion is what makes every border an actual border.
 *
 * `start` is the player's capital and is coloured first, unconditionally
 * gentlest. That used to be a swap afterwards, which quietly undid the colouring
 * it was applied to: exchanging two factions can seat one of them next to itself.
 * Colouring it first asks for the same thing without breaking the invariant —
 * every other capital simply treats it as a neighbour already taken.
 */
function colourTerritories(
  s: Survey,
  caps: readonly { x: number; z: number }[],
  start: number,
  rng: () => number,
): number[] {
  const n = caps.length
  const owner = new Int32Array(GRID * GRID).fill(-1)
  for (let j = 0; j < GRID; j++) {
    const z = cellX(s, j)
    for (let i = 0; i < GRID; i++) {
      if (!s.land[j * GRID + i]) continue
      const x = cellX(s, i)
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < n; c++) {
        const d = (caps[c].x - x) ** 2 + (caps[c].z - z) ** 2
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      owner[j * GRID + i] = best
    }
  }

  // Adjacency: two territories are neighbours where their cells touch.
  const adj: Set<number>[] = caps.map(() => new Set<number>())
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = owner[j * GRID + i]
      if (a < 0) continue
      if (i + 1 < GRID) {
        const b = owner[j * GRID + i + 1]
        if (b >= 0 && b !== a) {
          adj[a].add(b)
          adj[b].add(a)
        }
      }
      if (j + 1 < GRID) {
        const b = owner[(j + 1) * GRID + i]
        if (b >= 0 && b !== a) {
          adj[a].add(b)
          adj[b].add(a)
        }
      }
    }
  }

  const order = caps.map((_, i) => i).filter((i) => i !== start)
  // A stable jitter so equal-degree capitals do not always colour in index
  // order, which would make the same faction land in the same corner every seed.
  const tie = caps.map(() => rng())
  order.sort((a, b) => adj[b].size - adj[a].size || tie[a] - tie[b])

  const biome = new Int32Array(n).fill(-1)
  const used = new Int32Array(BIOMES.length)

  // Index 0 is the gentlest biome — see the ordering of `BIOMES`.
  biome[start] = 0
  used[0]++

  for (const i of order) {
    const taken = new Set<number>()
    for (const nb of adj[i]) if (biome[nb] >= 0) taken.add(biome[nb])

    let pick = -1
    let pickUse = Infinity
    for (let b = 0; b < BIOMES.length; b++) {
      if (taken.has(b)) continue
      if (used[b] < pickUse) {
        pickUse = used[b]
        pick = b
      }
    }
    // A capital hemmed in by more distinct factions than exist has to repeat
    // one. Take the rarest overall — a repeat that is at least not everywhere.
    if (pick < 0) {
      pick = 0
      for (let b = 1; b < BIOMES.length; b++) if (used[b] < used[pick]) pick = b
    }

    biome[i] = pick
    used[pick]++
  }

  return Array.from(biome)
}

/**
 * Place the capitals.
 *
 * Deterministic from the seed and the terrain, and it must stay that way: pads
 * are cut from this before the cards are seated on the result, so two calls that
 * disagreed would level the ground in one place and put the town in another.
 */
export function placeCities(seed: string, frame: TerrainFrame, p: CityParams): City[] {
  const rng = makeRng(seed, 'cities')
  const count = Math.max(1, p.count)
  const survey = surveyIsland(frame, rng, p.clearing, p.reserved)
  if (survey.landCells === 0) return []

  // --- stage 1: the best sites, spread out ---------------------------------
  //
  // Best-first with a minimum separation. The gap is what stops every capital
  // piling into whichever plain happens to score highest.
  //
  // Derived from how much land actually passed the test rather than from the
  // area of the map: on this island most of the map is sea, and a gap sized for
  // the map spaces fifteen cities as though they had twice the room.
  // `sites * step²` is a direct measure of buildable area, so the spacing
  // self-adjusts to a small island or a mountainous one.
  const candidates: { x: number; z: number; score: number }[] = []
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const q = survey.score[j * GRID + i]
      if (q < 0) continue
      candidates.push({ x: cellX(survey, i), z: cellX(survey, j), score: q })
    }
  }
  if (candidates.length === 0) return []
  candidates.sort((a, b) => b.score - a.score)

  const area = candidates.length * survey.step * survey.step
  // The separation the whole file measures against: what fifteen capitals spread
  // evenly over the buildable land would have between them.
  const spacing = Math.sqrt(area / count)

  // It relaxes rather than failing. An island may genuinely not have room for
  // fifteen well-spaced towns, and returning eleven is a better answer than
  // returning none.
  let picked: { x: number; z: number }[] = []
  let gap = spacing * 0.9
  for (let attempt = 0; attempt < 6 && picked.length < count; attempt++) {
    picked = []
    for (const c of candidates) {
      if (picked.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < gap)) continue
      picked.push({ x: c.x, z: c.z })
      if (picked.length === count) break
    }
    gap *= 0.7
  }
  if (picked.length === 0) return []

  // --- stage 2: measure, adjust, measure again -----------------------------
  //
  // Two corrections per round, doing different jobs. Relaxation fixes *shape*:
  // stepping a capital toward the centre of mass of what it holds pulls it out
  // of the corner of its own territory and squares the region up around it, and
  // that alone removes most of the imbalance, because a lopsided cell is usually
  // a capital sitting at one end of it.
  //
  // Relaxation cannot fix *count*, though. Where the land wants ten territories
  // and there are three capitals in one bay, no amount of centring will help —
  // one of them has to go somewhere else. So the worst-starved capital is picked
  // up and dropped into the far corner of the largest territory, which splits
  // the oversized region and closes the gap it left behind in one move.
  const minGap = spacing * 0.55
  let best = picked.map((c) => ({ ...c }))
  let bestScore = imbalance(divide(survey, picked), survey.landCells)

  for (let round = 0; round < ROUNDS && bestScore > AREA_TOLERANCE; round++) {
    const held = divide(survey, picked)
    const fair = survey.landCells / picked.length

    // Relax everyone toward the middle of what they hold.
    const next = picked.map((c, i) => {
      const h = held[i]
      if (h.cells === 0) return c
      const tx = c.x + (h.cx - c.x) * 0.65
      const tz = c.z + (h.cz - c.z) * 0.65
      return siteNear(survey, tx, tz, spacing * 0.6, picked, i, minGap) ?? c
    })

    // Then move one starved capital into one bloated territory, if the split is
    // worth making. One per round: each relocation changes what its new
    // neighbours hold, and the measurements the next round makes should be of
    // ground that has settled.
    let starved = 0
    let fattest = 0
    for (let i = 1; i < held.length; i++) {
      if (held[i].cells < held[starved].cells) starved = i
      if (held[i].cells > held[fattest].cells) fattest = i
    }
    if (
      starved !== fattest &&
      held[fattest].cells > fair * AREA_TOLERANCE &&
      held[starved].cells < fair * 0.6
    ) {
      const spot = siteNear(
        survey,
        held[fattest].farX,
        held[fattest].farZ,
        spacing * 0.5,
        next,
        starved,
        minGap,
      )
      if (spot) next[starved] = spot
    }

    picked = next
    const score = imbalance(divide(survey, picked), survey.landCells)
    // Keep the best arrangement seen, not the last one. Relocation is a jump,
    // not a gradient step, and a jump can overshoot — this makes a bad round
    // cost time rather than quality.
    if (score < bestScore) {
      bestScore = score
      best = picked.map((c) => ({ ...c }))
    }
  }

  // --- stage 3: hand out the factions --------------------------------------
  //
  // The avatar spawns at the map centre, so the capital nearest the origin is
  // the player's, and its territory is the gentlest — the opening region should
  // be survivable however the dice fell.
  let start = 0
  for (let i = 1; i < best.length; i++) {
    if (Math.hypot(best[i].x, best[i].z) < Math.hypot(best[start].x, best[start].z)) {
      start = i
    }
  }

  const biomes = colourTerritories(survey, best, start, rng)
  return best.map((s, i) => ({ ...s, biome: biomes[i], player: i === start }))
}
