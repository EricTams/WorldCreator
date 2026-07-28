import type { TerrainFrame } from '../world/terrainQuery'
import { terrainHeightAt } from '../world/terrainQuery'
import type { MapPlan, MapSite, Owner } from '../world/gameMap'
import { NOBODY } from '../world/gameMap'
import { ANIM_FPS, ARCHETYPE, FACTIONS, GARRISONS, NEUTRAL_TINT, UNIT_ANIM } from './factions'
import type { AnimName, UnitDef } from './factions'
import type { BoardLayer } from '../render/boardLayer'
import type { Banners } from '../render/banners'
import type { SpriteKey, UnitKey } from '../render/spriteAtlas'

/**
 * The match.
 *
 * Everything with a clock on it lives here: wizards, armies, garrisons, city
 * queues, gold, and the charge race that ends the game. It owns no three.js
 * objects and does no rendering — `draw` pushes cards into whichever layer it is
 * handed, and the HUD reads the same public state the AI does. That split is
 * what lets the whole match be reasoned about (and, later, replayed or tested)
 * without a canvas.
 *
 * The one thing it does *not* own is the player's own position: that is the
 * avatar, driven by the player's hands, and the sim reads it each tick. A
 * simulation that also moved the player would be fighting the input for control
 * of the same variable.
 */

// --- tuning ------------------------------------------------------------------

/**
 * Every number the match is played on, in one table.
 *
 * This is `docs/first-playable.md` §10. Kept together deliberately: these are
 * first-tuning values chosen to be *consistent* rather than correct, and they
 * are meaningless individually — fireball damage only means something against
 * the unit HP it is aimed at, and mana regen only means something against the
 * fireball cost. Tuning is editing this block, not hunting through the systems.
 */
export const RULES = {
  wizard: {
    hp: 100,
    /** HP per second, inside friendly territory only. */
    regen: 3,
    respawn: 15,
    mana: 100,
    manaRegen: 2,
    /** Extra mana regen per shrine held, and per Point of Power held. */
    manaPerShrine: 1,
    manaPerPoint: 3,
    sprint: 1.5,
    sprintDrain: 4,
  },
  fireball: {
    mana: 15,
    cooldown: 1.5,
    damage: 30,
    radius: 6,
    speed: 25,
  },
  /**
   * How far the wizard can reach with anything, in world units.
   *
   * One number for the whole spellbook rather than one per spell: the wizard's
   * reach is a property of the wizard, and two spells with two different ranges
   * would need two different indicators drawn around them.
   *
   * About twice the height the carpet rides at, which is what makes it legible
   * on screen — the wizard's own hover is the only length the player has an
   * intuition for. Written as a distance rather than derived from `hover`,
   * deliberately: tuning the ride height is a look change, and it must not
   * silently retune what the wizard can hit.
   */
  castRange: 15,
  convert: {
    /** Seconds of channel. The wizard is grounded and any hit interrupts. */
    time: 10,
  },
  army: {
    /** March speed. The wizard's 17 m/s is a little over four times this. */
    march: 4,
    /**
     * How far from its anchor a unit will chase before breaking off.
     *
     * Small, so an army stays a body rather than dissolving into a skirmish
     * line spread over a hundred units. It is the reason a fight is one thing
     * you can look at instead of six duels in different postcodes.
     */
    leash: 22,
    /**
     * How far a unit looks for something to fight.
     *
     * The single most important number for how combat *reads*. At 90 an army
     * and a garrison locked on to each other from two town-widths apart — well
     * outside the frame at the follow camera — so battles began and often ended
     * without ever being on screen. At 32 the two sides have to be close enough
     * that the player watching their wizard can see both.
     *
     * Comfortably above the 16-unit ranged reach, so archers still open fire as
     * they close rather than walking into contact first.
     */
    aggro: 32,
  },
  city: {
    income: 10 / 60,
    /** Cost, seconds, of each queue item. */
    build: {
      army: { gold: 100, time: 60, label: 'Train Army' },
      fort: { gold: 150, time: 90, label: 'Fort' },
      shrine: { gold: 100, time: 60, label: 'Shrine' },
    },
  },
  mine: { income: 15 / 60 },
  startingGold: 150,
  /** Seconds for a cleared neutral garrison to come back. */
  garrisonRegen: 300,
  /** Seconds for a held Point of Power to regrow its guard for its owner. */
  pointRegen: 180,
  /** Charge percent per second, per held point: 1% per 12 s. */
  chargePerPoint: 1 / 12,
} as const

export type BuildItem = keyof typeof RULES.city.build

// --- entities ----------------------------------------------------------------

export interface SimUnit {
  id: number
  def: UnitDef
  owner: Owner
  x: number
  z: number
  hp: number
  anim: AnimName
  animT: number
  /** Facing, for the horizontal sprite mirror. */
  flip: boolean
  /** Counts down after a hit; drives the damage flash and the hurt row. */
  hurtT: number
  /** Counts up once dead, so the death row plays before the unit is removed. */
  deadT: number
  dead: boolean
  /** Garrison home, or -1 for an army unit. */
  siteId: number
  armyId: number
  /** A fort tower: drawn from the board atlas, and it never moves. */
  tower: boolean
  target: SimUnit | null
  targetWizard: Wizard | null
}

export type ArmyOrder = 'idle' | 'march' | 'camp' | 'return'

export interface Army {
  id: number
  owner: Owner
  homeSiteId: number
  units: SimUnit[]
  order: ArmyOrder
  targetSiteId: number
  /** The point the army is walking to; its units keep formation around it. */
  ax: number
  az: number
  /** True while any of its units is in contact — the anchor stops to let it fight. */
  fighting: boolean
}

export interface SiteState extends MapSite {
  defenders: SimUnit[]
  /** Counts up while cleared and unclaimed, until the garrison comes back. */
  regenT: number
  /** Cities only. */
  fort: boolean
  shrine: boolean
  queue: { item: BuildItem; remaining: number; total: number } | null
  army: Army | null
  /** Set once a fort's towers are down and want rebuilding for the owner. */
  towerT: number
}

export interface Wizard {
  faction: number
  isPlayer: boolean
  x: number
  z: number
  /** World Y, for drawing and for the blast's origin. */
  y: number
  hp: number
  mana: number
  gold: number
  /** 0..100. At 100 the match is over. */
  charge: number
  dead: boolean
  respawnT: number
  cooldown: number
  /** The site being consecrated, and how far through the channel it is. */
  channelSiteId: number
  channelT: number
  /** AI only: where it is flying, and when it next thinks. */
  goalX: number
  goalZ: number
  thinkT: number
}

export interface Projectile {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  owner: Owner
  life: number
}

export interface Blast {
  x: number
  y: number
  z: number
  age: number
  radius: number
}

export interface Pickup {
  x: number
  z: number
  gold: number
}

export interface SimOptions {
  /** Put the avatar somewhere — respawn is the sim moving the player. */
  onRespawn: (x: number, z: number) => void
  onMessage: (text: string) => void
}

/**
 * Where each unit stands relative to its army's anchor.
 *
 * Tight — the whole formation is about twelve units across. It was twice this,
 * which spread six figures over a span wider than the engagement range itself,
 * so an "army" read as scattered individuals wandering the same field. A clump
 * reads as a body of troops, and it means the fireball that lands in the middle
 * of one is worth throwing.
 */
const FORMATION: [number, number][] = [
  [0, 0],
  [3.5, 2],
  [-3.5, 2],
  [3.5, -2],
  [-3.5, -2],
  [0, 4],
  [0, -4],
  [6.5, 0],
  [-6.5, 0],
]

/** Two towers, either side of the pad. */
const TOWER_OFFSETS: [number, number][] = [
  [-0.55, -0.35],
  [0.55, -0.35],
]

export class Sim {
  sites: SiteState[] = []
  wizards: Wizard[] = []
  armies: Army[] = []
  units: SimUnit[] = []
  projectiles: Projectile[] = []
  blasts: Blast[] = []
  pickups: Pickup[] = []

  /** Faction index of the winner, or -1 while the match is live. */
  winner = -1
  /** Wall-clock seconds since the match began. */
  elapsed = 0
  ready = false

  private opts: SimOptions
  private nextUnitId = 1
  private nextArmyId = 1
  private slowT = 0
  /** Site ids with something hostile nearby, refreshed on the slow tick. */
  private hot = new Set<number>()

  constructor(opts: SimOptions) {
    this.opts = opts
  }

  get player(): Wizard {
    return this.wizards[0]
  }

  siteById(id: number): SiteState | undefined {
    return this.sites.find((s) => s.id === id)
  }

  armyById(id: number): Army | undefined {
    return this.armies.find((a) => a.id === id)
  }

  // --- setup -----------------------------------------------------------------

  /**
   * Start a fresh match on a freshly planned board.
   *
   * Called from the same place the terrain is rebuilt, because everything here
   * is positioned against ground that has just moved. Regenerating the island
   * ends the match in progress, which is the honest behaviour — the map it was
   * being played on no longer exists.
   */
  reset(plan: MapPlan): void {
    this.sites = plan.sites.map((s) => ({
      ...s,
      defenders: [],
      regenT: 0,
      fort: false,
      shrine: false,
      queue: null,
      army: null,
      towerT: 0,
    }))
    this.units = []
    this.armies = []
    this.projectiles = []
    this.blasts = []
    this.pickups = []
    this.nextUnitId = 1
    this.nextArmyId = 1
    this.winner = -1
    this.elapsed = 0
    this.hot.clear()

    this.wizards = FACTIONS.map((_, f) => {
      const capital = this.siteById(plan.capitals[f])
      return {
        faction: f,
        isPlayer: f === 0,
        x: capital?.x ?? 0,
        z: capital?.z ?? 0,
        y: 0,
        hp: RULES.wizard.hp,
        mana: RULES.wizard.mana,
        gold: RULES.startingGold,
        charge: 0,
        dead: false,
        respawnT: 0,
        cooldown: 0,
        channelSiteId: -1,
        channelT: 0,
        goalX: capital?.x ?? 0,
        goalZ: capital?.z ?? 0,
        thinkT: f * 0.7,
      }
    })

    for (const site of this.sites) {
      if (site.garrison) this.spawnGarrison(site)
    }
    this.ready = true
  }

  private spawnUnit(def: UnitDef, owner: Owner, x: number, z: number): SimUnit {
    const u: SimUnit = {
      id: this.nextUnitId++,
      def,
      owner,
      x,
      z,
      hp: def.hp,
      anim: 'idle',
      // Staggered so a garrison does not breathe in lockstep, which reads as one
      // animated object rather than six creatures.
      animT: (this.nextUnitId % 7) * 0.13,
      flip: false,
      hurtT: 0,
      deadT: 0,
      dead: false,
      siteId: -1,
      armyId: -1,
      tower: false,
      target: null,
      targetWizard: null,
    }
    this.units.push(u)
    return u
  }

  private spawnGarrison(site: SiteState): void {
    const table = GARRISONS[site.garrison ?? 'town']
    if (!table) return
    table.forEach((def, i) => {
      const [ox, oz] = FORMATION[i % FORMATION.length]
      const u = this.spawnUnit(def, site.owner, site.x + ox, site.z + oz)
      u.siteId = site.id
      site.defenders.push(u)
    })
  }

  private spawnTowers(site: SiteState): void {
    for (const [ox, oz] of TOWER_OFFSETS) {
      const u = this.spawnUnit(
        { ...ARCHETYPE.tower, sprite: 'unit.castle.pikeman' as UnitKey, name: 'Tower' },
        site.owner,
        site.x + ox * site.radius,
        site.z + oz * site.radius,
      )
      u.siteId = site.id
      u.tower = true
      site.defenders.push(u)
    }
  }

  // --- queries ---------------------------------------------------------------

  /** Nothing left alive defending it. The precondition for consecrating. */
  isCleared(site: SiteState): boolean {
    return site.defenders.every((u) => u.dead)
  }

  /** Can this wizard start a consecration here, right now? */
  canConvert(w: Wizard, site: SiteState): boolean {
    if (site.kind === 'lair') return false
    if (site.owner === w.faction) return false
    if (!this.isCleared(site)) return false
    // The same reach as any other spell. It used to be the site's own pad
    // radius, which meant a wizard could consecrate a city from 48 units out —
    // further than it can throw a fireball, and far enough that "claiming" did
    // not require standing on the thing being claimed.
    return this.inCastRange(w, site.x, site.z)
  }

  /** The site a wizard is standing on, if any. */
  siteUnder(w: Wizard): SiteState | null {
    for (const s of this.sites) {
      if (Math.hypot(w.x - s.x, w.z - s.z) <= s.radius) return s
    }
    return null
  }

  sitesOf(faction: number): SiteState[] {
    return this.sites.filter((s) => s.owner === faction)
  }

  armiesOf(faction: number): Army[] {
    return this.armies.filter((a) => a.owner === faction)
  }

  /** Living units in an army — the thing every strength reading is taken from. */
  static alive(army: Army): SimUnit[] {
    return army.units.filter((u) => !u.dead)
  }

  static armyStrength(army: Army): number {
    let hp = 0
    let max = 0
    for (const u of army.units) {
      hp += Math.max(0, u.hp)
      max += u.def.hp
    }
    return max > 0 ? hp / max : 0
  }

  // --- player commands -------------------------------------------------------

  /**
   * Throw a fireball at a ground point.
   *
   * Returns false when it could not be cast, so the HUD can say why rather than
   * the click silently doing nothing — the single most common reason a player
   * thinks a game is broken.
   */
  castFireball(w: Wizard, tx: number, tz: number, ty: number): boolean {
    if (w.dead || w.cooldown > 0) return false
    if (w.mana < RULES.fireball.mana) return false
    if (!this.inCastRange(w, tx, tz)) return false
    // Casting breaks the consecration — it is a channel, not a stance.
    if (w.channelSiteId >= 0) this.cancelChannel(w)

    w.mana -= RULES.fireball.mana
    w.cooldown = RULES.fireball.cooldown

    const dx = tx - w.x
    const dy = ty - w.y
    const dz = tz - w.z
    const d = Math.max(1e-3, Math.hypot(dx, dy, dz))
    const s = RULES.fireball.speed
    this.projectiles.push({
      x: w.x,
      y: w.y,
      z: w.z,
      vx: (dx / d) * s,
      vy: (dy / d) * s,
      vz: (dz / d) * s,
      owner: w.faction,
      // Generous: a shot at the horizon should fizzle rather than fly forever.
      life: Math.min(6, d / s + 0.4),
    })
    return true
  }

  /**
   * Is that point close enough to reach? Public so the HUD can say why not, and
   * so the range indicator drawn on the ground is drawn from the same rule that
   * enforces it rather than from a second copy of the number.
   */
  inCastRange(w: Wizard, tx: number, tz: number): boolean {
    return Math.hypot(tx - w.x, tz - w.z) <= RULES.castRange
  }

  /**
   * Start consecrating, or carry on if already at it.
   *
   * Idempotent, and it has to be: this is called from the AI's decision tick
   * every 1.5 seconds and from the player's key on every press, and an
   * unconditional `channelT = 0` meant the ten-second channel was restarted
   * before it could ever finish. The AI stood on a cleared mine for fourteen
   * minutes doing exactly that, and a player leaning on E would have done the
   * same to themselves.
   */
  beginConvert(w: Wizard, site: SiteState): boolean {
    if (w.channelSiteId === site.id) return true
    if (!this.canConvert(w, site)) return false
    w.channelSiteId = site.id
    w.channelT = 0
    return true
  }

  cancelChannel(w: Wizard): void {
    w.channelSiteId = -1
    w.channelT = 0
  }

  /** Send an army at a site. The only order that exists, besides Recall. */
  orderArmy(army: Army, siteId: number): void {
    army.targetSiteId = siteId
    army.order = 'march'
  }

  recallArmy(army: Army): void {
    army.targetSiteId = -1
    army.order = 'return'
  }

  /**
   * Put something in a city's queue.
   *
   * Gold is taken at commission rather than on completion, so a queued item can
   * never fail at the last second because the wizard spent the money elsewhere —
   * and so the cost is visible at the moment the choice is made.
   */
  queueBuild(site: SiteState, item: BuildItem): boolean {
    if (site.kind !== 'city' || site.owner < 0 || site.queue) return false
    const w = this.wizards[site.owner]
    const spec = RULES.city.build[item]
    if (item === 'fort' && site.fort) return false
    if (item === 'shrine' && site.shrine) return false

    // Widened deliberately: `RULES` is `as const` so the table reads as data
    // rather than as something a system can quietly reassign, which makes every
    // number in it a literal type. These two are about to be scaled.
    let gold: number = spec.gold
    let time: number = spec.time
    if (item === 'army' && site.army) {
      // Reconstituting costs what was lost, not what a new army costs. An army
      // that walked home with one casualty should not be worth razing and
      // rebuilding, which a flat price would make it.
      const missing = 1 - Sim.armyStrength(site.army)
      if (missing < 0.02) return false
      gold = Math.max(25, Math.round(spec.gold * missing))
      time = Math.max(15, Math.round(spec.time * missing))
    }
    if (w.gold < gold) return false

    w.gold -= gold
    site.queue = { item, remaining: time, total: time }
    return true
  }

  // --- the tick --------------------------------------------------------------

  update(dt: number, frame: TerrainFrame, playerX: number, playerZ: number, playerY: number): void {
    if (!this.ready || this.winner >= 0) return
    this.elapsed += dt

    // The player's wizard *is* the avatar. Everything downstream — targeting,
    // fog, whether a consecration is interrupted — reads this position, so it is
    // copied in before anything else looks at it.
    const p = this.player
    if (!p.dead) {
      p.x = playerX
      p.z = playerZ
      p.y = playerY
    }

    this.slowT -= dt
    const slow = this.slowT <= 0
    if (slow) {
      this.slowT = 0.25
      this.markHotSites()
    }

    this.updateWizards(dt, frame)
    this.updateEconomy(dt)
    this.updateProjectiles(dt, frame)
    this.updateArmies(dt)
    this.updateUnits(dt, slow)
    this.updateSites(dt)
    this.updateVictory(dt)
  }

  /**
   * Which garrisons need to think this tick.
   *
   * A hundred and fifty creatures each scanning for a target every frame is
   * most of the sim's cost and nearly all of it is wasted: a garrison on the far
   * side of the island has nothing to look at. So the scan happens four times a
   * second against wizards and army anchors only, and a site with nothing near
   * it skips targeting entirely until something arrives.
   */
  private markHotSites(): void {
    this.hot.clear()
    // Comfortably outside the engagement range, so a garrison is awake and
    // walking before anything can reach it, but far tighter than it was — this
    // is the check that keeps a hundred and thirty idle creatures from scanning
    // for targets they cannot see.
    const NEAR = 150
    for (const site of this.sites) {
      let hot = false
      for (const w of this.wizards) {
        if (w.dead || w.faction === site.owner) continue
        if (Math.hypot(w.x - site.x, w.z - site.z) < NEAR) hot = true
      }
      if (!hot) {
        for (const a of this.armies) {
          if (a.owner === site.owner) continue
          if (Sim.alive(a).length === 0) continue
          if (Math.hypot(a.ax - site.x, a.az - site.z) < NEAR) hot = true
        }
      }
      if (hot) this.hot.add(site.id)
    }
  }

  private updateWizards(dt: number, frame: TerrainFrame): void {
    for (const w of this.wizards) {
      if (w.cooldown > 0) w.cooldown -= dt

      if (w.dead) {
        w.respawnT -= dt
        if (w.respawnT <= 0) this.respawn(w)
        continue
      }

      // Mana. Base regen plus what the wizard's holdings supply — the reason to
      // build a shrine and the reason to hold a point, expressed as the same
      // number so the two are directly comparable.
      let regen = RULES.wizard.manaRegen
      for (const s of this.sites) {
        if (s.owner !== w.faction) continue
        if (s.kind === 'city' && s.shrine) regen += RULES.wizard.manaPerShrine
        if (s.kind === 'point') regen += RULES.wizard.manaPerPoint
      }
      w.mana = Math.min(RULES.wizard.mana, w.mana + regen * dt)

      // Health, but only at home. No healing in neutral or enemy ground is what
      // makes a deep raid a commitment rather than a stroll.
      if (this.inFriendlyTerritory(w)) {
        w.hp = Math.min(RULES.wizard.hp, w.hp + RULES.wizard.regen * dt)
      }

      // Consecration.
      if (w.channelSiteId >= 0) {
        const site = this.siteById(w.channelSiteId)
        if (!site || !this.canConvert(w, site)) {
          this.cancelChannel(w)
        } else if (!this.inCastRange(w, site.x, site.z)) {
          // Walked off the pad. Movement cancels — the wizard is grounded for the
          // duration and this is what enforces it for the player, who is driving
          // the avatar directly and cannot be frozen in place without the input
          // fighting back.
          this.cancelChannel(w)
          if (w.isPlayer) this.opts.onMessage('Consecration broken — you left the site.')
        } else {
          w.channelT += dt
          if (w.channelT >= RULES.convert.time) this.claim(site, w)
        }
      }

      // Loot lying on cleared lairs. Collected by flying over it, which is the
      // cheapest possible reason to put the wizard where the fighting was.
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const g = this.pickups[i]
        if (Math.hypot(w.x - g.x, w.z - g.z) > 22) continue
        w.gold += g.gold
        this.pickups.splice(i, 1)
        if (w.isPlayer) this.opts.onMessage(`Recovered ${g.gold} gold.`)
      }

      if (!w.isPlayer) this.flyAi(w, dt, frame)
    }
  }

  private inFriendlyTerritory(w: Wizard): boolean {
    for (const s of this.sites) {
      if (s.owner !== w.faction) continue
      if (Math.hypot(w.x - s.x, w.z - s.z) < 150) return true
    }
    return false
  }

  private respawn(w: Wizard): void {
    const owned = this.sitesOf(w.faction).filter((s) => s.kind === 'city')
    // Nearest owned city to where it fell. A wizard with nothing left respawns
    // at its capital's coordinates anyway — losing every city is a losing
    // position, not a soft-lock.
    let best = owned[0] ?? null
    let bestD = Infinity
    for (const s of owned) {
      const d = Math.hypot(s.x - w.x, s.z - w.z)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    w.dead = false
    w.hp = RULES.wizard.hp
    w.mana = Math.max(w.mana, RULES.wizard.mana * 0.5)
    if (best) {
      w.x = best.x
      w.z = best.z
      w.goalX = best.x
      w.goalZ = best.z
    }
    if (w.isPlayer) {
      this.opts.onRespawn(w.x, w.z)
      this.opts.onMessage('You return to the world.')
    }
  }

  private killWizard(w: Wizard): void {
    w.dead = true
    w.hp = 0
    w.respawnT = RULES.wizard.respawn
    this.cancelChannel(w)
    if (w.isPlayer) this.opts.onMessage('You have fallen. Returning in 15 seconds…')
  }

  private damageWizard(w: Wizard, amount: number): void {
    if (w.dead) return
    w.hp -= amount
    // Any hit at all breaks a consecration. A damage *threshold* was the full
    // doc's proposal; a flat interrupt is simpler and, more importantly, legible
    // — the bar stops the instant something touches you.
    if (w.channelSiteId >= 0) {
      this.cancelChannel(w)
      if (w.isPlayer) this.opts.onMessage('Consecration broken — you were struck.')
    }
    if (w.hp <= 0) this.killWizard(w)
  }

  private updateEconomy(dt: number): void {
    for (const s of this.sites) {
      if (s.owner < 0) continue
      const w = this.wizards[s.owner]
      if (s.kind === 'city') w.gold += RULES.city.income * dt
      else if (s.kind === 'mine') w.gold += RULES.mine.income * dt

      if (s.kind !== 'city' || !s.queue) continue
      s.queue.remaining -= dt
      if (s.queue.remaining > 0) continue

      const item = s.queue.item
      s.queue = null
      if (item === 'shrine') s.shrine = true
      else if (item === 'fort') {
        s.fort = true
        this.spawnTowers(s)
      } else this.trainArmy(s)
      if (s.owner === 0) {
        this.opts.onMessage(`${s.name}: ${RULES.city.build[item].label} complete.`)
      }
    }
  }

  private trainArmy(site: SiteState): void {
    const roster = FACTIONS[site.owner].roster
    const wanted: UnitDef[] = [
      roster.foot,
      roster.foot,
      roster.foot,
      roster.ranged,
      roster.fast,
      roster.bearer,
    ]

    if (!site.army) {
      const army: Army = {
        id: this.nextArmyId++,
        owner: site.owner,
        homeSiteId: site.id,
        units: [],
        order: 'idle',
        targetSiteId: -1,
        ax: site.x,
        az: site.z,
        fighting: false,
      }
      this.armies.push(army)
      site.army = army
    }

    const army = site.army
    army.owner = site.owner
    // Reconstitute: heal what survived, replace what did not. Same call whether
    // this is a new army or a rebuilt one, so there is only one place that knows
    // what an army is made of.
    const survivors = Sim.alive(army)
    army.units = []
    for (let i = 0; i < wanted.length; i++) {
      const existing = survivors[i]
      if (existing && existing.def === wanted[i]) {
        existing.hp = existing.def.hp
        army.units.push(existing)
        continue
      }
      const [ox, oz] = FORMATION[i % FORMATION.length]
      const u = this.spawnUnit(wanted[i], site.owner, army.ax + ox, army.az + oz)
      u.armyId = army.id
      army.units.push(u)
    }
    // Anything left over from a previous roster is retired rather than orphaned.
    for (const s of survivors) {
      if (!army.units.includes(s)) s.dead = true
    }
  }

  private updateProjectiles(dt: number, frame: TerrainFrame): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.life -= dt

      const ground = terrainHeightAt(frame, p.x, p.z)
      let hit = p.y <= ground || p.life <= 0

      // Contact with a body, so a shot at a charging line detonates on the line
      // rather than sailing through it into the dirt behind.
      if (!hit) {
        for (const u of this.units) {
          if (u.dead || u.owner === p.owner) continue
          if (Math.hypot(u.x - p.x, u.z - p.z) < 3 && Math.abs(p.y - ground) < 6) {
            hit = true
            break
          }
        }
      }

      if (!hit) continue
      this.projectiles.splice(i, 1)
      this.detonate(p.x, Math.max(p.y, ground), p.z, p.owner)
    }

    for (let i = this.blasts.length - 1; i >= 0; i--) {
      this.blasts[i].age += dt
      if (this.blasts[i].age > 0.6) this.blasts.splice(i, 1)
    }
  }

  private detonate(x: number, y: number, z: number, owner: Owner): void {
    const r = RULES.fireball.radius
    this.blasts.push({ x, y, z, age: 0, radius: r })

    for (const u of this.units) {
      if (u.dead || u.owner === owner) continue
      if (Math.hypot(u.x - x, u.z - z) > r) continue
      this.damageUnit(u, RULES.fireball.damage)
    }
    for (const w of this.wizards) {
      if (w.dead || w.faction === owner) continue
      if (Math.hypot(w.x - x, w.z - z) > r) continue
      this.damageWizard(w, RULES.fireball.damage)
    }
  }

  private damageUnit(u: SimUnit, amount: number): void {
    if (u.dead) return
    u.hp -= amount
    u.hurtT = 0.35
    if (u.hp > 0) return
    u.dead = true
    u.deadT = 0
    u.anim = 'death'
    u.animT = 0
  }

  private updateArmies(dt: number): void {
    for (const army of this.armies) {
      const alive = Sim.alive(army)
      if (alive.length === 0) {
        army.order = 'idle'
        continue
      }

      // The bearer alone means the fighting strength is gone. Marching a lone
      // standard-bearer into a garrison is not a decision anyone would make on
      // purpose, so the army makes it for them and goes home.
      if (alive.length === 1 && alive[0].def.role === 'bearer' && army.order !== 'return') {
        army.order = 'return'
        army.targetSiteId = -1
        if (army.owner === 0) this.opts.onMessage('An army has routed and is marching home.')
      }

      // In contact, not merely aware.
      //
      // This used to be "any unit has a target", which quietly lost the army
      // every battle it fought. A town's hunters reach 117 units from the pad
      // (their leash plus their 40 of range) while an army unit may only chase
      // 60 from its anchor — so an army that froze the moment a hunter came into
      // view stood at 90 units and was shot to pieces by defenders it could
      // never walk to. Measured: six units in, one bearer out, one defender
      // killed.
      //
      // Stopping on *contact* instead means the column keeps closing while it is
      // under fire it cannot answer, which is both the correct behaviour and the
      // one that makes the threshold rules in the full doc mean anything.
      army.fighting = alive.some((u) => {
        const t = u.target ?? u.targetWizard
        return t !== null && t !== undefined && Math.hypot(t.x - u.x, t.z - u.z) <= u.def.range + 4
      })

      let gx = army.ax
      let gz = army.az
      if (army.order === 'march') {
        const target = this.siteById(army.targetSiteId)
        if (!target) {
          army.order = 'return'
        } else {
          gx = target.x
          gz = target.z
          const d = Math.hypot(target.x - army.ax, target.z - army.az)
          // Arrived and everything here is dead: camp, and hold the ground until
          // the wizard comes to claim it or the order changes.
          if (d < target.radius * 1.1 && this.isCleared(target)) {
            army.order = target.owner === army.owner ? 'return' : 'camp'
          }
        }
      } else if (army.order === 'camp') {
        const target = this.siteById(army.targetSiteId)
        if (!target) army.order = 'return'
        else {
          gx = target.x
          gz = target.z
          // Consecrated by its own side: the job is done, march home.
          if (target.owner === army.owner) army.order = 'return'
          // Something came back. Stop camping and fight for it again.
          else if (!this.isCleared(target)) army.order = 'march'
        }
      }

      if (army.order === 'return' || army.order === 'idle') {
        const home = this.siteById(army.homeSiteId)
        gx = home?.x ?? army.ax
        gz = home?.z ?? army.az
        if (army.order === 'return' && Math.hypot(gx - army.ax, gz - army.az) < 12) {
          army.order = 'idle'
        }
      }

      // An attack presses on; a withdrawal stops to fight.
      //
      // The asymmetry is the whole of it. Letting contact halt a *march* meant
      // an army stopped wherever the first defender happened to meet it — and a
      // site's ranged defenders never need to meet anything, because their reach
      // from the pad (leash plus range) is longer than an army unit's reach from
      // its anchor. So the column parked at 80 units and was shot by hunters
      // standing still at 0, which no amount of unit-level tuning can fix: the
      // army was never allowed to arrive. Pressing on until it is *at* the
      // objective is what makes the fight happen on the pad, where both sides
      // can reach each other.
      const pressing = army.order === 'march'
      if (pressing || !army.fighting) {
        const dx = gx - army.ax
        const dz = gz - army.az
        const d = Math.hypot(dx, dz)
        if (d > 1) {
          const step = Math.min(d, RULES.army.march * dt)
          army.ax += (dx / d) * step
          army.az += (dz / d) * step
        }
      }
    }

    // Retire armies that are gone, and cut the city's link to them.
    for (const site of this.sites) {
      if (site.army && Sim.alive(site.army).length === 0) {
        this.armies = this.armies.filter((a) => a !== site.army)
        site.army = null
      }
    }
  }

  private updateUnits(dt: number, slow: boolean): void {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i]

      if (u.dead) {
        u.deadT += dt
        u.animT += dt
        // Long enough for the death row to play out, then the body is gone. No
        // corpses: they would accumulate over a 30 minute match into thousands
        // of instances that never move again.
        if (u.deadT > 2.5) this.units.splice(i, 1)
        continue
      }

      if (u.hurtT > 0) u.hurtT -= dt

      const anchor = this.anchorFor(u)
      // A garrison with nothing near it does not think. See `markHotSites`.
      const asleep = u.armyId < 0 && u.siteId >= 0 && !this.hot.has(u.siteId)

      if (slow && !asleep) this.acquire(u, anchor)
      if (asleep) {
        u.target = null
        u.targetWizard = null
      }

      // Drop a target that died, walked out of the leash, or was claimed.
      if (u.target && u.target.dead) u.target = null
      if (u.targetWizard && u.targetWizard.dead) u.targetWizard = null

      const tx = u.target?.x ?? u.targetWizard?.x
      const tz = u.target?.z ?? u.targetWizard?.z

      if (tx !== undefined && tz !== undefined) {
        const d = Math.hypot(tx - u.x, tz - u.z)
        if (d > u.def.range) {
          this.step(u, tx, tz, dt, anchor)
          u.anim = u.def.speed > 0 ? 'walk' : 'idle'
        } else {
          u.anim = u.hurtT > 0 ? 'hurt' : 'attack'
          u.flip = tx < u.x
          const dmg = u.def.dps * dt
          if (u.target) this.damageUnit(u.target, dmg)
          else if (u.targetWizard) this.damageWizard(u.targetWizard, dmg)
        }
      } else {
        // Nothing to fight: fall back in around whatever this unit belongs to.
        const d = Math.hypot(anchor.x - u.x, anchor.z - u.z)
        if (d > 2.5) {
          this.step(u, anchor.x, anchor.z, dt, anchor, true)
          u.anim = 'walk'
        } else {
          u.anim = u.hurtT > 0 ? 'hurt' : 'idle'
        }
      }

      u.animT += dt
    }
  }

  /** Where this unit belongs when it has nothing to fight. */
  private anchorFor(u: SimUnit): { x: number; z: number; leash: number } {
    if (u.armyId >= 0) {
      const army = this.armyById(u.armyId)
      if (army) {
        const i = army.units.indexOf(u)
        const [ox, oz] = FORMATION[(i < 0 ? 0 : i) % FORMATION.length]
        return { x: army.ax + ox, z: army.az + oz, leash: RULES.army.leash }
      }
    }
    const site = this.siteById(u.siteId)
    if (site) {
      // A tower stands where it was built and never leaves it.
      if (u.tower) return { x: u.x, z: u.z, leash: u.def.range }
      // The sally leash: defenders come out to meet an attacker and then break
      // off, so a garrison can be pulled apart but not led away.
      //
      // Was 1.6x the pad, which on a 48-unit city let defenders operate 77 units
      // from home — further than the whole engagement is now wide, so a garrison
      // fought its battles halfway to the next valley. Under the pad radius, the
      // defence happens *on the site*, which is where the player is looking.
      return { x: site.x, z: site.z, leash: site.radius * 0.8 }
    }
    return { x: u.x, z: u.z, leash: RULES.army.leash }
  }

  /**
   * Pick something to fight.
   *
   * Nearest hostile inside the aggro radius that is also inside this unit's
   * leash — the leash is measured from the *anchor*, not from the unit, which is
   * what stops a garrison being walked off its site one step at a time by
   * something that keeps retreating.
   *
   * The fast slot prefers enemy ranged units, which is the whole reason the full
   * doc gives an army a fast slot at all: without the preference it is just a
   * quick foot soldier and the ranged line never comes under pressure.
   */
  private acquire(u: SimUnit, anchor: { x: number; z: number; leash: number }): void {
    u.target = null
    u.targetWizard = null
    if (u.def.dps <= 0) return

    let best: SimUnit | null = null
    let bestScore = Infinity
    const reach = anchor.leash + u.def.range

    for (const o of this.units) {
      if (o.dead || o.owner === u.owner) continue
      if (o.owner < 0 && u.owner < 0) continue
      const d = Math.hypot(o.x - u.x, o.z - u.z)
      if (d > RULES.army.aggro) continue
      if (Math.hypot(o.x - anchor.x, o.z - anchor.z) > reach) continue
      // Halving the effective distance is a preference, not a compulsion: a
      // cavalier will still take the swordsman in front of it over an archer
      // three times further away.
      const score = u.def.role === 'fast' && o.def.role === 'ranged' ? d * 0.5 : d
      if (score < bestScore) {
        bestScore = score
        best = o
      }
    }

    let bestWizard: Wizard | null = null
    for (const w of this.wizards) {
      if (w.dead || w.faction === u.owner) continue
      const d = Math.hypot(w.x - u.x, w.z - u.z)
      if (d > RULES.army.aggro) continue
      if (Math.hypot(w.x - anchor.x, w.z - anchor.z) > reach) continue
      if (d < bestScore) {
        bestScore = d
        bestWizard = w
      }
    }

    if (bestWizard) u.targetWizard = bestWizard
    else u.target = best
  }

  private step(
    u: SimUnit,
    tx: number,
    tz: number,
    dt: number,
    anchor: { x: number; z: number; leash: number },
    home = false,
  ): void {
    if (u.def.speed <= 0) return
    const dx = tx - u.x
    const dz = tz - u.z
    const d = Math.hypot(dx, dz)
    if (d < 1e-3) return
    const move = Math.min(d, u.def.speed * dt)
    const nx = u.x + (dx / d) * move
    const nz = u.z + (dz / d) * move
    // Never step outside the leash while chasing. Walking home is exempt, or a
    // unit knocked past its own leash could never get back inside it.
    if (!home && Math.hypot(nx - anchor.x, nz - anchor.z) > anchor.leash) return
    u.x = nx
    u.z = nz
    u.flip = dx < 0
  }

  private updateSites(dt: number): void {
    for (const site of this.sites) {
      site.defenders = site.defenders.filter((u) => !u.dead || u.deadT < 2.5)
      const living = site.defenders.filter((u) => !u.dead)

      // A cleared lair leaves its hoard on the ground for whoever flies over it.
      if (site.kind === 'lair' && site.cache && living.length === 0) this.dropCache(site)

      // A fort rebuilds its towers for whoever holds the city.
      if (site.fort && site.owner >= 0) {
        const towers = living.filter((u) => u.tower).length
        if (towers < TOWER_OFFSETS.length) {
          site.towerT += dt
          if (site.towerT >= 60) {
            site.towerT = 0
            site.defenders = site.defenders.filter((u) => !u.tower)
            this.spawnTowers(site)
          }
        } else site.towerT = 0
      }

      if (site.owner === NOBODY && site.garrison) {
        if (living.length === 0) {
          site.regenT += dt
          if (site.regenT >= RULES.garrisonRegen) {
            site.regenT = 0
            site.defenders = []
            this.spawnGarrison(site)
          }
        } else {
          site.regenT = 0
          // Chip damage fades. Consecutive waves still benefit from attrition,
          // but an attack an hour ago does not.
          for (const u of living) {
            u.hp = Math.min(u.def.hp, u.hp + (u.def.hp / RULES.garrisonRegen) * dt)
          }
        }
      }

      // A held point regrows its guard, so points are defensible without being
      // free to retake.
      if (site.kind === 'point' && site.owner >= 0) {
        const guards = living.filter((u) => !u.tower).length
        if (guards === 0) {
          site.regenT += dt
          if (site.regenT >= RULES.pointRegen) {
            site.regenT = 0
            site.defenders = site.defenders.filter((u) => u.tower)
            this.spawnGarrison(site)
          }
        } else site.regenT = 0
      }
    }
  }

  /** Hand a site to a wizard. The one place ownership ever changes. */
  private claim(site: SiteState, w: Wizard): void {
    const previous = site.owner
    site.owner = w.faction
    site.garrison = site.kind === 'point' ? 'point' : null
    site.regenT = 0
    this.cancelChannel(w)

    // Whatever was defending it is gone; a claimed site starts empty and is
    // defended by its owner's army until it builds something.
    for (const u of site.defenders) u.dead = true
    site.defenders = []
    if (site.fort) this.spawnTowers(site)

    if (previous >= 0) {
      // Taking a city takes its production with it, and its army with it.
      site.queue = null
      if (site.army) {
        this.armies = this.armies.filter((a) => a !== site.army)
        for (const u of site.army.units) u.dead = true
        site.army = null
      }
    }

    if (w.isPlayer) this.opts.onMessage(`${site.name} is yours.`)
    else if (previous === 0) {
      this.opts.onMessage(`${FACTIONS[w.faction].name} has taken ${site.name}.`)
    }
  }

  /** Clearing a lair leaves its hoard on the ground. */
  private dropCache(site: SiteState): void {
    if (site.kind !== 'lair' || !site.cache) return
    this.pickups.push({ x: site.x, z: site.z, gold: site.cache })
    site.cache = 0
  }

  private updateVictory(dt: number): void {
    for (const w of this.wizards) {
      const points = this.sites.filter((s) => s.kind === 'point' && s.owner === w.faction).length
      if (points > 0) {
        w.charge = Math.min(100, w.charge + points * RULES.chargePerPoint * dt)
      }
      if (w.charge >= 100 && this.winner < 0) this.winner = w.faction
    }
  }

  // --- the AI ----------------------------------------------------------------

  /**
   * An AI wizard's whole brain.
   *
   * Deliberately a script, not a planner. It plays by exactly the player's
   * rules — same two spells, same costs, same queue, no vision cheats and no
   * economy bonus — and the bar it has to clear is "applies credible pressure",
   * not "plays well". Anything cleverer would be tuning a system nobody has
   * played against yet.
   */
  private flyAi(w: Wizard, dt: number, frame: TerrainFrame): void {
    // A consecration is a stance: grounded, silent, and it takes ten seconds.
    // Thinking mid-channel would only ever break it — a fireball cancels the
    // channel by rule, and re-deciding where to fly is meaningless while the
    // wizard cannot move.
    if (w.channelSiteId >= 0) return

    w.thinkT -= dt
    if (w.thinkT <= 0) {
      w.thinkT = 1.5
      this.thinkAi(w)
    }

    // Fireball whatever is closest, if anything is in reach. The AI aims at a
    // body rather than at the ground, which is the same shot the player takes.
    if (w.cooldown <= 0 && w.mana > RULES.fireball.mana * 2) {
      let best: { x: number; z: number } | null = null
      // The AI plays by the player's range, not by its own. Reading the rule
      // rather than repeating the number is what keeps that true when it moves.
      let bestD: number = RULES.castRange
      for (const u of this.units) {
        if (u.dead || u.owner === w.faction) continue
        const d = Math.hypot(u.x - w.x, u.z - w.z)
        if (d < bestD) {
          bestD = d
          best = u
        }
      }
      if (best) {
        this.castFireball(w, best.x, best.z, terrainHeightAt(frame, best.x, best.z) + 1)
      }
    }

    // Flying. Nothing subtle: straight at the goal, at the same speed the player
    // gets, and it stops to consecrate when it arrives.
    if (w.channelSiteId >= 0) return
    const dx = w.goalX - w.x
    const dz = w.goalZ - w.z
    const d = Math.hypot(dx, dz)
    if (d > 4) {
      const speed = 17
      const step = Math.min(d, speed * dt)
      w.x += (dx / d) * step
      w.z += (dz / d) * step
    }
    w.y = terrainHeightAt(frame, w.x, w.z) + 8
  }

  private thinkAi(w: Wizard): void {
    // 1. Keep the queue busy. Army first — an AI with no army does nothing at
    //    all — then the economy, then rebuild.
    for (const site of this.sitesOf(w.faction)) {
      if (site.kind !== 'city' || site.queue) continue
      if (!site.army) this.queueBuild(site, 'army')
      else if (!site.shrine) this.queueBuild(site, 'shrine')
      else if (!site.fort) this.queueBuild(site, 'fort')
      else this.queueBuild(site, 'army')
    }

    // 2. Somebody is close to winning: everything goes at their points.
    const leader = this.wizards.find((o) => o.faction !== w.faction && o.charge >= 60)
    const owned = this.sitesOf(w.faction).length

    for (const army of this.armiesOf(w.faction)) {
      if (Sim.alive(army).length < 4) continue
      if (army.order === 'march' || army.order === 'camp') continue

      let target: SiteState | null = null
      if (leader) {
        target = this.nearestSite(army.ax, army.az, (s) => s.kind === 'point' && s.owner === leader.faction)
      }
      if (!target) {
        // Mines and towns early, points once there is an economy behind them.
        target = this.nearestSite(army.ax, army.az, (s) => {
          if (s.owner === w.faction) return false
          if (s.kind === 'point') return owned >= 3
          if (s.kind === 'lair') return false
          return true
        })
      }
      if (target) this.orderArmy(army, target.id)
    }

    // 3. The wizard: run home when hurt, otherwise go claim whatever its armies
    //    have already cleared, otherwise follow the fighting.
    if (w.hp < 30) {
      const home = this.nearestSite(w.x, w.z, (s) => s.owner === w.faction && s.kind === 'city')
      if (home) {
        w.goalX = home.x
        w.goalZ = home.z
        return
      }
    }

    // What my own armies have already taken, first.
    //
    // Nearest-cleared-site alone is not good enough and was actively broken:
    // both AI wizards picked the same distant town, hovered over it trading
    // fireballs, and left their armies camped on mines that nobody ever claimed.
    // Eight minutes in, neither had captured anything. An army that clears a
    // site and is never followed up is the entire economy standing still, so the
    // site one of my own armies is sitting on outranks anything else on the map.
    const camps = this.armiesOf(w.faction)
      .filter((a) => a.order === 'camp')
      .map((a) => this.siteById(a.targetSiteId))
      .filter((s): s is SiteState => !!s && s.owner !== w.faction && this.isCleared(s))

    let claimable: SiteState | null = null
    let bestD = Infinity
    for (const s of camps) {
      const d = Math.hypot(s.x - w.x, s.z - w.z)
      if (d < bestD) {
        bestD = d
        claimable = s
      }
    }

    // Failing that, anything cleared and close by — a lair the player emptied,
    // a town whose garrison never came back. Bounded, so this stays opportunism
    // rather than a cross-map errand.
    if (!claimable) {
      const near = this.nearestSite(
        w.x,
        w.z,
        (s) => s.owner !== w.faction && s.kind !== 'lair' && this.isCleared(s),
      )
      if (near && Math.hypot(near.x - w.x, near.z - w.z) < 420) claimable = near
    }

    if (claimable) {
      w.goalX = claimable.x
      w.goalZ = claimable.z
      if (this.inCastRange(w, claimable.x, claimable.z)) this.beginConvert(w, claimable)
      return
    }

    const army = this.armiesOf(w.faction).find((a) => a.order === 'march' || a.order === 'camp')
    if (army) {
      w.goalX = army.ax
      w.goalZ = army.az
    }
  }

  private nearestSite(
    x: number,
    z: number,
    pass: (s: SiteState) => boolean,
  ): SiteState | null {
    let best: SiteState | null = null
    let bestD = Infinity
    for (const s of this.sites) {
      if (!pass(s)) continue
      const d = Math.hypot(s.x - x, s.z - z)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    return best
  }

  // --- drawing ---------------------------------------------------------------

  /**
   * Push the match onto the board.
   *
   * Two layers because two atlases: creatures come from `units.png` and the map
   * pieces from `sprites.png`, and one material binds one texture. `dimAt`
   * is the fog — a unit standing in unexplored ground is drawn dark rather than
   * hidden outright, because a garrison that pops into existence as the fog
   * lifts reads worse than one you can half-see coming.
   */
  draw(
    unitLayer: BoardLayer<UnitKey>,
    boardLayer: BoardLayer<SpriteKey>,
    banners: Banners,
    frame: TerrainFrame,
    dimAt: (x: number, z: number) => number,
  ): void {
    unitLayer.begin(frame)
    boardLayer.begin(frame)
    banners.begin(frame)

    for (const site of this.sites) {
      const dim = dimAt(site.x, site.z)
      // A site nobody has ever seen is not on the map at all. Its garrison is
      // hidden with it — see below.
      if (dim <= 0.02) continue

      const tint = site.owner >= 0 ? FACTIONS[site.owner].tint : NEUTRAL_TINT

      // The standard goes up the moment a site changes hands.
      //
      // A city flies it from the middle of its own clearing. The village is a
      // ring of buildings around an empty plaza — see `settlementLayout` — and
      // the plaza is exactly where a town's standard belongs: nothing else is
      // standing there, and being at the centre means it reads as the whole
      // settlement's flag rather than one building's.
      //
      // Everything else is a single building sitting on its own pad, so its
      // banner stands just north of it instead of through it.
      if (site.owner >= 0) {
        // Sized against what it stands over: a town card is about ten units
        // tall, so a capital's standard clears the roofline and a mine's clears
        // the headworks, without either becoming the tallest thing on the map.
        const city = site.kind === 'city'
        banners.push(site.x, city ? site.z : site.z - site.radius * 0.42, city ? 10 : 8, tint, dim)
      }
      if (site.sprite) {
        const claimed = site.owner >= 0 && site.ownedSprite
        boardLayer.push({
          sprite: (claimed ? site.ownedSprite : site.sprite) as SpriteKey,
          x: site.x,
          z: site.z,
          tint,
          discRadius: site.radius * 0.8,
          dim,
          scale: site.kind === 'point' ? 1.35 : 1,
        })
      } else {
        // A city's building is drawn by the static card layer; all this adds is
        // the ownership disc under it, which is the thing that has to change
        // hands mid-match and so cannot live there.
        boardLayer.push({
          sprite: 'pickup.gold' as SpriteKey,
          x: site.x,
          z: site.z,
          tint,
          discRadius: site.radius * 0.95,
          dim,
          discOnly: true,
        })
      }
    }

    for (const g of this.pickups) {
      const dim = dimAt(g.x, g.z)
      if (dim <= 0.02) continue
      boardLayer.push({ sprite: 'pickup.chest' as SpriteKey, x: g.x, z: g.z, dim, scale: 1.2 })
    }

    for (const u of this.units) {
      const dim = dimAt(u.x, u.z)
      if (dim <= 0.02) continue
      if (u.tower) {
        boardLayer.push({
          sprite: 'mod.tower' as SpriteKey,
          x: u.x,
          z: u.z,
          dim,
          tint: u.owner >= 0 ? FACTIONS[u.owner].tint : NEUTRAL_TINT,
          scale: 0.8,
        })
        continue
      }
      const frameIndex = Math.floor(u.animT * ANIM_FPS)
      unitLayer.push({
        sprite: u.def.sprite,
        x: u.x,
        z: u.z,
        // The death row plays once and holds on its last frame rather than
        // looping, or every corpse flickers back to life for its last half second.
        frame: u.dead ? Math.min(3, frameIndex) : frameIndex % 4,
        row: UNIT_ANIM[u.anim],
        flip: u.flip,
        scale: u.def.scale,
        dim,
        flash: u.hurtT > 0 ? Math.min(1, u.hurtT * 2.2) : 0,
        tint: u.owner >= 0 ? FACTIONS[u.owner].tint : NEUTRAL_TINT,
        discRadius: 1.6,
      })
    }

    // The AI wizards. The player's own is the 3D avatar and is not drawn here.
    for (const w of this.wizards) {
      if (w.isPlayer || w.dead) continue
      const dim = dimAt(w.x, w.z)
      if (dim <= 0.02) continue
      unitLayer.push({
        sprite: FACTIONS[w.faction].wizard,
        x: w.x,
        z: w.z,
        lift: 6,
        scale: 1.5,
        frame: Math.floor(w.thinkT * ANIM_FPS) % 4,
        row: UNIT_ANIM.idle,
        dim,
        tint: FACTIONS[w.faction].tint,
        discRadius: 3,
      })
    }

    unitLayer.end()
    boardLayer.end()
    banners.end()
  }
}
