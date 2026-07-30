/**
 * The road network: what the island's traffic has worn into it.
 *
 * Pure TypeScript, no three.js — same rule as the rest of `world/`. This decides
 * *where* road is; `render/roadLayer.ts` decides what it looks like.
 *
 * Two rules decide everything here, and the second is the interesting one.
 *
 * **Roads run between neighbours, not across the island.** There is no trunk
 * network and nothing guarantees you can follow tarmac from one coast to the
 * other. Each place is linked to the few places near it, and that is all. A
 * fully connected network would be a second map drawn over the first, competing
 * with the territory colours for the same job; a local link says only "these
 * two are neighbours", which is a smaller and truer thing to say.
 *
 * **Road is only drawn where it cuts through something.** A path across open
 * pasture is invisible in this art and would be invisible in life — bare ground
 * already reads as passable, so paving it spends pixels to say nothing. Where a
 * route crosses a wood, though, the wood has to open for it, and *that* is worth
 * drawing: the gap in the canopy is the road. So the raster is the intersection
 * of "a route goes here" with "vegetation would be here", and the same predicate
 * that puts road down is the one that takes the trees away. Cross a meadow and
 * there is simply nothing to see.
 *
 * The one exception is a town, which is paved whether or not anything grew
 * there. A town square is a built thing, not a worn one.
 *
 * Lairs and camps are linked to nothing on purpose. Nobody keeps a road to a
 * monster.
 */

import type { Heightmap } from './heightmap'
import { sampleHeightAndGradient } from './heightmap'
import { BIOMES, sampleBiomeAt } from './biome'
import type { BiomeField } from './biome'
import type { MapSite, SiteKind } from './gameMap'
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
 * How many near neighbours a place is linked to, and how far counts as near.
 *
 * The reach is the number that decides whether this reads as neighbours calling
 * on each other or as a road network. Median distance to a site's nearest
 * neighbour is 86 units and cities sit 190 to 300 apart, so 170 links a place to
 * the handful of things in its own valley and essentially never to the next
 * city — which is the intent. Raise it and the local links start chaining into
 * exactly the cross-island network this is not.
 *
 * Links are symmetric and de-duplicated, so three each does not mean three
 * roads out of every door; it means a place reaches for three and keeps
 * whichever of those, plus whichever reached back, survive the terrain.
 */
const LINK_NEIGHBOURS = 3
const LINK_REACH = 170

/**
 * Which kinds of place are worth linking.
 *
 * Everything a wizard would have reason to visit repeatedly. Lairs and camps are
 * absent deliberately — see the header.
 */
const LINK_KINDS: readonly SiteKind[] = ['city', 'point', 'monument', 'outpost', 'mine', 'node']

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
 */
const CUT_DEPTH_SHARE = 0.12

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
 * A cut only reads as a cut when it is much longer than it is wide. The road is
 * one routing cell across, so at 14 it is fourteen times longer than it is wide
 * — unmistakably a line — and 70 world units, about three tree-heights, so
 * there is a real stretch of it to see. Anything shorter is dropped whole
 * rather than shortened, and the trees stay.
 */
const CUT_MIN_RUN = 14

export interface RoadNetwork {
  /**
   * Material index + 1 per cell, 0 for no road. Row-major, `size` per side.
   *
   * Offset by one so that zero can mean "nothing here" without costing a
   * parallel occupancy array — the grid is 640k cells and is walked twice per
   * regenerate, so its size is worth caring about.
   */
  cells: Uint8Array
  /** Cells per side. */
  size: number
  /** World units per cell. */
  cellSize: number
  /** World XZ of cell (0, 0)'s centre. */
  originX: number
  originZ: number
  /** Centrelines in world space, for anything that needs the route rather than the raster. */
  paths: readonly (readonly { x: number; z: number }[])[]
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
    // Beaten earth through farmland and forest.
    case 'meadow':
    case 'wildwood':
      return 'dirt'
    // Hard country, hard surface.
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

      // Water is not routed across. Bridges exist in the tileset and are not
      // wired up; until they are, "the road stops at the water" is the honest
      // result, and the island is connected land so no trunk needs one.
      if (g.height <= seaLevel + 0.004) {
        cost[j * size + i] = Infinity
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
 * Every pair of places near enough to have worn a path between them.
 *
 * Each node reaches for its `LINK_NEIGHBOURS` nearest within `LINK_REACH`, and
 * the pairs are then de-duplicated, so the result is symmetric and a popular
 * place can end up with more links than an isolated one — which is the right
 * asymmetry to have.
 *
 * O(n²) over about eighty nodes. A grid would be faster and is not worth the
 * code; this runs once per map, next to an erosion pass that costs a thousand
 * times more.
 *
 * Sorted by length before returning, shortest first. That ordering is load
 * bearing: routes laid earlier are discounted for reuse by routes laid later,
 * so doing the short obvious links first gives the longer ones something
 * sensible to join, rather than the other way round.
 */
function neighbourLinks(nodes: readonly { x: number; z: number }[]): [number, number][] {
  const n = nodes.length
  if (n < 2) return []

  const d2 = (a: number, b: number): number => {
    const dx = nodes[a].x - nodes[b].x
    const dz = nodes[a].z - nodes[b].z
    return dx * dx + dz * dz
  }

  const reach2 = LINK_REACH * LINK_REACH
  const seen = new Set<number>()
  const out: { a: number; b: number; d: number }[] = []

  for (let a = 0; a < n; a++) {
    const near: { b: number; d: number }[] = []
    for (let b = 0; b < n; b++) {
      if (b === a) continue
      const d = d2(a, b)
      if (d > reach2) continue
      near.push({ b, d })
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
      if (dx * dx + dz * dz <= r * r) net.cells[j * net.size + i] = v
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
): boolean[] {
  const keep = path.map((c) => {
    const x = origin + (c % routeSize) * ROUTE_CELL
    const z = origin + ((c / routeSize) | 0) * ROUTE_CELL
    return stands.depth(x, z) > CUT_DEPTH_SHARE * stands.cover(x, z)
  })

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

  return keep
}

/**
 * Rasterise the cut stretches of a routed path onto the draw grid.
 *
 * One routing cell becomes the 2x2 block of draw cells it covers, which is
 * where the road's two-tile width comes from. The material is resampled per
 * cell rather than per path, so a road crossing a border changes surface on the
 * border rather than at whichever end happened to decide.
 *
 * Returns the cells actually paved, so the caller can discount them for reuse.
 * Only paved cells are worth reusing: a later route that followed the unpaved
 * part of an earlier one would be following a road that is not there.
 */
function rasterise(
  net: RoadNetwork,
  path: readonly number[],
  keep: readonly boolean[],
  routeSize: number,
  field: BiomeField | null,
): number[] {
  const scale = ROUTE_CELL / net.cellSize
  const paved: number[] = []
  for (let n = 0; n < path.length; n++) {
    if (!keep[n]) continue
    const c = path[n]
    paved.push(c)
    const i0 = Math.round((c % routeSize) * scale)
    const j0 = Math.round(((c / routeSize) | 0) * scale)
    for (let j = j0; j < j0 + scale; j++) {
      for (let i = i0; i < i0 + scale; i++) {
        if (i < 0 || j < 0 || i >= net.size || j >= net.size) continue
        const k = j * net.size + i
        // A town's paving is not overwritten by the country road running into
        // it. The plaza is stamped first and is the more specific statement.
        if (net.cells[k] === MATERIAL_INDEX[PLAZA_MATERIAL] + 1) continue
        const x = net.originX + i * net.cellSize
        const z = net.originZ + j * net.cellSize
        const biome = field ? BIOMES[sampleBiomeAt(field, x, z).a].id : 'meadow'
        net.cells[k] = MATERIAL_INDEX[materialForBiome(biome)] + 1
      }
    }
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
    size: drawSize,
    cellSize: ROAD_CELL,
    originX: origin,
    originZ: origin,
    paths: [],
  }

  const linked = sites.filter((s) => LINK_KINDS.includes(s.kind))
  if (linked.length < 2) return net

  // Town squares first, so a country road arriving at one stops at the paving
  // instead of running over it. These are unconditional: a town is paved
  // whether or not a wood happened to be standing there.
  for (const s of sites) {
    if (s.kind !== 'city') continue
    stampDisc(net, s.x, s.z, plazaRadius, PLAZA_MATERIAL)
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

  const paths: { x: number; z: number }[][] = []
  for (const [a, b] of neighbourLinks(linked)) {
    const p = route(nodeCell[a], nodeCell[b], routeSize, cost, built, scratch)
    if (!p) continue
    const keep = cutMask(p, routeSize, origin, stands)
    const paved = rasterise(net, p, keep, routeSize, field)
    if (paved.length === 0) continue
    markBuilt(paved, built)
    paths.push(toWorld(paved, routeSize, origin))
  }

  net.paths = paths
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
