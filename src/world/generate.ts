import { Heightmap } from './heightmap'
import { clamp01, fbm, lerp, makeNoise2D, ridgedFbm, smoothstep } from './noise'
import { makeRng } from './prng'
import type { WorldParams } from './params'

/**
 * The generation pipeline, stages 1-5. Erosion (stage 6) is separate because
 * it costs seconds rather than milliseconds and shouldn't run on every slider
 * drag — see erosion.ts.
 *
 * Each stage is applied in order to a normalised [0, 1] height and can be
 * toggled off independently, so you can see what each one contributes:
 *
 *   1. FBM base          layered simplex
 *   2. domain warp       bend the sample position by a second noise field
 *   3. ridged mountains  sharp spines blended in above a height threshold
 *   4. redistribution    pow() to flatten lowlands / sharpen peaks
 *   5. island mask       radial falloff so the map ends in water
 *
 * Deterministic: the same seed and params always produce the same map.
 */
export function generateHeightmap(params: WorldParams): Heightmap {
  const size = params.mapSize + 1 // vertices per side
  const hm = new Heightmap(size)
  const data = hm.data

  // Separate noise streams so the base shape, the warp field and the ridges
  // don't correlate with each other.
  const baseNoise = makeNoise2D(makeRng(params.seed, 'base'))
  const warpNoiseX = makeNoise2D(makeRng(params.seed, 'warpX'))
  const warpNoiseZ = makeNoise2D(makeRng(params.seed, 'warpZ'))
  const ridgeNoise = makeNoise2D(makeRng(params.seed, 'ridge'))

  const { noise, warp, ridges, shape } = params
  const inv = 1 / (size - 1)

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      // Normalised [0,1] coords, so changing map size rescales detail rather
      // than changing what the island looks like.
      const u = x * inv
      const v = z * inv

      // --- 2. domain warp (applied to the coords before sampling the base) ---
      let su = u
      let sv = v
      if (warp.enabled && warp.strength > 0) {
        const wx = fbm(warpNoiseX, u, v, 3, warp.frequency, 2, 0.5)
        const wz = fbm(warpNoiseZ, u, v, 3, warp.frequency, 2, 0.5)
        su = u + wx * warp.strength
        sv = v + wz * warp.strength
      }

      // --- 1. FBM base, remapped from [-1,1] to [0,1] ---
      let h = 0.5
      if (noise.enabled) {
        const n = fbm(
          baseNoise,
          su,
          sv,
          noise.octaves,
          noise.frequency,
          noise.lacunarity,
          noise.persistence,
        )
        h = clamp01(n * 0.5 + 0.5)
      }

      // --- 3. ridged mountains, weighted in only at altitude ---
      if (ridges.enabled && ridges.strength > 0) {
        const w = smoothstep(ridges.threshold, 1.0, h) * ridges.strength
        if (w > 0) {
          const r = ridgedFbm(
            ridgeNoise,
            su,
            sv,
            ridges.octaves,
            ridges.frequency,
            2.0,
            0.5,
          )
          h = lerp(h, r, w)
        }
      }

      // --- 4. redistribution ---
      if (shape.redistribution !== 1) {
        h = Math.pow(h, shape.redistribution)
      }

      // --- 5. island mask ---
      if (shape.islandMask) {
        // Radial distance from map centre, normalised so 1.0 is the edge
        // midpoint. Corners exceed 1 and are driven fully to zero.
        const nx = u * 2 - 1
        const nz = v * 2 - 1
        const d = Math.sqrt(nx * nx + nz * nz)
        const t = smoothstep(shape.falloffStart, 1.0, d)
        const falloff = 1 - Math.pow(t, shape.falloffPower)
        h *= clamp01(falloff)
      }

      data[z * size + x] = h
    }
  }

  // --- 5b. normalise to the full [0, 1] range ---
  if (shape.normalize) {
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < data.length; i++) {
      if (data[i] < min) min = data[i]
      if (data[i] > max) max = data[i]
    }
    const range = max - min
    if (range > 1e-6) {
      const inv = 1 / range
      for (let i = 0; i < data.length; i++) {
        data[i] = (data[i] - min) * inv
      }
    }
  }

  return hm
}
