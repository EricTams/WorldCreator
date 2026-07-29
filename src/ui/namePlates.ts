import * as THREE from 'three'
import type { Sim, SiteState } from '../game/sim'

/**
 * What each place is called, and how hard it is — written on the map.
 *
 * With a hundred and thirty sites in eight kinds, the board has to be able to
 * say what it is. A plate carries a name and, where anything defends the site,
 * a one-to-five star rating.
 *
 * **The count says what the place is; the colour says what is left of it.** The
 * count comes from the site's garrison table and never moves, so a lair reads
 * three stars in minute two and in minute fifty and the player learns what a
 * lair costs. The colour fades gold to black with the garrison's health, so a
 * failed assault visibly dents it and the five-minute regrowth visibly restores
 * it. A cleared site keeps its full count in black, which says more than
 * hiding the stars would: *empty, and it was the hard one*.
 *
 * DOM rather than geometry. The HUD is already DOM, text in WebGL would mean
 * building and maintaining a font atlas for no gain, and stars-as-glyphs plus a
 * colour lerp is one CSS property. The camera is read and never touched.
 */

/** How far from the wizard a plate is drawn at all. */
const RANGE = 420
/** Where in that range it starts fading, as a fraction. */
const FADE_FROM = 0.72

interface Plate {
  el: HTMLElement
  name: HTMLElement
  stars: HTMLElement
  /** What the last write was, so unchanged plates never touch the DOM. */
  signature: string
}

export class NamePlates {
  private root: HTMLElement
  private pool: Plate[] = []
  private projected = new THREE.Vector3()
  /** World-to-camera, rebuilt each update so the depth test is this frame's. */
  private view = new THREE.Matrix4()

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'plates'
    parent.appendChild(this.root)
  }

  /**
   * @param dimAt how explored a world position is, 0..1 — the same gate
   *        `Sim.draw` applies, so a plate can never name a place the map has
   *        not drawn.
   */
  update(
    sim: Sim,
    camera: THREE.Camera,
    width: number,
    height: number,
    groundY: (x: number, z: number) => number,
    dimAt: (x: number, z: number) => number,
  ): void {
    const w = sim.player
    let used = 0

    // This frame's world-to-camera. Built here rather than read from
    // `camera.matrixWorldInverse`, which the renderer owns and refreshes on its
    // own schedule — a plate placed from last frame's matrix lags the view.
    camera.updateMatrixWorld()
    this.view.copy(camera.matrixWorld).invert()

    for (const site of sim.sites) {
      const d = Math.hypot(site.x - w.x, site.z - w.z)
      if (d > RANGE) continue
      if (dimAt(site.x, site.z) <= 0.02) continue

      this.projected.set(site.x, groundY(site.x, site.z) + 14, site.z)

      // Depth first, in view space, *before* anything divides by w.
      //
      // `Vector3.project` runs the perspective divide, and for a point behind
      // the camera w is negative — which flips x and y through the origin and
      // can still leave z inside [-1, 1]. So a site you had just flown past
      // reappeared as a plate on the wrong side of the screen, naming ground
      // that was no longer in front of you. In view space the camera looks
      // down -Z, so "in front" is simply a negative z and there is no divide
      // to be fooled by.
      this.projected.applyMatrix4(this.view)
      if (this.projected.z > -0.1) continue
      this.projected.applyMatrix4(camera.projectionMatrix)

      const sx = (this.projected.x * 0.5 + 0.5) * width
      const sy = (-this.projected.y * 0.5 + 0.5) * height
      // On screen means on screen. A plate is anchored to a place, so if the
      // place is not in the viewport the plate has nothing to point at.
      if (sx < 0 || sx > width || sy < 0 || sy > height) continue

      const plate = this.take(used++)
      const stars = sim.starsOf(site)
      const health = stars > 0 ? sim.garrisonHealth(site) : 0
      const fade = d < RANGE * FADE_FROM ? 1 : 1 - (d - RANGE * FADE_FROM) / (RANGE * (1 - FADE_FROM))

      const signature = `${site.name}|${stars}|${Math.round(health * 8)}`
      if (signature !== plate.signature) {
        plate.signature = signature
        plate.name.textContent = site.name
        plate.stars.textContent = stars > 0 ? '★'.repeat(stars) : ''
        // Gold at full strength, black at none. The star count is untouched by
        // this: what is being said is "how much of it is standing", not "how
        // hard it is", and conflating the two would make the rating unlearnable.
        const t = Math.max(0, Math.min(1, health))
        const r = Math.round(24 + (232 - 24) * t)
        const g = Math.round(20 + (193 - 20) * t)
        const b = Math.round(18 + (90 - 18) * t)
        plate.stars.style.color = `rgb(${r},${g},${b})`
      }

      plate.el.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`
      plate.el.style.opacity = fade.toFixed(2)
      plate.el.hidden = false
    }

    for (let i = used; i < this.pool.length; i++) this.pool[i].el.hidden = true
  }

  /** Hide everything — used while the world is rebuilding. */
  clear(): void {
    for (const p of this.pool) p.el.hidden = true
  }

  /** Plates are pooled: a hundred-odd sites must not churn the DOM every frame. */
  private take(i: number): Plate {
    let plate = this.pool[i]
    if (!plate) {
      const el = document.createElement('div')
      el.className = 'plate'
      const name = document.createElement('span')
      name.className = 'plate-name'
      const stars = document.createElement('span')
      stars.className = 'plate-stars'
      el.appendChild(name)
      el.appendChild(stars)
      this.root.appendChild(el)
      plate = { el, name, stars, signature: '' }
      this.pool[i] = plate
    }
    return plate
  }
}

export type { SiteState }
