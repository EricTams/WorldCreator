/**
 * Building the island the way the game builds it, without a renderer.
 *
 * The sequence itself now lives in `src/world/build.ts`, next to the modules it
 * calls and inside the directory `npm run typecheck` covers. This file is the
 * adapter the audits were written against: it keeps the `Board` shape and the
 * `buildBoard(seed, opts)` signature so `roadAudit`, `scatterAudit`,
 * `placementAudit`, `biomeAudit` and the match harness did not all have to
 * change at once.
 *
 * The header this file used to carry claimed "the sequence lives here once". It
 * did not — `matchHarness.ts` kept a private copy that had already drifted, and
 * this copy had drifted from the game itself by a whole stage of the pipeline.
 * That is the entire reason the sequence moved under `src/`.
 */
import { defaultParams } from '../src/world/params'
import type { WorldParams } from '../src/world/params'
import { buildWorld } from '../src/world/build'
import type { World, WorldStage } from '../src/world/build'
import { FACTIONS } from '../src/game/factions'
import type { City } from '../src/world/cities'
import type { MapPlan } from '../src/world/gameMap'
import type { Heightmap } from '../src/world/heightmap'
import type { TerrainFrame } from '../src/world/terrainQuery'

export type { WorldStage as BoardStage }

export interface Board {
  params: WorldParams
  heightmap: Heightmap
  frame: TerrainFrame
  cities: City[]
  plan: MapPlan
  /** The rest of the world, for audits that outgrew the four fields above. */
  world: World
}

export interface BoardOptions {
  /**
   * Which island to build. Defaults to `refine`, the stage every played island
   * reaches. An audit that asks for `generate` is measuring the raw preview a
   * terrain slider shows mid-drag, which no match is played on.
   */
  stage?: WorldStage
  /** Skip pad flattening — an audit that only reads positions does not need it. */
  flatten?: boolean
  factions?: number
}

export function buildBoard(seed: string, opts: BoardOptions = {}): Board {
  const { stage = 'refine', flatten = true, factions = FACTIONS.length } = opts

  const params = defaultParams()
  params.seed = seed

  const world = buildWorld(params, { stage, flatten, factions })

  return {
    params: world.params,
    heightmap: world.heightmap,
    frame: world.frame,
    cities: world.cities,
    plan: world.game,
    world,
  }
}
