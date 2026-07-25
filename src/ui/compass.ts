import * as THREE from 'three'
import { bearingFromNorth } from '../game/avatar'

/**
 * A corner compass.
 *
 * WASD moves in fixed world directions, so once you've orbited the camera the
 * only thing tying the keys to the screen is knowing which way north is now
 * pointing. This rotates with the camera to show that.
 */
export class Compass {
  readonly element: HTMLElement
  private rose: HTMLElement
  private settling = false
  private readonly dir = new THREE.Vector3()

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div')
    this.element.className = 'compass'
    this.element.innerHTML = `
      <div class="compass-rose">
        <div class="compass-needle"></div>
        <div class="compass-label compass-n">N</div>
        <div class="compass-label compass-e">E</div>
        <div class="compass-label compass-s">S</div>
        <div class="compass-label compass-w">W</div>
      </div>
      <div class="compass-keys">WASD</div>
    `
    parent.appendChild(this.element)
    this.rose = this.element.querySelector('.compass-rose') as HTMLElement
  }

  update(camera: THREE.Camera, settling = false): void {
    camera.getWorldDirection(this.dir)
    // Screen-up in the rose should be the direction the camera faces, so the
    // rose counter-rotates by the camera's bearing.
    const bearing = bearingFromNorth(this.dir.x, this.dir.z)
    this.rose.style.transform = `rotate(${-bearing}rad)`

    // Highlight while the camera is easing itself back to north — otherwise
    // the view drifting on its own reads as a bug rather than a feature.
    if (settling !== this.settling) {
      this.settling = settling
      this.element.classList.toggle('is-settling', settling)
    }
  }

  dispose(): void {
    this.element.remove()
  }
}
