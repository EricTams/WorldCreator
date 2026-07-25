import { createNoise4D } from 'simplex-noise'
import * as THREE from 'three'
import { makeRng } from '../world/prng'

/**
 * A seamlessly tiling surface-detail texture.
 *
 *   RGB — tangent-space normal
 *   A   — height, used for albedo mottling
 *
 * Tileability comes from sampling *4D* simplex noise around a torus: walking u
 * and v once around two circles returns exactly to the start, so the 2D slice
 * wraps in both axes with no seam. Sampling a 2D field over a square and hoping
 * gives a visible join, and blending the edges softens exactly the fine detail
 * this exists to provide.
 *
 * Generated rather than shipped as an asset so the whole page stays
 * self-contained — no binary in the repo, nothing to 404 on Pages.
 */
export function createDetailTexture(
  size = 256,
  octaves = 4,
  maxAnisotropy = 1,
): THREE.DataTexture {
  const noise4 = createNoise4D(makeRng('detail', 'surface'))
  const TAU = Math.PI * 2

  // Pass 1: the height field.
  const height = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    const b = (y / size) * TAU
    for (let x = 0; x < size; x++) {
      const a = (x / size) * TAU
      let sum = 0
      let amp = 1
      let norm = 0
      let r = 1.7
      for (let o = 0; o < octaves; o++) {
        sum +=
          noise4(
            Math.cos(a) * r,
            Math.sin(a) * r,
            Math.cos(b) * r,
            Math.sin(b) * r,
          ) * amp
        norm += amp
        amp *= 0.5
        r *= 2
      }
      height[y * size + x] = sum / norm
    }
  }

  // Pass 2: derive normals, wrapping at the edges so the normal map tiles too.
  const data = new Uint8Array(size * size * 4)
  const at = (x: number, y: number): number =>
    height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]

  const relief = 2.2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * relief
      const dy = (at(x, y + 1) - at(x, y - 1)) * relief
      // Surface normal of h(x, y) is (-dh/dx, -dh/dy, 1).
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1)
      const i = (y * size + x) * 4
      data[i] = (-dx * inv * 0.5 + 0.5) * 255
      data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255
      data[i + 2] = (inv * 0.5 + 0.5) * 255
      data[i + 3] = (height[y * size + x] * 0.5 + 0.5) * 255
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  // Terrain is viewed at grazing angles constantly; without anisotropy the
  // detail smears into mush a few metres ahead of the camera.
  tex.anisotropy = Math.min(8, maxAnisotropy)
  tex.needsUpdate = true
  return tex
}
