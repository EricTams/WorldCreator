/**
 * Querying the current terrain surface at an arbitrary world position.
 *
 * This started life as a static method on `Avatar`, which was fine while the
 * avatar was the only thing standing on the ground. Map sites, ground discs and
 * fog reveal all need the same answer, so it lives here instead — and it stays
 * in `world/` rather than `render/` because it is heightfield arithmetic with no
 * opinion about three.js.
 */

import type { Heightmap } from './heightmap'
import { sampleHeightAndGradient } from './heightmap'

/** Everything needed to place something on the current terrain. */
export interface TerrainFrame {
  heightmap: Heightmap
  /**
   * World units per heightmap cell of the *current* map. Amplification
   * subdivides the grid, so this is not `params.render.cellSize` — derive it
   * from the world width (see `effectiveCellSize` in main.ts).
   */
  cellSize: number
  heightScale: number
  seaLevel: number
  /** Normalised height of the coastal step. See `shelfHeight`. */
  shelfRise: number
  /** Normalised height either side of the waterline over which it eases out. */
  shelfBand: number
}

/**
 * The coastal shelf: a step in the ground at the waterline.
 *
 * Land within `band` of sea level is pushed up and seabed within `band` of it
 * is pushed down, by `rise` at the water's edge and easing to nothing further
 * away. A gentle ramp through sea level becomes a bank with dry ground on top
 * and water at its foot.
 *
 * This is what replaced the painted sand beach. Colouring the coast could only
 * ever work where the coast was steep: on the flats around an inland lagoon, a
 * beach wide enough to notice from the shore covered hundreds of metres of
 * ground, which is why whole territories were coming out cream instead of the
 * colour of the biome standing on them. A step reads as a coastline at any
 * gradient, because how wide it looks comes from the step rather than from how
 * fast the land happens to be falling.
 *
 * Sign-preserving by construction — land stays above the waterline and seabed
 * stays below it — so everything that decides what is dry by comparing against
 * sea level still gets the same answer it did before.
 *
 * Heights are normalised, as everywhere else in `world/`.
 */
export function shelfHeight(h: number, seaLevel: number, rise: number, band: number): number {
  if (rise <= 0 || band <= 0) return h
  const e = h - seaLevel
  const t = Math.abs(e) / band
  if (t >= 1) return h
  // Capped so the map stays monotonic in height. The offset falls off at up to
  // 2*rise/band per unit of elevation, and once that exceeds 1 a vertex slightly
  // further up the beach comes out lower than the one below it — the shore
  // folds back through itself and the mesh turns inside out.
  const step = Math.min(rise, band * 0.5)
  const fall = (1 - t) * (1 - t)
  return h + (e >= 0 ? step : -step) * fall
}

/** Half the world's extent in world units — the map spans [-half, +half]. */
export function worldHalfExtent(frame: TerrainFrame): number {
  return ((frame.heightmap.size - 1) * frame.cellSize) / 2
}

/**
 * World XZ to grid coordinates, clamped into the last addressable cell.
 *
 * The bilinear sampler reads (floor+1) without bounds checks — that check lives
 * at the call site because the erosion droplet loop runs it millions of times.
 */
function toGrid(frame: TerrainFrame, worldX: number, worldZ: number): { gx: number; gz: number } {
  const cells = frame.heightmap.size - 1
  const half = (cells * frame.cellSize) / 2
  const max = cells - 1.001

  let gx = (worldX + half) / frame.cellSize
  let gz = (worldZ + half) / frame.cellSize
  gx = gx < 0 ? 0 : gx > max ? max : gx
  gz = gz < 0 ? 0 : gz > max ? max : gz
  return { gx, gz }
}

/**
 * Terrain height in world units at a world-space XZ.
 *
 * The shelf is applied after the bilinear filter rather than to the four
 * corners the way the mesh does it, so inside the one cell that straddles the
 * shore this returns a ramp where the mesh draws a step. That is the better
 * answer for the things that ask: the avatar walks up the bank instead of
 * teleporting to the top of it.
 */
export function terrainHeightAt(frame: TerrainFrame, worldX: number, worldZ: number): number {
  const { seaLevel, shelfRise, shelfBand, heightScale } = frame
  const h = terrainRawHeightAt(frame, worldX, worldZ) / heightScale
  return shelfHeight(h, seaLevel, shelfRise, shelfBand) * heightScale
}

/**
 * The heightmap as generated, in world units, with no coastal shelf on it.
 *
 * Anything *planted* in the terrain wants `terrainHeightAt` instead, because
 * that is the surface which gets drawn — a tree seated on the raw field at the
 * coast stands a shelf's depth inside the bank.
 *
 * What wants this one is anything that *hovers*: the shelf is a step, so riding
 * it drops the avatar the height of the bank between one footfall and the next,
 * over ground whose real height changed by centimetres. Ride height comfortably
 * exceeds the step, so ignoring it still clears the surface underneath.
 */
export function terrainRawHeightAt(frame: TerrainFrame, worldX: number, worldZ: number): number {
  const { gx, gz } = toGrid(frame, worldX, worldZ)
  const { heightmap, heightScale } = frame
  return sampleHeightAndGradient(heightmap.data, heightmap.size, gx, gz).height * heightScale
}

/**
 * Height of the surface as it is actually *drawn*, in world units.
 *
 * The difference from `terrainHeightAt` is what happens inside one cell. That
 * one filters the four corners bilinearly, which is a curved surface; the mesh
 * draws two flat triangles. Between the corners those are not the same surface,
 * and at this scale the gap is not small — a 2 km island over a 256-cell grid
 * puts 8 world units between corners, and on a ridge the bilinear value runs
 * metres above the triangle underneath it.
 *
 * Anything that has to lie *flush* with the ground therefore has to ask this
 * one, or it sinks into the mesh over rough terrain and comes out in pieces.
 * The avatar's ground shadow is the case this was written for. The corners are
 * shelved before interpolating, exactly as `fillTile` does it, so the shoreline
 * bank is where the shadow sees it too.
 *
 * The triangulation is mirrored from `terrainMesh.fillTile`, which splits every
 * cell along the b–c diagonal — the corners at (x+1, z) and (x, z+1). If that
 * winding ever changes, this has to change with it.
 */
export function terrainDrawnHeightAt(frame: TerrainFrame, worldX: number, worldZ: number): number {
  const { heightmap, cellSize, heightScale, seaLevel, shelfRise, shelfBand } = frame
  const cells = heightmap.size - 1
  const half = (cells * cellSize) / 2

  // Clamped to the last *cell* rather than the last vertex: this reads a cell's
  // four corners, so the origin has to leave one to its east and one to its
  // south.
  const max = cells - 1e-4
  let gx = (worldX + half) / cellSize
  let gz = (worldZ + half) / cellSize
  gx = gx < 0 ? 0 : gx > max ? max : gx
  gz = gz < 0 ? 0 : gz > max ? max : gz

  const ix = Math.floor(gx)
  const iz = Math.floor(gz)
  const u = gx - ix
  const v = gz - iz

  const shelf = (h: number): number => shelfHeight(h, seaLevel, shelfRise, shelfBand)

  // The two triangles meet along u + v = 1: the near one spans the corner at
  // the cell's origin, the far one the corner diagonally opposite it.
  const b = shelf(heightmap.getClamped(ix + 1, iz))
  const c = shelf(heightmap.getClamped(ix, iz + 1))
  if (u + v <= 1) {
    const a = shelf(heightmap.getClamped(ix, iz))
    return (a + (b - a) * u + (c - a) * v) * heightScale
  }
  const d = shelf(heightmap.getClamped(ix + 1, iz + 1))
  return (d + (c - d) * (1 - u) + (b - d) * (1 - v)) * heightScale
}

/** Height plus the world-space surface derivatives dY/dX and dY/dZ. */
export function terrainSampleAt(
  frame: TerrainFrame,
  worldX: number,
  worldZ: number,
): { height: number; dx: number; dz: number } {
  const { gx, gz } = toGrid(frame, worldX, worldZ)
  const { heightmap, heightScale, cellSize, seaLevel, shelfRise, shelfBand } = frame
  const g = sampleHeightAndGradient(heightmap.data, heightmap.size, gx, gz)
  // Grid gradients are per-cell in normalised height; scale to world units per
  // world unit. Same conversion the avatar's carpet uses to conform to a slope.
  //
  // Deliberately the *unshelved* gradient. The shelf is a step, so its slope at
  // the water's edge is however steep one cell makes it — and the callers are
  // the avatar's carpet and the discs under the map cards, neither of which
  // should stand on end because they happen to be at the top of a bank.
  return {
    height: shelfHeight(g.height, seaLevel, shelfRise, shelfBand) * heightScale,
    dx: (g.gradX * heightScale) / cellSize,
    dz: (g.gradZ * heightScale) / cellSize,
  }
}

/**
 * Steepness at a world XZ on the same scale the terrain colour ramp uses:
 * `1 - ny`, where ny is the normalised Y component of the surface normal. 0 is
 * flat, approaching 1 is vertical.
 *
 * Anything that wants to agree with what the terrain *looks* like — placing a
 * sawmill on grass, an ore pit on exposed rock — has to use this exact metric
 * rather than a gradient magnitude, because that is what `writeTerrainColor`
 * branches on.
 */
export function terrainSlopeAt(frame: TerrainFrame, worldX: number, worldZ: number): number {
  const { dx, dz } = terrainSampleAt(frame, worldX, worldZ)
  return 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz)
}
