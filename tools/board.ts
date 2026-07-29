/**
 * Building the island the way the game builds it, without a renderer.
 *
 * Three tools need a board — the match harness, the placement audit and the
 * biome audit — and getting one is not a one-liner: the heightmap has to be
 * eroded and amplified, and the frame has to carry the coastal shelf, or every
 * height query comes back under sea level and `placeCities` returns nothing at
 * all. `tools/biomeAudit.ts` was doing exactly that and had been silently
 * broken; it also hardcoded a 60-unit capital clearing when the real figure is
 * 17.6, so it had been reporting on a board the game does not build.
 *
 * So the sequence lives here once. A tool that plans its own board is a tool
 * that can disagree with the game, and a measurement that disagrees with the
 * game is worse than no measurement.
 */
import { defaultParams } from '../src/world/params'
import type { WorldParams } from '../src/world/params'
import { generateHeightmap } from '../src/world/generate'
import { erode } from '../src/world/erosion'
import { amplify } from '../src/world/amplify'
import { makeRng } from '../src/world/prng'
import { placeCities } from '../src/world/cities'
import type { City } from '../src/world/cities'
import { planGameMap, planPoints } from '../src/world/gameMap'
import type { MapPlan } from '../src/world/gameMap'
import type { Heightmap } from '../src/world/heightmap'
import type { TerrainFrame } from '../src/world/terrainQuery'
import { capitalClearing, flattenSitePads, siteClearing } from '../src/world/sites'
import type { SitePad } from '../src/world/sites'
import type { SpriteKey } from '../src/assets/sprites'

export interface Board {
  params: WorldParams
  heightmap: Heightmap
  frame: TerrainFrame
  cities: City[]
  plan: MapPlan
}

export interface BoardOptions {
  /** Skip amplification. Much faster, and the coarse shape is unchanged. */
  rough?: boolean
  /** Skip pad flattening — an audit that only reads positions does not need it. */
  flatten?: boolean
  factions?: number
}

export function buildBoard(seed: string, opts: BoardOptions = {}): Board {
  const { rough = false, flatten = true, factions = 3 } = opts

  const params = defaultParams()
  params.seed = seed

  let hm = generateHeightmap(params)
  if (params.erosion.droplets > 0) {
    erode(hm, params.erosion, params.shape.seaLevel, makeRng(params.seed, 'erosion'))
  }
  if (params.amplify.enabled && !rough) {
    hm = amplify(hm, params.amplify, params.seed).heightmap
  }

  const worldWidth = params.mapSize * params.render.cellSize
  const scale = Math.max(1e-5, params.render.heightScale)
  const frame: TerrainFrame = {
    heightmap: hm,
    cellSize: worldWidth / (hm.size - 1),
    heightScale: params.render.heightScale,
    seaLevel: params.shape.seaLevel,
    // The coastal step, in the normalised heights the heightfield speaks —
    // `main.ts` `coastShelf()`, which every height query has to agree with.
    // Leaving these out is what made the biome audit see an island with no
    // land on it.
    shelfRise: params.render.coastStep / scale,
    shelfBand: params.render.coastBand / scale,
  }

  // Points of Power first, cities around them, everything else in the gaps.
  // The X the five points make is the map's fairness, so it is decided from the
  // terrain before anything can crowd it.
  const clearing = capitalClearing()
  const points = planPoints(params.seed, frame)
  const cities = placeCities(params.seed, frame, {
    count: params.biome.cities,
    clearing,
    reserved: points.map((p) => ({ x: p.x, z: p.z, radius: p.radius + clearing })),
  })
  const plan = planGameMap(params.seed, frame, cities, factions, points)

  if (flatten) {
    // A capital levels its whole village ring; everything else levels only the
    // ground its own card stands on. Same rule as `main.ts` — `s.radius` is the
    // defender leash, not a measure of the building.
    const plazas: SitePad[] = cities.map((c) => ({ x: c.x, z: c.z, radius: clearing }))
    const pads: SitePad[] = plan.sites
      .filter((s) => s.sprite !== null)
      .map((s) => ({ x: s.x, z: s.z, radius: siteClearing(s.sprite as SpriteKey) }))
    flattenSitePads(hm, frame.cellSize, [...plazas, ...pads])
  }

  return { params, heightmap: hm, frame, cities, plan }
}
