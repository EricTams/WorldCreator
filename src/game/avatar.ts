import * as THREE from 'three'
import { Heightmap, sampleHeightAndGradient } from '../world/heightmap'
import type { Keyboard } from './input'

export interface AvatarSettings {
  walkSpeed: number
  flySpeed: number
  /** How far the avatar's feet sit above the terrain surface. */
  hover: number
  fly: boolean
  scale: number
}

/**
 * World north. Three's default camera looks down -Z, so -Z is the natural
 * "into the scene" direction to call north; east is then +X. Everything that
 * needs a compass bearing derives it from here rather than hard-coding a sign.
 */
export const NORTH = new THREE.Vector3(0, 0, -1)

/** Compass bearing of a world-space direction, in radians clockwise from north. */
export function bearingFromNorth(x: number, z: number): number {
  return Math.atan2(x, -z)
}

export interface TerrainFrame {
  heightmap: Heightmap
  cellSize: number
  heightScale: number
  seaLevel: number
}

/**
 * A stand-in body you can drive around the terrain.
 *
 * Deliberately not a character controller — no collision volume, no physics,
 * no slope limit. It samples the heightmap directly and sits on it. That's
 * enough to answer "does this landscape feel good to move through", which is
 * what it exists for.
 */
export class Avatar {
  readonly object = new THREE.Group()
  readonly position = new THREE.Vector3()

  private facing = 0
  private flyY = 0
  private body: THREE.Mesh
  private nose: THREE.Mesh
  private pole: THREE.Mesh
  private flag: THREE.Mesh
  private carpet: THREE.Mesh
  /** Flat rest positions, so the ripple is re-derived rather than accumulated. */
  private carpetRest: Float32Array
  private carpetPhase = 0
  private materials: THREE.Material[] = []

  // Scratch vector — this runs every frame and shouldn't allocate.
  private readonly move = new THREE.Vector3()

  constructor() {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xe2653a,
      roughness: 0.5,
    })
    const noseMat = new THREE.MeshStandardMaterial({
      color: 0xffd9a0,
      roughness: 0.6,
    })
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0xf2f2f2,
      roughness: 0.7,
    })
    const flagMat = new THREE.MeshStandardMaterial({
      color: 0xe2653a,
      roughness: 0.7,
      side: THREE.DoubleSide,
    })
    this.materials.push(bodyMat, noseMat, poleMat, flagMat)

    // Capsule origin is its centre, so lift it by half its total height plus
    // the carpet's thickness to stand the figure on the rug rather than in it.
    // Kept slim: a bulkier body hides the carpet entirely from the overhead
    // follow angle, and the marker pole already covers long-range visibility.
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.8, 6, 12), bodyMat)
    this.body.position.y = 0.94

    // A snout so you can tell which way it's pointing.
    this.nose = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.34, 10), noseMat)
    this.nose.rotation.x = Math.PI / 2
    this.nose.position.set(0, 1.05, 0.4)

    // Findable from strategy altitude, where the body is a couple of pixels.
    this.pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 7, 6), poleMat)
    this.pole.position.y = 5.1
    this.flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.9), flagMat)
    this.flag.position.set(0.75, 8.1, 0)

    this.carpet = Avatar.makeCarpet()
    this.carpetRest = (
      this.carpet.geometry.getAttribute('position') as THREE.BufferAttribute
    ).array.slice() as Float32Array
    this.materials.push(this.carpet.material as THREE.Material)

    this.object.add(this.body, this.nose, this.pole, this.flag, this.carpet)
  }

  /**
   * A woven rug for the figure to stand on. Purely cosmetic, but it's what
   * makes the stand-in read as a magic carpet rather than a traffic cone.
   *
   * Patterned with vertex colours rather than a texture — it's a couple of
   * hundred vertices and this keeps it asset-free like everything else here.
   */
  private static makeCarpet(): THREE.Mesh {
    // Comfortably wider than the body (radius 0.5), or the figure sits on it
    // like a plug and you never see the rug from the overhead follow angle.
    const WIDTH = 2.0
    const LENGTH = 2.9
    const geo = new THREE.PlaneGeometry(WIDTH, LENGTH, 10, 14)
    // Lay it flat; the plane's height axis becomes the carpet's length (Z),
    // which is the direction the avatar faces.
    geo.rotateX(-Math.PI / 2)

    const FRINGE: [number, number, number] = [0.86, 0.78, 0.55]
    const GOLD: [number, number, number] = [0.82, 0.64, 0.24]
    const DARK: [number, number, number] = [0.24, 0.05, 0.09]
    const FIELD: [number, number, number] = [0.52, 0.09, 0.13]

    const pos = geo.getAttribute('position')
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) / WIDTH + 0.5
      const v = pos.getZ(i) / LENGTH + 0.5
      let c: [number, number, number]
      if (v < 0.04 || v > 0.96) c = FRINGE
      else if (u < 0.09 || u > 0.91 || v < 0.08 || v > 0.92) c = GOLD
      else if (u < 0.15 || u > 0.85 || v < 0.13 || v > 0.87) c = DARK
      else if (Math.abs(u - 0.5) + Math.abs(v - 0.5) < 0.2) c = GOLD
      else c = FIELD
      colors[i * 3] = c[0]
      colors[i * 3 + 1] = c[1]
      colors[i * 3 + 2] = c[2]
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        side: THREE.DoubleSide,
      }),
    )
    // Aligning to the gradient matches the ground's average tilt but not its
    // curvature, so a rigid 3-unit plane still cuts in on steep ground. A bit
    // of ride height covers that; it reads as hovering, which for a carpet is
    // the right failure mode.
    mesh.position.y = 0.22
    return mesh
  }

  /**
   * Lay the carpet along the ground rather than flat.
   *
   * It's ~3 units long, so on any real slope a flat rug buries its uphill
   * corners and floats its downhill ones. The figure stays upright — people
   * stand vertically on hillsides — and only the rug conforms.
   */
  private alignCarpet(frame: TerrainFrame): void {
    const { heightmap, cellSize, heightScale } = frame
    const cells = heightmap.size - 1
    const half = (cells * cellSize) / 2
    const max = cells - 1.001
    const gx = THREE.MathUtils.clamp((this.position.x + half) / cellSize, 0, max)
    const gz = THREE.MathUtils.clamp((this.position.z + half) / cellSize, 0, max)

    const g = sampleHeightAndGradient(heightmap.data, heightmap.size, gx, gz)
    // Grid-space gradient is normalised height per cell; world slope needs the
    // height scale applied and the cell width divided out.
    const dx = (g.gradX * heightScale) / cellSize
    const dz = (g.gradZ * heightScale) / cellSize

    // The carpet is a child of a group already yawed by `facing`, so the world
    // gradient has to be resolved onto the group's local axes first.
    const c = Math.cos(this.facing)
    const s = Math.sin(this.facing)
    const localX = dx * c - dz * s
    const localZ = dx * s + dz * c

    const LIMIT = 0.9 // ~50°, past which it looks like it's falling off
    this.carpet.rotation.x = THREE.MathUtils.clamp(-Math.atan(localZ), -LIMIT, LIMIT)
    this.carpet.rotation.z = THREE.MathUtils.clamp(Math.atan(localX), -LIMIT, LIMIT)
  }

  /** Travelling ripple, so the carpet looks like it's holding itself up. */
  private rippleCarpet(dt: number): void {
    this.carpetPhase += dt
    const attr = this.carpet.geometry.getAttribute('position') as THREE.BufferAttribute
    const rest = this.carpetRest
    for (let i = 0; i < attr.count; i++) {
      const x = rest[i * 3]
      const z = rest[i * 3 + 2]
      const lift =
        Math.sin(z * 2.6 + this.carpetPhase * 3.4) * 0.085 +
        Math.sin(x * 3.1 - this.carpetPhase * 2.2) * 0.035
      attr.setY(i, rest[i * 3 + 1] + lift)
    }
    attr.needsUpdate = true
    this.carpet.geometry.computeVertexNormals()
  }

  setScale(s: number): void {
    this.object.scale.setScalar(s)
  }

  /**
   * The marker pole exists to make the avatar findable from strategy altitude.
   * Up close it's a flagpole through the middle of the shot, so drop it once
   * the camera is near enough that the body itself is clearly visible.
   */
  updateMarkerVisibility(camera: THREE.Camera): void {
    const near = this.object.scale.x * 26
    const show = camera.position.distanceToSquared(this.position) > near * near
    this.pole.visible = show
    this.flag.visible = show
  }

  /** Terrain height in world units at a world-space XZ, plus whether in bounds. */
  static sampleTerrain(
    frame: TerrainFrame,
    worldX: number,
    worldZ: number,
  ): number {
    const { heightmap, cellSize, heightScale } = frame
    const cells = heightmap.size - 1
    const half = (cells * cellSize) / 2

    // World space is centred on the origin; grid space starts at 0.
    let gx = (worldX + half) / cellSize
    let gz = (worldZ + half) / cellSize

    // The bilinear sampler reads (floor+1), so stay inside the last cell.
    const max = cells - 1.001
    gx = gx < 0 ? 0 : gx > max ? max : gx
    gz = gz < 0 ? 0 : gz > max ? max : gz

    return (
      sampleHeightAndGradient(heightmap.data, heightmap.size, gx, gz).height *
      heightScale
    )
  }

  /** Drop the avatar onto the surface at a world XZ, e.g. after regenerating. */
  placeAt(frame: TerrainFrame, worldX: number, worldZ: number, settings: AvatarSettings): void {
    const ground = Avatar.sampleTerrain(frame, worldX, worldZ)
    const sea = frame.seaLevel * frame.heightScale
    this.position.set(worldX, Math.max(ground, sea) + settings.hover, worldZ)
    this.flyY = this.position.y
    this.syncObject()
  }

  /**
   * Move for one frame.
   *
   * Movement is in fixed world directions, not relative to the camera: W is
   * always north no matter how the view is orbited. That keeps the map's
   * geography stable in your head — a place stays north-east of another place
   * whichever way you happen to be looking — which is how the strategy games
   * this is aiming at behave. The on-screen compass tracks where north went.
   */
  update(
    dt: number,
    keys: Keyboard,
    frame: TerrainFrame,
    settings: AvatarSettings,
  ): boolean {
    const east = keys.axis('KeyA', 'KeyD')
    const north = keys.axis('KeyS', 'KeyW')
    const lift = settings.fly ? keys.axis('ShiftLeft', 'Space') : 0

    // North is -Z, east is +X.
    this.move.set(east, 0, -north)
    const moving = this.move.lengthSq() > 1e-8
    if (moving) {
      // Normalise so diagonals aren't faster than the cardinals.
      this.move.normalize()
      const speed = settings.fly ? settings.flySpeed : settings.walkSpeed
      this.position.addScaledVector(this.move, speed * dt)
      this.facing = Math.atan2(this.move.x, this.move.z)
    }

    // Keep inside the map.
    const cells = frame.heightmap.size - 1
    const half = (cells * frame.cellSize) / 2
    this.position.x = THREE.MathUtils.clamp(this.position.x, -half, half)
    this.position.z = THREE.MathUtils.clamp(this.position.z, -half, half)

    const ground = Avatar.sampleTerrain(frame, this.position.x, this.position.z)
    const sea = frame.seaLevel * frame.heightScale
    // Standing at the waterline rather than walking along the seabed.
    const floor = Math.max(ground, sea) + settings.hover

    if (settings.fly) {
      this.flyY += lift * settings.flySpeed * dt
      this.position.y = Math.max(this.flyY, floor)
      this.flyY = this.position.y
    } else {
      this.position.y = floor
      this.flyY = floor
    }

    this.rippleCarpet(dt)
    // Flying free of the ground, so nothing to conform to.
    if (settings.fly) {
      this.carpet.rotation.x = 0
      this.carpet.rotation.z = 0
    } else {
      this.alignCarpet(frame)
    }
    this.syncObject()
    return moving || lift !== 0
  }

  private syncObject(): void {
    this.object.position.copy(this.position)
    this.object.rotation.y = this.facing
  }

  dispose(): void {
    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose()
    })
    for (const m of this.materials) m.dispose()
  }
}
