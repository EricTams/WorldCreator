import * as THREE from 'three'
import { terrainSampleAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'

/**
 * The standard raised over everything a wizard holds.
 *
 * Ownership was carried entirely by a tinted disc on the ground, which is the
 * right answer looking down and nearly useless from the deck: at the follow
 * camera the disc is a sliver of colour under a building that hides most of it.
 * A banner is the opposite — it is tallest exactly where the disc is thinnest,
 * so between them a site reads as *someone's* from any altitude.
 *
 * Built from primitives rather than from art, on the same argument as
 * `effects.ts`: a coloured cloth on a pole is something geometry describes
 * exactly, and generating it means every faction gets one for free rather than
 * needing a sprite drawn per colour per site type. When there is real flag art,
 * this becomes a card in `boardLayer` and the geometry goes away.
 *
 * The cloth is two crossed quads. One quad is invisible edge-on, and the camera
 * orbits — a flag that vanishes at certain bearings reads as a flicker bug, and
 * crossing them costs four triangles.
 */

/** Pole and cloth in one geometry, standing on y=0, one unit tall. */
function makeBannerGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const index: number[] = []

  /** Vertex colour multiplies the instance colour, so this is how the pole
   *  stays dark timber while the cloth takes the faction's colour at full. */
  const POLE = 0.22
  const CLOTH = 1

  function quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    shade: number,
  ): void {
    const base = positions.length / 3
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz)
    for (let i = 0; i < 4; i++) colors.push(shade, shade, shade)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  // The pole: a thin cross of two quads, for the same reason the cloth is
  // crossed — a flat pole disappears when you orbit past it.
  const t = 0.018
  quad(-t, 0, 0, t, 0, 0, t, 1, 0, -t, 1, 0, POLE)
  quad(0, 0, -t, 0, 0, t, 0, 1, t, 0, 1, -t, POLE)

  // The cloth hangs from the top of the pole. Wide enough to read as a flag at
  // strategy altitude, short enough not to look like a sail up close.
  const top = 0.97
  const bottom = 0.62
  const reach = 0.42
  quad(0, bottom, 0, reach, bottom, 0, reach, top, 0, 0, top, 0, CLOTH)
  quad(0, bottom, 0, 0, bottom, reach, 0, top, reach, 0, top, 0, CLOTH)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return geo
}

export class Banners {
  readonly object = new THREE.Group()

  private mesh: THREE.InstancedMesh
  private material: THREE.MeshLambertMaterial
  private capacity: number
  private count = 0
  private frame: TerrainFrame | null = null

  private scratch = new THREE.Matrix4()
  private position = new THREE.Vector3()
  private quat = new THREE.Quaternion()
  private scale = new THREE.Vector3()
  private colour = new THREE.Color()

  constructor(capacity = 64) {
    this.capacity = capacity
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
    })
    this.mesh = new THREE.InstancedMesh(makeBannerGeometry(), this.material, capacity)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // A banner is a few dozen triangles on a stick; culling it per-instance
    // costs more than drawing it.
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.object.add(this.mesh)
  }

  begin(frame: TerrainFrame): void {
    this.frame = frame
    this.count = 0
  }

  /**
   * Raise a banner at a site.
   *
   * `height` is in world units — sized by the caller from what it is standing
   * over, so a capital's standard is visibly taller than a mine's.
   */
  push(x: number, z: number, height: number, tint: number, dim = 1): void {
    const frame = this.frame
    if (!frame || this.count >= this.capacity) return
    const i = this.count++

    const sample = terrainSampleAt(frame, x, z)
    const ground = Math.max(sample.height, frame.seaLevel * frame.heightScale)

    this.position.set(x, ground, z)
    this.quat.identity()
    this.scale.set(height, height, height)
    this.scratch.compose(this.position, this.quat, this.scale)
    this.mesh.setMatrixAt(i, this.scratch)

    // Dimmed with the fog, like everything else on the board — a banner is the
    // loudest thing on a site and would otherwise burn through unexplored ground.
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
