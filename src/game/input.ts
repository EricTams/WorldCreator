/**
 * Keyboard state as a polled set rather than events, because movement needs to
 * ask "is W held right now" once per frame, not react to keypresses.
 */
export class Keyboard {
  private held = new Set<string>()
  private onKeyDown: (e: KeyboardEvent) => void
  private onKeyUp: (e: KeyboardEvent) => void
  private onBlur: () => void

  /** Codes we swallow so the page doesn't scroll while you're driving. */
  private static readonly SWALLOW = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Space',
  ])

  constructor() {
    this.onKeyDown = (e) => {
      // The seed field and lil-gui's number inputs are real text inputs —
      // typing "was" in there must not drive the avatar across the map.
      if (Keyboard.isTypingTarget(document.activeElement)) return
      this.held.add(e.code)
      if (Keyboard.SWALLOW.has(e.code)) e.preventDefault()
    }
    this.onKeyUp = (e) => {
      this.held.delete(e.code)
    }
    // Losing focus mid-keypress otherwise leaves the key stuck down forever.
    this.onBlur = () => this.held.clear()

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
    return this.held.has(code)
  }

  /** 1 if `pos` is held, -1 if `neg` is held, 0 if neither or both. */
  axis(neg: string, pos: string): number {
    return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.held.clear()
  }
}
