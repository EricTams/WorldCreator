import * as THREE from 'three'
import { terrainSampleAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'

/**
 * Trebuchets, built out of primitives.
 *
 * There is no siege art in either atlas — no engine in `sprites.png`, no
 * war-machine creature in `units.png` — and a siege train is the whole point of
 * the second playable, so the renderer builds one rather than the design being
 * cut to fit the pack. That is the same call `banners.ts` made for flags, and
 * the same rule applies: when real art lands, this becomes a card in
 * `boardLayer` and the geometry goes away.
 *
 * The engine is a flat south-facing silhouette. Gameplay runs with the view
 * locked north-up, so south is always where the viewer is and one plane of
 * geometry is broadside to them forever — the trick the sprite cards already use
 * when billboarding is off. A trebuchet's whole identity is its outline: a
 * triangle with a long arm over it, which is legible at any distance and costs
 * about twenty triangles.
 */

/**
 * An A-frame, a base beam and a throwing arm, standing on y=0, one unit tall.
 *
 * Vertex colour multiplies the instance colour, so the timber stays dark
 * regardless of whose engine it is while the pennant takes the faction colour at
 * full strength — the same division of labour as the banner's pole and cloth.
 */
function makeTrebuchetGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const index: number[] = []

  const TIMBER = 0.26
  const PENNANT = 1

  /** A thick line from (x1,y1) to (x2,y2), as one quad in the XY plane. */
  function bar(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    shade: number,
  ): void {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    // The perpendicular, scaled to half the bar's width.
    const px = (-dy / len) * width * 0.5
    const py = (dx / len) * width * 0.5

    const base = positions.length / 3
    positions.push(
      x1 - px, y1 - py, 0,
      x2 - px, y2 - py, 0,
      x2 + px, y2 + py, 0,
      x1 + px, y1 + py, 0,
    )
    for (let i = 0; i < 4; i++) colors.push(shade, shade, shade)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  // The frame: two legs meeting at an apex two-thirds of the way up, and a base
  // beam wide enough that the thing looks planted rather than balanced.
  const apexY = 0.62
  bar(-0.3, 0, 0, apexY, 0.075, TIMBER)
  bar(0.3, 0, 0, apexY, 0.075, TIMBER)
  bar(-0.36, 0.03, 0.36, 0.03, 0.07, TIMBER)
  // A cross-brace, which is most of what makes it read as a machine.
  bar(-0.16, 0.31, 0.16, 0.31, 0.05, TIMBER)

  // The arm, pivoting at the apex: long end thrown back and high, counterweight
  // stub forward and low. The diagonal over the triangle is the silhouette.
  bar(0.02, apexY, -0.44, 1, 0.055, TIMBER)
  bar(-0.02, apexY, 0.26, 0.4, 0.05, TIMBER)
  // The counterweight, a stubby block at the short end.
  bar(0.26, 0.4, 0.3, 0.3, 0.16, TIMBER)

  // A pennant at the throwing tip: the only faction-coloured part, and the
  // reason you can tell whose siege train is coming over the hill.
  bar(-0.44, 1, -0.26, 0.93, 0.12, PENNANT)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return geo
}

export class SiegeEngines {
  readonly object = new THREE.Group()

  private mesh: THREE.InstancedMesh
  private material: THREE.MeshBasicMaterial
  private capacity: number
  private count = 0
  private frame: TerrainFrame | null = null

  private scratch = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private quat = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private colour = new THREE.Color()

  constructor(capacity = 32) {
    this.capacity = capacity
    // Unlit for the same reason the banners are: the pennant is an ownership
    // readout, and it has to be the colour the HUD prints regardless of where
    // the sun is. Fog still applies, so a distant engine recedes properly.
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
    })
    this.mesh = new THREE.InstancedMesh(makeTrebuchetGeometry(), this.material, capacity)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.object.add(this.mesh)
  }

  begin(frame: TerrainFrame): void {
    this.frame = frame
    this.count = 0
  }

  /** Stand an engine on the ground. `height` is its world-unit size. */
  push(x: number, z: number, height: number, tint: number, dim = 1, flip = false): void {
    const frame = this.frame
    if (!frame || this.count >= this.capacity) return
    const i = this.count++

    const sample = terrainSampleAt(frame, x, z)
    const ground = Math.max(sample.height, frame.seaLevel * frame.heightScale)

    this.position.set(x, ground, z)
    this.quat.identity()
    // Mirrored by facing, like every sprite on the board, so an engine marching
    // west does not appear to be throwing backwards.
    this.scale.set(flip ? -height : height, height, height)
    this.scratch.compose(this.position, this.quat, this.scale)
    this.mesh.setMatrixAt(i, this.scratch)

    this.colour.set(tint).multiplyScalar(0.35 + 0.65 * dim)
    this.mesh.setColorAt(i, this.colour)
  }

  end(): void {
    this.mesh.count = this.count
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
