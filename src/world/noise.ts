import { createNoise2D } from 'simplex-noise'

export type Noise2D = (x: number, y: number) => number

export function makeNoise2D(rng: () => number): Noise2D {
  return createNoise2D(rng)
}

/** Hermite interpolation between two edges. Returns 0 below a, 1 above b. */
export function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * Fractal Brownian motion: sum octaves of simplex, each at higher frequency
 * (× lacunarity) and lower amplitude (× persistence). Normalised by the total
 * amplitude so the result stays in roughly [-1, 1] regardless of octave count —
 * without that, adding octaves would also change the overall height.
 */
export function fbm(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  frequency: number,
  lacunarity: number,
  persistence: number,
): number {
  let sum = 0
  let amp = 1
  let freq = frequency
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp
    norm += amp
    amp *= persistence
    freq *= lacunarity
  }
  return norm === 0 ? 0 : sum / norm
}

/**
 * Ridged multifractal: `1 - |noise|` puts a sharp crease where the noise
 * crosses zero, and squaring sharpens it further. Returns [0, 1] with ridges
 * at 1 — the source of mountain spines rather than rounded lumps.
 */
export function ridgedFbm(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  frequency: number,
  lacunarity: number,
  persistence: number,
): number {
  let sum = 0
  let amp = 1
  let freq = frequency
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise(x * freq, y * freq))
    sum += n * n * amp
    norm += amp
    amp *= persistence
    freq *= lacunarity
  }
  return norm === 0 ? 0 : sum / norm
}
