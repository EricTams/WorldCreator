/**
 * Biomes as territory, not as climate.
 *
 * The obvious way to do this is to derive biomes from simulated fields —
 * elevation, moisture, temperature — and let them fall where physics puts them.
 * That produces a plausible world and an uncontrollable one: you cannot say
 * "there should be a hostile region on the far side" or "the player's start
 * should be temperate", because the noise decides.
 *
 * So a biome here is a *region someone drew* — grown outward from a capital that
 * was sited on ground fit for one, see `world/cities.ts`. Terrain still governs
 * the bands inside a region — a coast is sandy and a summit is bare in every
 * biome — but which palette those bands come from, which creatures garrison it
 * and which resources it yields is a property of whose land you are standing on.
 * That is the axis gameplay actually cares about.
 *
 * A faction holds several cities, not one, so a territory is however many
 * neighbouring cells happen to share a faction — which is what keeps the map
 * from being six blobs with a castle in each.
 *
 * Pure TypeScript: no three.js, no DOM.
 */

import { GROUND_BASE, GROUND_NAMES } from '../assets/groundTiles'
import { SPRITE_FRAMES } from '../assets/sprites'
import { makeNoise2D } from './noise'
import { makeRng } from './prng'

export type BiomeId =
  | 'meadow'
  | 'wildwood'
  | 'highland'
  | 'blight'
  | 'ashland'
  | 'frostmark'

/** RGB in the linear working space, matching colorRamp.ts. */
export type Rgb = readonly [number, number, number]

/**
 * The colours a biome paints its elevation bands with.
 *
 * Every biome supplies the full set rather than sharing a global ramp, because
 * "the same terrain in different territory" is the whole point — a blighted
 * lowland and a meadow lowland are the same height and slope and must not look
 * the same.
 */
export interface BiomeRamp {
  shallow: Rgb
  sand: Rgb
  low: Rgb
  mid: Rgb
  rock: Rgb
  peak: Rgb
}

/**
 * sRGB 0-255 — the space the source art is authored in — to the linear working
 * space the vertex colours live in.
 *
 * Ramps are written in art coordinates on purpose. The first pass hand-picked
 * "tasteful" linear values and every territory came out the same muted sage:
 * measured on screen, three biomes landed on red 139, 138, 139. Numbers you can
 * paste out of the tileset are the only ones that keep the terrain in the same
 * colour world as the sprites standing on it.
 */
/**
 * The flat ground colour of the tileset a territory is floored with, taken
 * straight from that sheet's fill cells. This is the artist's own base colour —
 * the textured tiles are only variety sprinkled over it — so the terrain's
 * dominant band should *be* this, not an approximation of it.
 */
function groundBase(name: string): Rgb {
  const i = GROUND_NAMES.indexOf(name as (typeof GROUND_NAMES)[number])
  const c = GROUND_BASE[i < 0 ? 0 : i]
  return srgb(c[0], c[1], c[2])
}

function srgb(r: number, g: number, b: number): Rgb {
  const f = (c: number): number => {
    const n = c / 255
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)
  }
  return [f(r), f(g), f(b)]
}

export interface Biome {
  id: BiomeId
  name: string
  /** Town sprite key stem for a city sited here. */
  faction: string
  ramp: BiomeRamp
  /** Resources that may be mined in this territory. */
  resources: readonly string[]
  /** Which creature roster garrisons its lairs. */
  roster: string
  /**
   * Name of the tileset whose ground fill this territory is floored with.
   * One of GROUND_NAMES — the biomes the artist actually drew.
   */
  ground: string
  /**
   * Baseline threat, 0..1. Scaled further by distance from the player's start,
   * but this is the authored floor — an ashland is dangerous even next door.
   */
  danger: number
  /**
   * The dominant vegetation — trees, and the mountains that stand in for them
   * where nothing grows. Most of what a territory scatters comes from here.
   *
   * A **number** is an index into this territory's own `tree.<ground>.*` set,
   * resolved the same way `litter` indexes its prop cells: the art pack draws
   * the same five subjects — broadleaf, bush, stump, conifer, pebble — once per
   * biome in that biome's palette, so an index yields a colour-matched tree
   * without naming a sprite. Every territory used to share one Universal set,
   * which made an Ashland pine and a Meadowland pine the same pixels.
   *
   * A **string** is an explicit sprite key, for the cases an index cannot
   * reach — the dead trees the Blight wants but its own sheet does not draw, it
   * being floored on `sand`, whose vegetation is palms and cactus.
   *
   * Repeats are the weighting: a roll picks uniformly from this list, so an
   * entry twice is twice as common.
   */
  canopy: readonly (number | string)[]
  /**
   * The mountain this territory raises where nothing grows.
   *
   * A field of its own rather than another slot in `canopy`, for exactly the
   * reason `litterShare` is a field rather than more entries in one flat list: a
   * mountain is two and a half times the width of a tree and six times its area,
   * so one slot in six *by count* covered nearly half the screen. Scenery this
   * much larger than its neighbours needs a share, not a slot.
   */
  relief: string
  /**
   * Share of scattered props that are relief rather than canopy or litter, 0..1.
   *
   * Highest where the mountain *is* the scenery — an Ashland with three things
   * alive in it is carried by its volcanoes — and lowest under a closed canopy,
   * where a peak poking out of the treetops reads as a z-order bug.
   */
  reliefShare: number
  /**
   * Ground clutter, as indices into the nine prop cells every LandTileset
   * shares. The sprite key is built from `ground`, so the litter is always
   * drawn from the same sheet as the ground it lies on — naming the sprites
   * directly let the two drift apart the moment a territory changed sheets.
   */
  litter: readonly number[]
  /**
   * Share of scattered props that are litter rather than canopy, 0..1.
   *
   * Low for anywhere forested. Canopy and litter were one flat list picked
   * uniformly, which put a log on the ground for every second tree — a wood
   * should read as trees with the occasional fallen branch, not as a even mix
   * of the two. It rises for the barren territories, where there is little
   * canopy for clutter to compete with and the clutter *is* the ground cover.
   */
  litterShare: number
  /**
   * Fraction of the territory that lies inside a stand, 0..1.
   *
   * Area, not a per-point probability — the scatter thresholds a ragged noise
   * field against this. Values near 1 leave no gaps for stands to have edges
   * against, which is what made an earlier pass read as an even sprinkle
   * however dense it was; these are deliberately mid-range so the woods have
   * somewhere to stop.
   *
   * This is what makes a territory legible from a distance more than colour
   * does — a wildwood you cannot walk through and an ashland with nothing alive
   * in it read as different places even in grey-scale.
   */
  density: number
  /**
   * How wide this territory's stands are, as a multiple of `scatterBlob`.
   *
   * `density` says how much of the territory is wooded; this says whether that
   * cover arrives as a few great masses or as many copses. They are independent,
   * and conflating them is what one global blob scale did: at 170 units for
   * everybody, the two territories with the most cover had their stands overlap
   * until the gaps closed, so the Meadowlands and the Wildwood came out as one
   * continuous wood with a ragged outside edge and no interior edges at all.
   * Coverage was right and the shape was wrong, which no amount of `density`
   * could fix — lowering it thins the canopy everywhere rather than breaking the
   * mass up.
   *
   * So the rule is: the more a territory grows, the smaller its stands want to
   * be, because a stand only reads as one when there is something between it and
   * the next. The barren territories go the other way — with cover this sparse,
   * small stands scatter into single props and the territory loses the little
   * structure it has, so their few stands are made wide enough to find.
   */
  standScale: number
}

/**
 * The six factions, one per available town sprite.
 *
 * Six *kinds* of territory, not six territories: there are more cities than
 * factions, so each of these turns up in two or three places on a map.
 *
 * Ordered so index 0 is the gentlest: the player's start region is chosen as
 * the capital nearest the map centre, and it wants to be somewhere survivable.
 */
export const BIOMES: readonly Biome[] = [
  {
    id: 'meadow',
    name: 'Meadowlands',
    faction: 'city.castle',
    ramp: {
      shallow: srgb(70,110,96),
      sand: srgb(227,211,177),
      low: groundBase('grass'),
      // Reference pasture is (118,192,74) and stays there. `mid` was a pale
      // (156,219,67) that bleached every hillside; this is the same green a
      // shade deeper, so height reads as shading rather than as another biome.
      mid: srgb(102,170,64),
      // The reference's brown cliff, measured. Rock is the one band that should
      // *not* stay in the biome's family — bare stone is bare stone.
      rock: srgb(120,102,85),
      peak: srgb(236,241,246),
    },
    resources: ['wood', 'gold', 'ore'],
    roster: 'castle',
    ground: 'grass',
    danger: 0.15,
    // Open pasture: broadleaf-heavy, a few firs, the odd stump.
    canopy: [0, 0, 0, 1, 1, 3, 2],
    relief: 'mount.grass',
    reliefShare: 0.04,
    litter: [0, 2, 3, 6],
    litterShare: 0.22,
    density: 0.52,
    // Copses in pasture. Half the default, because at the default this
    // territory's woods touched and the pasture between them closed up — and
    // open ground with woods standing in it is the whole subject of a meadow.
    standScale: 0.4,
  },
  {
    id: 'wildwood',
    name: 'Wildwood',
    faction: 'city.rampart',
    ramp: {
      shallow: srgb(46,86,74),
      sand: srgb(150,142,110),
      low: groundBase('marsh'),
      // Measured off the artist's own swamp, not chosen: the reference map's
      // marshland is (45,79,59) over a third of its area and never lightens —
      // high ground in a swamp is still swamp. This was a vivid (20,120,44),
      // a pasture green, which pulled everything above the plateau back towards
      // the Meadowlands and was why the Wildwood did not look swampy.
      mid: srgb(48,88,64),
      // Grey, like the reference's swamp outcrops. Brown read as dry ground.
      rock: srgb(96,104,118),
      peak: srgb(186,198,196),
    },
    resources: ['wood', 'gems', 'crystal'],
    roster: 'greatElf',
    // The dark sheet, not the meadow's bright one. Sharing `grass` with the
    // Meadowlands gave two territories literally identical ground, separated
    // only by what grew on it; a closed canopy genuinely shades its floor
    // darker than open pasture, so this is also the truer read.
    ground: 'marsh',
    danger: 0.3,
    // Mangrove and mushroom-capped, and heavy on index 2 — the red fungus. The
    // reference plants those in dense stands rather than sprinkling them, and
    // they are most of what reads as *swamp* rather than as dark woodland.
    canopy: [0, 0, 1, 1, 2, 2, 2, 3],
    relief: 'mount.marsh',
    reliefShare: 0.03,
    litter: [1, 4, 5],
    litterShare: 0.08,
    density: 0.68,
    // The smallest stands on the map, because this territory has the most cover
    // and therefore the least room to show an edge. Thickets and the wet gaps
    // between them: at 0.68 cover the gaps are already the minority, and they
    // have to be numerous or the swamp is just a green fill.
    standScale: 0.32,
  },
  {
    id: 'highland',
    name: 'Highland',
    faction: 'city.stronghold',
    ramp: {
      shallow: srgb(74,96,86),
      sand: srgb(194,179,144),
      low: groundBase('dirt'),
      // Reference badland is (179,121,75); ours bases on (187,117,71). `mid`
      // was (160,134,98), a sandy tan that drifted towards the desert.
      mid: srgb(168,110,70),
      // The grey outcrop the reference uses on every hard biome.
      rock: srgb(108,117,137),
      peak: srgb(226,232,240),
    },
    resources: ['ore', 'gold', 'gems'],
    roster: 'stronghold',
    ground: 'dirt',
    danger: 0.45,
    // Conifer and autumn oak on bare rock. The dirt sheet draws seven subjects
    // rather than five — it is the only one with two broadleaf colourways.
    canopy: [5, 5, 1, 0, 3, 4],
    relief: 'mount.dirt',
    reliefShare: 0.1,
    litter: [0, 5, 7],
    litterShare: 0.3,
    density: 0.38,
    // Not far off the default. At 0.38 cover the stands already have gaps to sit
    // in, so there is nothing to break up.
    standScale: 0.85,
  },
  {
    id: 'blight',
    name: 'The Blight',
    faction: 'city.necropolis',
    ramp: {
      shallow: srgb(46,54,46),
      sand: srgb(160,150,124),
      // `sand`, matching `ground` below. This said `marsh` — so the Blight was
      // painted in the swamp's dark green while being textured, littered and
      // planted from the desert sheet, the same mismatch the Wildwood had.
      low: groundBase('sand'),
      // No reference region for this one; the Blight is ours. So it follows the
      // rule rather than a measurement: stay in the base's family and let it
      // drain. (96,92,58) was a sickly olive sharing nothing with its ground.
      mid: srgb(172,152,120),
      rock: srgb(96,92,84),
      peak: srgb(168,168,160),
    },
    resources: ['mercury', 'ore', 'gold'],
    roster: 'necropolis',
    // Bleached rather than boggy, now that the Wildwood has the dark green.
    // Blighted ground reads either way, and this leaves all six territories on
    // a sheet of their own.
    ground: 'sand',
    danger: 0.7,
    // The one territory that cannot use its own sheet's canopy: it floors on
    // `sand`, whose vegetation is palms and cactus — a desert, not a blight. So
    // the dead trees stay explicit, and only the pebble and the mesa are drawn
    // from the sheet the ground came from.
    canopy: ['deco.deadBare', 'deco.deadBare', 'deco.deadTwisted', 'deco.mushroom', 3],
    relief: 'mount.sand',
    reliefShare: 0.08,
    litter: [1, 5, 6],
    litterShare: 0.28,
    density: 0.3,
    // Wide and few. Dead ground wants its standing timber gathered into stands
    // you can name rather than sprinkled evenly at low odds.
    standScale: 1.15,
  },
  {
    id: 'ashland',
    name: 'Ashlands',
    faction: 'city.inferno',
    ramp: {
      shallow: srgb(44,40,42),
      sand: srgb(110,96,84),
      low: groundBase('lava'),
      // Reference ashland is (76,85,97) — a cold blue-grey, not the hot rust
      // this had at (116,68,42). The red in that biome comes from lava pools and
      // fire props, not from the ground, which is why ground reading as scorched
      // earth made the whole territory muddy.
      mid: srgb(66,74,86),
      rock: srgb(33,33,49),
      peak: srgb(120,112,110),
    },
    resources: ['sulfur', 'ore', 'mercury'],
    roster: 'darkBastion',
    ground: 'lava',
    danger: 0.85,
    // Bleached dead trees, red coral, and the sheet's volcano — the one peak in
    // the pack with lava at the top, which is worth a heavier weighting than the
    // other territories give their mountains.
    //
    // Plus the two props in the pack that are fire rather than vegetation. They
    // were drawn for exactly this territory and no biome was scattering them:
    // the Ashlands' own ramp comment notes that its red is supposed to come from
    // lava and fire props rather than from the ground, and then nothing put any
    // on the ground. A spout and an open flame are also the only things here
    // that are *not* dead, which is what stops the territory reading as a grey
    // field with sticks in it.
    canopy: [0, 0, 1, 2, 3, 'deco.lavaSpout', 'deco.lavaSpout', 'deco.flame'],
    relief: 'mount.lava',
    // Trimmed from 0.14. The volcano was carrying the territory when there was
    // nothing else to look at; now that there is, it can go back to being the
    // landmark rather than the ground cover.
    reliefShare: 0.11,
    litter: [0, 2, 5, 6],
    // Down from 0.5. Half of everything scattered here being a pebble is what
    // made the extra cover invisible at any distance — litter is small, so it
    // reads as texture on the ground rather than as things standing on it.
    litterShare: 0.32,
    // Up from 0.16. That was not "sparse", it was empty — measured over two
    // seeds it scattered 0.5 props per 1000 u², against 9 in the Blight and 25
    // in the Highland. About two hundred things in a whole territory.
    //
    // The reason it was so much worse than the number looks is that `density`
    // is a percentile on a near-normal noise field, not a fraction of points
    // kept, so it falls off a cliff in the tail rather than in proportion.
    // Measured on this territory: 0.24 gives 4 per 1000, 0.28 gives 9, 0.32
    // gives 15, 0.36 gives 23. Nearly a factor of six across a range that reads
    // as if it should be a factor of one and a half.
    //
    // 0.28 is sixteen times what was there and still the lowest of the six —
    // just under the Blight on its emptiest seed. The Ashlands should be the
    // place where the least grows, not the place where nothing does.
    density: 0.28,
    // Wide stands, for the same reason the Blight has them: at this little
    // cover, small stands break up into lone props and the territory stops
    // having any structure to read at all.
    standScale: 1.1,
  },
  {
    id: 'frostmark',
    name: 'Frostmark',
    faction: 'city.tower',
    ramp: {
      shallow: srgb(46,88,110),
      sand: srgb(178,188,200),
      low: groundBase('ice'),
      // Reference snowfield is (230,230,253) across a quarter of its area and
      // never turns blue. `mid` was (124,162,176), a mid teal — half the
      // territory came out looking like shallow water.
      mid: srgb(210,216,244),
      // The same grey outcrop as the other hard biomes. White-on-white has no
      // relief, and this is where that contrast should come from.
      rock: srgb(108,117,137),
      peak: srgb(255,255,247),
    },
    resources: ['crystal', 'gems', 'ore'],
    roster: 'wizards',
    ground: 'ice',
    danger: 0.6,
    // Index 4 is the ice sheet's blue crystal — the one thing in any of the six
    // canopies that is not vegetation at all, and the clearest single tell that
    // you have crossed into Frostmark.
    canopy: [0, 1, 3, 3, 4, 5],
    relief: 'mount.ice',
    reliefShare: 0.07,
    litter: [0, 5, 7],
    litterShare: 0.32,
    density: 0.32,
    // Snowfields with treelines in them. Near the default — at 0.32 cover the
    // stands already stand apart.
    standScale: 0.95,
  },
]

/**
 * Every sprite key a territory can scatter.
 *
 * Both lists are indices rather than keys, which is what keeps them tied to the
 * sheet the ground came from — and also what lets one go stale silently when the
 * manifest changes. An index past the end of a tree set builds a key that is
 * simply absent from the atlas, and the card layer would then look up an
 * undefined frame and stretch the whole texture across one card. So the keys are
 * resolved once here and checked below.
 */
export function scatterKeys(b: Biome): string[] {
  return [
    b.relief,
    ...b.litter.map((i) => `prop.${b.ground}.${i}`),
    ...b.canopy.map((c) => (typeof c === 'number' ? `tree.${b.ground}.${c}` : c)),
  ]
}

for (const b of BIOMES) {
  for (const key of scatterKeys(b)) {
    if (!(key in SPRITE_FRAMES)) {
      throw new Error(`biome "${b.id}": scatter sprite "${key}" is not in the atlas`)
    }
  }
}

/**
 * Deal `count` territory types out, as evenly as the count allows.
 *
 * A whole shuffled permutation at a time rather than `count` independent draws.
 * There are more cities than factions, and sampling each independently leaves
 * one faction absent about as often as it gives another five — with fifteen
 * cities and six factions this guarantees every faction two or three.
 */
export function dealBiomes(count: number, rng: () => number): number[] {
  const out: number[] = []
  while (out.length < count) {
    const block = BIOMES.map((_, i) => i)
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[block[i], block[j]] = [block[j], block[i]]
    }
    out.push(...block)
  }
  return out.slice(0, count)
}

export interface BiomeSeed {
  x: number
  z: number
  biome: number
}

export interface BiomeField {
  seeds: readonly BiomeSeed[]
  /** Index into `seeds` of the region the player starts in. */
  startSeed: number
  worldSize: number
  /** World units over which neighbouring regions cross-fade. */
  blend: number
  warpAmount: number
  warpScale: number
  /**
   * A second, much finer octave of the same warp.
   *
   * The coarse warp bends a border over hundreds of units, which stops the map
   * reading as a Voronoi diagram but still leaves every border a smooth curve.
   * Once the cross-fade is narrow enough to read as an edge, that smoothness is
   * visible as such — and the art this is matching has borders that are ragged
   * at the scale of a tile or two, because they are made of tiles. This supplies
   * that raggedness.
   */
  detailAmount: number
  detailScale: number
  warpX: (x: number, y: number) => number
  warpZ: (x: number, y: number) => number
}

export interface BiomeParams {
  enabled: boolean
  /**
   * How many capitals to place, and so how many cells the territory field is
   * seeded from. Not capped at the number of biomes — several cities share a
   * faction, and adjacent cells of the same faction read as one territory.
   */
  cities: number
  /** World units of cross-fade at a border. */
  blend: number
  /** How far the border wanders from a straight bisector, in world units. */
  warp: number
}

/**
 * Seed the territories.
 *
 * Pass `cities` and each capital becomes the seed of its own territory, so a
 * region is the land around its city — see `world/cities.ts`. That is the path
 * the game takes.
 *
 * Without them the seeds are scattered at random with a minimum separation, the
 * start region is chosen and swapped here rather than there, and no terrain is
 * consulted. That path is still live for the two callers that have no terrain to
 * consult: anything asking what the territories *would* be before a heightmap
 * exists, and the GUI's biome preview.
 */
export function buildBiomeField(
  seed: string,
  worldSize: number,
  p: BiomeParams,
  cities?: readonly { x: number; z: number; biome: number; player: boolean }[],
): BiomeField {
  const rng = makeRng(seed, 'biome')
  const count = Math.max(1, p.cities)
  const half = worldSize / 2

  // Keep seeds off the very edge; a region centred in the sea is wasted.
  const reach = half * 0.62
  const minGap = (reach * 1.5) / Math.sqrt(count)

  const seeds: BiomeSeed[] = []
  let startSeed = 0

  if (cities && cities.length > 0) {
    for (const c of cities) seeds.push({ x: c.x, z: c.z, biome: c.biome })
    startSeed = Math.max(
      0,
      cities.findIndex((c) => c.player),
    )
  } else {
    const pool = dealBiomes(count, rng)

    let guard = 0
    while (seeds.length < count && guard++ < 4000) {
      const a = rng() * Math.PI * 2
      const r = Math.sqrt(rng()) * reach
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      if (seeds.some((s) => Math.hypot(s.x - x, s.z - z) < minGap)) continue
      seeds.push({ x, z, biome: pool[seeds.length] })
    }

    // The player starts in whichever territory sits nearest the map centre,
    // which is where the avatar spawns. Then swap the gentlest biome into it, so
    // the opening region is survivable however the dice fell.
    let best = Infinity
    for (let i = 0; i < seeds.length; i++) {
      const d = Math.hypot(seeds[i].x, seeds[i].z)
      if (d < best) {
        best = d
        startSeed = i
      }
    }
    const gentle = seeds.findIndex((s) => s.biome === 0)
    if (gentle >= 0 && gentle !== startSeed) {
      const tmp = seeds[startSeed].biome
      seeds[startSeed].biome = seeds[gentle].biome
      seeds[gentle].biome = tmp
    }
  }

  // Borders follow a noise-warped bisector rather than a straight one. Without
  // this the map is visibly a Voronoi diagram, and straight territory edges on
  // an organic island look like a rendering bug.
  const warpX = makeNoise2D(makeRng(seed, 'biomeWarpX'))
  const warpZ = makeNoise2D(makeRng(seed, 'biomeWarpZ'))

  // A border must never cross a capital. The warp displaces the *query point*
  // before the nearest-seed search, so a warp larger than half the distance
  // between two seeds can carry a point past its own city and hand it to the
  // neighbour — which is how a territory ends up with its border running through
  // the town that defines it.
  //
  // This was safe while there were six seeds spread over the whole island and
  // half-gaps ran to several hundred units. At fifteen the cells are a quarter
  // the area, the measured half-gap is about 120, and the default warp of 180
  // simply swamps them. So the wander is capped by the geometry it is wandering
  // in rather than by a constant.
  let halfGap = Infinity
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const d = Math.hypot(seeds[i].x - seeds[j].x, seeds[i].z - seeds[j].z)
      if (d < halfGap) halfGap = d
    }
  }
  halfGap = seeds.length > 1 ? halfGap * 0.5 : Infinity
  // Two thirds, not all of it: at exactly the half-gap a border can still graze
  // a seed, and the blend band needs somewhere to sit clear of the town.
  const warpAmount = Math.min(p.warp, halfGap * 0.66)

  return {
    seeds,
    startSeed,
    worldSize,
    blend: Math.min(Math.max(1, p.blend), halfGap * 0.9),
    warpAmount,
    warpScale: 1 / Math.max(1, worldSize * 0.35),
    // Roughly a fifth of the wander at six times the frequency — enough to make
    // an edge ragged, far too little to carry a point out of its own territory.
    detailAmount: warpAmount * 0.2,
    detailScale: 6 / Math.max(1, worldSize * 0.35),
    warpX,
    warpZ,
  }
}

/** The two territories nearest a point, and how far between them it sits. */
export interface BiomeSample {
  /** Index into BIOMES. */
  a: number
  b: number
  /** 0 at the centre of `a`, 1 at the centre of `b`. */
  t: number
  /**
   * How far inside its own territory this point is, in world units — the
   * difference between the distances to the two nearest capitals, 0 on a border
   * and growing inland.
   *
   * Roughly *twice* the perpendicular distance to the border: a step across a
   * bisector closes one unit on the capital behind and opens one on the capital
   * ahead. `t` cannot stand in for this, because `t` saturates to 0 the moment
   * the gap exceeds `blend` and so says only "not near a border", not how far.
   */
  gap: number
  /**
   * Index into `field.seeds` of the nearest capital — which *territory* owns
   * this point, as opposed to which biome is painted on it. Two capitals can
   * share a biome, so `a` cannot answer this.
   *
   * Exposed because the biome audit was recomputing it: it kept its own copy of
   * the warp and the nearest-seed search, and a duplicate of a search is a
   * search that can disagree with the one the game runs.
   */
  seed: number
}

const sample: BiomeSample = { a: 0, b: 0, t: 0, gap: 0, seed: -1 }

/**
 * Which territory owns a world position.
 *
 * Returns a shared object — this runs once per terrain vertex, up to four
 * million times per rebuild, and allocating there would dominate the cost.
 * Copy out what you need before the next call.
 */
export function sampleBiomeAt(field: BiomeField, worldX: number, worldZ: number): BiomeSample {
  const { seeds } = field
  if (seeds.length === 0) {
    sample.a = 0
    sample.b = 0
    sample.t = 0
    sample.gap = Infinity
    sample.seed = -1
    return sample
  }

  const wx = worldX * field.warpScale
  const wz = worldZ * field.warpScale
  const dx = worldX * field.detailScale
  const dz = worldZ * field.detailScale
  const x =
    worldX + field.warpX(wx, wz) * field.warpAmount + field.warpX(dx, dz) * field.detailAmount
  const z =
    worldZ + field.warpZ(wx, wz) * field.warpAmount + field.warpZ(dx, dz) * field.detailAmount

  let i0 = 0
  let d0 = Infinity
  let i1 = 0
  let d1 = Infinity
  for (let i = 0; i < seeds.length; i++) {
    const dx = seeds[i].x - x
    const dz = seeds[i].z - z
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < d0) {
      d1 = d0
      i1 = i0
      d0 = d
      i0 = i
    } else if (d < d1) {
      d1 = d
      i1 = i
    }
  }

  sample.a = seeds[i0].biome
  sample.b = seeds[i1 === i0 ? i0 : i1].biome
  // Distance *difference* rather than ratio: a ratio makes the blend band widen
  // with distance from the seeds, so borders near the coast turn to mush while
  // borders near the middle stay crisp.
  //
  // Note that this is roughly *twice* the distance to the border — walking one
  // metre across a bisector closes one metre on the seed behind and opens one on
  // the seed ahead. So `blend` is a band width in difference-units and the fade
  // it paints on the ground is about half as wide. That factor of two is why the
  // old 260 read as a continent-wide gradient rather than as a border.
  const gap = seeds.length > 1 ? d1 - d0 : Infinity
  const t = gap >= field.blend ? 0 : 0.5 * (1 - gap / field.blend)
  sample.t = t
  sample.gap = gap
  sample.seed = i0
  return sample
}

/** Convenience for gameplay code that only needs the owning territory. */
export function biomeAt(field: BiomeField, worldX: number, worldZ: number): Biome {
  const s = sampleBiomeAt(field, worldX, worldZ)
  return BIOMES[s.t > 0.5 ? s.b : s.a]
}
