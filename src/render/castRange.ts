import * as THREE from 'three'
import { terrainHeightAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'

/**
 * A dashed ring on the ground showing how far the wizard can reach.
 *
 * Range is invisible otherwise. The rule is enforced in the simulation and the
 * only feedback was a refusal after the fact — "out of range, fly closer" told
 * the player they had guessed wrong, which is a worse way to learn a number than
 * simply drawing it.
 *
 * The ring is sampled onto the terrain rather than drawn as a flat circle. A
 * flat one is only correct on flat ground, and on the sort of slope the island
 * is mostly made of it either floats off the hillside or buries itself in it —
 * either way it stops reading as "the ground I can reach".
 *
 * Dashes rather than a solid line because a solid circle around the avatar reads
 * as a selection ring or a shadow; a dashed one reads as a measurement, which is
 * what it is.
 *
 * Each dash is a **quad**, not a line segment. WebGL ignores `linewidth` — every
 * `LineSegments` is one device pixel wide whatever you ask for — so on a retina
 * display the first version of this drew forty perfectly correct hairlines that
 * were invisible against grass. A quad has a width in *world* units, so the ring
 * keeps its weight at any zoom and any pixel density.
 */

/** How many dashes go round the circle. */
const DASHES = 40
/** Fraction of each dash's arc that is drawn rather than gap. */
const DUTY = 0.55
/** Width of the band, in world units. About a third of the avatar's width. */
const WIDTH = 0.7
/**
 * Lift above the surface, in world units.
 *
 * Enough to clear the local relief between two samples so the line does not
 * disappear into the far side of every bump, small enough that it still reads as
 * lying on the ground rather than hovering over it.
 */
const LIFT = 0.5

export class CastRange {
  readonly object: THREE.Group

  private mesh: THREE.Mesh
  private material: THREE.MeshBasicMaterial
  private positions: THREE.BufferAttribute

  constructor() {
    const geo = new THREE.BufferGeometry()
    // Four vertices per dash, rewritten every frame the ring is visible.
    this.positions = new THREE.BufferAttribute(new Float32Array(DASHES * 4 * 3), 3)
    this.positions.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.positions)

    // Winding is fixed, so the index buffer is built once and never touched.
    const index: number[] = []
    for (let i = 0; i < DASHES; i++) {
      const b = i * 4
      index.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
    geo.setIndex(index)

    this.material = new THREE.MeshBasicMaterial({
      // The same accent the armed spell uses in the hotbar, so the ring and the
      // slot that summoned it are obviously the same state.
      color: 0xe2653a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Unfogged: this is an instrument, not scenery, and a range ring that
      // faded into the distance haze would be lying about where the edge is.
      fog: false,
      // A band lying on the ground is very nearly coplanar with it, and no
      // amount of depth precision resolves that reliably. Bias it toward the eye
      // so it wins the tie consistently instead of stippling as the wizard moves.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })

    this.mesh = new THREE.Mesh(geo, this.material)
    // The ring is rebuilt around the wizard every frame; three's cached bounding
    // sphere would be a frame stale and could cull it at the screen edge.
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
    this.mesh.visible = false

    this.object = new THREE.Group()
    this.object.add(this.mesh)
  }

  /** Hide it without touching the geometry. */
  hide(): void {
    this.mesh.visible = false
  }

  /** Redraw the ring at `radius` around a world XZ, seated on the terrain. */
  show(frame: TerrainFrame, x: number, z: number, radius: number): void {
    const array = this.positions.array as Float32Array
    const step = (Math.PI * 2) / DASHES
    const inner = radius - WIDTH / 2
    const outer = radius + WIDTH / 2
    const seaY = frame.seaLevel * frame.heightScale

    let o = 0
    for (let i = 0; i < DASHES; i++) {
      const a0 = i * step
      const a1 = a0 + step * DUTY
      // Corners in order: inner-start, inner-end, outer-end, outer-start, which
      // is the winding the shared index buffer above expects.
      const corners: [number, number][] = [
        [a0, inner],
        [a1, inner],
        [a1, outer],
        [a0, outer],
      ]
      for (const [a, r] of corners) {
        const px = x + Math.cos(a) * r
        const pz = z + Math.sin(a) * r
        // Each corner is sampled separately, so a dash straddling a slope tilts
        // with it instead of one end sinking into the hill.
        const py = Math.max(terrainHeightAt(frame, px, pz), seaY)
        array[o++] = px
        array[o++] = py + LIFT
        array[o++] = pz
      }
    }

    this.positions.needsUpdate = true
    this.mesh.visible = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
