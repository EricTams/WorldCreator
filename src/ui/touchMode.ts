/**
 * Whether we're presenting the game to a thumb rather than to a workstation.
 *
 * One flag, published as `is-touch` on the body, because the difference is not
 * only "add a d-pad" — it's a different product. On a desktop this is a tool
 * for building a world, with a parameter panel and a stats readout; on a phone
 * it's a game you walk around in, and every one of those affordances is either
 * unusable or noise. So the whole HUD keys off this rather than each piece
 * sniffing at the pointer type on its own.
 *
 * The attribution line is the deliberate exception and stays in both: the art
 * licence asks for credit on screen, and a small screen is still a screen.
 */

const listeners = new Set<(on: boolean) => void>()
let touch = false

export function isTouchMode(): boolean {
  return touch
}

/** Turn phone presentation on or off — how you preview it from a desktop. */
export function setTouchMode(on: boolean): void {
  if (on === touch) return
  touch = on
  document.body.classList.toggle('is-touch', on)
  for (const fn of listeners) fn(on)
}

export function onTouchModeChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Watch for evidence of a touchscreen and switch over when it turns up.
 *
 * A pointing device that reports itself as coarse is the reliable signal and
 * settles it before the first frame. It isn't sufficient on its own, though —
 * a laptop with a touchscreen reports fine — so an actual touch anywhere is
 * taken as the answer too. Deliberately one-way: having decided there's a thumb
 * involved we don't switch back because a mouse was later waggled, since the
 * layout jumping mid-play is worse than a slightly wrong guess.
 */
export function startTouchDetection(): void {
  const coarse = window.matchMedia?.('(pointer: coarse)') ?? null
  if (coarse?.matches) setTouchMode(true)
  coarse?.addEventListener('change', () => {
    if (coarse.matches) setTouchMode(true)
  })
  window.addEventListener('touchstart', () => setTouchMode(true), {
    once: true,
    passive: true,
  })
}
