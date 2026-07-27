import {
  ART_ARTIST,
  ART_HANDLE,
  ART_PATREON,
  ART_PATRONS,
  ART_THANKS_NOTE,
} from '../assets/artCredits'

/**
 * The art credit, on screen.
 *
 * Two layers, because the licence and the artist ask for different things. The
 * attribution line is always visible and never needs a click — that is the part
 * `TempArt/license.txt` actually requires, and a credit you have to go looking
 * for is not a credit. The patron list the artist asked to have carried along
 * is behind that line, because sixty names permanently over the map would be
 * the map's problem rather than the credit's.
 */
export class Credits {
  readonly element: HTMLElement
  private panel: HTMLElement
  private onKey: (e: KeyboardEvent) => void

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div')
    this.element.className = 'credits'
    this.element.innerHTML = `
      <button class="credits-line" type="button" aria-expanded="false">
        Art by <strong>${ART_ARTIST}</strong> · ${ART_HANDLE}
      </button>
      <div class="credits-panel" hidden>
        <div class="credits-head">
          <div>
            Every sprite and tile in this world is by <strong>${ART_ARTIST}</strong>.
          </div>
          <div class="credits-links">${ART_HANDLE} · ${ART_PATREON}</div>
        </div>
        <div class="credits-thanks">Special thanks to his patrons</div>
        <div class="credits-note">${ART_THANKS_NOTE}</div>
        <ul class="credits-patrons">
          ${ART_PATRONS.map((name) => `<li>${name}</li>`).join('')}
        </ul>
      </div>
    `
    parent.appendChild(this.element)

    this.panel = this.element.querySelector('.credits-panel') as HTMLElement
    const line = this.element.querySelector('.credits-line') as HTMLButtonElement
    line.addEventListener('click', () => {
      const open = this.panel.hidden
      this.panel.hidden = !open
      line.setAttribute('aria-expanded', String(open))
    })

    // Escape closes it, like anything else that covers the view. Registered on
    // the window rather than the panel so it works without the panel holding
    // focus — and it deliberately does not go through `Keyboard`, which is the
    // avatar's input and swallows keys the game drives on.
    this.onKey = (e) => {
      if (e.key !== 'Escape' || this.panel.hidden) return
      this.panel.hidden = true
      line.setAttribute('aria-expanded', 'false')
    }
    window.addEventListener('keydown', this.onKey)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey)
    this.element.remove()
  }
}
