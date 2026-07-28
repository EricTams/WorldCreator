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

/**
 * Pole and cloth in one geometry, standing on y=0, one unit tall.
 *
 * A square pole and one flat flag — a normal flag. The cloth is a single quad
 * lying in the XY plane, so its face points due south: gameplay runs with the
 * view locked north-up and the camera fixed, which means south is *always* where
 * the viewer is and one quad is broadside to them forever. This is the same
 * trick the sprite cards use when `uBillboard` is 0, and for the same reason.
 *
 * An earlier version crossed two quads so that neither could be caught edge-on.
 * That solved a problem the fixed camera does not have, and read as a strange
 * two-winged banner from every angle where both halves showed at once.
 */
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

  // The pole: a square post, four sides. Thin enough to read as timber rather
  // than as a tower, thick enough to catch the light on one face.
  const t = 0.014
  quad(-t, 0, -t, t, 0, -t, t, 1, -t, -t, 1, -t, POLE)
  quad(t, 0, t, -t, 0, t, -t, 1, t, t, 1, t, POLE)
  quad(t, 0, -t, t, 0, t, t, 1, t, t, 1, -t, POLE)
  quad(-t, 0, t, -t, 0, -t, -t, 1, -t, -t, 1, t, POLE)

  // The cloth: one rectangle, hoisted to the top and flying to +X. Its
  // proportions are a real flag's — half again as wide as it is tall — and it is
  // deliberately a fraction of the building it stands over. A banner is a label,
  // and a label larger than the thing it labels is just an obstruction.
  const top = 0.97
  const bottom = 0.72
  const fly = 0.34
  quad(t, bottom, 0, fly, bottom, 0, fly, top, 0, t, top, 0, CLOTH)

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
  private material: THREE.MeshBasicMaterial
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
    // Unlit, deliberately. A banner is an *ownership readout* before it is
    // scenery: blue has to mean "mine" at a glance, and it has to be the same
    // blue the HUD prints. Shading it broke exactly that — the cloth faces due
    // south, the sun does not, so every faction's colour came out darkened by a
    // different amount depending on where the sun happened to be, and the
    // player's medium blue read as navy. Fog still applies, so a distant flag
    // recedes with the landscape instead of floating over it.
    this.material = new THREE.MeshBasicMaterial({
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
