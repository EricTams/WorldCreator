/**
 * The road network: what the island's traffic has worn into it.
 *
 * Pure TypeScript, no three.js — same rule as the rest of `world/`. This decides
 * *where* road is; `render/roadLayer.ts` decides what it looks like.
 *
 * **Everything joins its three nearest.** Every site on the board reaches for
 * the three places closest to it — city, mine, monument, lair, camp, no
 * exceptions — and the pairs are de-duplicated, so nothing is ever left with no
 * road and a place several neighbours all chose becomes a junction. There is no
 * distance limit and no trunk tier: the network's shape falls out of where the
 * sites happen to be, which is the same thing that decides everything else
 * about how a map plays.
 *
 * **Everything routed is drawn**, for now. See `CUT_TO_COVER`: the machinery to
 * pave only where a road cuts through vegetation is intact and still measured,
 * but switched off, so what you see on the ground is exactly the network the
 * router built. That makes a bad route and a deliberately-unpaved one tell
 * apart, which they do not when both are simply an absence.
 *
 * A town is paved whether or not anything grew there — a town square is a built
 * thing, not a worn one — and that stays true either way.
 */

import type { Heightmap } from './heightmap'
import { sampleHeightAndGradient } from './heightmap'
import { BIOMES, sampleBiomeAt } from './biome'
import type { BiomeField } from './biome'
import type { MapSite } from './gameMap'
import type { StandField } from './sites'
import { ROAD_MATERIALS } from '../assets/roads'
import type { RoadMaterial } from '../assets/roads'

/**
 * World units across one road tile.
 *
 * Not a free parameter: it is `DEFAULT_PIXEL_SCALE`, the same conversion the
 * props and the ground texture use, so a road pixel is exactly a tree pixel.
 * Anything else and the road reads as a different piece of art laid on top of
 * this one — which is precisely how it looked when it was tried at 4.
 */
export const ROAD_CELL = 2.5

/**
 * World units across one routing cell — two road tiles.
 *
 * Routing is done coarser than drawing, for two reasons that happen to agree.
 * The cheap one: A* over the draw grid is four times the nodes for a path that
 * is visually identical once it has been rasterised. The real one: a road wants
 * to be two tiles wide, so a routed cell that *is* two tiles wide makes the
 * width fall out of the rasteriser instead of being brushed on afterwards, and
 * a brush is what produces the lumpy edges and stray diagonal nicks that make
 * an autotiled road look like a mistake.
 */
export const ROUTE_CELL = ROAD_CELL * 2

/**
 * How steep a road will tolerate before it would rather go round.
 *
 * Not a hard limit — the cost curve below is smooth, and a road will still climb
 * a pass if the detour is long enough. This is the slope at which climbing costs
 * about as much as going four times as far, which is roughly the trade a road
 * builder makes.
 */
const SLOPE_REFERENCE = 0.22

/**
 * What a cell of existing road costs, as a fraction of open ground.
 *
 * This is the single most important number here and the least obvious. Without
 * it every pair is routed independently, and two towns on the same side of the
 * island end up joined by two roads running parallel a few cells apart — which
 * reads not as a network but as a rendering bug. At a steep discount the second
 * route prefers to join the first, run along it, and leave again near its
 * destination, which is what a road network actually is.
 *
 * Low enough to be worth a real detour, not zero: at zero, routes take
 * absurd tours along existing road to save a few cells of new ground.
 */
const REUSE_COST = 0.15

/**
 * How deep the water may be for a bridge to cross it, in normalised height
 * below the waterline.
 *
 * This, not the cost below, is what stops roads striding across the sea. Cost
 * alone cannot: make it high enough to forbid a long ocean crossing and a road
 * will not step over a stream either, because A* only ever compares a crossing
 * against the detour around it, and for a site on an islet there is no detour
 * at any price. A depth limit is a statement about the water itself and does
 * not depend on what is on the far side.
 *
 * 0.05 against a sea level of about 0.32 covers inlets, river mouths and the
 * bar across a lagoon, and stops well short of open sea. Measured on two seeds:
 * at 0.05 the longest span is 15 units, at 0.25 it is 22 and starts to read as a
 * causeway rather than a bridge.
 */
const BRIDGE_DEPTH = 0.05

/**
 * What a cell of bridgeable water costs, against 1 for flat land.
 *
 * High enough that a road takes a reasonable dry detour first — six cells of
 * dry ground, 30 world units, before a single cell of water is worth it — so
 * bridges appear where crossing is genuinely the sensible line and not merely
 * possible. Bridges are also expensive to look at: a handful across the map is
 * a feature, one at every stream is noise.
 */
const BRIDGE_COST = 6

/**
 * How many nearest places each place reaches for.
 *
 * Every linkable place reaches, not just the cities — a mine and the node in
 * the next valley are joined whether or not a capital cared about either. Three
 * is enough to make the network connected in practice while leaving it visibly
 * a network rather than a mesh.
 *
 * There is deliberately no distance limit. An earlier version capped reach at
 * 170 units so that a link meant "these two are neighbours", and the cost was
 * that an isolated place — one with nothing inside the cap — got no roads at
 * all, which reads as a bug rather than as a statement about its isolation.
 * Three nearest, however far they turn out to be, guarantees everything is
 * joined to something, and on a crowded part of the map they are short anyway.
 *
 * Links are symmetric and de-duplicated, so three each does not mean three
 * roads out of every door: two places that each pick the other share one road,
 * and a popular place ends up with more than three while a remote one keeps
 * exactly its three. That asymmetry is worth having — it is the difference
 * between a crossroads and a dead end.
 */
const LINK_NEIGHBOURS = 3

/**
 * How deep into a stand the vegetation has to be before road is drawn, as a
 * fraction of what the territory grows at all.
 *
 * Not zero, and this matters more than it looks. At exactly the treeline the
 * stand field is hovering either side of the threshold, so a route skimming the
 * edge of a wood lays a dotted line of one- and two-cell fragments — which reads
 * as a rendering fault, not as a path. Requiring the route to be properly inside
 * cover before it paves means a road either enters the wood or does not. The
 * same slack works at the other end: a road already inside a wood keeps paving
 * until it is properly clear, so it exits cleanly rather than fraying.
 *
 * A *fraction* rather than a fixed depth, because depth is not comparable
 * between territories. This was 0.06 flat, tuned against the Meadowlands, and
 * measured over two seeds it gave the Blight, the Ashlands and the Frostmark
 * exactly zero road between them — not because those places have no woods, but
 * because a bar set at a meadow's idea of "properly inside" is past the deepest
 * point a sparse territory's stands ever reach. Scaling by the territory's own
 * cover asks the same question of each: is this the thick of it, for here?
 *
 * Down from 0.12, which asked for the thick of it far too literally. Read off
 * the debug overlay on a road leaving a capital: the tiles either side of the
 * gate scored 0.4, 0.6, 0.9 — all genuinely inside cover, all rejected — and
 * only three tiles in the whole 27-tile route cleared the bar. The territory's
 * woods simply are not that deep near a town, which is exactly where a road is
 * most wanted. At 0.04 the bar is "meaningfully inside a stand" rather than
 * "at its heart", and anything with no cover at all still scores negative and
 * still gets nothing, which is the part that has to keep holding.
 */
const CUT_DEPTH_SHARE = 0.04

/**
 * Cells of road either side of a gap that get filled in anyway.
 *
 * A wood is not solid — the stand field has small holes in it — and a road that
 * honestly stopped at every one would be a dashed line through a thicket. Any
 * break shorter than this is bridged, so the road stays continuous through a
 * wood while still ending where the wood does.
 */
const CUT_BRIDGE = 8

/**
 * Shortest stretch of road worth drawing, in routing cells.
 *
 * The failure this exists to stop is the one that made the first version look
 * broken, and it is worth spelling out because the cause is not where the
 * symptom is. A road is *also* a clearing — the trees under it are removed — so
 * a four-cell cut through a small copse does not read as a path through a wood.
 * It removes the copse and leaves a bare rounded patch of dirt in open grass,
 * with no line through it and nothing left standing to have been cut. On the
 * meadow those blobs read as bald spots in the turf.
 *
 * A cut only reads as a cut when it is longer than it is wide. The road is one
 * routing cell across, so this is also its aspect ratio: at 4 a cut is four
 * times longer than it is wide and 20 world units end to end, which is a short
 * length of road rather than a patch.
 *
 * Down from 14, which was set against the blob failure above and was solving it
 * twice over. The blobs had two causes and the other one — 2x2 blocks stamped
 * per routing cell, meeting only at their corners on every diagonal — is now
 * fixed properly in `rasterise`, so the length rule no longer has to compensate
 * for a rasteriser that could not draw a thin line. Measured against what it
 * was throwing away: a road leaving a capital had cover running 1.7, 1.9, 1.3
 * over three tiles and was discarded whole for want of eleven more. Cover near
 * a town arrives in bursts of three to six tiles, and those bursts are the
 * roads most worth having.
 */
const CUT_MIN_RUN = 4

/**
 * Whether to pave only where a route cuts through vegetation.
 *
 * Off for now: every routed link is drawn end to end, open field included. The
 * cut rule and its two smoothing passes are left intact below and are still
 * measured — the debug overlay draws the score for every tile either way — so
 * turning this back on is one word and changes nothing else.
 *
 * The reason to have it off is that the two questions are easier to answer
 * apart than together. "Does the network go to sensible places, and does the
 * drawn road look right?" is about routing and rasterising; "should this
 * stretch exist?" is about cover. With the cut rule on, a bad route and a
 * correctly-declined one look identical — an absence — which is exactly the
 * confusion that made the Stonebury exits hard to reason about.
 */
const CUT_TO_COVER = false

export interface RoadNetwork {
  /**
   * Material index + 1 per cell, 0 for no road. Row-major, `size` per side.
   *
   * Offset by one so that zero can mean "nothing here" without costing a
   * parallel occupancy array — the grid is 640k cells and is walked twice per
   * regenerate, so its size is worth caring about.
   */
  cells: Uint8Array
  /**
   * The surface this cell fades *towards*, same +1 offset, and how far along
   * that fade it is as 0..255 mapping 0..1.
   *
   * Two arrays rather than one packed value because the renderer reads them
   * into two separate vertex attributes anyway, and because `cells` is the hot
   * one — the autotiler walks it eight times per cell and has no use for these.
   */
  alt: Uint8Array
  mix: Uint8Array
  /**
   * Where the road is a bridge, and which way its deck runs.
   *
   * 0 for ordinary road, 1 for a deck running east-west, 2 for north-south.
   * A bridge is not autotiled — its tile is chosen by the direction of the road
   * crossing, not by which neighbours are road — so it cannot be expressed in
   * `cells` and needs a channel of its own.
   */
  bridge: Uint8Array
  /** Cells per side. */
  size: number
  /** World units per cell. */
  cellSize: number
  /** World XZ of cell (0, 0)'s centre. */
  originX: number
  originZ: number
  /**
   * Every link that was routed, paved or not.
   *
   * The whole centreline is kept, not just the stretches that became road,
   * because the two are different claims and the difference is the thing worth
   * being able to look at. `cells` says what is drawn; this says what was
   * *meant* — which pairs of places the network considers neighbours and which
   * way the ground let a route between them run. Only where the two disagree,
   * and why, tells you whether a missing road is a routing failure or the cut
   * rule correctly declining to pave a field.
   *
   * Nothing in the game reads this. The debug overlay and the audit do.
   */
  routes: readonly RoadRoute[]
}

/** One neighbour link: where it went, and how much of it was paved. */
export interface RoadRoute {
  /** The places joined, in world space. */
  from: { x: number; z: number }
  to: { x: number; z: number }
  /** The routed centreline, one point per routing cell. */
  points: readonly { x: number; z: number }[]
  /**
   * Per point of `points`: did this cell become road?
   *
   * Parallel to `points` rather than a filtered second list, so a consumer can
   * draw the intended route and the drawn one in one walk and see exactly where
   * the road enters and leaves cover.
   */
  paved: readonly boolean[]
  /**
   * Per point of `points`: how much vegetation there is here, as a multiple of
   * how much it takes to be worth paving. 1 is exactly the bar.
   *
   * This is the number the cut rule actually decides on, before the two passes
   * that smooth its verdict — gap bridging and the minimum-run filter. So a
   * cell can be paved with a score under 1 (bridged across a hole in a wood) or
   * unpaved with a score over 1 (part of a run too short to be worth drawing),
   * and those two disagreements are precisely the ones worth being able to see.
   */
  score: readonly number[]
}

/** Terrain the router has to cross. */
export interface RoadTerrain {
  hm: Heightmap
  cellSize: number
  heightScale: number
  seaLevel: number
}

/**
 * Which road material a territory surfaces its roads with.
 *
 * Indexed by biome, and deliberately not by anything the player controls: it is
 * a property of the place, the same way its ground tile and its trees are, and
 * it is one more thing that makes a territory recognisable from the air.
 */
function materialForBiome(id: string): RoadMaterial {
  switch (id) {
    // Beaten earth, on the one territory pale enough to take it. `dirt` is the
    // lightest surface in the pack and its outline is a warm tan barely a shade
    // darker than its fill — it has almost no edge of its own, and relies on
    // the ground around it to supply the contrast. Meadow grass does.
    case 'meadow':
      return 'dirt'
    // Hard country, hard surface — and the Wildwood, which floors on the dark
    // marsh sheet. `dirt` was here first and was wrong: cream on near-black
    // green is a scar rather than a path, and because the material's own
    // outline is so faint the road read as a flat slab with no edges at all.
    // Gravel is a mid brown, so it sits against dark ground instead of
    // shouting over it, and its outline is dark enough to be seen.
    case 'wildwood':
    case 'highland':
    case 'blight':
      return 'gravel'
    // Dark stone on the ash and the ice, both of which need the contrast:
    // a dirt road on either would be nearly the same value as its ground.
    default:
      return 'cobble'
  }
}

/** A town's own streets are paved, whatever the country road into it is made of. */
const PLAZA_MATERIAL: RoadMaterial = 'brick'

/**
 * How much wider the road's surface transition is than the ground's colour fade.
 *
 * Matching `biome.blend` exactly was the first attempt and it is invisible. The
 * arithmetic: `blend` is 16 *difference* units, which is about 8 units on the
 * ground, which is three road cells — and across three cells a probabilistic
 * dither flips one of them. The road changed surface in a single step with one
 * stray tile beside it, which reads as a hard edge with a rendering fault next
 * to it rather than as a transition.
 *
 * The ground gets away with a band that narrow because it is fading a *colour*
 * continuously: eight units is plenty to cross-fade green into tan. A road
 * cannot fade, because a cell holds one tile index — the only thing it can do
 * is interleave whole cells, and interleaving needs room to be legible. Four
 * times the width gives about thirteen cells, which is a stretch of road you
 * can watch change rather than a boundary you cross.
 *
 * So the two are deliberately no longer the same number. They are still tied:
 * this scales `biome.blend`, so moving the border-blend slider still moves the
 * road with it.
 */
const BLEND_SCALE = 4

/**
 * The two surfaces a road cell is made of, and how far between them it sits.
 *
 * A real cross-fade, not a choice. The renderer samples the same tile out of
 * both materials' blocks and lerps — the four blocks are pixel-identical in
 * layout, so a given neighbourhood picks the same tile in each and the two
 * samples differ only in surface, never in shape. That makes mixing them safe
 * and makes the alpha mask identical, so the road's outline stays crisp while
 * its material dissolves.
 *
 * An earlier version dithered instead, picking one material or the other per
 * cell on a hash. It is the traditional answer for indexed tiles and it was
 * wrong here: across a band a few cells wide it flips one or two tiles, which
 * reads as a hard edge with stray pixels beside it rather than as a transition.
 *
 * `mix` runs 0 at the heart of a territory to 0.5 exactly on the border, where
 * the two are even. It stops at 0.5 rather than reaching 1 because the pair
 * swaps as you cross — past the line the far territory becomes `a` and the mix
 * falls away again — which is what makes the fade symmetric without either side
 * having to know where the border is.
 *
 * The width comes from `gap`, the difference between the distances to the two
 * nearest capitals, rather than from the sample's own `t`, because that one is
 * scaled to `biome.blend` and this band is deliberately wider. See
 * `BLEND_SCALE`.
 */
function materialAt(
  field: BiomeField | null,
  x: number,
  z: number,
): { a: RoadMaterial; b: RoadMaterial; mix: number } {
  const fallback = materialForBiome('meadow')
  if (!field) return { a: fallback, b: fallback, mix: 0 }
  const s = sampleBiomeAt(field, x, z)
  const band = Math.max(1e-3, field.blend * BLEND_SCALE)
  const mix = s.gap >= band ? 0 : 0.5 * (1 - s.gap / band)
  return {
    a: materialForBiome(BIOMES[s.a].id),
    b: materialForBiome(BIOMES[s.b].id),
    mix,
  }
}

const MATERIAL_INDEX: Record<string, number> = Object.fromEntries(
  ROAD_MATERIALS.map((m, i) => [m, i]),
)

/**
 * A binary heap keyed on cost.
 *
 * Written out rather than sorting an array: the frontier reaches tens of
 * thousands of cells on a long route and a sort per pop turned the whole build
 * into seconds. Parallel typed arrays rather than objects for the same reason.
 */
class Frontier {
  private cell = new Int32Array(1024)
  private cost = new Float32Array(1024)
  private n = 0

  get size(): number {
    return this.n
  }

  clear(): void {
    this.n = 0
  }

  push(cell: number, cost: number): void {
    if (this.n === this.cell.length) {
      const c = new Int32Array(this.n * 2)
      const f = new Float32Array(this.n * 2)
      c.set(this.cell)
      f.set(this.cost)
      this.cell = c
      this.cost = f
    }
    let i = this.n++
    this.cell[i] = cell
    this.cost[i] = cost
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.cost[p] <= this.cost[i]) break
      this.swap(i, p)
      i = p
    }
  }

  pop(): number {
    const top = this.cell[0]
    this.n--
    if (this.n > 0) {
      this.cell[0] = this.cell[this.n]
      this.cost[0] = this.cost[this.n]
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < this.n && this.cost[l] < this.cost[m]) m = l
        if (r < this.n && this.cost[r] < this.cost[m]) m = r
        if (m === i) break
        this.swap(i, m)
        i = m
      }
    }
    return top
  }

  private swap(a: number, b: number): void {
    const c = this.cell[a]
    this.cell[a] = this.cell[b]
    this.cell[b] = c
    const f = this.cost[a]
    this.cost[a] = this.cost[b]
    this.cost[b] = f
  }
}

/**
 * The cost of building through each routing cell, and where the sea is.
 *
 * Baked once for the whole map rather than sampled inside A*, because every
 * route re-walks the same ground and `sampleHeightAndGradient` is a bilinear
 * fetch plus two differences. With twenty-odd routes over a 400-cell grid this
 * is the difference between one pass and twenty.
 */
function bakeCost(terrain: RoadTerrain, size: number): Float32Array {
  const { hm, cellSize, heightScale, seaLevel } = terrain
  const cells = hm.size - 1
  const cost = new Float32Array(size * size)

  // Routing cell to heightmap grid space. The two grids share an origin — the
  // caller's `worldSize` is the heightmap's own extent — so this is a ratio and
  // not an offset, and the clamp is for the bilinear sampler's last cell.
  const perCell = ROUTE_CELL / cellSize

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const gx = Math.min(cells - 1.001, Math.max(0, i * perCell))
      const gz = Math.min(cells - 1.001, Math.max(0, j * perCell))
      const g = sampleHeightAndGradient(hm.data, hm.size, gx, gz)

      // Water is crossable, on a bridge, if it is shallow enough — see
      // `BRIDGE_DEPTH` and `BRIDGE_COST`. Deep water is not: a bridge across an
      // ocean is a mistake, and the depth test is what keeps crossings at the
      // inlets and river mouths where one belongs.
      const depth = seaLevel - g.height
      if (depth > -0.004) {
        cost[j * size + i] = depth > BRIDGE_DEPTH ? Infinity : BRIDGE_COST
        continue
      }

      const dx = (g.gradX * heightScale) / cellSize
      const dz = (g.gradZ * heightScale) / cellSize
      const slope = Math.sqrt(dx * dx + dz * dz)

      // Quadratic in slope, so gentle ground is all much the same and a
      // hillside gets expensive fast. Linear was tried and produced roads that
      // climbed straight over ridges: at any sane weight a linear penalty is
      // either ignorable on the flat or crippling everywhere.
      const s = slope / SLOPE_REFERENCE
      cost[j * size + i] = 1 + s * s * 3
    }
  }
  return cost
}

/** World XZ to routing-cell index, clamped to the grid. */
function cellOf(x: number, z: number, size: number, origin: number): number {
  const i = Math.min(size - 1, Math.max(0, Math.round((x - origin) / ROUTE_CELL)))
  const j = Math.min(size - 1, Math.max(0, Math.round((z - origin) / ROUTE_CELL)))
  return j * size + i
}

/**
 * Cheapest route between two cells, as a list of cell indices, or null.
 *
 * A* with an octile heuristic — the grid is 8-connected, so straight-line
 * distance under-estimates badly enough on diagonals to cost real time.
 * `built` marks cells that already carry road and makes them cheap; see
 * `REUSE_COST`.
 *
 * The scratch arrays are passed in and reused across every route on a map. They
 * are 160k entries each and allocating a fresh pair per route was, measured,
 * most of the time this file spent.
 */
function route(
  from: number,
  to: number,
  size: number,
  cost: Float32Array,
  built: Uint8Array,
  scratch: { g: Float32Array; came: Int32Array; stamp: Int32Array; era: number; heap: Frontier },
): number[] | null {
  const { g, came, stamp, heap } = scratch
  const era = ++scratch.era
  heap.clear()

  const tx = to % size
  const tz = (to / size) | 0
  const heuristic = (c: number): number => {
    const dx = Math.abs((c % size) - tx)
    const dz = Math.abs(((c / size) | 0) - tz)
    const lo = Math.min(dx, dz)
    return dx + dz + (Math.SQRT2 - 2) * lo
  }

  if (!isFinite(cost[from]) || !isFinite(cost[to])) return null

  g[from] = 0
  came[from] = -1
  stamp[from] = era
  heap.push(from, heuristic(from))

  const closed = new Set<number>()

  while (heap.size > 0) {
    const cur = heap.pop()
    if (cur === to) {
      const path: number[] = []
      for (let c = cur; c !== -1; c = came[c]) path.push(c)
      return path.reverse()
    }
    if (closed.has(cur)) continue
    closed.add(cur)

    const cx = cur % size
    const cz = (cur / size) | 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        const nx = cx + dx
        const nz = cz + dz
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue
        const n = nz * size + nx
        const base = cost[n]
        if (!isFinite(base)) continue

        // A diagonal may not cut a corner past impassable ground, or a road
        // slips through a one-cell gap between two cliffs and looks teleported.
        if (dx !== 0 && dz !== 0) {
          if (!isFinite(cost[cz * size + nx]) || !isFinite(cost[nz * size + cx])) continue
        }

        const step = dx !== 0 && dz !== 0 ? Math.SQRT2 : 1
        const w = (built[n] ? REUSE_COST : 1) * base * step
        const tentative = g[cur] + w
        if (stamp[n] === era && tentative >= g[n]) continue
        stamp[n] = era
        g[n] = tentative
        came[n] = cur
        heap.push(n, tentative + heuristic(n))
      }
    }
  }
  return null
}

/** Mark a routed path into the built mask, so later routes can join it. */
function markBuilt(path: readonly number[], built: Uint8Array): void {
  for (const c of path) built[c] = 1
}

/**
 * Every road anywhere wants: each place's `LINK_NEIGHBOURS` nearest.
 *
 * Every node reaches, and every node is reachable. Pairs are de-duplicated
 * after everyone has chosen, so the result is symmetric and a place that
 * several neighbours all picked ends up a junction.
 *
 * O(n²) over about eighty places. A spatial index would be faster and is not
 * worth the code; this runs once per map, next to an erosion pass that costs a
 * thousand times more.
 *
 * Sorted by length before returning, shortest first. That ordering is load
 * bearing: routes laid earlier are discounted for reuse by routes laid later,
 * so doing the short obvious links first gives the longer ones something
 * sensible to join, rather than the other way round.
 */
function nearestLinks(nodes: readonly { x: number; z: number }[]): [number, number][] {
  const n = nodes.length
  if (n < 2) return []

  const d2 = (a: number, b: number): number => {
    const dx = nodes[a].x - nodes[b].x
    const dz = nodes[a].z - nodes[b].z
    return dx * dx + dz * dz
  }

  const seen = new Set<number>()
  const out: { a: number; b: number; d: number }[] = []

  for (let a = 0; a < n; a++) {
    const near: { b: number; d: number }[] = []
    for (let b = 0; b < n; b++) {
      if (b === a) continue
      near.push({ b, d: d2(a, b) })
    }
    near.sort((p, q) => p.d - q.d)
    for (const { b, d } of near.slice(0, LINK_NEIGHBOURS)) {
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const k = lo * n + hi
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ a: lo, b: hi, d })
    }
  }

  out.sort((p, q) => p.d - q.d)
  return out.map((e) => [e.a, e.b] as [number, number])
}

/**
 * Stamp a filled disc of road into the draw grid.
 *
 * Used for town squares, and for the little apron where a spur meets its
 * building — a road that arrives at a wall and stops dead reads as unfinished,
 * where a widening at the end reads as a yard.
 */
function stampDisc(
  net: RoadNetwork,
  x: number,
  z: number,
  radius: number,
  material: RoadMaterial,
): void {
  const v = MATERIAL_INDEX[material] + 1
  const ci = (x - net.originX) / net.cellSize
  const cj = (z - net.originZ) / net.cellSize
  const r = radius / net.cellSize
  const i0 = Math.max(0, Math.floor(ci - r))
  const i1 = Math.min(net.size - 1, Math.ceil(ci + r))
  const j0 = Math.max(0, Math.floor(cj - r))
  const j1 = Math.min(net.size - 1, Math.ceil(cj + r))
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = i - ci
      const dz = j - cj
      if (dx * dx + dz * dz > r * r) continue
      const k = j * net.size + i
      // A plaza is one flat surface with nothing to fade towards, so it points
      // its blend at itself. Leaving `alt` at 0 would name material -1.
      net.cells[k] = v
      net.alt[k] = v
      net.mix[k] = 0
    }
  }
}

/**
 * Which stretches of a route are cutting through vegetation.
 *
 * Returns a keep-flag per path cell. Two passes, because the naive test is not
 * enough on its own:
 *
 *   1. Is this cell properly inside a stand? (`CUT_DEPTH`, not merely inside,
 *      so a route grazing a treeline does not stipple.)
 *   2. Close any gap shorter than `CUT_BRIDGE`, so the small holes every wood
 *      has do not chop the road into dashes.
 *   3. Drop any surviving stretch shorter than `CUT_MIN_RUN`, because a short
 *      cut erases a copse instead of passing through one.
 *
 * The order matters. Bridging before measuring means two cut stretches either
 * side of a small gap count as the one road they visually are, rather than as
 * two short ones that both get dropped.
 *
 * Pass 2 deliberately does not extend the road past its last cut cell. A road
 * should end at the treeline, not a few cells out in the field.
 */
function cutMask(
  path: readonly number[],
  routeSize: number,
  origin: number,
  stands: StandField,
): { keep: boolean[]; score: number[] } {
  // The raw verdict per cell, and the number behind it. `score` is the stand
  // depth as a multiple of the threshold it had to clear, so 1 is exactly the
  // bar: at or above and this cell has enough vegetation to be worth cutting,
  // below and it does not. Kept because "the road stops here" has several
  // possible causes and only this number distinguishes them — see the debug
  // overlay, which draws it per tile.
  const score = path.map((c) => {
    const x = origin + (c % routeSize) * ROUTE_CELL
    const z = origin + ((c / routeSize) | 0) * ROUTE_CELL
    const bar = CUT_DEPTH_SHARE * stands.cover(x, z)
    return bar > 0 ? stands.depth(x, z) / bar : 0
  })
  // Everything routed is paved, and the smoothing passes have nothing to do.
  // The scores above are still computed and returned: they cost one noise
  // lookup a tile and they are what the debug overlay draws.
  if (!CUT_TO_COVER) return { keep: score.map(() => true), score }

  const keep = score.map((s) => s > 1)

  let gap = 0
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) {
      // A gap counts only when it has road on both sides; a false run at the
      // start of the path is the approach to the wood, not a hole in it.
      if (gap > 0 && gap <= CUT_BRIDGE) {
        for (let j = i - gap; j < i; j++) keep[j] = true
      }
      gap = 0
    } else {
      gap++
    }
  }

  let run = 0
  for (let i = 0; i <= keep.length; i++) {
    if (i < keep.length && keep[i]) {
      run++
      continue
    }
    if (run > 0 && run < CUT_MIN_RUN) {
      for (let j = i - run; j < i; j++) keep[j] = false
    }
    run = 0
  }

  return { keep, score }
}

/**
 * Centre of the 2x2 block of draw cells one routing cell covers.
 *
 * Half a draw cell off the grid's own centres, because a two-wide road is
 * centred on the *boundary* between its two cells, not on either of them.
 */
function blockCentre(
  net: RoadNetwork,
  c: number,
  routeSize: number,
): { x: number; z: number } {
  return {
    x: net.originX + ((c % routeSize) * 2 + 0.5) * net.cellSize,
    z: net.originZ + (((c / routeSize) | 0) * 2 + 0.5) * net.cellSize,
  }
}

/**
 * Paint every draw cell within `half` of the segment a–b.
 *
 * A distance test rather than a block fill, which is the whole point: see
 * `rasterise`. The bounding box is the segment's own, grown by the half-width,
 * so a step costs about five cells by five however the road is oriented.
 */
function stampSegment(
  net: RoadNetwork,
  a: { x: number; z: number },
  b: { x: number; z: number },
  half: number,
  field: BiomeField | null,
  overWater: (x: number, z: number) => boolean,
): void {
  const plaza = MATERIAL_INDEX[PLAZA_MATERIAL] + 1
  // Which way the deck runs, decided once for the whole segment rather than per
  // cell. Per cell it would flip mid-span wherever the crossing is close to
  // diagonal, and a bridge whose planks change direction halfway is worse than
  // one that is slightly off the line of travel.
  const deck = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z) ? 1 : 2
  const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - half - net.originX) / net.cellSize))
  const i1 = Math.min(net.size - 1, Math.ceil((Math.max(a.x, b.x) + half - net.originX) / net.cellSize))
  const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - half - net.originZ) / net.cellSize))
  const j1 = Math.min(net.size - 1, Math.ceil((Math.max(a.z, b.z) + half - net.originZ) / net.cellSize))

  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const half2 = half * half + 1e-6

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = net.originX + i * net.cellSize
      const z = net.originZ + j * net.cellSize
      let t = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const px = a.x + dx * t - x
      const pz = a.z + dz * t - z
      if (px * px + pz * pz > half2) continue
      const k = j * net.size + i
      // A town's paving is not overwritten by the country road running into
      // it. The plaza is stamped first and is the more specific statement.
      if (net.cells[k] === plaza) continue
      const m = materialAt(field, x, z)
      net.cells[k] = MATERIAL_INDEX[m.a] + 1
      net.alt[k] = MATERIAL_INDEX[m.b] + 1
      net.mix[k] = Math.round(m.mix * 255)
      net.bridge[k] = overWater(x, z) ? deck : 0
    }
  }
}

/**
 * Rasterise the cut stretches of a routed path onto the draw grid.
 *
 * Painted as a swept band along the centreline, *not* as one 2x2 block of draw
 * cells per routing cell. The block version is the obvious implementation and
 * it breaks on exactly the case the router produces most: the route grid is
 * eight-connected, so a diagonal step moves one cell in both axes, and the two
 * 2x2 blocks it stamps meet only at a single corner. The road pinches to
 * nothing at every diagonal — a chain of squares touching at their corners
 * rather than a road. It is worst where roads look best otherwise, because a
 * route that is not following an axis is diagonal most of the way.
 *
 * Sweeping a half-width of one draw cell along the segment between successive
 * centres gives two cells across on the axes — the same width as before — and
 * an unbroken two-cell band on the diagonals. The material is resampled per
 * cell rather than per path, so a road crossing a border changes surface on the
 * border rather than at whichever end happened to decide.
 *
 * Returns the routing cells actually paved, so the caller can discount them for
 * reuse. Only paved cells are worth reusing: a later route that followed the
 * unpaved part of an earlier one would be following a road that is not there.
 */
function rasterise(
  net: RoadNetwork,
  path: readonly number[],
  keep: readonly boolean[],
  routeSize: number,
  field: BiomeField | null,
  overWater: (x: number, z: number) => boolean,
): number[] {
  // One draw cell. On an axis this keeps exactly the two cells either side of
  // the block boundary and rejects their neighbours at 1.5 cells out.
  const half = net.cellSize
  const paved: number[] = []

  for (let n = 0; n < path.length; n++) {
    if (!keep[n]) continue
    paved.push(path[n])
    const a = blockCentre(net, path[n], routeSize)
    // Sweep to the next kept cell. Where there is none — the last cell of a
    // cut — the segment collapses to a point and stamps a round cap, which is
    // how a road should end anyway.
    const b = n + 1 < path.length && keep[n + 1] ? blockCentre(net, path[n + 1], routeSize) : a
    stampSegment(net, a, b, half, field, overWater)
  }

  return paved
}

/** Path cells back to world-space centreline points. */
function toWorld(
  path: readonly number[],
  routeSize: number,
  origin: number,
): { x: number; z: number }[] {
  return path.map((c) => ({
    x: origin + (c % routeSize) * ROUTE_CELL,
    z: origin + (((c / routeSize) | 0) as number) * ROUTE_CELL,
  }))
}

/**
 * Lay the island's roads.
 *
 * `plazaRadius` is the town square: the same clearing the capital's houses
 * stand in, so the paving stops where the prepared ground does rather than
 * spilling into the fields.
 */
export function buildRoadNetwork(
  terrain: RoadTerrain,
  sites: readonly MapSite[],
  field: BiomeField | null,
  stands: StandField,
  opts: { worldSize: number; plazaRadius: number },
): RoadNetwork {
  const { worldSize, plazaRadius } = opts
  const origin = -worldSize / 2

  const drawSize = Math.ceil(worldSize / ROAD_CELL)
  const routeSize = Math.ceil(worldSize / ROUTE_CELL)

  const net: RoadNetwork = {
    cells: new Uint8Array(drawSize * drawSize),
    alt: new Uint8Array(drawSize * drawSize),
    mix: new Uint8Array(drawSize * drawSize),
    bridge: new Uint8Array(drawSize * drawSize),
    size: drawSize,
    cellSize: ROAD_CELL,
    originX: origin,
    originZ: origin,
    routes: [],
  }

  // Every site, with no filter on kind, and that is deliberate.
  //
  // There used to be one: lairs and camps were held out on the reasoning that
  // nobody maintains a road to a monster. It reads well and it is wrong on the
  // board — it silently left 40 of 132 sites with no road at all, a camp
  // standing in the middle of a network that flowed around it, which looks like
  // a bug in the router rather than a statement about who lives there. A road
  // to a lair is fine in the fiction too: somebody cut it once, and something
  // else lives at the end of it now.
  //
  // Unfiltered rather than a list of all eight kinds, so a kind added later
  // joins the network instead of quietly falling out of it.
  const linked = sites
  if (linked.length < 2) return net

  // Town squares first, so a country road arriving at one stops at the paving
  // instead of running over it. These are unconditional: a town is paved
  // whether or not a wood happened to be standing there.
  for (const s of sites) {
    if (s.kind !== 'city') continue
    stampDisc(net, s.x, s.z, plazaRadius, PLAZA_MATERIAL)
  }

  // Is this point standing in water? Asked per drawn cell, so it samples the
  // heightfield directly rather than the routing grid — a crossing is five
  // world units wide and the routing grid is coarser than that, so reading the
  // route's own cells would put the deck a cell wide of the water it spans.
  const cells = terrain.hm.size - 1
  const overWater = (x: number, z: number): boolean => {
    const gx = Math.min(cells - 1.001, Math.max(0, (x - origin) / terrain.cellSize))
    const gz = Math.min(cells - 1.001, Math.max(0, (z - origin) / terrain.cellSize))
    return sampleHeightAndGradient(terrain.hm.data, terrain.hm.size, gx, gz).height <= terrain.seaLevel
  }

  const cost = bakeCost(terrain, routeSize)
  const built = new Uint8Array(routeSize * routeSize)
  const scratch = {
    g: new Float32Array(routeSize * routeSize),
    came: new Int32Array(routeSize * routeSize),
    stamp: new Int32Array(routeSize * routeSize),
    era: 0,
    heap: new Frontier(),
  }

  // A site sits on a levelled pad, but the pad is flat *ground* — it can still
  // be ringed by cost, and a place in a valley can have its own cell be the
  // only finite one for some way. Nothing to do about that here; if a node
  // cannot be reached its links simply fail and the rest stands.
  const nodeCell = linked.map((s) => cellOf(s.x, s.z, routeSize, origin))

  const routes: RoadRoute[] = []
  for (const [a, b] of nearestLinks(linked)) {
    const p = route(nodeCell[a], nodeCell[b], routeSize, cost, built, scratch)
    // A link the terrain refused is still worth recording — a route that could
    // not be found and a route that was found and not paved look identical on
    // the ground, and the overlay should be able to tell them apart.
    if (!p) {
      routes.push({
        from: { x: linked[a].x, z: linked[a].z },
        to: { x: linked[b].x, z: linked[b].z },
        points: [],
        paved: [],
        score: [],
      })
      continue
    }
    const { keep, score } = cutMask(p, routeSize, origin, stands)
    const paved = rasterise(net, p, keep, routeSize, field, overWater)
    if (paved.length > 0) markBuilt(paved, built)
    routes.push({
      from: { x: linked[a].x, z: linked[a].z },
      to: { x: linked[b].x, z: linked[b].z },
      points: toWorld(p, routeSize, origin),
      paved: keep,
      score,
    })
  }

  net.routes = routes
  return net
}

/**
 * Is there road at this point? Used by the scatter to keep the verge clear.
 *
 * `margin` widens the query beyond the paving itself, which is what actually
 * produces the swath: trees whose trunks are a metre off the kerb still lean
 * their canopy over it, and a 16px tree drawn at 2.5 units is mostly canopy.
 */
export function roadAt(net: RoadNetwork, x: number, z: number, margin = 0): boolean {
  const r = Math.ceil(margin / net.cellSize)
  const ci = Math.round((x - net.originX) / net.cellSize)
  const cj = Math.round((z - net.originZ) / net.cellSize)
  for (let j = cj - r; j <= cj + r; j++) {
    if (j < 0 || j >= net.size) continue
    for (let i = ci - r; i <= ci + r; i++) {
      if (i < 0 || i >= net.size) continue
      if (net.cells[j * net.size + i]) return true
    }
  }
  return false
}
