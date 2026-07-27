import * as THREE from 'three'
import type { FogGrid } from '../world/fog'

/**
 * The fog grid as a texture the terrain shader can sample.
 *
 * Two channels in one RG texture — explored and currently visible — so a single
 * fetch answers both "may I draw this" and "is it lit". Linear filtering is what
 * turns 16-metre cells into a soft reveal edge instead of a staircase.
 */
export class FogTexture {
  readonly texture: THREE.DataTexture
  private uploaded = -1

  constructor(grid: FogGrid) {
    this.texture = new THREE.DataTexture(
      grid.data,
      grid.size,
      grid.size,
      THREE.RGFormat,
      THREE.UnsignedByteType,
    )
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    // Visibility data, not colour.
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.needsUpdate = true
  }

  /** Upload only when the grid actually changed. */
  sync(grid: FogGrid): void {
    if (grid.version === this.uploaded) return
    this.uploaded = grid.version
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}
