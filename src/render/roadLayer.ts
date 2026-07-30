import * as THREE from 'three'
import roadsUrl from '../assets/roads.png'
import {
  ROAD_BLOCK_ORIGIN,
  ROAD_BRIDGES,
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
 * This was 0.08, on the reasoning that a 2.5-unit road quad sits well inside an
 * 8-unit terrain cell and only has a chord to clear. That reasoning forgot
 * amplification, which is on by default at three levels: the 256 simulation
 * grid renders at 2048, so a terrain triangle is **one world unit** and a road
 * quad spans two and a half of them. Every bump between the four sampled
 * corners came straight through the road, which is the scalloped green bite
 * along its edges.
 *
 * Measured over 4000 random land quads, the drawn surface rises above the flat
 * quad through its corners by a median of 0.098 and a p99 of 0.677 — so 0.08
 * cleared 42% of quads. Lifting instead of subdividing is not the fix: the tail
 * runs to 4.2 units, so covering it would float the road well clear of the
 * ground it is supposed to be lying on.
 *
 * With `SUBDIVISION` below cutting each quad to 0.83 units, the same
 * measurement gives a median of 0.014 and a p99 of 0.101, and 0.15 clears
 * 99.5%. What still clips is near-vertical rock, where nothing laid flat would
 * survive anyway.
 */
const LIFT = 0.15

/**
 * Clearance of a bridge deck above the waterline, in world units.
 *
 * A bridge cannot use `LIFT`, because `terrainDrawnHeightAt` over water returns
 * the *seabed* — the sea is part of the terrain surface here, not a separate
 * plane laid on top — so a deck lifted from the ground it stands over would be
 * drawn beneath the water it is supposed to cross.
 *
 * Taking the greater of the ground and the waterline gives the right shape for
 * free: flat across the span at the height of the water, and rising onto the
 * bank at either end where the ground climbs out from under it.
 *
 * Larger than `LIFT` because the sea is drawn as a flat surface with no relief
 * to clear, so all this has to beat is depth precision — and a deck sitting a
 * little proud of the water reads as a bridge, where one exactly level with it
 * reads as a ford.
 */
const BRIDGE_LIFT = 0.5

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
attribute vec2 uvAlt;
attribute float blend;

varying vec2 vUv;
varying vec2 vUvAlt;
varying float vBlend;
varying vec3 vWorld;

void main() {
  vUv = uv;
  vUvAlt = uvAlt;
  vBlend = blend;
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
varying vec2 vUvAlt;
varying float vBlend;
varying vec3 vWorld;

void main() {
  // The same tile out of two materials' blocks. All four blocks share a layout,
  // so these differ in surface and never in shape — which is why the alpha of
  // one speaks for both, and why mixing cannot smear the road's outline.
  vec4 texel = texture2D(uMap, vUv);
  vec4 other = texture2D(uMap, vUvAlt);
  texel.rgb = mix(texel.rgb, other.rgb, vBlend);
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

    /**
     * Sub-quads per side of a road cell, so no piece of road spans more than
     * one terrain triangle.
     *
     * Derived from the terrain rather than fixed, because the terrain's
     * resolution is a slider: amplification at three levels puts a triangle at
     * one world unit and needs 3x3, while amplification off leaves 8-unit cells
     * that a 2.5-unit quad already fits inside, and this comes out 1 — no
     * subdivision and no cost. See `LIFT` for the measurements.
     */
    const sub = Math.max(1, Math.ceil(cellSize / Math.max(1e-4, frame.cellSize)))
    const step = cellSize / sub
    /** World Y of the waterline — what a bridge deck rests on. */
    const seaY = frame.seaLevel * frame.heightScale

    // Count first, then fill. Two passes over the grid is far cheaper than
    // growing three JS arrays across a few thousand quads and converting at the
    // end, and it lets the buffers be typed from the start.
    let cellCount = 0
    for (let k = 0; k < cells.length; k++) if (cells[k]) cellCount++

    if (cellCount === 0) {
      this.object.visible = false
      return
    }

    const quads = cellCount * sub * sub
    const positions = new Float32Array(quads * 4 * 3)
    const uvs = new Float32Array(quads * 4 * 2)
    const uvAlts = new Float32Array(quads * 4 * 2)
    const blends = new Float32Array(quads * 4)
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

        // Where the road stands in water it is a bridge, and a bridge is not
        // autotiled: its tile is chosen by the direction the deck runs, not by
        // which neighbours happen to be road. It also has nothing to fade
        // towards — a crossing is one built structure end to end — so both uv
        // sets point at the same tile and the blend is forced off.
        const deck = net.bridge[j * size + i]
        let tx: number
        let ty: number
        let ax: number
        let ay: number
        let blend: number

        if (deck !== 0) {
          // Stone for the earthen surfaces, grey for the built ones, so the
          // crossing looks like it belongs to the road that arrives at it.
          const stone = cell <= 2
          const key = deck === 1 ? (stone ? 'stoneEW' : 'greyEW') : stone ? 'stoneNS' : 'greyNS'
          ;[tx, ty] = ROAD_BRIDGES[key]
          ax = tx
          ay = ty
          blend = 0
        } else {
          // One tile, located in two materials' blocks. The mask decides the
          // tile and the material decides only which block to take it from, so
          // the two rects are the same shape at different offsets and can be
          // crossfaded.
          const [lx, ly] = ROAD_TILE_FOR_MASK[mask]
          const [bx, by] = ROAD_BLOCK_ORIGIN[cell - 1]
          const altCell = net.alt[j * size + i] || cell
          const [cx2, cy2] = ROAD_BLOCK_ORIGIN[altCell - 1]
          tx = bx + lx
          ty = by + ly
          ax = cx2 + lx
          ay = cy2 + ly
          blend = net.mix[j * size + i] / 255
        }

        const u0 = tx * du + insetU
        const v0 = ty * dv + insetV
        const u1 = u0 + du - insetU * 2
        const v1 = v0 + dv - insetV * 2
        const a0 = ax * du + insetU
        const b0 = ay * dv + insetV
        const a1 = a0 + du - insetU * 2
        const b1 = b0 + dv - insetV * 2

        const bx0 = originX + i * cellSize - half
        const bz0 = originZ + j * cellSize - half

        // One tile, cut into `sub` x `sub` pieces that each conform to the
        // ground on their own. UVs interpolate linearly across the tile, which
        // is exact — the quad maps one 16px cell of the sheet either way.
        //
        // Neighbouring road cells sample `terrainDrawnHeightAt` at exactly the
        // same world positions along their shared edge, so the heights agree to
        // the bit and no seam opens between them.
        for (let sj = 0; sj < sub; sj++) {
          for (let si = 0; si < sub; si++) {
            const x0 = bx0 + si * step
            const x1 = x0 + step
            const z0 = bz0 + sj * step
            const z1 = z0 + step
            const su0 = u0 + ((u1 - u0) * si) / sub
            const su1 = u0 + ((u1 - u0) * (si + 1)) / sub
            const sv0 = v0 + ((v1 - v0) * sj) / sub
            const sv1 = v0 + ((v1 - v0) * (sj + 1)) / sub
            const sa0 = a0 + ((a1 - a0) * si) / sub
            const sa1 = a0 + ((a1 - a0) * (si + 1)) / sub
            const sb0 = b0 + ((b1 - b0) * sj) / sub
            const sb1 = b0 + ((b1 - b0) * (sj + 1)) / sub

            // Corners (x0,z0) (x1,z0) (x1,z1) (x0,z1) — north-west first, then
            // clockwise — so the winding below is front-facing seen from above
            // and the UVs line up with the image's own top-left origin without
            // a flip.
            const corners: [number, number, number, number, number, number][] = [
              [x0, z0, su0, sv0, sa0, sb0],
              [x1, z0, su1, sv0, sa1, sb0],
              [x1, z1, su1, sv1, sa1, sb1],
              [x0, z1, su0, sv1, sa0, sb1],
            ]

            for (const [x, z, u, w, au, aw] of corners) {
              const ground = terrainDrawnHeightAt(frame, x, z)
              positions[v * 3] = x
              positions[v * 3 + 1] =
                deck !== 0 ? Math.max(ground, seaY) + BRIDGE_LIFT : ground + LIFT
              positions[v * 3 + 2] = z
              uvs[v * 2] = u
              uvs[v * 2 + 1] = w
              uvAlts[v * 2] = au
              uvAlts[v * 2 + 1] = aw
              blends[v] = blend
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
      }
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    this.geometry.setAttribute('uvAlt', new THREE.BufferAttribute(uvAlts, 2))
    this.geometry.setAttribute('blend', new THREE.BufferAttribute(blends, 1))
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
