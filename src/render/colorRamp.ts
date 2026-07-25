/**
 * Height + slope → vertex colour.
 *
 * Bands are positioned in "elevation above sea, normalised to the peak"
 * rather than raw height, so moving the sea level slider slides the whole
 * ecology up and down instead of drowning the palette.
 *
 * The slope override is what makes erosion legible: carved channels and cliff
 * faces expose rock regardless of altitude, so drainage networks read as
 * structure rather than as noise in the green.
 */

export type RGB = readonly [number, number, number]

/** Also used for the open-ocean floor plane, so the two must match exactly. */
export const DEEP_SILT: RGB = [0.09, 0.14, 0.19]
const SHALLOW_BED: RGB = [0.36, 0.36, 0.28]
const SAND: RGB = [0.76, 0.70, 0.50]
const GRASS_LUSH: RGB = [0.24, 0.42, 0.20]
const GRASS_DRY: RGB = [0.42, 0.47, 0.24]
const ROCK: RGB = [0.40, 0.38, 0.36]
const ROCK_HIGH: RGB = [0.50, 0.48, 0.47]
const SNOW: RGB = [0.92, 0.94, 0.96]

function mix(a: RGB, b: RGB, t: number, out: Float32Array, o: number): void {
  out[o] = a[0] + (b[0] - a[0]) * t
  out[o + 1] = a[1] + (b[1] - a[1]) * t
  out[o + 2] = a[2] + (b[2] - a[2]) * t
}

function mixToward(target: RGB, t: number, out: Float32Array, o: number): void {
  out[o] += (target[0] - out[o]) * t
  out[o + 1] += (target[1] - out[o + 1]) * t
  out[o + 2] += (target[2] - out[o + 2]) * t
}

function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Inverse-lerp clamped to [0,1]. */
function band(x: number, lo: number, hi: number): number {
  return Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
}

/**
 * @param slope 0 for flat ground, approaching 1 for a vertical face.
 */
export function writeTerrainColor(
  out: Float32Array,
  offset: number,
  height: number,
  slope: number,
  seaLevel: number,
): void {
  if (height < seaLevel) {
    // Underwater bed: shallows sandy, depths silty. Sits beneath the
    // translucent water plane, so it only needs to read as "not land".
    const depth = seaLevel > 0 ? (seaLevel - height) / seaLevel : 0
    mix(SHALLOW_BED, DEEP_SILT, smoothstep(0.05, 0.7, depth), out, offset)
    return
  }

  const e = (height - seaLevel) / Math.max(1e-5, 1 - seaLevel)

  // Bands are weighted towards green: after range normalisation a lot of the
  // island sits in the upper half of the elevation range, and evenly spaced
  // bands turn almost the whole map to bare rock.
  if (e < 0.03) {
    // Beach
    mix(SAND, GRASS_LUSH, band(e, 0.015, 0.03), out, offset)
  } else if (e < 0.55) {
    mix(GRASS_LUSH, GRASS_DRY, band(e, 0.03, 0.55), out, offset)
  } else if (e < 0.78) {
    mix(GRASS_DRY, ROCK, band(e, 0.55, 0.78), out, offset)
  } else if (e < 0.92) {
    mix(ROCK, ROCK_HIGH, band(e, 0.78, 0.92), out, offset)
  } else {
    mix(ROCK_HIGH, SNOW, band(e, 0.92, 0.98), out, offset)
  }

  // Steep faces shed soil and snow alike — expose rock. Applied last so it
  // overrides every band above.
  const rockiness = smoothstep(0.45, 0.78, slope)
  if (rockiness > 0) {
    mixToward(e > 0.8 ? ROCK_HIGH : ROCK, rockiness, out, offset)
  }
}
