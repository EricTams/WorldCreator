export interface MenuHandlers {
  onResume: () => void
  onExitToMenu: () => void
  onNewGame: () => void
  onAttract: () => void
}

/** Which card is up, or null when the menu is closed. */
export type MenuFace = 'pause' | 'main' | null

/**
 * The pause card and the main menu.
 *
 * Built like the end-of-match card in `hud.ts` — a full-screen scrim with one
 * centred panel — because they are the same object as far as the player is
 * concerned: the world stops, and a short list of things to do next appears over
 * it. Sharing the look means the game only ever teaches one "everything has
 * paused" signal.
 *
 * Unlike the HUD this *does* catch the pointer across the whole screen. That is
 * the point: while a card is up, no click can reach the map behind it, so
 * nothing can be ordered, cast or selected by aiming at a hole in the menu.
 */
export class Menu {
  readonly element: HTMLElement
  private readonly handlers: MenuHandlers
  private face: MenuFace = null

  constructor(parent: HTMLElement, handlers: MenuHandlers) {
    this.handlers = handlers
    this.element = document.createElement('div')
    this.element.className = 'menu'
    this.element.hidden = true
    parent.appendChild(this.element)
  }

  get open(): MenuFace {
    return this.face
  }

  showPause(): void {
    this.face = 'pause'
    this.element.hidden = false
    this.element.innerHTML = `
      <div class="menu-card">
        <div class="menu-title">Paused</div>
        <div class="menu-note">The island is holding its breath.</div>
        <button class="hud-action" type="button" data-act="resume">Resume</button>
        <button class="hud-action" type="button" data-act="exit">Exit to Main Menu</button>
      </div>`
    this.bind()
  }

  showMain(): void {
    this.face = 'main'
    this.element.hidden = false
    this.element.innerHTML = `
      <div class="menu-card">
        <div class="menu-title">Wizard RTS</div>
        <div class="menu-note">
          Take the Points of Power and cast the Spell of Mastery before the other two do —
          or sit back and watch someone else try.
        </div>
        <button class="hud-action" type="button" data-act="new">New Game</button>
        <button class="hud-action" type="button" data-act="attract">Attract Mode</button>
      </div>`
    this.bind()
  }

  hide(): void {
    this.face = null
    this.element.hidden = true
    this.element.innerHTML = ''
  }

  private bind(): void {
    // Wired by data-act rather than by position, so reordering the buttons in a
    // card cannot quietly swap what they do.
    for (const btn of this.element.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
      const act = btn.dataset.act
      btn.onclick = () => {
        if (act === 'resume') this.handlers.onResume()
        else if (act === 'exit') this.handlers.onExitToMenu()
        else if (act === 'new') this.handlers.onNewGame()
        else if (act === 'attract') this.handlers.onAttract()
      }
    }
  }
}
