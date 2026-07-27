import type { Keyboard } from '../game/input'
import { onTouchModeChange } from './touchMode'

/**
 * The eight headings, clockwise from north, as the movement codes each one
 * holds down. Diagonals hold two, which is what `Keyboard.axis` already expects
 * — the avatar normalises the pair, so a diagonal isn't faster than a cardinal.
 */
const OCTANT_CODES: readonly (readonly string[])[] = [
  ['KeyW'], // N
  ['KeyW', 'KeyD'], // NE
  ['KeyD'], // E
  ['KeyS', 'KeyD'], // SE
  ['KeyS'], // S
  ['KeyS', 'KeyA'], // SW
  ['KeyA'], // W
  ['KeyW', 'KeyA'], // NW
]

const NONE: readonly string[] = []

/** Which octant each of the nine grid cells is, read left-to-right, top-to-bottom. */
const CELL_OCTANT = [7, 0, 1, 6, -1, 2, 5, 4, 3]

/** Fraction of the pad's width around the centre that asserts no direction. */
const DEADZONE = 0.16

/**
 * An eight-way movement pad for touch.
 *
 * It steers by position rather than by which cell you hit: the heading is the
 * angle from the pad's centre to your thumb, snapped to eighths. So the cells
 * are a legend for what the pad does, not nine separate buttons — you can press
 * a corner to go north-east, and you can swing your thumb around the ring to
 * turn without ever lifting off, which is how you actually steer with a thumb.
 * The middle is a deadzone, so sliding back to the centre is a stop.
 *
 * It asserts movement through `Keyboard.setVirtual` instead of exposing its own
 * axis. That keeps a single movement input in the game loop and means the pad
 * needs no wiring beyond being constructed.
 *
 * Movement only — the camera is not steerable here on purpose. Orbiting is a
 * development affordance; in play the view is locked behind the avatar, so
 * there is nothing on a phone for a second control to do.
 *
 * Whether it's on screen is not its decision: it's built always and shown by
 * `is-touch` in CSS, alongside everything else that changes for a phone.
 */
export class DPad {
  readonly element: HTMLElement
  /** Indexed by octant, so the active one can be lit without a search. */
  private readonly cells: HTMLElement[] = []
  private readonly keys: Keyboard
  /** The one pointer that owns the pad; a second finger is ignored. */
  private pointerId: number | null = null
  private octant = -1
  private readonly unwatchTouchMode: () => void

  constructor(parent: HTMLElement, keys: Keyboard) {
    this.keys = keys

    this.element = document.createElement('div')
    this.element.className = 'dpad'
    for (let i = 0; i < 9; i++) {
      const octant = CELL_OCTANT[i]
      const cell = document.createElement('div')
      if (octant < 0) {
        cell.className = 'dpad-cell dpad-hub'
      } else {
        cell.className = 'dpad-cell'
        // One glyph turned to face, rather than eight different arrow
        // characters — several of the diagonal arrows have emoji presentations
        // that iOS renders in colour.
        const arrow = document.createElement('span')
        arrow.className = 'dpad-arrow'
        arrow.textContent = '▲'
        arrow.style.transform = `rotate(${octant * 45}deg)`
        cell.appendChild(arrow)
        this.cells[octant] = cell
      }
      this.element.appendChild(cell)
    }
    parent.appendChild(this.element)

    this.element.addEventListener('pointerdown', this.onPointerDown)
    this.element.addEventListener('pointermove', this.onPointerMove)
    this.element.addEventListener('pointerup', this.onPointerUp)
    this.element.addEventListener('pointercancel', this.onPointerUp)
    // Capture can be taken away (a system gesture, the tab hiding) without an
    // up ever arriving, which would leave the avatar walking forever.
    this.element.addEventListener('lostpointercapture', this.onPointerUp)

    // Being hidden mid-press would otherwise leave a direction asserted with no
    // way to lift off it, and the avatar walking on its own.
    this.unwatchTouchMode = onTouchModeChange((on) => {
      if (!on) this.release()
    })
  }

  /** Which eighth of the compass a point sits in, or -1 for the deadzone. */
  private octantAt(clientX: number, clientY: number): number {
    const r = this.element.getBoundingClientRect()
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    const dead = r.width * DEADZONE
    if (dx * dx + dy * dy < dead * dead) return -1
    // Screen Y grows downward, so negating it makes 0 point up the screen —
    // which is north, since the camera is locked north-up in play.
    const eighths = Math.atan2(dx, -dy) / (Math.PI / 4)
    return (Math.round(eighths) + 8) % 8
  }

  private setOctant(octant: number): void {
    if (octant === this.octant) return
    this.cells[this.octant]?.classList.remove('is-active')
    this.octant = octant
    this.cells[octant]?.classList.add('is-active')
    this.keys.setVirtual(octant < 0 ? NONE : OCTANT_CODES[octant])
  }

  private release(): void {
    this.pointerId = null
    this.setOctant(-1)
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.pointerId !== null) return
    this.pointerId = e.pointerId
    // Capture keeps the moves coming once the thumb wanders off the pad, so a
    // drift beyond the edge steers instead of silently stopping. It's a nicety
    // rather than the mechanism, so a browser that refuses costs steering
    // outside the pad's bounds and nothing else.
    try {
      this.element.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
    // Stops the tap becoming a text selection or a synthetic mouse click.
    e.preventDefault()
    this.setOctant(this.octantAt(e.clientX, e.clientY))
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return
    this.setOctant(this.octantAt(e.clientX, e.clientY))
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return
    this.release()
  }

  dispose(): void {
    this.release()
    this.unwatchTouchMode()
    this.element.remove()
  }
}
