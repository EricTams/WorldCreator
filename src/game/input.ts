/**
 * Keyboard state as a polled set rather than events, because movement needs to
 * ask "is W held right now" once per frame, not react to keypresses.
 */
export class Keyboard {
  private held = new Set<string>()
  /**
   * Keys that went down this frame and haven't been acted on yet.
   *
   * Separate from `held` because one-shot actions want the *edge*, not the
   * state: holding C should reset the view once, not on every frame for as long
   * as your finger is down.
   */
  private pressed = new Set<string>()
  /**
   * Codes an on-screen control is holding down.
   *
   * Kept apart from `held` rather than written into it so the two can't corrupt
   * each other: a keyup for W must not cancel a thumb that is still on the pad's
   * north cell, and the pad can replace its whole direction on every move
   * without remembering what it asserted last frame.
   */
  private virtual = new Set<string>()
  private onKeyDown: (e: KeyboardEvent) => void
  private onKeyUp: (e: KeyboardEvent) => void
  private onBlur: () => void

  /** Codes we swallow so the page doesn't scroll while you're driving. */
  private static readonly SWALLOW = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ])

  constructor() {
    this.onKeyDown = (e) => {
      // The seed field and lil-gui's number inputs are real text inputs —
      // typing "was" in there must not drive the avatar across the map.
      if (Keyboard.isTypingTarget(document.activeElement)) return
      this.held.add(e.code)
      // `repeat` filters the auto-repeat stream, and the modifier check keeps
      // browser shortcuts out: Cmd+C is copy, and it must not also be a game
      // binding just because the C key was involved.
      if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        this.pressed.add(e.code)
      }
      if (Keyboard.SWALLOW.has(e.code)) e.preventDefault()
    }
    this.onKeyUp = (e) => {
      this.held.delete(e.code)
    }
    // Losing focus mid-keypress otherwise leaves the key stuck down forever.
    // The pad is cleared too: backgrounding the page with a thumb down should
    // stop the avatar, not leave it walking off on its own. The pad re-asserts
    // itself on the next move, so this heals rather than sticks.
    this.onBlur = () => {
      this.held.clear()
      this.pressed.clear()
      this.virtual.clear()
    }

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  private static isTypingTarget(el: Element | null): boolean {
    if (!el) return false
    const tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  }

  isDown(code: string): boolean {
    return this.held.has(code) || this.virtual.has(code)
  }

  /**
   * Replace the set of codes an on-screen control is holding down.
   *
   * The d-pad steers by asserting the same movement codes a keyboard does — a
   * diagonal is "north and east at once" there as it is here — so the avatar
   * keeps reading exactly one movement input and never has to know which of the
   * two the player used.
   */
  setVirtual(codes: readonly string[]): void {
    this.virtual.clear()
    for (const code of codes) this.virtual.add(code)
  }

  /** 1 if `pos` is held, -1 if `neg` is held, 0 if neither or both. */
  axis(neg: string, pos: string): number {
    return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0)
  }

  /** True once per physical press of `code`, then false until it's pressed again. */
  consumePress(code: string): boolean {
    return this.pressed.delete(code)
  }

  /**
   * Drop any presses nobody claimed. Call once per frame, after every
   * `consumePress`, so an unbound key can't sit in the set and fire the day
   * someone binds it.
   */
  endFrame(): void {
    if (this.pressed.size > 0) this.pressed.clear()
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.held.clear()
    this.pressed.clear()
    this.virtual.clear()
  }
}
