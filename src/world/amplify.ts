import { Heightmap } from './heightmap'
import { makeNoise2D, smoothstep, type Noise2D } from './noise'
import type { AmplifyParams } from './params'
import { makeRng } from './prng'

/**
 * Detail amplification: refine the eroded heightmap to a higher resolution and
 * synthesise the fine structure that the simulation never had.
 *
 * The point is cost. Erosion at 2048² takes tens of seconds, and its features —
 * drainage networks, valley floors, sediment fans — are large-scale anyway, so
 * almost all of that time buys nothing you can see. Eroding at 512² and then
 * subdividing gets 2048²-class geometry for a fraction of a second.
 *
 * The trade is real and worth stating: the *channels* stay at simulation
 * resolution. What you gain is surface structure, not finer rivers.
 *
 * Detail is added once per level rather than all at the end, so each doubling
 * contributes one octave at its own scale — the levels together are the fractal,
 * which is why a single pass of broadband noise at the final resolution looks
 * wrong by comparison.
 */

/** Catmull-Rom through p1..p2. C1 continuous, so no creases at cell edges. */
function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

/**
 * Double the grid resolution. Bicubic rather than bilinear: bilinear is only C0,
 * so every original cell boundary keeps a derivative discontinuity that lights
 * up as a visible crease once the surface is shaded.
 */
function upsample2x(src: Heightmap): Heightmap {
  const n = src.size
  const m = (n - 1) * 2 + 1
  const out = new Heightmap(m)
  const s = src.data
  const d = out.data

  const clampI = (i: number, hi: number): number => (i < 0 ? 0 : i > hi ? hi : i)

  // Separable: horizontal into a temp (m wide, n tall), then vertical.
  const tmp = new Float32Array(m * n)
  for (let z = 0; z < n; z++) {
    const row = z * n
    for (let X = 0; X < m; X++) {
      if ((X & 1) === 0) {
        tmp[z * m + X] = s[row + (X >> 1)]
        continue
      }
      const i = X >> 1
      tmp[z * m + X] = catmullRom(
        s[row + clampI(i - 1, n - 1)],
        s[row + i],
        s[row + clampI(i + 1, n - 1)],
        s[row + clampI(i + 2, n - 1)],
        0.5,
      )
    }
  }

  for (let Z = 0; Z < m; Z++) {
    const j = Z >> 1
    const even = (Z & 1) === 0
    const r1 = clampI(j, n - 1) * m
    if (even) {
      d.set(tmp.subarray(r1, r1 + m), Z * m)
      continue
    }
    const r0 = clampI(j - 1, n - 1) * m
    const r2 = clampI(j + 1, n - 1) * m
    const r3 = clampI(j + 2, n - 1) * m
    for (let X = 0; X < m; X++) {
      d[Z * m + X] = catmullRom(tmp[r0 + X], tmp[r1 + X], tmp[r2 + X], tmp[r3 + X], 0.5)
    }
  }

  return out
}

/**
 * Add one octave of detail, weighted by local slope.
 *
 * Slope weighting is what stops this looking like noise smeared over
 * everything: erosion works hard to produce flat sediment plains, valley floors
 * and beaches, and roughening those undoes it. Steep faces get the detail,
 * flats keep only `flatFloor` of it.
 */
function addDetailOctave(
  hm: Heightmap,
  noise: Noise2D,
  params: AmplifyParams,
  amplitude: number,
): void {
  const n = hm.size
  const d = hm.data
  const cells = n - 1
  const inv = 1 / cells
  const freq = cells * params.frequencyScale

  // Slope is measured per unit of normalised map width, not per cell, so the
  // thresholds keep the same meaning as the resolution doubles.
  const at = (x: number, z: number): number => {
    const cx = x < 0 ? 0 : x > cells ? cells : x
    const cz = z < 0 ? 0 : z > cells ? cells : z
    return d[cz * n + cx]
  }

  // Written into a copy: sampling slope from a partially-updated array would
  // let each row's new detail feed into the next row's weighting.
  const out = new Float32Array(d.length)

  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x

      const gx = (at(x + 1, z) - at(x - 1, z)) * 0.5 * cells
      const gz = (at(x, z + 1) - at(x, z - 1)) * 0.5 * cells
      const slope = Math.sqrt(gx * gx + gz * gz)

      const w =
        params.flatFloor +
        (1 - params.flatFloor) *
          smoothstep(params.slopeLo, params.slopeHi, slope)

      const raw = noise(x * inv * freq, z * inv * freq)
      // Ridged form creases at the zero crossing, which reads as rock; the
      // plain form gives rounded swells. Most terrain wants some of each.
      const ridged = (0.5 - Math.abs(raw)) * 2
      const val = raw * (1 - params.ridged) + ridged * params.ridged

      out[i] = d[i] + val * amplitude * w
    }
  }

  d.set(out)
}

export interface AmplifyResult {
  levels: number
  finalSize: number
  ms: number
}

/**
 * Subdivide `hm` `levels` times, adding an octave of slope-weighted detail at
 * each step. Returns a new Heightmap; the input is left untouched.
 */
export function amplify(
  src: Heightmap,
  params: AmplifyParams,
  seed: string,
): { heightmap: Heightmap; result: AmplifyResult } {
  const started = performance.now()
  const levels = Math.max(0, Math.min(4, Math.round(params.levels)))

  let hm = src
  let amplitude = params.amplitude

  for (let level = 0; level < levels; level++) {
    hm = upsample2x(hm)
    // A fresh stream per level, so the octaves don't rhyme with each other.
    const noise = makeNoise2D(makeRng(seed, `amplify${level}`))
    addDetailOctave(hm, noise, params, amplitude)
    amplitude *= params.persistence
  }

  // Nothing to subdivide but detail was still asked for — add it in place.
  if (levels === 0 && params.amplitude > 0) {
    hm = src.clone()
    const noise = makeNoise2D(makeRng(seed, 'amplify0'))
    addDetailOctave(hm, noise, params, amplitude)
  }

  return {
    heightmap: hm,
    result: {
      levels,
      finalSize: hm.size,
      ms: performance.now() - started,
    },
  }
}
