import * as THREE from 'three'
import { terrainDrawnHeightAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'

/**
 * A soft round shadow laid on the ground beneath something that hovers.
 *
 * Two jobs, both of them about *reading* the ground rather than lighting it:
 *
 *  - Where am I? A hovering figure and the terrain under it are drawn at
 *    different depths, and from the follow camera there is nothing to tie them
 *    together — you can be a body-length off a shoreline and not know which
 *    side of it you are over. The disc is a plumb line you can see.
 *  - Which way does the ground fall? The disc conforms per-vertex to the
 *    surface it lands on, so it tilts and bends with what is underneath. A
 *    slope you are flying over is legible from the shadow before you land.
 *
 * Deliberately cast straight down rather than along the sun. A sun-accurate
 * shadow answers "where would the light put it", and at this sun elevation
 * (32 degrees by default) that is tens of metres downhill of the avatar — no
 * use at all for the question being asked, which is "what am I over". This is
 * an instrument, not a light transport result.
 *
 * Cheap enough to ignore: one small mesh, one draw call, and 73 heightfield
 * lookups a frame.
 */

/** Vertices around each ring. Smooth enough at the follow camera's distance. */
const SEGMENTS = 24

/**
 * Concentric rings and their opacity, as fractions of the disc's radius.
 *
 * Three rings rather than two: the alpha ramp wants the outer band to itself,
 * and the conforming wants samples *inside* the disc — with a centre and a rim
 * alone, a ridge running under the middle of the shadow would be spanned by
 * straight edges and read as flat ground.
 */
const RINGS = [0, 0.5, 0.82, 1]
const RING_ALPHA = [1, 0.86, 0.42, 0]

/**
 * How much the disc spreads per world unit of altitude.
 *
 * A penumbra widens with distance from the occluder, and reproducing that is
 * what stops the shadow reading as a decal stuck to the avatar's feet: rising
 * off the ground visibly loosens it. 1/12 puts the default 4-body-height hover
 * at about 1.4x the footprint, and the 12-body-height maximum at about 2.2x.
 */
const SPREAD = 1 / 12

/** Darkest the disc ever gets, at ground contact. */
const MAX_ALPHA = 0.55

/**
 * Floor under the altitude fade.
 *
 * The fade is physical — the same darkness smeared over a wider disc — but the
 * shadow exists to be *found*, so it is not allowed to fade to the point where
 * you have to look for it at maximum hover.
 */
const MIN_ALPHA = 0.13

/**
 * Clearance above the surface, as a fraction of the disc's radius.
 *
 * Small, because the disc samples the terrain's *drawn* triangles rather than
 * the bilinear field (see `terrainDrawnHeightAt`) — its vertices land exactly
 * on the mesh, and only its chords cut the corner between them. What is left to
 * clear is that chord sag, which is why this scales with the radius: a wider
 * disc spans more of a cell between samples and sags further.
 *
 * The earlier version sampled the smooth field and lifted by the same fraction,
 * and it came out in pieces — over a ridge the mesh stood metres above the
 * surface the disc thought it was lying on, and all that showed was the crescent
 * that happened to clear it.
 */
const LIFT = 0.04

export class GroundShadow {
  readonly object: THREE.Mesh

  private geometry = new THREE.BufferGeometry()
  private material: THREE.MeshBasicMaterial
  /** Unit-circle XZ per vertex — the shape, before a radius is applied. */
  private unit: Float32Array

  constructor() {
    const positions: number[] = []
    const colors: number[] = []
    const index: number[] = []
    const unit: number[] = []

    for (let r = 0; r < RINGS.length; r++) {
      const count = r === 0 ? 1 : SEGMENTS
      for (let s = 0; s < count; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2
        const x = Math.cos(a) * RINGS[r]
        const z = Math.sin(a) * RINGS[r]
        unit.push(x, z)
        positions.push(x, 0, z)
        // White, so the material's colour is the shadow's colour and the
        // vertex channel is purely the rim ramp.
        colors.push(1, 1, 1, RING_ALPHA[r])
      }
    }

    // Fan from the centre vertex out to the first ring.
    for (let s = 0; s < SEGMENTS; s++) {
      index.push(0, 1 + s, 1 + ((s + 1) % SEGMENTS))
    }
    // Strips between successive rings.
    for (let r = 1; r < RINGS.length - 1; r++) {
      const inner = 1 + (r - 1) * SEGMENTS
      const outer = inner + SEGMENTS
      for (let s = 0; s < SEGMENTS; s++) {
        const n = (s + 1) % SEGMENTS
        index.push(inner + s, outer + s, outer + n)
        index.push(inner + s, outer + n, inner + n)
      }
    }

    this.unit = new Float32Array(unit)
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
    this.geometry.setIndex(index)
    ;(this.geometry.getAttribute('position') as THREE.BufferAttribute).setUsage(
      THREE.DynamicDrawUsage,
    )

    this.material = new THREE.MeshBasicMaterial({
      // Not black. The terrain's shadowed slopes pick up a strong sky term (see
      // the hemisphere light in scene.ts), so a neutral-black multiply reads as
      // a hole punched in the ground rather than as shade on it.
      color: 0x0d1420,
      vertexColors: true,
      transparent: true,
      // A shadow must never occlude anything — least of all the figure casting
      // it, whose carpet is a couple of units above it.
      depthWrite: false,
      // The far side of the disc faces away from the eye when it wraps over a
      // crest, and a one-sided shadow would tear along the ridge line.
      side: THREE.DoubleSide,
      // Aerial perspective, so a shadow seen from the overview recedes with the
      // ground it is lying on instead of staying a hard dark spot.
      fog: true,
      // Same reason as the map cards' ground discs: a decal this close to the
      // terrain cannot be resolved by depth precision at any zoom, so bias it
      // towards the eye. Kept small — the factor scales with the polygon's
      // depth slope, and a disc tilted onto a hillside has a steep one.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })

    this.object = new THREE.Mesh(this.geometry, this.material)
    // The vertex buffer is rewritten every frame, so three's cached bounds are
    // never the current shape. It is one small mesh sitting under the avatar,
    // which is the one thing on the map you are always looking at.
    this.object.frustumCulled = false
    // With the ground discs, ahead of the terrain's own transparent work.
    this.object.renderOrder = 2
  }

  /**
   * Lay the shadow on the surface under `at`.
   *
   * `bodyRadius` is the caster's ground footprint in world units; the disc
   * starts there and widens with how far above the ground it is being cast.
   */
  update(frame: TerrainFrame, at: THREE.Vector3, bodyRadius: number): void {
    const seaY = frame.seaLevel * frame.heightScale
    const centre = this.surfaceAt(frame, at.x, at.z, seaY)
    // Clamped because the avatar's own footing is sampled from the *unshelved*
    // field (see Avatar.update), so at a coastline it can be a shelf's depth
    // below the surface being drawn — and a negative altitude would invert the
    // spread and turn the shadow inside out.
    const altitude = Math.max(0, at.y - centre)

    const radius = bodyRadius + altitude * SPREAD
    this.object.position.set(at.x, centre + radius * LIFT, at.z)

    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = this.unit[i * 2] * radius
      const z = this.unit[i * 2 + 1] * radius
      // Heights are written relative to the centre sample, which is where the
      // mesh itself is parked — so the geometry stays small numbers around the
      // origin however high the terrain under it happens to be.
      pos.setXYZ(i, x, this.surfaceAt(frame, at.x + x, at.z + z, seaY) - centre, z)
    }
    pos.needsUpdate = true

    // Conserve the darkness rather than the opacity: spreading the same shadow
    // over a disc n times wider thins it by n². Without this, rising off the
    // ground would make the shadow *more* prominent, not less.
    const thin = bodyRadius / radius
    this.material.opacity = Math.max(MIN_ALPHA, MAX_ALPHA * thin * thin)
  }

  /**
   * The surface the shadow lands on: the terrain as *drawn*, not as generated.
   *
   * Two differences from what the avatar rides, and both are deliberate. The
   * coastal shelf is included, because the bank is what you see. And the
   * waterline is a floor, because the terrain shader lifts the seabed up to it
   * (see terrainMaterial.ts) — flying out over a bay, the thing below you is
   * the sea, and the shadow belongs on it rather than eighty metres down on
   * the bottom. It is also where the avatar's own footing is floored, so the
   * two agree about how high it is riding.
   *
   * Turning the water off exposes the seabed without moving the avatar, which
   * leaves the shadow at the waterline over a dry basin. That view is a look at
   * the bathymetry rather than a place to fly around in, and the alternative —
   * a shadow on the seabed under an avatar that is still riding the waterline —
   * puts a hundred metres of nothing between them.
   */
  private surfaceAt(frame: TerrainFrame, x: number, z: number, seaY: number): number {
    return Math.max(terrainDrawnHeightAt(frame, x, z), seaY)
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
