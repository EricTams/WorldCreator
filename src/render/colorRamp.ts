/**
 * Height + territory → vertex colour.
 *
 * Bands are positioned in "elevation above sea, normalised to the peak" rather
 * than raw height, so moving the sea level slider slides the whole coastline up
 * and down instead of drowning the palette.
 *
 * Which palette a point is drawn from is a property of whose land it is; see
 * `world/biome.ts`. Terrain decides only whether it is beach or not.
 */

import type { BiomeRamp } from '../world/biome'

export type RGB = readonly [number, number, number]

/** The bare seabed, shown only when the water is switched off. */
export const DEEP_SILT: RGB = [0.09, 0.14, 0.19]
const SHALLOW_BED: RGB = [0.36, 0.36, 0.28]

/**
 * The sea, in three depths, measured off the reference overworld sheet.
 *
 * sRGB (89,183,207), (76,155,217) and (55,92,191): a bright rim in the
 * shallows, the open sea, and the deep. Linear here because everything else in
 * this file is, and because the shader mixes them before anything converts.
 *
 * Three stops rather than two because two is a gradient and three is a coast —
 * the rim is what makes a shoreline read as a shoreline from the overview.
 */
export const WATER_SHALLOW: RGB = [0.0999, 0.4735, 0.624]
export const WATER_MID: RGB = [0.0723, 0.3278, 0.6939]
export const WATER_DEEP: RGB = [0.0382, 0.107, 0.521]
const SAND: RGB = [0.76, 0.7, 0.5]
const GRASS_LUSH: RGB = [0.24, 0.42, 0.2]
const GRASS_DRY: RGB = [0.42, 0.47, 0.24]
const ROCK: RGB = [0.4, 0.38, 0.36]
const SNOW: RGB = [0.92, 0.94, 0.96]

/** Used when territories are switched off, so the map still has an ecology. */
export const DEFAULT_RAMP: BiomeRamp = {
  shallow: SHALLOW_BED,
  sand: SAND,
  low: GRASS_LUSH,
  mid: GRASS_DRY,
  rock: ROCK,
  peak: SNOW,
}

function mix(a: RGB, b: RGB, t: number, out: Float32Array, o: number): void {
  out[o] = a[0] + (b[0] - a[0]) * t
  out[o + 1] = a[1] + (b[1] - a[1]) * t
  out[o + 2] = a[2] + (b[2] - a[2]) * t
}

/**
 * A territory is one flat colour, all the way to the water.
 *
 * There were five elevation bands here — low, mid, rock, peak, and a
 * slope-driven rock override — each blending into the next. Every one of them
 * was a departure from the artist's fill colour, and together they were why the
 * biomes never looked like the tilesets: on any real island most ground sits in
 * the middle of the elevation range, so most of the map was painted as a blend
 * of two invented colours rather than as the one measured colour it was meant to
 * be. Widening the low band helped and did not fix it, because the bands above
 * still owned every hill.
 *
 * The reference art settles it. Altitude does not tint the ground there at all —
 * a mountain is a *sprite standing on flat colour*, and the map reads as terrain
 * because of what is drawn on it, not because the ground is shaded. There is now
 * one mountain sprite per biome, so the ground can stop trying to describe
 * relief and simply be the tileset.
 *
 * The last two bands to go were the sand beach at the waterline and the seabed
 * under it, and they went for the same reason as the rest, only more so: a band
 * in *elevation* is a band of unpredictable width on the ground. Around the
 * shallow inland lagoons a beach broad enough to see covered several hundred
 * metres, so whole stretches were coming out cream instead of the colour of the
 * biome that owned them. The coast is drawn by `shelfHeight` now — a step in the
 * ground rather than a stripe of paint, which is a fixed width on screen
 * wherever it happens to be.
 *
 * The seabed went with it. There is nothing left for it to do: the sea is opaque
 * from the waterline out (see `terrainMaterial.ts`), so the only thing a special
 * underwater colour could still reach was a stray fringe of khaki showing
 * through where the two disagreed by a pixel. Territory colour simply carries on
 * under the water.
 *
 * So height does not enter into it at all any more, and neither does slope —
 * hence neither is a parameter. `sand`, `shallow`, `mid`, `rock` and `peak` are
 * consequently unread. They stay on `BiomeRamp` because deleting hand-tuned
 * colours is a decision to take deliberately rather than as a side effect of
 * this one.
 *
 * @param biomeB the neighbouring territory, and `t` how far between the two this
 *   point sits. Pass t = 0 to ignore.
 */
export function writeTerrainColor(
  out: Float32Array,
  offset: number,
  biomeA: BiomeRamp | null = null,
  biomeB: BiomeRamp | null = null,
  t = 0,
): void {
  const ramp = biomeA ?? DEFAULT_RAMP

  // Cross-fade at a territory border.
  mix(ramp.low, biomeB && t > 0 ? biomeB.low : ramp.low, t, out, offset)
}
