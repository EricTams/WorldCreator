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

    // Capsule origin is its centre, so lift it by half its total height to put
    // the feet on the group origin.
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.1, 6, 12), bodyMat)
    this.body.position.y = 1.05

    // A snout so you can tell which way it's pointing.
    this.nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 10), noseMat)
    this.nose.rotation.x = Math.PI / 2
    this.nose.position.set(0, 1.25, 0.55)

    // Findable from strategy altitude, where the body is a couple of pixels.
    this.pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 7, 6), poleMat)
    this.pole.position.y = 5.1
    this.flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.9), flagMat)
    this.flag.position.set(0.75, 8.1, 0)

    this.object.add(this.body, this.nose, this.pole, this.flag)
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
