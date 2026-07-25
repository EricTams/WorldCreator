import { Heightmap, sampleHeightAndGradient } from './heightmap'
import type { ErosionParams } from './params'

/**
 * Particle-based hydraulic erosion (the Beyer / Lague droplet model).
 *
 * Thousands of droplets are dropped at random, roll downhill, pick up sediment
 * where they're moving fast down a steep slope, and drop it where they slow
 * down or run uphill. The emergent result is drainage networks: valleys that
 * branch, join and eventually reach the sea, which no amount of layered noise
 * produces on its own.
 *
 * Runs on normalised [0, 1] heights with positions in grid cells, which is the
 * space the default constants in params.ts are tuned for.
 */

interface Brush {
  dx: Int32Array
  dz: Int32Array
  weight: Float32Array
}

/**
 * A radial falloff kernel used to spread each erosion event over a disc rather
 * than a single cell. Without it, droplets carve one-cell-wide scratches that
 * read as pixel noise instead of valleys.
 *
 * Stored as small relative offsets (a few dozen entries) rather than
 * precomputed per-cell index lists — the per-cell version costs tens of
 * megabytes at 512² and buys only the removal of a bounds check.
 *
 * Weights sum to 1, so eroding `amount` removes `amount` of total volume.
 */
function makeBrush(radius: number): Brush {
  const r = Math.max(1, Math.round(radius))
  const dx: number[] = []
  const dz: number[] = []
  const weight: number[] = []
  let total = 0

  for (let z = -r; z <= r; z++) {
    for (let x = -r; x <= r; x++) {
      const d2 = x * x + z * z
      if (d2 > r * r) continue
      const w = 1 - Math.sqrt(d2) / r
      if (w <= 0) continue
      dx.push(x)
      dz.push(z)
      weight.push(w)
      total += w
    }
  }
  for (let i = 0; i < weight.length; i++) weight[i] /= total

  return {
    dx: Int32Array.from(dx),
    dz: Int32Array.from(dz),
    weight: Float32Array.from(weight),
  }
}

/**
 * Remove `amount` of material around (cx, cz) through the brush kernel.
 * Returns how much was actually removed — less than requested near the map
 * edge (where part of the kernel falls outside) or where the terrain would go
 * below zero. Returning the real figure is what keeps sediment mass conserved.
 */
function erodeThroughBrush(
  data: Float32Array,
  size: number,
  cx: number,
  cz: number,
  brush: Brush,
  amount: number,
): number {
  let removed = 0
  for (let i = 0; i < brush.weight.length; i++) {
    const x = cx + brush.dx[i]
    const z = cz + brush.dz[i]
    if (x < 0 || x >= size || z < 0 || z >= size) continue
    const idx = z * size + x
    const want = amount * brush.weight[i]
    const delta = want < data[idx] ? want : data[idx]
    data[idx] -= delta
    removed += delta
  }
  return removed
}

/** Drop `amount` back into the four cells surrounding the droplet's position. */
function depositBilinear(
  data: Float32Array,
  size: number,
  cx: number,
  cz: number,
  fx: number,
  fz: number,
  amount: number,
): void {
  const i = cz * size + cx
  data[i] += amount * (1 - fx) * (1 - fz)
  data[i + 1] += amount * fx * (1 - fz)
  data[i + size] += amount * (1 - fx) * fz
  data[i + size + 1] += amount * fx * fz
}

export interface ErosionResult {
  /** Droplets that ran at least one step. */
  droplets: number
  ms: number
}

/**
 * Erode `hm` in place.
 *
 * `rng` seeds droplet spawn positions, so erosion is reproducible for a given
 * seed. `onProgress` is called occasionally with a 0..1 fraction — this is a
 * multi-second loop, so the worker needs something to report.
 */
export function erode(
  hm: Heightmap,
  params: ErosionParams,
  seaLevel: number,
  rng: () => number,
  onProgress?: (frac: number) => void,
): ErosionResult {
  const started = performance.now()
  const size = hm.size
  const data = hm.data
  const brush = makeBrush(params.radius)

  const {
    droplets,
    inertia,
    capacityFactor,
    minSlope,
    erodeSpeed,
    depositSpeed,
    evaporation,
    gravity,
    maxLifetime,
    initialWater,
    initialSpeed,
  } = params

  // The bilinear sampler reads (floor+1), so droplets must stay strictly
  // inside the last cell.
  const maxCoord = size - 1

  let spawned = 0

  for (let iter = 0; iter < droplets; iter++) {
    if (onProgress && (iter & 8191) === 0) {
      onProgress(iter / droplets)
    }

    // Rain falls on land. Spawning uniformly across the map wastes most
    // droplets on the flat sea floor outside the island mask, where the
    // gradient is zero and they die on their first step.
    let posX = -1
    let posZ = -1
    for (let attempt = 0; attempt < 24; attempt++) {
      const px = rng() * (maxCoord - 1)
      const pz = rng() * (maxCoord - 1)
      if (data[(pz | 0) * size + (px | 0)] > seaLevel) {
        posX = px
        posZ = pz
        break
      }
    }
    if (posX < 0) continue // effectively no land left to rain on
    spawned++

    let dirX = 0
    let dirZ = 0
    let speed = initialSpeed
    let water = initialWater
    let sediment = 0

    for (let life = 0; life < maxLifetime; life++) {
      const cellX = posX | 0
      const cellZ = posZ | 0
      const fx = posX - cellX
      const fz = posZ - cellZ

      const here = sampleHeightAndGradient(data, size, posX, posZ)

      // Steer: blend the previous heading with the downhill direction.
      // inertia near 0 makes droplets hug the terrain and carve tight
      // channels; near 1 they plough straight through hills.
      dirX = dirX * inertia - here.gradX * (1 - inertia)
      dirZ = dirZ * inertia - here.gradZ * (1 - inertia)

      const len = Math.sqrt(dirX * dirX + dirZ * dirZ)
      if (len === 0) break // sitting in a perfectly flat spot
      dirX /= len
      dirZ /= len

      posX += dirX
      posZ += dirZ

      // Ran off the map, or into the last row where sampling is invalid.
      if (posX < 0 || posX >= maxCoord - 1 || posZ < 0 || posZ >= maxCoord - 1) break

      const newHeight = sampleHeightAndGradient(data, size, posX, posZ).height
      const deltaHeight = newHeight - here.height

      // How much sediment this droplet can carry: faster, wetter droplets on
      // steeper descents carry more. minSlope stops capacity collapsing to
      // zero on flats, which would make droplets dump everything instantly.
      const capacity =
        Math.max(-deltaHeight, minSlope) * speed * water * capacityFactor

      if (sediment > capacity || deltaHeight > 0) {
        // Over capacity, or running uphill — drop material. When climbing,
        // deposit at most enough to fill the rise, which is what fills pits
        // and lets later droplets flow over them instead of pooling forever.
        const amount =
          deltaHeight > 0
            ? Math.min(deltaHeight, sediment)
            : (sediment - capacity) * depositSpeed
        sediment -= amount
        depositBilinear(data, size, cellX, cellZ, fx, fz, amount)
      } else {
        // Room to carry more — cut into the bed, but never more than the
        // height difference, or the droplet would dig a hole beneath itself.
        const amount = Math.min((capacity - sediment) * erodeSpeed, -deltaHeight)
        sediment += erodeThroughBrush(data, size, cellX, cellZ, brush, amount)
      }

      speed = Math.sqrt(Math.max(0, speed * speed - deltaHeight * gravity))
      water *= 1 - evaporation
      if (water < 1e-4) break
    }
  }

  return { droplets: spawned, ms: performance.now() - started }
}
