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

export type SiteKind =
  | 'city'
  | 'mine'
  | 'lair'
  | 'point'
  | 'node'
  | 'camp'
  | 'monument'
  | 'outpost'

/**
 * The six outposts, and the patrol each one knows how to raise.
 *
 * An outpost is where a wizard spends gold on troops *outside* a city queue —
 * the first thing on the board that turns money directly into soldiers without
 * a production slot. What it can sell is a property of the building, so which
 * outpost you take decides what kind of trouble you can make.
 *
 * The patrol is also its neutral garrison. What guards it is what you get,
 * which means the player learns each building by fighting it once.
 */
export type OutpostKind = 'watchfort' | 'arena' | 'wayhouse' | 'blackMarket' | 'warren' | 'wardens'

/**
 * The eight monuments, and what holding one is worth.
 *
 * A monument pays the *wizard*, not a city. Until now everything on the board
 * paid a city — a node buffs the one it supplies, a mine feeds the gold pile —
 * and the only thing that ever rewarded the wizard directly was a Point of
 * Power. That left the one piece the player actually controls with nothing on
 * the map addressed to it.
 *
 * There is one of each and no more, deliberately. A node's buff is per-city, so
 * a second Mithril seam is genuinely useful; a monument's is per-wizard, so a
 * duplicate would do nothing at all — the same "duplicates do nothing" rule the
 * node table already states, arriving here as a placement decision instead.
 */
export type MonumentKind =
  | 'temple'
  | 'shrine'
  | 'oasis'
  | 'observatory'
  | 'sanctum'
  | 'library'
  | 'sphinx'
  | 'tradingPost'

/**
 * The six connection resources.
 *
 * A node is consecrated like anything else that can be held; what a caravan
 * decides is *which city* the buff lands on. The kind is carried here rather
 * than inferred from the sprite, because the buff a link grants is a rule and
 * rules should not be read off artwork.
 */
export type ResourceKind =
  | 'mithril'
  | 'horse'
  | 'granary'
  | 'ley'
  | 'ironwood'
  | 'monster'
  | 'crystal'
  | 'gem'
  | 'sulfur'
  | 'quicksilver'

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
  /** Resource nodes only: which buff a live caravan link grants. */
  resource?: ResourceKind
  /** Monuments only: which standing benefit holding it grants its wizard. */
  monument?: MonumentKind
  /** Outposts only: which patrol this building garrisons with and sells. */
  outpost?: OutpostKind
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

/**
 * Breathing room between two sites, on top of *both* their radii.
 *
 * This is geometry, not taste. `radius` is the leash a site's defenders keep
 * to, so two sites closer than the sum of theirs have overlapping leashes: an
 * army attacking one is fought by both, and the star rating on either plate
 * becomes a lie about what you are walking into.
 *
 * The sum and not the larger of the two. Taking the larger reads as sensible
 * and is not — a camp 45 units from a city clears `max(48, 24) + 12` and still
 * stands *inside* the city's 48-unit leash. Measured over twenty seeds, that
 * rule was putting the closest pair of sites 45 units apart.
 *
 * It never relaxes, unlike a spread, which is only a preference.
 */
const KEEPOUT_MARGIN = 8

/**
 * Every kind spreads only against its own sort.
 *
 * Cities and Points of Power were tried as one shared group, on the reasoning
 * that both are deliberately placed and both want elbow room. Measured, it cost
 * a Point of Power on a third of all seeds: fifteen capitals holding 150 units
 * apiece inside the same group left the ring positions with nowhere legal to
 * land, and `nearest` answered by placing nothing at all.
 *
 * Separating them is also the better game. A Point of Power beside a neutral
 * town is a place worth two trips, and the keep-out still holds their leashes
 * apart — 48 + 42 + 8, so neither garrison can reach the other's ground.
 */
const CITY_GROUP = 'city'
const POINT_GROUP = 'point'

/**
 * How much of each thing the board carries.
 *
 * Sixty-one sites on a 2 km island is one every 170 units or so — about ten
 * seconds of flying between them, which is why the map read as scenery with a
 * few flags in it. These counts put a site roughly every 95 units instead.
 * They are affordable because of two changes and not because the island grew:
 * clearings are now sized to the building rather than to the leash, and a
 * city's spread no longer applies to anything that is not another city.
 */
const LAIR_COUNT = 15
const CAMP_COUNT = 25
const MINE_COUNT = 20
/** Between a node's 34 and a lair's 40 — it needs an army, like a lair does. */
const MONUMENT_RADIUS = 36

/**
 * How many of each kind a finished board must carry.
 *
 * Exported so `npm run audit-placement` asserts against the generator's own
 * numbers rather than a copy of them. A `spread` that runs out of candidates
 * returns what it managed and says nothing — a map four mines short still looks
 * like a map — so the count has to be checked from outside, against a figure
 * that cannot drift from the one placement used.
 */
/** A Point of Power, sited before anything else on the board exists. */
export interface PlannedPoint {
  x: number
  z: number
  radius: number
  garrison: string
  name: string
  /** True for the frontier ring — the points a wizard is expected to open on. */
  frontier: boolean
}

/** Arms of the X. The fifth point is its centre. */
const POINT_ARMS = 4
/** How far out the arms sit, as a fraction of the island's half-extent. */
const POINT_ARM_REACH = 0.55

/**
 * Where the Points of Power go: an X, decided from the terrain and nothing else.
 *
 * These run **before the capitals**, and the shape is the reason. A point used
 * to be sited 45% of the way from a capital toward the centre, so the ground
 * the match is won on was a by-product of wherever city placement happened to
 * drop three towns — and a wizard who drew a roomy capital drew an easy point
 * with it. That is the one thing a victory condition must never be.
 *
 * Four arms on a seed-spun square, plus the centre. The layout is symmetric by
 * construction, so no wizard's point is easier than another's before anyone has
 * moved, and the middle one is equidistant from all four arms — the ground
 * everybody has the same claim on and nobody has an early claim to.
 *
 * `factionCount` deliberately does not change the shape. Five points with three
 * wizards means one arm belongs to nobody at the start, which is a contested
 * prize rather than an imbalance.
 */
export function planPoints(seed: string, frame: TerrainFrame): PlannedPoint[] {
  const rng = makeRng(seed, 'points')
  const cands = buildable(frame, rng)
  const half = worldHalfExtent(frame)
  const taken: Taken[] = []
  const out: PlannedPoint[] = []

  // Spun so the X is not bolted to the compass on every seed. Everything else
  // about the figure is fixed, because the fairness is the figure.
  const spin = rng() * Math.PI * 2

  for (let k = 0; k < POINT_ARMS; k++) {
    const a = spin + (k / POINT_ARMS) * Math.PI * 2
    const r = half * POINT_ARM_REACH
    const spot = nearest(
      cands,
      taken,
      Math.cos(a) * r,
      Math.sin(a) * r,
      half * 0.42,
      42,
      POINT_GROUP,
      220,
    )
    if (!spot) continue
    taken.push({ x: spot.x, z: spot.z, radius: 42, group: POINT_GROUP, spread: 220 })
    out.push({ x: spot.x, z: spot.z, radius: 42, garrison: 'point', name: '', frontier: true })
  }

  // The middle of the X. Nearest buildable ground to the origin, and guarded by
  // the hardest garrison on the board — it is meant to be the last thing
  // anybody takes, which is what stops the centre simply being a free fifth.
  const middle = nearest(cands, taken, 0, 0, half * 0.3, 46, POINT_GROUP, 200)
  if (middle) {
    taken.push({ x: middle.x, z: middle.z, radius: 46, group: POINT_GROUP, spread: 200 })
    out.push({ x: middle.x, z: middle.z, radius: 46, garrison: 'dragon', name: '', frontier: false })
  }

  out.forEach((p, i) => {
    p.name = POINT_NAMES[i % POINT_NAMES.length]
  })
  return out
}

export function expectedSiteCounts(cityCount: number): Record<SiteKind, number> {
  return {
    city: cityCount,
    point: POINT_NAMES.length,
    lair: LAIR_COUNT,
    node: NODE_KINDS.length * NODES_PER_KIND,
    camp: CAMP_COUNT,
    mine: MINE_COUNT,
    monument: MONUMENTS.length,
    outpost: OUTPOST_COUNT,
  }
}

interface Taken {
  x: number
  z: number
  /** Leash radius, which sets how much room this site needs from anything. */
  radius: number
  /**
   * Sites that want to be spread apart from one another. Every kind spreads
   * only against its own sort; keeping out of everything else is the pad rule
   * above, which is a different question with a different answer.
   */
  group: string
  /** How far this site would like to be from others in its group. */
  spread: number
}

/**
 * Is this spot far enough from everything already placed?
 *
 * Two distances, because one number was doing two unrelated jobs. A city wants
 * 150 units from another city; it never wanted 150 units from a bandit camp.
 * The old rule took the larger of any two gaps, so a capital's reserve applied
 * to *everything* placed after it — fifteen capitals sterilising a 150-unit
 * disc apiece is about π×150²×15 ≈ 1.06 million square units, which on this
 * island is very nearly the whole buildable set. That is what "the island is
 * full" meant: not a shortage of ground, but a spacing rule spending it all.
 *
 * So a spread applies only within a group, and everything else has to clear
 * the pads and no more.
 */
function clear(
  taken: readonly Taken[],
  x: number,
  z: number,
  radius: number,
  group: string,
  spread: number,
): boolean {
  for (const t of taken) {
    const pads = radius + t.radius + KEEPOUT_MARGIN
    const need = t.group === group ? Math.max(pads, spread, t.spread) : pads
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
  reach: number,
  padRadius: number,
  group: string,
  spread: number,
): Candidate | null {
  const scan = (maxD: number, g: number): Candidate | null => {
    let best: Candidate | null = null
    let bestD = maxD * maxD
    for (const c of cands) {
      const d = (c.x - x) ** 2 + (c.z - z) ** 2
      if (d >= bestD) continue
      if (!clear(taken, c.x, c.z, padRadius, group, g)) continue
      bestD = d
      best = c
    }
    return best
  }

  // Relax the spread before widening the search: a Point of Power's whole
  // argument is *where* it is, so standing a little closer to another point is
  // a smaller compromise than sitting somewhere else entirely.
  for (let g = spread; g > padRadius; g *= 0.85) {
    const hit = scan(reach, g)
    if (hit) return hit
  }
  // Then look further afield. `spread` has closed up its spacing rather than
  // giving up since the third playable; this had not, and answered a crowded
  // ring by returning null — which the caller reads as "skip it". A wizard
  // silently short a Point of Power is short its victory condition, on a map
  // that looks perfectly normal.
  for (let r = reach * 1.3; r <= reach * 2.6; r *= 1.3) {
    const hit = scan(r, padRadius)
    if (hit) return hit
  }
  return null
}

/**
 * Greedily take the best-scoring spots that respect the spacing rules, closing
 * up the spacing rather than giving up if the island turns out to be full.
 *
 * The retry is the whole point. A gap is a *preference* — how far apart these
 * things would like to be — while the count is a design decision about how much
 * content the map carries. Treating the gap as inviolable inverts that: the
 * first version of this function silently returned however many it managed, so
 * a seed with a rockier coast quietly shipped six mines instead of ten and
 * nothing anywhere said so. Filling the island to 61 sites made that failure
 * routine — one seed placed **none** of its ten mines — and it is invisible
 * from inside the game, because a map with missing content still looks like a
 * map.
 *
 * So: try at the preferred gap, then at 85% of it, and so on down to a floor,
 * which is the point at which two sites would genuinely overlap. If it still
 * cannot place them all, that is a real "this does not fit" and the caller's
 * count is what wants revisiting.
 *
 * Only the *spread* relaxes. The pad keep-out inside `clear` is geometry and
 * holds at every retry, so closing up the spacing can never stack two leashes
 * on top of each other however crowded the island gets.
 */
function spread(
  cands: readonly Candidate[],
  taken: Taken[],
  count: number,
  gap: number,
  radius: number,
  group: string,
  floor = gap * 0.5,
): Candidate[] {
  const out: Candidate[] = []
  const used = new Set<Candidate>()
  for (let g = gap; out.length < count; g *= 0.85) {
    for (const c of cands) {
      if (out.length >= count) break
      if (used.has(c)) continue
      if (!clear(taken, c.x, c.z, radius, group, g)) continue
      out.push(c)
      used.add(c)
      taken.push({ x: c.x, z: c.z, radius, group, spread: g })
    }
    if (g <= floor) break
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
  'Blackpan',
  'Thrushcut',
  'Greyadit',
  'The Deep Cut',
  'Farrowpit',
  'Coldshaft',
  'The Long Stope',
  'Ironbrook',
  'Wraydelve',
  'The Slag Steps',
  'Bellowsmouth',
  'Quarryfoot',
]

/**
 * Every lair the atlas can draw, paired with its name.
 *
 * Nine of these sprites were sitting unused in `sprites.png` — packed, shipped
 * and never named by any code path. Fifteen lairs therefore cost no art work
 * at all, and every one on the board is a different building rather than the
 * same nine repeated.
 */
const LAIRS: { sprite: string; name: string }[] = [
  { sprite: 'lair.keep', name: 'The Broken Keep' },
  { sprite: 'lair.griffinTower', name: 'Griffin Tower' },
  { sprite: 'lair.medusaBank', name: 'The Medusa Bank' },
  { sprite: 'lair.snake', name: 'Serpent Hollow' },
  { sprite: 'lair.cyclops', name: 'Cyclops Crag' },
  { sprite: 'lair.graveyard', name: 'The Barrow Field' },
  { sprite: 'lair.ruins', name: 'The Sunken Ruins' },
  { sprite: 'lair.daemonCave', name: 'The Daemon Cave' },
  { sprite: 'lair.dwarfFortress', name: 'Karak Vaun' },
  { sprite: 'lair.lair', name: 'The Wolf Den' },
  { sprite: 'lair.maze', name: 'The Labyrinth' },
  { sprite: 'lair.dwarvenTreasury', name: 'The Deephoard' },
  { sprite: 'lair.elementalStockpile', name: 'The Bound Stones' },
  { sprite: 'lair.oldTreeNests', name: 'The Old Nests' },
  { sprite: 'lair.dragonCity', name: 'Dragonspire' },
]

/**
 * Bandit camps: the small trouble in a wizard's own back yard.
 *
 * Named rather than numbered because a camp is a place the player will fly to
 * repeatedly — its garrison grows back — and "Gallows Copse" is a landmark in
 * a way that "Camp 4" is not.
 */
const CAMP_NAMES = [
  'Gallows Copse',
  'The Cutthroat Ford',
  'Rooksnest',
  'The Broken Wain',
  'Thistlefen',
  'Hangman’s Reach',
  'The Sour Well',
  'Crowfoot Hollow',
  'The Leaning Barn',
  'Mudlark Bend',
  'The Gibbet Oak',
  'Rateye Ford',
  'The Blackened Post',
  'Nettlebank',
  'The Split Stump',
  'Cinderhearth',
  'The Drowned Cart',
  'Magpie Hollow',
  'The Rotten Weir',
  'Grimsditch',
  'The Ashen Camp',
  'Coldkettle',
  'The Broken Palisade',
  'Ravensfoot',
  'The Slumped Barrow',
]

/**
 * The resource node kinds, each with a pool of names to draw from.
 *
 * A kind table rather than a literal list of sites, because *which* nodes a
 * match contains is now part of what makes one match differ from another. The
 * old list was twelve fixed entries, so every seed carried identical content
 * merely rearranged — the map moved, the game did not. `nodeRoster` below draws
 * the multiset, so a seed can hand you three Quicksilver Springs and no
 * Mithril, and deciding what to do about that is the point.
 */
const NODE_KINDS: {
  resource: ResourceKind
  sprite: string
  ownedSprite?: string
  names: string[]
}[] = [
  {
    resource: 'mithril',
    sprite: 'vein.ore',
    ownedSprite: 'mine.orePit',
    names: ['The Mithril Seam', 'Deepdelve', 'Silverbore', 'The Pale Lode'],
  },
  {
    resource: 'horse',
    sprite: 'misc.stables',
    names: ['The Horse Plains', 'Wildmane Steppe', 'The Long Gallop', 'Thunderfield'],
  },
  {
    resource: 'granary',
    sprite: 'mine.windMill',
    names: ['The Long Granary', 'Goldsheaf', 'Harvestmere', 'The Millpond Flats'],
  },
  {
    resource: 'ley',
    sprite: 'mod.fairyRing',
    names: ['The Ley Spring', 'The Whistling Font', 'Wellspring Hollow', 'The Singing Pool'],
  },
  {
    resource: 'ironwood',
    sprite: 'vein.wood',
    ownedSprite: 'mine.sawmill',
    names: ['Ironwood Grove', 'The Blackbole Stand', 'Kingswood', 'Thornhallow'],
  },
  {
    resource: 'monster',
    sprite: 'lair.cityOfTheDead',
    names: ['The Monster Graveyard', 'The Bonefields', 'The Charnel Downs', 'The Cairn Waste'],
  },
  {
    resource: 'crystal',
    sprite: 'vein.crystal',
    ownedSprite: 'mine.crystal',
    names: ['The Crystal Fissure', 'Glassrift', 'The Shining Cleft', 'Starfall Hollow'],
  },
  {
    resource: 'gem',
    sprite: 'vein.gem',
    ownedSprite: 'mine.gem',
    names: ['The Gem Pit', 'Brightdelve', 'The Jewelled Cut', 'Ember Hollow'],
  },
  {
    resource: 'sulfur',
    sprite: 'vein.sulfur',
    ownedSprite: 'mine.sulfur',
    names: ['The Sulfur Vent', 'Reekfell', 'The Yellow Steps', 'Smoulderpit'],
  },
  {
    resource: 'quicksilver',
    sprite: 'vein.mercury',
    ownedSprite: 'mine.alchemist',
    names: ['The Quicksilver Spring', 'The Silver Draught', 'Swiftwell', 'The Running Font'],
  },
]

/**
 * How many nodes of each kind the board carries, on average.
 *
 * The total is derived rather than written down, so adding a node kind adds
 * nodes to the map instead of quietly diluting the ones already there.
 */
const NODES_PER_KIND = 3
/** Ceiling per kind, set by the name pools above — nothing may go unnamed. */
const NODE_KIND_CAP = 4

/** Fisher-Yates on a copy, driven by the seeded stream. */
function shuffled<T>(list: readonly T[], rng: () => number): T[] {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Which nodes this match actually contains.
 *
 * Every kind appears at least once — a match with no Mithril anywhere would
 * make one of the six buffs unbuildable rather than contested — and the
 * remainder is drawn at random up to the name-pool cap. The result is shuffled
 * because `spread` walks its candidate list in order, so an unshuffled roster
 * would put every Mithril seam in the same quarter of the island and turn
 * "which node can I reach" into a fact about where you happened to start.
 */
function nodeRoster(rng: () => number): { resource: ResourceKind; name: string; sprite: string; ownedSprite?: string }[] {
  const per = NODE_KINDS.map(() => 1)
  let left = NODE_KINDS.length * NODES_PER_KIND - per.length
  while (left > 0) {
    const i = Math.floor(rng() * per.length)
    if (per[i] >= NODE_KIND_CAP) continue
    per[i]++
    left--
  }

  const roster: { resource: ResourceKind; name: string; sprite: string; ownedSprite?: string }[] = []
  NODE_KINDS.forEach((kind, i) => {
    const names = shuffled(kind.names, rng)
    for (let n = 0; n < per[i]; n++) {
      roster.push({
        resource: kind.resource,
        name: names[n],
        sprite: kind.sprite,
        ownedSprite: kind.ownedSprite,
      })
    }
  })
  return shuffled(roster, rng)
}

/**
 * Every monument, its art, and its name.
 *
 * All eight sprites were already packed in `sprites.png` and never drawn by
 * anything — of 241 keys in that atlas, some eighty pieces of location art were
 * shipping as bytes nobody looked at. The Standing Shrine carries three, picked
 * per placement, because the pack authored a tiered set and one of the three
 * being on your map instead of another is free variety.
 */
const MONUMENTS: { kind: MonumentKind; name: string; sprites: string[] }[] = [
  { kind: 'temple', name: 'The Temple of the Open Sky', sprites: ['mod.temple'] },
  { kind: 'shrine', name: 'The Standing Shrine', sprites: ['mod.shrine1', 'mod.shrine2', 'mod.shrine3'] },
  { kind: 'oasis', name: 'The Quiet Water', sprites: ['mod.oasis'] },
  { kind: 'observatory', name: 'The Redwood Observatory', sprites: ['misc.observatory'] },
  { kind: 'sanctum', name: 'The Sanctum of Order', sprites: ['mod.templeOfOrder'] },
  { kind: 'library', name: 'The Drowned Library', sprites: ['mod.library'] },
  { kind: 'sphinx', name: 'The Sphinx', sprites: ['mod.sphinx'] },
  { kind: 'tradingPost', name: 'The Wayfarers’ Post', sprites: ['misc.tradingPost'] },
]

/** Every monument kind that is actually placed, for tools to check against. */
export const MONUMENT_KINDS: readonly MonumentKind[] = MONUMENTS.map((m) => m.kind)

/**
 * The outposts, with a pool of names each — there are more outposts on the
 * board than kinds, because a patrol is local and two Watchforts in different
 * corners are both useful, unlike two Temples.
 */
const OUTPOSTS: { kind: OutpostKind; sprite: string; names: string[] }[] = [
  { kind: 'watchfort', sprite: 'mod.fort', names: ['The Watchfort', 'Highwatch', 'The Bastion'] },
  { kind: 'arena', sprite: 'mod.arena', names: ['The Arena', 'The Proving Ground', 'The Pit'] },
  { kind: 'wayhouse', sprite: 'misc.tavern', names: ['The Wayhouse', 'The Roadside Inn', 'The Last Lamp'] },
  { kind: 'blackMarket', sprite: 'misc.blackMarket', names: ['The Black Market', 'The Cut', 'Thieves’ Row'] },
  { kind: 'warren', sprite: 'mine.dwarvenWarren', names: ['The Dwarven Warren', 'Deepgate', 'The Under-Hall'] },
  { kind: 'wardens', sprite: 'mod.templeOfNature', names: ['The Wardens’ Post', 'Greenwatch', 'The Thornhold'] },
]

/** How many outposts the board carries, and how big their pads are. */
const OUTPOST_COUNT = 14
const OUTPOST_RADIUS = 30
/** Every outpost kind that is actually placed, for tools to check against. */
export const OUTPOST_KINDS: readonly OutpostKind[] = OUTPOSTS.map((o) => o.kind)

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
 * Turn the placed points and capitals into a playable board.
 *
 * Order is deliberate and each step constrains the next, cheapest choice last:
 * the Points of Power are already sited by `planPoints` before this is called,
 * the capitals were placed around them, and what follows here is the fill —
 * lairs, nodes, camps and mines, in whatever room the first two left. Placing
 * mines first would scatter them over exactly the ground the points need.
 */
export function planGameMap(
  seed: string,
  frame: TerrainFrame,
  cities: readonly City[],
  factionCount: number,
  points: readonly PlannedPoint[],
): MapPlan {
  const rng = makeRng(seed, 'gamemap')
  const sites: MapSite[] = []
  const taken: Taken[] = []
  let nextId = 0

  // --- the Points of Power, already sited ------------------------------------
  //
  // First into `taken`, because they were first onto the map. They are the only
  // ground the match is actually won on, so everything else is fitted around
  // them rather than the other way round.
  for (const p of points) {
    taken.push({
      x: p.x,
      z: p.z,
      radius: p.radius,
      group: POINT_GROUP,
      spread: p.frontier ? 220 : 200,
    })
  }

  // --- who owns which capital ------------------------------------------------
  //
  // Each wizard takes the city nearest one of the frontier points. That reverses
  // the old rule, which chose capitals by maximin distance from each other and
  // then hung a Point of Power off each one at 45% of the way to the centre.
  //
  // Maximin existed to stop two wizards starting as neighbours — a real failure
  // that had them trading undefended capitals for whole matches. Anchoring on
  // the frontier ring protects the same thing more strongly and for a better
  // reason: three points evenly divided around a ring are further apart than
  // any search over town positions could promise, so the capitals that inherit
  // them are separated by construction rather than by a scoring function.
  //
  // The player still gets the seat `cities.ts` flagged — the one nearest the
  // map centre, whose territory is coloured the gentlest biome.
  const playerIndex = Math.max(0, cities.findIndex((c) => c.player))
  const ownerOf = new Map<number, number>()
  ownerOf.set(playerIndex, 0)

  const arms = points.filter((p) => p.frontier)
  // The player's arm is whichever one its flagged capital already sits nearest.
  let playerArm = -1
  let playerArmD = Infinity
  arms.forEach((p, i) => {
    const d = (cities[playerIndex].x - p.x) ** 2 + (cities[playerIndex].z - p.z) ** 2
    if (d < playerArmD) {
      playerArmD = d
      playerArm = i
    }
  })

  // Then the AI wizards take the arms furthest from the ones already spoken
  // for. Four arms and three wizards means one is left over, and which one is
  // left over decides how the opening reads — taking them in list order would
  // hand the two AI wizards adjacent corners on every seed.
  const usedArms = playerArm >= 0 ? [playerArm] : []
  let f = 1
  while (f < factionCount && usedArms.length < arms.length) {
    let pick = -1
    let pickD = -1
    arms.forEach((p, i) => {
      if (usedArms.includes(i)) return
      let closest = Infinity
      for (const u of usedArms) {
        const d = (arms[u].x - p.x) ** 2 + (arms[u].z - p.z) ** 2
        if (d < closest) closest = d
      }
      if (closest > pickD) {
        pickD = closest
        pick = i
      }
    })
    if (pick < 0) break
    usedArms.push(pick)

    // Not the *nearest* city to the arm, but the one whose opening run best
    // matches the player's — where an opening run is the distance to the
    // nearest point of any kind, which is the thing a wizard actually races.
    //
    // Matching distance-to-*arm* was tried and made it worse, from a 77-unit
    // median spread to 243: a capital can be a fixed distance from its own arm
    // and still be much nearer or further from the centre, which is often the
    // point it would go for first.
    //
    // Candidates are restricted to cities this arm is nearest to, so the arm
    // assignment still means something and two wizards cannot be seated in the
    // same corner.
    const openingOf = (cx: number, cz: number): number => {
      let best = Infinity
      for (const p of points) {
        const d = Math.hypot(p.x - cx, p.z - cz)
        if (d < best) best = d
      }
      return best
    }
    const target = openingOf(cities[playerIndex].x, cities[playerIndex].z)

    const nearestArmOf = (cx: number, cz: number): number => {
      let bestI = -1
      let bestD = Infinity
      arms.forEach((p, i) => {
        const d = (p.x - cx) ** 2 + (p.z - cz) ** 2
        if (d < bestD) {
          bestD = d
          bestI = i
        }
      })
      return bestI
    }

    let best = -1
    let bestErr = Infinity
    let fallback = -1
    let fallbackD = Infinity
    for (let c = 0; c < cities.length; c++) {
      if (ownerOf.has(c)) continue
      const d = (cities[c].x - arms[pick].x) ** 2 + (cities[c].z - arms[pick].z) ** 2
      if (d < fallbackD) {
        fallbackD = d
        fallback = c
      }
      if (nearestArmOf(cities[c].x, cities[c].z) !== pick) continue
      const err = Math.abs(openingOf(cities[c].x, cities[c].z) - target)
      if (err < bestErr) {
        bestErr = err
        best = c
      }
    }
    if (best < 0) best = fallback
    if (best < 0) break
    ownerOf.set(best, f)
    f++
  }

  // A seed with fewer frontier points than factions still has to seat everyone,
  // so fall back to "furthest from every seat already given out".
  while (f < factionCount) {
    let best = -1
    let bestD = -1
    for (let i = 0; i < cities.length; i++) {
      if (ownerOf.has(i)) continue
      let closest = Infinity
      for (const s of ownerOf.keys()) {
        const d = (cities[i].x - cities[s].x) ** 2 + (cities[i].z - cities[s].z) ** 2
        if (d < closest) closest = d
      }
      if (closest > bestD) {
        bestD = closest
        best = i
      }
    }
    if (best < 0) break
    ownerOf.set(best, f)
    f++
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
    // Cities keep 150 units from each other, exactly as they always have — that
    // separation is what maximin selection reads to keep two wizards from
    // starting as neighbours, and it is not up for negotiation.
    //
    // What changed is that they no longer project 150 units at *everything*.
    // The old rule took the larger of any two gaps, so fifteen capitals
    // sterilised fifteen 150-unit discs for every mine, node and camp placed
    // after them — roughly a million square units on a 2 km island, which is
    // very nearly the whole buildable set. A camp now only has to clear a
    // city's pad. That single distinction is where the room for a full island
    // comes from, and no city moved an inch to get it.
    taken.push({ x: c.x, z: c.z, radius: CITY_RADIUS, group: CITY_GROUP, spread: 150 })
  })

  const cands = buildable(frame, rng)

  for (const p of points) {
    sites.push({
      id: nextId++,
      kind: 'point',
      x: p.x,
      z: p.z,
      owner: NOBODY,
      garrison: p.garrison,
      radius: p.radius,
      name: p.name,
      sprite: 'mod.standingStones',
    })
  }

  // --- monuments -------------------------------------------------------------
  //
  // First of the fill, and spread hardest. There are eight of them and no
  // duplicates anywhere on the board, so each one is a unique prize and two of
  // them in the same valley would hand whoever starts there a realm's worth of
  // standing buffs for one march.
  const monuments = shuffled(MONUMENTS, rng)
  const monumentSpots = spread(cands, taken, monuments.length, 200, MONUMENT_RADIUS, 'monument')
  monumentSpots.forEach((spot, k) => {
    const def = monuments[k]
    sites.push({
      id: nextId++,
      kind: 'monument',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      garrison: 'monument',
      radius: MONUMENT_RADIUS,
      name: def.name,
      sprite: def.sprites[Math.floor(rng() * def.sprites.length)],
      monument: def.kind,
    })
  })

  // --- outposts --------------------------------------------------------------
  //
  // After the monuments, before everything else. An outpost's patrol only ever
  // walks its own beat, so where one stands is the whole of what it is worth —
  // one on a road between two capitals threatens every wagon that passes, and
  // one in a corner threatens nothing.
  const outpostNames = new Map<OutpostKind, string[]>(
    OUTPOSTS.map((o) => [o.kind, shuffled(o.names, rng)]),
  )
  const outpostSpots = spread(cands, taken, OUTPOST_COUNT, 120, OUTPOST_RADIUS, 'outpost')
  outpostSpots.forEach((spot, k) => {
    const def = OUTPOSTS[k % OUTPOSTS.length]
    const pool = outpostNames.get(def.kind)!
    sites.push({
      id: nextId++,
      kind: 'outpost',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      // Guarded by the very patrol it sells, so what you fight is what you buy.
      garrison: `outpost.${def.kind}`,
      radius: OUTPOST_RADIUS,
      name: pool[Math.floor(k / OUTPOSTS.length) % pool.length],
      sprite: def.sprite,
      outpost: def.kind,
    })
  })

  // --- lairs -----------------------------------------------------------------
  //
  // Anywhere on the island. Lairs used to be confined to a midland annulus so
  // they would stand between the homelands and the centre, but a band is a
  // guarantee about where content is, and the same guarantee on every seed is
  // exactly what made one match feel like the last. The roster is shuffled and
  // the whole island is fair ground; a lair behind your own towns is now a
  // thing that happens to you on some seeds and not others.
  const lairs = shuffled(LAIRS, rng).slice(0, LAIR_COUNT)
  const lairSpots = spread(cands, taken, lairs.length, 110, 40, 'lair')
  lairSpots.forEach((spot, k) => {
    sites.push({
      id: nextId++,
      kind: 'lair',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      garrison: 'lair',
      radius: 40,
      name: lairs[k].name,
      sprite: lairs[k].sprite,
      cache: 100 + Math.floor(rng() * 200),
    })
  })

  // --- resource nodes --------------------------------------------------------
  //
  // Before the mines, so the nodes get the better of the leftover ground: a mine
  // is worth gold and nothing else, while a node is worth an army-wide buff and
  // is meant to be somewhere a wizard will fight over.
  const nodes = nodeRoster(rng)
  const nodeSpots = spread(cands, taken, nodes.length, 90, 34, 'node')
  nodeSpots.forEach((spot, k) => {
    const def = nodes[k]
    sites.push({
      id: nextId++,
      kind: 'node',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      garrison: 'node',
      radius: 34,
      name: def.name,
      sprite: def.sprite,
      ownedSprite: def.ownedSprite,
      resource: def.resource,
    })
  })

  // --- camps -----------------------------------------------------------------
  //
  // Before the mines, because a camp is the more *constrained* placement and the
  // island is close to full: a mine may go anywhere, while a camp has to be in
  // somebody's back yard. Placed last it lost every time — one of ten on a good
  // seed, none at all on a bad one — because the mines had already taken the
  // homeland ground it was competing for. This is the same rule the Points of
  // Power get for the same reason: whatever has the least choice picks first.
  //
  // The homeland restriction is gone with the lair band, for the same reason.
  // What it was protecting — that the opening has something to do besides
  // escort an army — is now protected by *count* instead: twenty-five camps at
  // a 70-unit spread means several are within a short flight of any capital on
  // every seed, without any of them being guaranteed to sit in the same ring
  // around your town every single match.
  const campNames = shuffled(CAMP_NAMES, rng)
  const campSpots = spread(cands, taken, CAMP_COUNT, 70, 24, 'camp')
  campSpots.forEach((spot, k) => {
    sites.push({
      id: nextId++,
      kind: 'camp',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      garrison: 'camp',
      radius: 24,
      name: campNames[k % campNames.length],
      sprite: 'mod.mercenaryCamp',
      // Burned, never consecrated — so the cache is the whole reward, the same
      // bargain a lair offers at a fifth of the price.
      cache: 50 + Math.floor(rng() * 100),
    })
  })

  // --- mines -----------------------------------------------------------------
  //
  // Last, and over the whole island rather than the middle: a mine is the thing
  // a wizard takes near home in the first five minutes, so they need to exist in
  // the homelands as well as in the contested ground.
  const mineNames = shuffled(MINE_NAMES, rng)
  const mineSpots = spread(cands, taken, MINE_COUNT, 80, 32, 'mine')
  mineSpots.forEach((spot, k) => {
    sites.push({
      id: nextId++,
      kind: 'mine',
      x: spot.x,
      z: spot.z,
      owner: NOBODY,
      garrison: 'mine',
      radius: 32,
      name: mineNames[k % mineNames.length],
      // Unclaimed it is a raw vein; consecrating it puts a working mine on it.
      sprite: 'vein.gold',
      ownedSprite: 'mine.gold',
    })
  })

  return { sites, capitals }
}
