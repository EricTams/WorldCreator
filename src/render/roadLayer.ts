import * as THREE from 'three'
import roadsUrl from '../assets/roads.png'
import {
  ROAD_BLOCK_ORIGIN,
  ROAD_SHEET_HEIGHT,
  ROAD_SHEET_WIDTH,
  ROAD_TILE,
  ROAD_TILE_FOR_MASK,
} from '../assets/roads'
import type { RoadNetwork } from '../world/roads'
import { terrainDrawnHeightAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'

/**
 * The roads, laid on the ground.
 *
 * One quad per road cell, autotiled from the cell's eight neighbours and
 * conformed to the terrain at its corners. `world/roads.ts` decided where road
 * is and what it is made of; everything here is about making it lie flat and
 * join up.
 *
 * Not instanced, and not a decal projector. Instancing wants one geometry drawn
 * many times, and every quad here has different UVs *and* different corner
 * heights, so there would be nothing left to share. A projector would be the
 * textbook answer and is the wrong one for this art: it filters, and a filtered
 * 16px tile at this scale is mud. This is a few thousand quads written once per
 * map into one buffer, which is one draw call and no per-frame work at all.
 */

/**
 * Clearance above the drawn surface, in world units.
 *
 * A road quad is 2.5 units across against an 8-unit terrain cell, so it is
 * almost always well inside one cell and its corners land on the very triangles
 * it is lying on — `terrainDrawnHeightAt` reads the mesh's triangulation, not
 * the smooth field above it. What is left to clear is the sag of a 2.5-unit
 * chord across a triangle, plus depth-buffer slop at draw distance, and 0.08 is
 * comfortably more than both while being far too small to see from any camera
 * the game has.
 */
const LIFT = 0.08

/**
 * Alpha below which a road texel is not drawn at all.
 *
 * A hard cut rather than blending, because the whole layer is then opaque and
 * can write depth and sort like anything else. The tileset's edges are already
 * hard — this is pixel art with a one-pixel outline, not a soft mask — so there
 * is nothing here that blending would preserve.
 */
const ALPHA_CUTOFF = 0.5

const VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

/**
 * Unlit, and fogged exactly as the terrain is.
 *
 * Unlit because the source art is drawn with its own light baked in, the same
 * reason the ground tiles are laid on as albedo — running a sun over it a second
 * time reads as two suns. Fogged with the same thresholds and the same curve the
 * terrain shader uses, because a road is a thing the player learns by exploring
 * and a road visible through unexplored ground would give the map away.
 */
const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uFogMap;
uniform vec2 uFogOrigin;
uniform float uFogInvExtent;
uniform float uFogOverride;

varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vec4 texel = texture2D(uMap, vUv);
  if (texel.a < ${ALPHA_CUTOFF}) discard;

  vec2 fogUv = (vWorld.xz - uFogOrigin) * uFogInvExtent;
  float seen = max(texture2D(uFogMap, fogUv).r, uFogOverride);
  if (seen < 0.18) discard;

  gl_FragColor = vec4(texel.rgb * smoothstep(0.18, 0.55, seen), 1.0);
  #include <colorspace_fragment>
}
`

export class RoadLayer {
  readonly object: THREE.Mesh
  private geometry = new THREE.BufferGeometry()
  private material: THREE.ShaderMaterial
  private texture: THREE.Texture

  constructor(maxAnisotropy = 1) {
    this.texture = new THREE.TextureLoader().load(roadsUrl)
    // Point sampling and no mip chain, for the same reason the ground strip has
    // none: this is 16px pixel art, and any filter at all turns its one-pixel
    // outlines to grey. Distance aliasing is handled by the camera never getting
    // far enough away for a road to be sub-pixel.
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.texture.anisotropy = maxAnisotropy
    // The sheet is authored top-down and read unflipped, matching the sprite
    // atlas, so v runs down the image and the tile rects below are in image
    // coordinates rather than GL ones.
    this.texture.flipY = false
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.needsUpdate = true

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uMap: { value: this.texture },
        uFogMap: { value: null },
        uFogOrigin: { value: new THREE.Vector2(-1024, -1024) },
        uFogInvExtent: { value: 1 / 2048 },
        uFogOverride: { value: 1 },
      },
    })

    this.object = new THREE.Mesh(this.geometry, this.material)
    this.object.frustumCulled = false
    this.object.renderOrder = 1
    this.object.visible = false
  }

  /**
   * Rebuild the whole layer for a network and the terrain it lies on.
   *
   * Called once per map. Rebuilding rather than updating because every input
   * changes at once — a new seed is a new network on a new heightfield — and an
   * incremental path would be code with no caller.
   */
  build(net: RoadNetwork | null, frame: TerrainFrame): void {
    this.geometry.dispose()
    this.geometry = new THREE.BufferGeometry()
    this.object.geometry = this.geometry

    if (!net) {
      this.object.visible = false
      return
    }

    const { cells, size, cellSize, originX, originZ } = net
    const half = cellSize / 2

    // Count first, then fill. Two passes over the grid is far cheaper than
    // growing three JS arrays across a few thousand quads and converting at the
    // end, and it lets the buffers be typed from the start.
    let quads = 0
    for (let k = 0; k < cells.length; k++) if (cells[k]) quads++

    if (quads === 0) {
      this.object.visible = false
      return
    }

    const positions = new Float32Array(quads * 4 * 3)
    const uvs = new Float32Array(quads * 4 * 2)
    const index = new Uint32Array(quads * 6)

    const du = ROAD_TILE / ROAD_SHEET_WIDTH
    const dv = ROAD_TILE / ROAD_SHEET_HEIGHT
    // Quarter-texel inset, the same guard the sprite atlas uses: with NEAREST a
    // uv landing exactly on a tile boundary can round outward into the next
    // tile, which here would fringe every road edge with its neighbour.
    const insetU = 0.25 / ROAD_SHEET_WIDTH
    const insetV = 0.25 / ROAD_SHEET_HEIGHT

    let v = 0
    let t = 0
    let q = 0

    const road = (i: number, j: number): boolean =>
      i >= 0 && j >= 0 && i < size && j < size && cells[j * size + i] !== 0

    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const cell = cells[j * size + i]
        if (!cell) continue

        // The eight-way neighbourhood, clockwise from north. North is -Z, which
        // is also -j: the grid is written in the same orientation the world is
        // read in, so no axis is flipped anywhere in this file.
        const mask =
          (road(i, j - 1) ? 1 : 0) |
          (road(i + 1, j - 1) ? 2 : 0) |
          (road(i + 1, j) ? 4 : 0) |
          (road(i + 1, j + 1) ? 8 : 0) |
          (road(i, j + 1) ? 16 : 0) |
          (road(i - 1, j + 1) ? 32 : 0) |
          (road(i - 1, j) ? 64 : 0) |
          (road(i - 1, j - 1) ? 128 : 0)

        const [lx, ly] = ROAD_TILE_FOR_MASK[mask]
        const [bx, by] = ROAD_BLOCK_ORIGIN[cell - 1]
        const u0 = (bx + lx) * du + insetU
        const v0 = (by + ly) * dv + insetV
        const u1 = u0 + du - insetU * 2
        const v1 = v0 + dv - insetV * 2

        const cx = originX + i * cellSize
        const cz = originZ + j * cellSize
        const x0 = cx - half
        const x1 = cx + half
        const z0 = cz - half
        const z1 = cz + half

        // Corners in the order (x0,z0) (x1,z0) (x1,z1) (x0,z1) — north-west
        // first, then clockwise — so the winding below is front-facing when
        // viewed from above and the UVs line up with the image's own top-left
        // origin without a flip.
        const corners: [number, number, number, number][] = [
          [x0, z0, u0, v0],
          [x1, z0, u1, v0],
          [x1, z1, u1, v1],
          [x0, z1, u0, v1],
        ]

        for (const [x, z, u, w] of corners) {
          positions[v * 3] = x
          positions[v * 3 + 1] = terrainDrawnHeightAt(frame, x, z) + LIFT
          positions[v * 3 + 2] = z
          uvs[v * 2] = u
          uvs[v * 2 + 1] = w
          v++
        }

        const base = q * 4
        index[t++] = base
        index[t++] = base + 2
        index[t++] = base + 1
        index[t++] = base
        index[t++] = base + 3
        index[t++] = base + 2
        q++
      }
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1))
    this.geometry.computeBoundingSphere()
    this.object.visible = true
  }

  /** Same fog the terrain uses. A null texture, or fog off, draws everything. */
  setFog(texture: THREE.Texture | null, worldSize: number, enabled: boolean): void {
    const u = this.material.uniforms
    u.uFogMap.value = texture
    u.uFogOrigin.value.set(-worldSize / 2, -worldSize / 2)
    u.uFogInvExtent.value = 1 / Math.max(1, worldSize)
    u.uFogOverride.value = texture && enabled ? 0 : 1
  }

  setVisible(on: boolean): void {
    this.object.visible = on
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}
