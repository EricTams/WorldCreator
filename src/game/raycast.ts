import type { TerrainFrame } from '../world/terrainQuery'
import { terrainHeightAt, worldHalfExtent } from '../world/terrainQuery'

/**
 * Where a ray from the camera meets the ground.
 *
 * Deliberately *not* `THREE.Raycaster`. The terrain is a couple of million
 * triangles at the default amplification and three's raycaster is a brute-force
 * loop over every one of them, so picking a spot to throw a fireball at would
 * cost a visible hitch on every click. A heightfield does not need that: it is a
 * function of XZ, so marching the ray and asking how far above the surface each
 * step is converges in a few dozen samples whatever the triangle count.
 *
 * The step is the distance to the surface directly below rather than a fixed
 * increment — the standard sphere-tracing trick. High above the map it strides,
 * and it shortens automatically as it closes on the ground, which is what keeps
 * a grazing shot along a valley floor from stepping straight through a ridge.
 */
export function raycastTerrain(
  frame: TerrainFrame,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): { x: number; y: number; z: number } | null {
  const half = worldHalfExtent(frame)
  // Far enough to cross the island diagonally from outside it, and no further.
  const maxDist = half * 4
  let t = 0

  let prevT = 0
  let prevGap = oy - terrainHeightAt(frame, ox, oz)

  for (let i = 0; i < 160 && t < maxDist; i++) {
    const x = ox + dx * t
    const y = oy + dy * t
    const z = oz + dz * t

    // Off the edge of the world and heading away: nothing left to hit.
    if (Math.abs(x) > half * 1.5 && Math.abs(z) > half * 1.5 && dy >= 0) return null

    const ground = terrainHeightAt(frame, x, z)
    const gap = y - ground

    if (gap <= 0) {
      // Crossed the surface between the last sample and this one. One linear
      // interpolation on the gap is plenty — the samples either side are close
      // together by the time this fires, because the step shrinks as it closes.
      const span = prevGap - gap
      const f = span > 1e-6 ? prevGap / span : 0
      const hit = prevT + (t - prevT) * f
      return { x: ox + dx * hit, y: oy + dy * hit, z: oz + dz * hit }
    }

    prevT = t
    prevGap = gap
    // Never advance by less than a couple of units, or a ray running almost
    // parallel to a hillside stalls and burns the whole iteration budget
    // travelling a few metres.
    t += Math.max(2, gap * 0.8)
  }

  return null
}
