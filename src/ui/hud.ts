import { FACTIONS } from '../game/factions'
import { RULES, Sim } from '../game/sim'
import type { Army, BuildItem, SiteState } from '../game/sim'

/**
 * Everything the player reads while playing.
 *
 * Plain DOM over the canvas rather than anything drawn in three.js. A HUD is
 * text, bars and buttons — the things the DOM is already good at, and the things
 * a 3D scene is worst at. It also means the whole interface stays crisp on a
 * high-DPI screen and reflows itself on a phone for free.
 *
 * The panel reads the sim and never writes to it: every action goes back out
 * through the callbacks in `HudHandlers`, so there is exactly one place that can
 * change the match — the sim's own command methods — and the UI cannot get the
 * game into a state the AI could not also reach.
 */

export interface HudHandlers {
  /** Order the selected army to a site. */
  onOrder: (army: Army, siteId: number) => void
  onRecall: (army: Army) => void
  onBuild: (site: SiteState, item: BuildItem) => void
  onConvert: (site: SiteState) => void
  onRestart: () => void
}

/** Which of a city's build options to offer, and whether each is available. */
const BUILD_ORDER: BuildItem[] = ['army', 'fort', 'shrine']

/**
 * The spellbook.
 *
 * Two spells, and they are the whole list by decision rather than by omission —
 * see `docs/first-playable.md` §1. Both appear on the hotbar even though they
 * are cast differently: a spell you own should be visible whether or not you can
 * use it this second, because "what can I do" is a question about the wizard and
 * not about the tile underfoot.
 *
 * `aim` is the difference between them. Fireball is *armed* by its hotkey and
 * then thrown at whatever you click, which is what stops a stray click on the
 * landscape from spending mana. Consecrate takes no target at all — it applies
 * to the ground the wizard is already standing on — so its key fires it directly.
 */
export type Spell = 'fireball' | 'consecrate'

export interface SpellDef {
  id: Spell
  name: string
  key: string
  code: string
  aim: 'target' | 'self'
  hint: string
}

export const SPELLS: SpellDef[] = [
  {
    id: 'fireball',
    name: 'Fireball',
    key: '1',
    code: 'Digit1',
    aim: 'target',
    hint: 'Click a target',
  },
  {
    id: 'consecrate',
    name: 'Consecrate',
    key: 'E',
    code: 'KeyE',
    aim: 'self',
    hint: 'Claim a cleared site',
  },
]

export class Hud {
  readonly element: HTMLElement

  /** The army awaiting a target, or -1. The map click handler reads this. */
  selectedArmy = -1
  /**
   * The spell armed and waiting for a target, or null.
   *
   * Casting is deliberately two steps — hotkey, then click. A click on the world
   * used to throw a fireball on its own, which meant every attempt to look at
   * something cost fifteen mana, and mana is the wizard's only resource.
   */
  armedSpell: Spell | null = null

  private handlers: HudHandlers
  private sim: Sim

  private hp: HTMLElement
  private mana: HTMLElement
  private hpText: HTMLElement
  private manaText: HTMLElement
  private gold: HTMLElement
  private charge: HTMLElement
  private armies: HTMLElement
  private city: HTMLElement
  private hotbar: HTMLElement
  private prompt: HTMLElement
  private toast: HTMLElement
  private end: HTMLElement

  private toastT = 0
  /** What the army list was last built from, so it is only rebuilt when it changes. */
  private armySignature = ''
  private citySignature = ''
  private rebuildT = 0

  constructor(parent: HTMLElement, sim: Sim, handlers: HudHandlers) {
    this.sim = sim
    this.handlers = handlers

    this.element = document.createElement('div')
    this.element.className = 'hud'
    this.element.innerHTML = `
      <div class="hud-charge"></div>
      <div class="hud-toast" hidden></div>
      <div class="hud-armies">
        <div class="hud-armies-head">Armies</div>
        <div class="hud-armies-list"></div>
      </div>
      <div class="hud-bottom">
        <div class="hud-prompt" hidden></div>
        <div class="hud-city" hidden></div>
        <div class="hud-hotbar"></div>
        <div class="hud-vitals">
          <div class="hud-bar hud-bar-hp"><span></span></div>
          <div class="hud-bar-label hud-hp-text"></div>
          <div class="hud-bar hud-bar-mana"><span></span></div>
          <div class="hud-bar-label hud-mana-text"></div>
          <div class="hud-gold"></div>
        </div>
      </div>
      <div class="hud-end" hidden></div>
    `
    parent.appendChild(this.element)

    const q = <T extends HTMLElement>(sel: string): T =>
      this.element.querySelector(sel) as T

    this.hp = q('.hud-bar-hp span')
    this.mana = q('.hud-bar-mana span')
    this.hpText = q('.hud-hp-text')
    this.manaText = q('.hud-mana-text')
    this.gold = q('.hud-gold')
    this.charge = q('.hud-charge')
    this.armies = q('.hud-armies-list')
    this.city = q('.hud-city')
    this.hotbar = q('.hud-hotbar')
    this.prompt = q('.hud-prompt')
    this.buildHotbar()
    this.toast = q('.hud-toast')
    this.end = q('.hud-end')
  }

  /** The hotbar's structure, built once. Only its *state* changes per frame. */
  private buildHotbar(): void {
    this.hotbar.innerHTML = SPELLS.map(
      (sp) => `
        <button class="hud-spell" type="button" data-spell="${sp.id}" title="${sp.hint}">
          <span class="hud-spell-key">${sp.key}</span>
          <span class="hud-spell-text">
            <span class="hud-spell-name">${sp.name}</span>
            <span class="hud-spell-cost"></span>
          </span>
        </button>`,
    ).join('')

    for (const node of this.hotbar.querySelectorAll('.hud-spell')) {
      const el = node as HTMLButtonElement
      el.onclick = () => this.activate(el.dataset.spell as Spell)
    }
  }

  /**
   * Press a spell. One path for the hotkey and for clicking its slot, so the two
   * can never drift apart.
   *
   * A targeted spell arms and waits; a self-aimed one goes off now. Arming also
   * clears any army waiting for orders — exactly one thing may be waiting on the
   * next click, or the click is ambiguous and the player has to guess.
   */
  activate(spell: Spell): void {
    const w = this.sim.player
    if (this.sim.winner >= 0 || w.dead) return
    const def = SPELLS.find((s) => s.id === spell)
    if (!def) return

    if (def.aim === 'target') {
      this.armedSpell = this.armedSpell === spell ? null : spell
      if (this.armedSpell) this.selectedArmy = -1
      return
    }

    const under = this.sim.siteUnder(w)
    if (under && this.sim.canConvert(w, under)) this.handlers.onConvert(under)
    else if (under && under.owner === w.faction) this.message(`${under.name} is already yours.`)
    else if (under) this.message(`${under.name} is still defended.`)
    else this.message('Stand on a cleared site to consecrate it.')
  }

  private refreshHotbar(): void {
    const sim = this.sim
    const w = sim.player
    const under = sim.siteUnder(w)

    for (const node of this.hotbar.querySelectorAll('.hud-spell')) {
      const el = node as HTMLButtonElement
      const id = el.dataset.spell as Spell
      const cost = el.querySelector('.hud-spell-cost') as HTMLElement

      if (id === 'fireball') {
        const ready = !w.dead && w.mana >= RULES.fireball.mana && w.cooldown <= 0
        el.classList.toggle('is-armed', this.armedSpell === 'fireball')
        el.classList.toggle('is-ready', ready)
        cost.textContent =
          w.cooldown > 0 ? `${w.cooldown.toFixed(1)}s` : `${RULES.fireball.mana} mana`
      } else {
        const ready = !!under && sim.canConvert(w, under)
        el.classList.toggle('is-armed', w.channelSiteId >= 0)
        el.classList.toggle('is-ready', ready)
        cost.textContent = w.channelSiteId >= 0 ? 'casting…' : ready ? under!.name : '—'
      }
    }
  }

  message(text: string): void {
    this.toast.textContent = text
    this.toast.hidden = false
    this.toastT = 4
  }

  /** True when the pointer is over a HUD control, so the map click is not ours. */
  static isHudTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.hud') !== null
  }

  update(dt: number): void {
    const sim = this.sim
    if (!sim.ready) return
    const w = sim.player

    if (this.toastT > 0) {
      this.toastT -= dt
      if (this.toastT <= 0) this.toast.hidden = true
    }

    // --- vitals ---------------------------------------------------------------
    const hpFrac = Math.max(0, w.hp) / RULES.wizard.hp
    const manaFrac = w.mana / RULES.wizard.mana
    this.hp.style.width = `${hpFrac * 100}%`
    this.mana.style.width = `${manaFrac * 100}%`
    this.hpText.textContent = w.dead
      ? `dead — ${Math.ceil(w.respawnT)}s`
      : `${Math.round(Math.max(0, w.hp))} hp`
    this.manaText.textContent = `${Math.round(w.mana)} mana`
    this.gold.textContent = `${Math.floor(w.gold)} gold`

    // --- the charge race ------------------------------------------------------
    //
    // Always visible for everybody, which is the full doc's rule and the thing
    // that makes the endgame legible: the defence against a leader is knowing
    // there is one.
    this.charge.innerHTML = sim.wizards
      .map((z) => {
        const points = sim.sites.filter((s) => s.kind === 'point' && s.owner === z.faction).length
        const colour = `#${FACTIONS[z.faction].tint.toString(16).padStart(6, '0')}`
        const name = z.isPlayer ? 'You' : FACTIONS[z.faction].name
        return `
          <div class="hud-charge-row${z.isPlayer ? ' is-you' : ''}">
            <span class="hud-charge-name" style="color:${colour}">${name}</span>
            <span class="hud-charge-bar"><span style="width:${z.charge}%;background:${colour}"></span></span>
            <span class="hud-charge-num">${z.charge.toFixed(0)}%</span>
            <span class="hud-charge-points">${points ? '◆'.repeat(points) : '·'}</span>
          </div>`
      })
      .join('')

    // --- prompts --------------------------------------------------------------
    const under = sim.siteUnder(w)
    if (w.channelSiteId >= 0) {
      const pct = (w.channelT / RULES.convert.time) * 100
      this.prompt.hidden = false
      this.prompt.innerHTML = `
        <div class="hud-channel">Consecrating…
          <span class="hud-channel-bar"><span style="width:${pct}%"></span></span>
        </div>
        <div class="hud-prompt-note">Hold still. Any hit breaks it.</div>`
    } else if (this.armedSpell) {
      const def = SPELLS.find((s) => s.id === this.armedSpell)
      this.prompt.hidden = false
      this.prompt.innerHTML = `<div class="hud-prompt-note"><b>${def?.name}</b> ready — ${def?.hint}. <kbd>Esc</kbd> to cancel.</div>`
    } else if (under && sim.canConvert(w, under)) {
      this.prompt.hidden = false
      this.prompt.innerHTML = `<div class="hud-prompt-note">${under.name} is undefended — <kbd>E</kbd> to consecrate it.</div>`
    } else if (this.selectedArmy >= 0) {
      this.prompt.hidden = false
      this.prompt.innerHTML = `<div class="hud-prompt-note">Click the map to send this army. <kbd>Esc</kbd> to cancel.</div>`
    } else {
      this.prompt.hidden = true
    }

    this.refreshHotbar()

    // Rebuilding the lists is throttled: they are the only part of the HUD that
    // replaces DOM rather than writing to it, and doing that every frame would
    // drop hover states and make the buttons feel dead under the cursor.
    this.rebuildT -= dt
    if (this.rebuildT <= 0) {
      this.rebuildT = 0.25
      this.refreshCity(under)
      this.refreshArmies()
    }

    if (sim.winner >= 0 && this.end.hidden) this.showEnd(sim.winner)
  }

  private refreshCity(under: SiteState | null): void {
    const sim = this.sim
    const w = sim.player
    const city = under && under.kind === 'city' && under.owner === w.faction ? under : null

    if (!city) {
      this.city.hidden = true
      this.citySignature = ''
      return
    }

    const q = city.queue
    const signature = [
      city.id,
      q ? `${q.item}:${Math.ceil(q.remaining)}` : 'idle',
      city.fort,
      city.shrine,
      Math.floor(w.gold / 5),
      city.army ? Sim.armyStrength(city.army).toFixed(2) : 'none',
    ].join('|')
    if (signature === this.citySignature) return
    this.citySignature = signature
    this.city.hidden = false

    if (q) {
      const pct = (1 - q.remaining / q.total) * 100
      this.city.innerHTML = `
        <div class="hud-city-name">${city.name}</div>
        <div class="hud-queue">${RULES.city.build[q.item].label}
          <span class="hud-queue-bar"><span style="width:${pct}%"></span></span>
          <span class="hud-queue-time">${Math.ceil(q.remaining)}s</span>
        </div>`
      return
    }

    const buttons = BUILD_ORDER.map((item) => {
      const spec = RULES.city.build[item]
      let label: string = spec.label
      let gold: number = spec.gold
      let disabled = false
      if (item === 'fort' && city.fort) disabled = true
      if (item === 'shrine' && city.shrine) disabled = true
      if (item === 'army' && city.army) {
        const missing = 1 - Sim.armyStrength(city.army)
        if (missing < 0.02) {
          disabled = true
          label = 'Army ready'
        } else {
          label = 'Reconstitute'
          gold = Math.max(25, Math.round(spec.gold * missing))
        }
      }
      if (w.gold < gold) disabled = true
      return `<button class="hud-build" type="button" data-item="${item}" ${
        disabled ? 'disabled' : ''
      }>${label}<span>${disabled && label !== spec.label ? '' : `${gold}g`}</span></button>`
    }).join('')

    this.city.innerHTML = `<div class="hud-city-name">${city.name}</div><div class="hud-build-row">${buttons}</div>`
    for (const btn of this.city.querySelectorAll('.hud-build')) {
      const el = btn as HTMLButtonElement
      el.onclick = () => {
        this.handlers.onBuild(city, el.dataset.item as BuildItem)
        // Force the next tick to redraw rather than wait out the throttle.
        this.citySignature = ''
        this.rebuildT = 0
      }
    }
  }

  private refreshArmies(): void {
    const sim = this.sim
    const w = sim.player
    // Sorted by distance to the wizard, which is the full doc's rule: the army
    // you are standing over is the one you are most likely to be thinking about.
    const list = sim
      .armiesOf(w.faction)
      .map((a) => ({ a, d: Math.hypot(a.ax - w.x, a.az - w.z) }))
      .sort((p, q) => p.d - q.d)

    const signature = list
      .map(({ a }) => `${a.id}:${a.order}:${Sim.alive(a).length}:${a.targetSiteId}`)
      .join(',')
    if (signature === this.armySignature) return
    this.armySignature = signature

    if (list.length === 0) {
      this.armies.innerHTML = `<div class="hud-armies-empty">No armies. Build one at a city.</div>`
      return
    }

    this.armies.innerHTML = list
      .map(({ a }) => {
        const home = sim.siteById(a.homeSiteId)
        const target = sim.siteById(a.targetSiteId)
        const strength = Sim.armyStrength(a)
        const pips = a.units
          .map(
            (u) =>
              `<i class="hud-pip${u.dead ? ' is-dead' : ''}${
                u.def.role === 'bearer' ? ' is-bearer' : ''
              }"></i>`,
          )
          .join('')
        const verb =
          a.order === 'march'
            ? `Marching → ${target?.name ?? '?'}`
            : a.order === 'camp'
              ? `Camped at ${target?.name ?? '?'}`
              : a.order === 'return'
                ? 'Marching home'
                : `Defending ${home?.name ?? 'home'}`
        // An army already sitting at home has nowhere to be recalled to.
        const atHome = a.order === 'idle'
        // The row is a div rather than a button because it now contains one, and
        // a button inside a button is invalid markup that browsers resolve by
        // dropping the inner one. `role`/`tabindex` keep it operable by keyboard.
        return `
          <div class="hud-army${a.id === this.selectedArmy ? ' is-selected' : ''}" data-army="${a.id}" role="button" tabindex="0">
            <span class="hud-army-top">
              <span class="hud-army-home">${home?.name ?? 'Army'}</span>
              <span class="hud-army-pips">${pips}</span>
            </span>
            <span class="hud-army-foot">
              <span class="hud-army-verb" title="${verb}">${verb}</span>
              <button class="hud-army-recall" type="button" ${atHome ? 'disabled' : ''}
                title="March this army back to ${home?.name ?? 'its city'}">Home</button>
            </span>
            <span class="hud-army-bar"><span style="width:${strength * 100}%"></span></span>
          </div>`
      })
      .join('')

    for (const node of this.armies.querySelectorAll('.hud-army')) {
      const el = node as HTMLElement
      const id = Number(el.dataset.army)

      const select = (e: Event) => {
        const army = sim.armyById(id)
        if (!army) return
        // Shift-click still recalls. The button is the discoverable way to do
        // it; this stays for anyone who already learned the shortcut.
        if (e instanceof MouseEvent && e.shiftKey) this.recall(army)
        else this.selectedArmy = this.selectedArmy === id ? -1 : id
        this.armySignature = ''
        this.rebuildT = 0
      }

      el.onclick = select
      el.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select(e)
        }
      }

      const recall = el.querySelector('.hud-army-recall') as HTMLButtonElement | null
      if (recall) {
        recall.onclick = (e) => {
          // Or the click also lands on the row and selects the army we just
          // sent home, leaving the map waiting for an order nobody meant to give.
          e.stopPropagation()
          const army = sim.armyById(id)
          if (army) this.recall(army)
        }
      }
    }
  }

  private recall(army: Army): void {
    this.handlers.onRecall(army)
    if (this.selectedArmy === army.id) this.selectedArmy = -1
    this.armySignature = ''
    this.rebuildT = 0
  }

  private showEnd(winner: number): void {
    const won = winner === 0
    this.end.hidden = false
    this.end.innerHTML = `
      <div class="hud-end-card">
        <div class="hud-end-title">${won ? 'The Spell of Mastery is yours' : `${FACTIONS[winner].name} has cast the Spell of Mastery`}</div>
        <div class="hud-end-note">${
          won
            ? 'You held the Points of Power long enough to finish it.'
            : 'Their charge reached 100% before anyone could take their points.'
        }</div>
        <button class="hud-action" type="button">New world</button>
      </div>`
    const btn = this.end.querySelector('.hud-action') as HTMLButtonElement
    btn.onclick = () => {
      this.end.hidden = true
      this.handlers.onRestart()
    }
  }

  /** Wipe transient state when a new match starts on a new island. */
  reset(): void {
    this.selectedArmy = -1
    this.armedSpell = null
    this.armySignature = ''
    this.citySignature = ''
    this.end.hidden = true
    this.toast.hidden = true
  }
}
