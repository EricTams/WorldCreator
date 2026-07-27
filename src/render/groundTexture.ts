import * as THREE from 'three'
import {
  GROUND_DATA,
  GROUND_HEIGHT,
  GROUND_NAMES,
  GROUND_WIDTH,
} from '../assets/groundTiles'

export { GROUND_NAMES }
export type { GroundName } from '../assets/groundTiles'

/**
 * The biome ground tiles, as one horizontal strip.
 *
 * Deliberately not a texture array, and deliberately not mipmapped. Tiling is
 * done in the shader with `fract`, so the strip only ever needs point sampling
 * within one column — which is also the correct filter for pixel art, and
 * sidesteps the bleeding an atlas would otherwise suffer between neighbouring
 * biome columns. Minification aliasing is handled by fading the texture out
 * with distance rather than by mip chains; see the terrain material.
 */
export function createGroundTexture(): THREE.DataTexture {
  const bin = atob(GROUND_DATA)
  const data = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)

  const tex = new THREE.DataTexture(data, GROUND_WIDTH, GROUND_HEIGHT)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/** Index of a named ground tile within the strip. */
export function groundIndex(name: string): number {
  const i = GROUND_NAMES.indexOf(name as (typeof GROUND_NAMES)[number])
  return i < 0 ? 0 : i
}
