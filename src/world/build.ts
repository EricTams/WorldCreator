/**
 * Building the island, once, for everyone who needs one.
 *
 * There used to be three of these: `planWorld` in `main.ts`, `buildBoard` in
 * `tools/board.ts`, and a private copy inside `tools/matchHarness.ts`. They
 * disagreed, silently, for as long as they existed — the harness eroded and
 * amplified before placing anything and the game never did either, so the same
 * seed grew two different islands and only one of them was ever on screen. A
 * measurement taken on the other one is worse than no measurement, because it
 * looks like a fact.
 *
 * So the sequence lives here, under `src/`, where `npm run typecheck` can see it
 * and both sides have to import it rather than restate it.
 *
 * Pure TypeScript: no three.js, no DOM. `main.ts` keeps everything that turns
 * this plan into cards; this module stops at where things go.
 */
import { spriteWidthOf } from '../assets/spriteScale'
import type { SpriteKey } from '../assets/sprites'
import { amplify } from './amplify'
import { buildBiomeField } from './biome'
import type { BiomeField } from './biome'
import { placeCities } from './cities'
import type { City } from './cities'
import { erode } from './erosion'
import { generateHeightmap } from './generate'
import { planGameMap, planPoints } from './gameMap'
import type { MapPlan, PlannedPoint } from './gameMap'
import { Heightmap } from './heightmap'
import type { WorldParams } from './params'
import { makeRng } from './prng'
import {
  VILLAGE_INNER,
  VILLAGE_OUTER,
  capitalClearing,
  flattenSitePads,
  settlementLayout,
  siteClearing,
} from './sites'
import type { Settlement, SitePad } from './sites'
import type { TerrainFrame } from './terrainQuery'

/**
 * How far down the pipeline the heightmap has been taken.
 *
 * Every island a match is played on reaches `refine`, so that is the default:
 * `main.ts` follows its `generate` with an erode and an amplify before anything
 * is sited, and only then plans the world. `generate` is what a terrain slider
 * shows you mid-drag — the raw shape, moving under your hands, with no capitals
 * on it — and no match is ever played on it.
 *
 * It used to be the other way round. Erosion was reachable only from the GUI
 * button, so the game shipped planning its cities on raw ground while this
 * harness planned them on refined ground, and the same seed grew two different
 * islands.
 *
 * `rough` erodes but skips amplification. Much faster and the coarse shape is
 * unchanged, so it is a fair stand-in for `refine` when a tool is measuring
 * statistics rather than a specific place.
 */
export type WorldStage = 'generate' | 'rough' | 'refine'

// --- geometry ----------------------------------------------------------------

/**
 * World units per heightmap cell.
 *
 * The world is a fixed `mapSize * cellSize` across whatever grid it is currently
 * stored on, so amplifying subdivides the cells without moving the coastline.
 * That invariance is also why "2048 across" on the HUD cannot tell you which
 * stage you are looking at.
 */
export function worldCellSize(params: WorldParams, gridSize: number): number {
  const worldWidth = params.mapSize * params.render.cellSize
  return worldWidth / Math.max(1, gridSize - 1)
}

/**
 * The coastal step, converted from the world units the GUI speaks to the
 * normalised heights the heightfield does.
 *
 * One function, because the mesh and every height query have to be shaping the
 * ground identically — a shelf under the terrain but not under the avatar puts
 * it knee-deep in its own beach. Leaving it out entirely puts every height query
 * below sea level, which is how an audit ends up reporting an island with no
 * land on it.
 */
export function coastShelf(params: WorldParams): { shelfRise: number; shelfBand: number } {
  const scale = Math.max(1e-5, params.render.heightScale)
  return {
    shelfRise: params.render.coastStep / scale,
    shelfBand: params.render.coastBand / scale,
  }
}

/** Everything a height query needs to read a heightmap as ground. */
export function terrainFrameFor(params: WorldParams, heightmap: Heightmap): TerrainFrame {
  return {
    heightmap,
    cellSize: worldCellSize(params, heightmap.size),
    heightScale: params.render.heightScale,
    seaLevel: params.shape.seaLevel,
    ...coastShelf(params),
  }
}

// --- terrain -----------------------------------------------------------------

/**
 * Noise, then water, then detail.
 *
 * Erosion runs at the simulation resolution rather than the subdivided one — its
 * features are large-scale, so running it after amplification would cost an
 * order of magnitude more for detail nobody can see. This is the same order the
 * generation worker uses, because the worker now calls this.
 */
export function buildTerrain(params: WorldParams, stage: WorldStage = 'refine'): Heightmap {
  let hm = generateHeightmap(params)
  if (stage !== 'generate' && params.erosion.droplets > 0) {
    erode(hm, params.erosion, params.shape.seaLevel, makeRng(params.seed, 'erosion'))
  }
  if (stage === 'refine' && params.amplify.enabled) {
    hm = amplify(hm, params.amplify, params.seed).heightmap
  }
  return hm
}

// --- the plan ----------------------------------------------------------------

/** Where everything goes. Not what it looks like — that is the renderer's half. */
export interface WorldPlan {
  cities: City[]
  field: BiomeField | null
  /** The five Points of Power, sited before anything else can crowd them. */
  points: PlannedPoint[]
  /** The board: who owns which capital, and where the mines and points are. */
  game: MapPlan
  /** Each capital's village: the town card and the houses around it. */
  settlements: Settlement[]
  /**
   * The levelled ground each village stands on, centred on its plaza.
   *
   * Not carried by the town card. A card's pad is centred on the card, and the
   * town stands on the rim of its own circle — hanging the terrace off it would
   * level a disc pushed a full ring-radius north of the village and leave the
   * southern houses on whatever slope was there. The clearing belongs to the
   * settlement, so the settlement holds it.
   */
  plazas: SitePad[]
  /** Capitals whose surroundings stay permanently on the map: the player's own. */
  owned: { x: number; z: number }[]
  /** Card width of a castle, in world units — the unit the village ring is in. */
  townWidth: number
  /** Flat ground a capital wants around it. */
  clearing: number
}

/**
 * Site the capitals and grow their settlements on ground that already exists.
 *
 * Order matters and each step constrains the next: the Points of Power are sited
 * first because the X they make is the map's fairness and a capital cannot be
 * moved once it has a village and a territory, so first refusal has to be given
 * rather than taken. Cities are then scored against the terrain, and the biome
 * field is seeded from where they landed — so a territory is the land around its
 * capital rather than a random disc that happens to contain one.
 *
 * Flattening is not done here. It comes after, and only touches ground under the
 * pads chosen here.
 */
export function planWorld(
  params: WorldParams,
  frame: TerrainFrame,
  factionCount: number,
): WorldPlan {
  const townWidth = spriteWidthOf('city.castle')
  const clearing = capitalClearing()

  const points = params.biome.enabled ? planPoints(params.seed, frame) : []
  const cities = params.biome.enabled
    ? placeCities(params.seed, frame, {
        count: params.biome.cities,
        clearing,
        reserved: points.map((p) => ({ x: p.x, z: p.z, radius: p.radius + clearing })),
      })
    : []

  const field = params.biome.enabled
    ? buildBiomeField(
        params.seed,
        params.mapSize * params.render.cellSize,
        params.biome,
        cities,
      )
    : null

  const game = planGameMap(params.seed, frame, cities, factionCount, points)

  const settlements = settlementLayout(cities, params.seed, {
    inner: townWidth * VILLAGE_INNER,
    outer: townWidth * VILLAGE_OUTER,
    townWidth,
  })

  // A capital levels its whole village ring; everything else levels only the
  // ground its own card stands on. `s.radius` is the defender leash, not a
  // measure of the building, and terracing to it cut an 80-unit bald disc
  // around a five-unit-wide lair.
  const plazas: SitePad[] = cities.map((c) => ({ x: c.x, z: c.z, radius: clearing }))
  for (const s of game.sites) {
    if (s.sprite !== null) {
      plazas.push({ x: s.x, z: s.z, radius: siteClearing(s.sprite as SpriteKey) })
    }
  }

  const owned = cities.filter((c) => c.player).map((c) => ({ x: c.x, z: c.z }))

  return { cities, field, points, game, settlements, plazas, owned, townWidth, clearing }
}

// --- both halves together ----------------------------------------------------

export interface WorldOptions {
  /**
   * Which island to build. Defaults to the stage every played island reaches,
   * so a headless caller that says nothing measures the ground matches are
   * fought on rather than a preview nobody plays.
   */
  stage?: WorldStage
  /** Skip pad flattening — a caller that only reads positions does not need it. */
  flatten?: boolean
  factions?: number
}

export interface World extends WorldPlan {
  params: WorldParams
  heightmap: Heightmap
  frame: TerrainFrame
  stage: WorldStage
}

/**
 * Terrain and plan in one call, for anyone outside the browser.
 *
 * `main.ts` deliberately does not use this: it splits the two halves across a
 * worker so the camera stays interactive while a map is being built. It calls
 * `buildTerrain` (in the worker) and `planWorld` (on the main thread) instead,
 * which is the same sequence with a thread boundary through the middle.
 */
export function buildWorld(params: WorldParams, opts: WorldOptions = {}): World {
  const { stage = 'refine', flatten = true, factions = 3 } = opts

  const heightmap = buildTerrain(params, stage)
  const frame = terrainFrameFor(params, heightmap)
  const plan = planWorld(params, frame, factions)

  if (flatten) {
    // Mutates `heightmap`, which `frame` holds by reference — so callers read
    // levelled ground, while placement was decided on unlevelled ground. That
    // order is the point: seating first would put every card on ground that is
    // about to move.
    flattenSitePads(heightmap, frame.cellSize, plan.plazas)
  }

  return { ...plan, params, heightmap, frame, stage }
}
