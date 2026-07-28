/**
 * The board, laid out on top of the island.
 *
 * `cities.ts` decides where the fifteen capitals stand and what land each one
 * holds; that is a *geography* question and it stays there. This file asks the
 * *game* question that follows: which of those capitals is a wizard's, which are
 * neutral towns to be taken, and where the mines, lairs and Points of Power go
 * in the gaps between them.
 *
 * Kept separate for the same reason `world/` imports nothing from three.js — the
 * layout is a pure function of (seed, terrain, capitals), so it is reproducible,
 * testable, and can be reasoned about without a renderer. It returns plain data;
 * `game/sim.ts` is what brings it to life.
 *
 * Pure TypeScript, no three.js — same rule as the rest of `world/`.
 */

import type { City } from './cities'
import { makeRng } from './prng'
import type { TerrainFrame } from './terrainQuery'
import { terrainHeightAt, terrainSlopeAt, worldHalfExtent } from './terrainQuery'

export type SiteKind = 'city' | 'mine' | 'lair' | 'point'

/** Which faction owns something. -1 is nobody. */
export type Owner = number
export const NOBODY = -1

export interface MapSite {
  id: number
  kind: SiteKind
  x: number
  z: number
  owner: Owner
  /**
   * The garrison table in `game/factions.ts` that defends it, or null for a
   * wizard's own capital, which starts in friendly hands.
   */
  garrison: string | null
  /** World-unit radius of the levelled pad, and the leash its defenders keep to. */
  radius: number
  name: string
  /**
   * Board sprite. Cities are drawn by the static `CardLayer` and carry null
   * here; everything else is drawn by the dynamic layer so it can change.
   */
  sprite: string | null
  /** What the sprite becomes once claimed — a gold vein becomes a gold mine. */
  ownedSprite?: string
  /** One-time reward for clearing, in gold. */
  cache?: number
  /** Index into `cities` for a city site, so the two lists can be rejoined. */
  cityIndex?: number
}

export interface MapPlan {
  sites: MapSite[]
  /** Site ids of the three wizards' capitals, indexed by faction. */
  capitals: number[]
}

/** How steep the ground under a placed site may be. Matches `cities.ts`. */
const MAX_SLOPE = 0.24
const MIN_BAND = 0.05
const MAX_BAND = 0.62

/** Resolution of the candidate grid. 128 over 2 km is ~16 units a cell. */
const GRID = 128

interface Candidate {
  x: number
  z: number
  score: number
}

/**
 * Every cell of the island something could be built on, best ground first.
 *
 * Scored on flatness alone, jittered. Unlike a capital a mine has no opinion
 * about elevation — the interesting variation in where they end up should come
 * from the spacing rules below, which are what actually decide whether the map
 * plays well, rather than from a scoring function nobody can see the output of.
 */
function buildable(frame: TerrainFrame, rng: () => number): Candidate[] {
  const half = worldHalfExtent(frame)
  const step = (half * 2) / GRID
  const seaY = frame.seaLevel * frame.heightScale
  const out: Candidate[] = []

  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = -half + (i + 0.5) * step
      const z = -half + (j + 0.5) * step
      // Drawn before the rejection tests, so the random stream does not depend
      // on the terrain — the convention the rest of `world/` follows.
      const jitter = rng()
      const height = terrainHeightAt(frame, x, z)
      if (height <= seaY) continue
      const e = (height / frame.heightScale - frame.seaLevel) / (1 - frame.seaLevel)
      if (e < MIN_BAND || e > MAX_BAND) continue
      const slope = terrainSlopeAt(frame, x, z)
      if (slope > MAX_SLOPE) continue
      out.push({ x, z, score: (1 - slope / MAX_SLOPE) * (0.8 + jitter * 0.4) })
    }
  }

  out.sort((a, b) => b.score - a.score)
  return out
}

interface Taken {
  x: number
  z: number
  gap: number
}

/** Is this spot far enough from everything already placed? */
function clear(taken: readonly Taken[], x: number, z: number, gap: number): boolean {
  for (const t of taken) {
    const need = Math.max(gap, t.gap)
    if ((t.x - x) ** 2 + (t.z - z) ** 2 < need * need) return false
  }
  return true
}

/**
 * The best buildable spot near a target point.
 *
 * Used for the things whose position is decided by the *layout* rather than by
 * the ground — a Point of Power belongs on a particular part of the map, and
 * this is what puts that abstract intent onto ground you can actually stand on.
 * Returns null when there is nothing suitable inside the radius, which the
 * callers treat as "skip it" rather than forcing a bad placement.
 */
function nearest(
  cands: readonly Candidate[],
  taken: readonly Taken[],
  x: number,
  z: number,
  radius: number,
  gap: number,
): Candidate | null {
  let best: Candidate | null = null
  let bestD = radius * radius
  for (const c of cands) {
    const d = (c.x - x) ** 2 + (c.z - z) ** 2
    if (d >= bestD) continue
    if (!clear(taken, c.x, c.z, gap)) continue
    bestD = d
    best = c
  }
  return best
}

/** Greedily take the best-scoring spots that respect the spacing rules. */
function spread(
  cands: readonly Candidate[],
  taken: Taken[],
  count: number,
  gap: number,
): Candidate[] {
  const out: Candidate[] = []
  for (const c of cands) {
    if (out.length >= count) break
    if (!clear(taken, c.x, c.z, gap)) continue
    out.push(c)
    taken.push({ x: c.x, z: c.z, gap })
  }
  return out
}

const MINE_NAMES = [
  'Goldbrook',
  'Deepcut',
  'The Glitterworks',
  'Emberhole',
  'Old Seam',
  'Kingsvein',
  'Hollowdelve',
  'Redshaft',
]

const LAIR_SPRITES = [
  'lair.keep',
  'lair.griffinTower',
  'lair.medusaBank',
  'lair.snake',
  'lair.cyclops',
  'lair.graveyard',
]

const LAIR_NAMES = [
  'The Broken Keep',
  'Griffin Tower',
  'The Medusa Bank',
  'Serpent Hollow',
  'Cyclops Crag',
  'The Barrow Field',
]

const POINT_NAMES = [
  'The First Seat',
  'The Second Seat',
  'The Third Seat',
  'The Sunken Crown',
  'The Axle of the World',
]

const TOWN_NAMES = [
  'Ashford',
  'Millhaven',
  'Greyfell',
  'Thornwick',
  'Duncastle',
  'Rookmoor',
  'Elderbridge',
  'Cairnholt',
  'Westmarch',
  'Fenwick',
  'Stonebury',
  'Harrowgate',
  'Larkhill',
  'Blackmere',
  'Yarrowvale',
]

/**
 * Turn the placed capitals into a playable board.
 *
 * Order is deliberate and each step constrains the next: the wizards' capitals
 * are chosen first because everything else is positioned relative to them, then
 * the Points of Power (the map's most important ground, so they get first refusal
 * on it), then the lairs that guard the middle, then the mines in whatever is
 * left. Placing the mines first would scatter them over exactly the spots the
 * points need.
 */
export function planGameMap(
  seed: string,
  frame: TerrainFrame,
  cities: readonly City[],
  factionCount: number,
): MapPlan {
  const rng = makeRng(seed, 'gamemap')
  const sites: MapSite[] = []
  const taken: Taken[] = []
  let nextId = 0
  const half = worldHalfExtent(frame)

  // --- who owns which capital ------------------------------------------------
  //
  // The player's is already flagged: `cities.ts` gives it to the capital nearest
  // the map centre and colours its territory the gentlest biome. The AI wizards
  // take the two capitals furthest from that one, so the opening minutes are
  // spent against neutral garrisons rather than against another wizard — which
  // is what makes the first playable teachable.
  const playerIndex = Math.max(0, cities.findIndex((c) => c.player))
  const byDistance = cities
    .map((c, i) => ({ i, d: (c.x - cities[playerIndex].x) ** 2 + (c.z - cities[playerIndex].z) ** 2 }))
    .filter((e) => e.i !== playerIndex)
    .sort((a, b) => b.d - a.d)

  const ownerOf = new Map<number, number>()
  ownerOf.set(playerIndex, 0)
  for (let f = 1; f < factionCount && f - 1 < byDistance.length; f++) {
    ownerOf.set(byDistance[f - 1].i, f)
  }

  const capitals: number[] = new Array(factionCount).fill(-1)
  // Every capital already carries a levelled clearing from `planWorld`, so the
  // pad radius here only has to describe the ground the *garrison* holds.
  const CITY_RADIUS = 48

  cities.forEach((c, i) => {
    const owner = ownerOf.get(i) ?? NOBODY
    const id = nextId++
    if (owner !== NOBODY) capitals[owner] = id
    sites.push({
      id,
      kind: 'city',
      x: c.x,
      z: c.z,
      owner,
      // A wizard's own capital starts in friendly hands and needs no garrison.
      garrison: owner === NOBODY ? 'town' : null,
      radius: CITY_RADIUS,
      name: TOWN_NAMES[i % TOWN_NAMES.length],
      sprite: null,
      cityIndex: i,
    })
    taken.push({ x: c.x, z: c.z, gap: 170 })
  })

  const cands = buildable(frame, rng)

  // --- Points of Power -------------------------------------------------------
  //
  // One per wizard, on the frontier between that wizard's capital and the middle
  // of the map: near enough to defend, far enough that holding it is a choice
  // rather than a freebie. The remainder go in the contested centre, guarded by
  // the hardest garrisons on the board.
  let pointN = 0
  for (let f = 0; f < factionCount; f++) {
    const cityIndex = [...ownerOf.entries()].find(([, o]) => o === f)?.[0]
    if (cityIndex === undefined) continue
    const c = cities[cityIndex]
    // 45% of the way from the capital toward the map centre.
    const tx = c.x * 0.55
    const tz = c.z * 0.55
    const spot = nearest(cands, taken, tx, tz, half * 0.4, 220)
    if (!spot) continue
    taken.push({ x: spot.x, z: spot.z, gap: 220 })
    sites.push({
      id: nextId++,
      kind: 'point',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      garrison: 'point',
      radius: 42,
      name: POINT_NAMES[pointN % POINT_NAMES.length],
      sprite: 'mod.standingStones',
    })
    pointN++
  }

  // The centre. Placed on a ring rather than at the origin so two central points
  // are not stacked on the same hill, and spun by the seed so the contested
  // ground is not in the same place every match.
  const spin = rng() * Math.PI * 2
  const central = POINT_NAMES.length - pointN
  for (let k = 0; k < central; k++) {
    const a = spin + (k / Math.max(1, central)) * Math.PI * 2
    const r = half * 0.16
    const spot = nearest(cands, taken, Math.cos(a) * r, Math.sin(a) * r, half * 0.32, 200)
    if (!spot) continue
    taken.push({ x: spot.x, z: spot.z, gap: 200 })
    sites.push({
      id: nextId++,
      kind: 'point',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      // The centre is meant to be the last thing anyone takes.
      garrison: 'dragon',
      radius: 46,
      name: POINT_NAMES[pointN % POINT_NAMES.length],
      sprite: 'mod.standingStones',
    })
    pointN++
  }

  // --- lairs -----------------------------------------------------------------
  //
  // Biased to the middle third of the island: a lair's job is to stand between
  // the homelands and the contested centre, and one tucked into a corner behind
  // a player's own towns is a chore rather than an obstacle.
  const midland = cands.filter((c) => {
    const d = Math.hypot(c.x, c.z)
    return d > half * 0.18 && d < half * 0.68
  })
  const lairSpots = spread(midland, taken, LAIR_SPRITES.length, 190)
  lairSpots.forEach((spot, k) => {
    sites.push({
      id: nextId++,
      kind: 'lair',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      garrison: 'lair',
      radius: 40,
      name: LAIR_NAMES[k % LAIR_NAMES.length],
      sprite: LAIR_SPRITES[k % LAIR_SPRITES.length],
      cache: 100 + Math.floor(rng() * 200),
    })
  })

  // --- mines -----------------------------------------------------------------
  //
  // Last, and over the whole island rather than the middle: a mine is the thing
  // a wizard takes near home in the first five minutes, so they need to exist in
  // the homelands as well as in the contested ground.
  const mineSpots = spread(cands, taken, MINE_NAMES.length, 150)
  mineSpots.forEach((spot, k) => {
    sites.push({
      id: nextId++,
      kind: 'mine',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      garrison: 'mine',
      radius: 32,
      name: MINE_NAMES[k % MINE_NAMES.length],
      // Unclaimed it is a raw vein; consecrating it puts a working mine on it.
      sprite: 'vein.gold',
      ownedSprite: 'mine.gold',
    })
  })

  return { sites, capitals }
}
