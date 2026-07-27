import * as THREE from 'three'
import { BIOMES, sampleBiomeAt } from '../world/biome'
import type { BiomeField } from '../world/biome'
import { groundIndex } from './groundTexture'

/**
 * Which tileset floors each point of the world, as a texture.
 *
 * This exists because the previous answer was to hand the fragment shader a
 * *vertex attribute* carrying tileset indices, and a vertex attribute is
 * interpolated. An index is a name, not a quantity: `GROUND_NAMES` runs
 * grass, sand, marsh, ice, lava, cave, dirt, so a triangle straddling a border
 * between grass (0) and dirt (6) had the rasteriser walk the index from 0 to 6
 * and name five tilesets neither of its vertices belonged to. That is what drew
 * the pale stripe along territory edges — ice at 3 and cave at 5, showing up in
 * territories that contain neither. Rounding the interpolated value, which the
 * shader used to do, snaps it to a whole column without stopping it travelling.
 *
 * A NEAREST-filtered lookup cannot interpolate, so the question does not arise:
 * every fragment reads exactly the index that was written for its cell. It is
 * also no longer tied to the terrain's vertex grid, so a border is as crisp as
 * this texture rather than as crisp as the mesh — which is what lets the
 * transition read as the near-instantaneous one the tile art has.
 *
 * Two bytes per texel, and neither is colour — `NoColorSpace`, or the renderer
 * would apply a transfer curve to what is really an array index.
 *
 *   R  the tileset index
 *   G  how far inside its own territory the texel is, in world units, clamped
 *      to 255. This is what lets the shader keep the ground flat near a border
 *      and save the textured tiles for the interiors: a patch of grain running
 *      up to the edge fights the border, and two flat colours meeting is what
 *      makes the transition legible.
 */
export class BiomeTexture {
  texture: THREE.DataTexture
  private data: Uint8Array
  private size: number

  /**
   * @param size texels per side. 512 over a 2 km island is 4 world units a
   *   texel — finer than both the 8-unit terrain grid and the 12-unit ground
   *   tile, so the border steps at a third of a tile and reads as a tile edge.
   *   Raising it costs a `sampleBiomeAt` per texel on every regenerate, which is
   *   a per-seed loop and the reason this is not simply set to the map size.
   */
  constructor(size = 512) {
    this.size = size
    this.data = new Uint8Array(size * size * 2)
    this.texture = new THREE.DataTexture(
      this.data,
      size,
      size,
      THREE.RGFormat,
      THREE.UnsignedByteType,
    )
    this.texture.minFilter = THREE.NearestFilter
    this.texture.magFilter = THREE.NearestFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.needsUpdate = true
  }

  /**
   * Re-bake for `field` across a world of `worldSize` units.
   *
   * A null field means territories are switched off; the whole map becomes
   * index 0, which is the grass sheet the default ramp is built around.
   */
  update(field: BiomeField | null, worldSize: number): THREE.DataTexture {
    const n = this.size
    if (!field) {
      // Index 0 — the grass sheet the default ramp is built around — and
      // "everywhere is deep interior", so nothing is held flat.
      for (let k = 0; k < this.data.length; k += 2) {
        this.data[k] = 0
        this.data[k + 1] = 255
      }
      this.texture.needsUpdate = true
      return this.texture
    }

    const half = worldSize / 2
    const step = worldSize / n
    for (let j = 0; j < n; j++) {
      // Texel centres, so the value stored is what the middle of the texel
      // actually is — sampling at the corner biases every border half a texel.
      const z = -half + (j + 0.5) * step
      for (let i = 0; i < n; i++) {
        const x = -half + (i + 0.5) * step
        const s = sampleBiomeAt(field, x, z)
        const k = (j * n + i) * 2
        // The owning territory, not a mix. There is nothing to mix here: this
        // texture answers "whose ground is this", and half way between two
        // answers is not a third answer. The cross-fade that softens the *colour*
        // at a border still happens, per vertex, in `colorRamp`.
        this.data[k] = groundIndex(BIOMES[s.t > 0.5 ? s.b : s.a].ground)
        // World units, so the shader's threshold can be a distance the GUI can
        // name. Saturating at 255 costs nothing: capitals sit some 380 units
        // apart, so anything past 255 is deep interior either way.
        this.data[k + 1] = s.gap >= 255 ? 255 : s.gap
      }
    }
    this.texture.needsUpdate = true
    return this.texture
  }

  dispose(): void {
    this.texture.dispose()
  }
}
