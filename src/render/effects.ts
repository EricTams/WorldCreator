import * as THREE from 'three'
import type { Blast, Projectile } from '../game/sim'

/**
 * Fireballs, and what they leave behind.
 *
 * Built from primitives rather than art on purpose: the pack has no spell
 * effects in it, and generating them is the same argument the terrain detail
 * texture makes — a glowing sphere is a thing a shader can produce exactly, and
 * shipping a hand-drawn one would be a binary in the repo for no gain.
 *
 * Two pools, sized once. Both are additive and neither writes depth: a blast is
 * light, and light does not occlude the thing it is lighting. That also sidesteps
 * the sorting problem entirely — additive blending is commutative, so overlapping
 * fireballs composite correctly in any order.
 */

const MAX_PROJECTILES = 24
const MAX_BLASTS = 16

export class Effects {
  readonly object = new THREE.Group()

  private bolts: THREE.Mesh[] = []
  private blasts: THREE.Mesh[] = []
  private light: THREE.PointLight
  private materials: THREE.Material[] = []

  constructor() {
    const boltGeo = new THREE.SphereGeometry(1, 10, 8)
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb040,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
      this.materials.push(mat)
      const mesh = new THREE.Mesh(boltGeo, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      this.bolts.push(mesh)
      this.object.add(mesh)
    }

    const blastGeo = new THREE.SphereGeometry(1, 14, 10)
    for (let i = 0; i < MAX_BLASTS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff7028,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
      this.materials.push(mat)
      const mesh = new THREE.Mesh(blastGeo, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      this.blasts.push(mesh)
      this.object.add(mesh)
    }

    // One light between them all. A point light per fireball would blow past
    // the renderer's light limit the moment three of them were in the air, and
    // the whole reason a fireball needs a light is the flash on the ground under
    // the newest one — which is exactly what a single moved light gives.
    this.light = new THREE.PointLight(0xff8030, 0, 90, 2)
    this.light.visible = false
    this.object.add(this.light)
  }

  update(projectiles: readonly Projectile[], blasts: readonly Blast[]): void {
    for (let i = 0; i < this.bolts.length; i++) {
      const p = projectiles[i]
      const mesh = this.bolts[i]
      if (!p) {
        mesh.visible = false
        continue
      }
      mesh.visible = true
      mesh.position.set(p.x, p.y, p.z)
      // Stretched along its own velocity, so a bolt in flight reads as moving
      // rather than as a ball hanging in the air.
      const speed = Math.hypot(p.vx, p.vy, p.vz) || 1
      mesh.scale.set(1.1, 1.1, 2.6)
      mesh.lookAt(p.x + p.vx / speed, p.y + p.vy / speed, p.z + p.vz / speed)
    }

    let lit = false
    for (let i = 0; i < this.blasts.length; i++) {
      const b = blasts[i]
      const mesh = this.blasts[i]
      if (!b) {
        mesh.visible = false
        continue
      }
      const t = Math.min(1, b.age / 0.6)
      mesh.visible = true
      mesh.position.set(b.x, b.y + 1.5, b.z)
      // Expands past the damage radius and fades: the damage is a hard circle,
      // and a sphere that stopped exactly on it would read as a cheat when
      // something just outside survived.
      const r = b.radius * (0.4 + t * 1.5)
      mesh.scale.setScalar(r)
      const mat = mesh.material as THREE.MeshBasicMaterial
      mat.opacity = 0.85 * (1 - t) * (1 - t)

      if (!lit) {
        lit = true
        this.light.visible = true
        this.light.position.set(b.x, b.y + 6, b.z)
        this.light.intensity = 900 * (1 - t)
      }
    }
    if (!lit) this.light.visible = false
  }

  dispose(): void {
    this.bolts[0]?.geometry.dispose()
    this.blasts[0]?.geometry.dispose()
    for (const m of this.materials) m.dispose()
  }
}
