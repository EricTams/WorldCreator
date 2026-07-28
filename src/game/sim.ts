import type { TerrainFrame } from '../world/terrainQuery'
import { terrainHeightAt } from '../world/terrainQuery'
import type { MapPlan, MapSite, Owner, ResourceKind } from '../world/gameMap'
import { NOBODY } from '../world/gameMap'
import { ANIM_FPS, ARCHETYPE, FACTIONS, GARRISONS, NEUTRAL_TINT, UNIT_ANIM } from './factions'
import type { AnimName, UnitDef } from './factions'
import { MAX_TIER, RULES, TIER_NAMES } from './rules'
import type { BuildItem } from './rules'
import { flyAi } from './ai'
import type { BoardLayer } from '../render/boardLayer'
import type { Banners } from '../render/banners'
import type { SiegeEngines } from '../render/siege'
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
  /**
   * A caravan wagon: drawn from the board atlas, and driven by its caravan
   * rather than by the combat loop. It has no weapon and never picks a fight.
   */
  wagon: boolean
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
  /**
   * Connection-resource multipliers, refreshed every tick from the home city's
   * live links. Cached on the army rather than looked up per unit per frame,
   * and read straight through so that cutting a caravan takes effect on the
   * next swing rather than the next battle.
   */
  damageMul: number
  marchMul: number
}

/**
 * A trade link, and the wagon that is the link.
 *
 * The buff is not stored anywhere — it is computed from the caravans that are
 * alive, which is what makes severing one instant and total. There is no state
 * to forget to clear.
 */
export interface Caravan {
  id: number
  owner: Owner
  homeSiteId: number
  nodeSiteId: number
  unit: SimUnit
  /** False while walking out for the first time; true once the link is up. */
  live: boolean
  /** Which end of the route it is walking towards. */
  toNode: boolean
}

export interface SiteState extends MapSite {
  defenders: SimUnit[]
  /** Counts up while cleared and unclaimed, until the garrison comes back. */
  regenT: number
  /**
   * Village, Town or City. Cities only, and it survives capture — taking a
   * developed city takes the development with it, which is what makes an
   * enemy capital the biggest prize on the board.
   */
  tier: number
  /** Cities only. */
  fort: boolean
  shrine: boolean
  market: boolean
  siegeWorks: boolean
  queue: {
    item: BuildItem
    remaining: number
    total: number
    /** Caravans only: the node this one was commissioned for. */
    targetId: number
    /** Caravans only: the build is done and the queue is held for the journey. */
    travelling: boolean
  } | null
  army: Army | null
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

/**
 * The caravan wagon.
 *
 * A bearer with a cart: no damage, no reach, and slower than a marching army.
 * Sixty health means anything hostile kills it in seconds, which is the whole
 * design — a link is a promise that a road stays safe.
 */
const WAGON_DEF: UnitDef = {
  ...ARCHETYPE.bearer,
  sprite: 'unit.castle.peasant' as UnitKey,
  name: 'Caravan',
  hp: RULES.caravan.hp,
  speed: RULES.caravan.speed,
}

/**
 * The trebuchet.
 *
 * Drawn by `render/siege.ts` as generated geometry rather than from an atlas —
 * there is no siege art in the pack — so the sprite here is a placeholder that
 * is never sampled, the same arrangement fort towers use.
 */
const TREBUCHET_DEF: UnitDef = {
  ...ARCHETYPE.siege,
  sprite: 'unit.castle.peasant' as UnitKey,
  name: 'Trebuchet',
}

/**
 * The build menu, in the order it is offered.
 *
 * Army first because it is what a city is usually for, then growth, then the
 * buildings. `repair` is deliberately absent: it is never chosen, only
 * auto-queued when a damaged city has nothing better to do.
 */
const MENU_ORDER: BuildItem[] = ['army', 'tier', 'fort', 'shrine', 'market', 'caravan', 'siegeWorks', 'trebuchet']

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
  caravans: Caravan[] = []

  /** Faction index of the winner, or -1 while the match is live. */
  winner = -1
  /** Wall-clock seconds since the match began. */
  elapsed = 0
  ready = false

  private opts: SimOptions
  private nextUnitId = 1
  private nextArmyId = 1
  private nextCaravanId = 1
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
    const capitals = new Set(plan.capitals)
    this.sites = plan.sites.map((s) => ({
      ...s,
      defenders: [],
      regenT: 0,
      // A wizard's capital opens at Town. Charging every wizard ninety seconds
      // of queue before the game can start would tax the one part of the first
      // playable that already works — the opening. Everything else, including
      // every neutral town waiting to be captured, starts as a Village: a
      // foothold is a foothold, and growing it is the investment.
      tier: capitals.has(s.id) ? 2 : 1,
      fort: false,
      shrine: false,
      market: false,
      siegeWorks: false,
      queue: null,
      army: null,
    }))
    this.units = []
    this.armies = []
    this.projectiles = []
    this.blasts = []
    this.pickups = []
    this.caravans = []
    this.nextUnitId = 1
    this.nextCaravanId = 1
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
      wagon: false,
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

  /**
   * Put a fort's towers back, whole.
   *
   * The same call finishes a new Fort and completes a Repair, because "a fort
   * has two undamaged towers" is one fact and deserves one implementation. The
   * old towers are removed outright rather than killed — a repaired wall must
   * not play a death animation on its way to being fixed.
   */
  private repairTowers(site: SiteState): void {
    if (!site.fort || site.owner < 0) return
    const old = site.defenders.filter((u) => u.tower)
    site.defenders = site.defenders.filter((u) => !u.tower)
    this.units = this.units.filter((u) => !old.includes(u))
    this.spawnTowers(site)
  }

  // --- queries ---------------------------------------------------------------

  /** Nothing left alive defending it. The precondition for consecrating. */
  isCleared(site: SiteState): boolean {
    return site.defenders.every((u) => u.dead)
  }

  /**
   * A site this wizard would consecrate if it were standing on it.
   *
   * `canConvert` without the range test, and it exists so that "is this worth
   * flying to" and "may I claim this" can never disagree. An AI that answers
   * those two questions with two different rules flies somewhere it will never
   * be allowed to claim and hovers there — which is exactly how an AI wizard
   * once spent fourteen minutes standing on a cleared mine.
   */
  canClaim(w: Wizard, site: SiteState): boolean {
    if (site.kind === 'lair') return false
    // A resource node is claimed by a caravan arriving, never by the wizard.
    // It is the one place the identity sentence is extended rather than obeyed:
    // armies destroy defenses, *caravans claim nodes*, the wizard claims the
    // rest — and it is what gives a caravan a job nothing else can do.
    if (site.kind === 'node') return false
    if (site.owner === w.faction) return false
    return this.isCleared(site)
  }

  /** Can this wizard start a consecration here, right now? */
  canConvert(w: Wizard, site: SiteState): boolean {
    if (!this.canClaim(w, site)) return false
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

  /** Is this army escorting a living siege engine? */
  static hasSiege(army: Army): boolean {
    return army.units.some((u) => !u.dead && u.def.role === 'siege')
  }

  /** Give a city's waiting army its engine. */
  private attachTrebuchet(site: SiteState): void {
    const army = site.army
    if (!army) return
    const [ox, oz] = FORMATION[army.units.length % FORMATION.length]
    const u = this.spawnUnit(TREBUCHET_DEF, site.owner, army.ax + ox, army.az + oz)
    u.armyId = army.id
    army.units.push(u)
  }

  static armyStrength(army: Army): number {
    let hp = 0
    let max = 0
    for (const u of army.units) {
      // The engine is not part of the army's establishment: reconstitution
      // neither prices it nor replaces it, so counting it here would quietly
      // discount every rebuild for anyone escorting one.
      if (u.def.role === 'siege') continue
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
   * Which items this city can offer, in menu order.
   *
   * Derived from the tier rather than listed in the HUD, because the tier ladder
   * only means anything if it is the single place that decides what a city can
   * do. A menu that kept its own list would eventually disagree with the rule
   * the AI plays by, and the disagreement would be invisible.
   */
  buildOptions(site: SiteState): BuildItem[] {
    if (site.kind !== 'city') return []
    return MENU_ORDER.filter((item) => site.tier >= RULES.city.build[item].tier)
  }

  /** What an item costs *at this city, right now* — the scaled price, not the table's. */
  buildSpec(site: SiteState, item: BuildItem): { gold: number; time: number; label: string } {
    const spec = RULES.city.build[item]
    if (item === 'tier') {
      const up = RULES.city.tierUp[site.tier - 1]
      if (!up) return { gold: 0, time: 0, label: 'Tier Up' }
      return { gold: up.gold, time: up.time, label: `Grow to ${TIER_NAMES[site.tier + 1]}` }
    }
    if (item === 'army' && site.army) {
      // Reconstituting costs what was lost, not what a new army costs. An army
      // that walked home with one casualty should not be worth razing and
      // rebuilding, which a flat price would make it.
      const missing = 1 - Sim.armyStrength(site.army)
      // A Granary link is the "war-torn city" buff: it does nothing for a city
      // whose army is whole, and a great deal for the one that keeps losing it.
      const granary = this.linkedTo(site.id, 'granary') ? RULES.node.granaryRecon : 1
      return {
        gold: Math.max(25, Math.round(spec.gold * missing * granary)),
        time: Math.max(15, Math.round(spec.time * missing * granary)),
        label: 'Reconstitute',
      }
    }
    return { gold: spec.gold, time: spec.time, label: spec.label }
  }

  /**
   * Why this item cannot be commissioned here, or null if it can.
   *
   * One function answers both "may the AI do this" and "is the button dead",
   * and the reason it returns is the text the button shows. Two copies of this
   * logic is how a HUD ends up offering something the sim refuses.
   */
  buildBlocked(site: SiteState, item: BuildItem): string | null {
    if (site.kind !== 'city' || site.owner < 0) return 'Not yours'
    if (site.tier < RULES.city.build[item].tier) return 'Too small'
    if (item === 'fort' && site.fort) return 'Built'
    if (item === 'shrine' && site.shrine) return 'Built'
    if (item === 'market' && site.market) return 'Built'
    if (item === 'siegeWorks' && site.siegeWorks) return 'Built'
    if (item === 'tier' && site.tier >= MAX_TIER) return 'Built'
    if (item === 'trebuchet') {
      // An engine is attached to a *particular* body of troops, so the troops
      // have to be standing here to receive it.
      if (!site.siegeWorks) return 'Needs a Siege Works'
      if (!site.army || site.army.order !== 'idle') return 'Army must be home'
      if (Sim.hasSiege(site.army)) return 'Already escorting one'
    }
    if (item === 'army' && site.army && 1 - Sim.armyStrength(site.army) < 0.02) {
      return 'Army ready'
    }
    if (this.wizards[site.owner].gold < this.buildSpec(site, item).gold) return 'Too costly'
    return null
  }

  /**
   * Put something in a city's queue.
   *
   * Gold is taken at commission rather than on completion, so a queued item can
   * never fail at the last second because the wizard spent the money elsewhere —
   * and so the cost is visible at the moment the choice is made.
   *
   * A queue already running is refused, with one exception: a repair yields.
   * That is the whole of the "repair occupies the queue" rule — a city with
   * broken walls and nothing better to do fixes them, and a city with something
   * better to do builds that instead.
   */
  queueBuild(site: SiteState, item: BuildItem, targetId = -1): boolean {
    if (site.queue && site.queue.item !== 'repair') return false
    if (this.buildBlocked(site, item)) return false
    // A caravan is the one order that names a place, so it is the one order
    // that can be refused for where it is going rather than for what it costs.
    if (item === 'caravan' && !this.canLinkTo(targetId)) return false

    const { gold, time } = this.buildSpec(site, item)
    this.wizards[site.owner].gold -= gold
    site.queue = { item, remaining: time, total: time, targetId, travelling: false }
    return true
  }

  /** A node that is standing empty and unspoken for. */
  canLinkTo(nodeId: number): boolean {
    const node = this.siteById(nodeId)
    if (!node || node.kind !== 'node' || node.owner >= 0) return false
    if (!this.isCleared(node)) return false
    // One city per resource, which here just means one caravan per node.
    return !this.caravans.some((c) => c.nodeSiteId === nodeId)
  }

  /** Is this city drawing on a live node of this kind? */
  linkedTo(siteId: number, resource: ResourceKind): boolean {
    return this.caravans.some(
      (c) =>
        c.live && c.homeSiteId === siteId && this.siteById(c.nodeSiteId)?.resource === resource,
    )
  }

  /** The live links a city holds, for the panel to list. */
  linksOf(siteId: number): Caravan[] {
    return this.caravans.filter((c) => c.homeSiteId === siteId)
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
    this.updateCaravans(dt)
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
      // Wagons too, or a caravan strolls past a sleeping garrison untouched and
      // every route on the map is safe by accident.
      if (!hot) {
        for (const c of this.caravans) {
          if (c.owner === site.owner || c.unit.dead) continue
          if (Math.hypot(c.unit.x - site.x, c.unit.z - site.z) < NEAR) hot = true
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

      if (!w.isPlayer) flyAi(this, w, dt, frame)
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
      if (s.kind === 'city') {
        w.gold += RULES.city.income[s.tier - 1] * dt
        if (s.market) w.gold += RULES.city.marketIncome * dt
      } else if (s.kind === 'mine') w.gold += RULES.mine.income * dt

      if (s.kind !== 'city' || !s.queue) continue
      s.queue.remaining -= dt
      if (s.queue.remaining > 0) continue

      const item = s.queue.item
      const targetId = s.queue.targetId
      s.queue = null
      switch (item) {
        case 'shrine':
          s.shrine = true
          break
        case 'market':
          s.market = true
          break
        case 'siegeWorks':
          s.siegeWorks = true
          break
        case 'trebuchet':
          this.attachTrebuchet(s)
          break
        case 'fort':
          s.fort = true
          this.repairTowers(s)
          break
        case 'tier':
          s.tier = Math.min(MAX_TIER, s.tier + 1)
          break
        case 'repair':
          this.repairTowers(s)
          break
        case 'caravan':
          this.launchCaravan(s, targetId)
          continue
        default:
          this.trainArmy(s)
          break
      }
      if (s.owner === 0) {
        const done = item === 'tier' ? `is now a ${TIER_NAMES[s.tier]}` : `${RULES.city.build[item].label} complete`
        this.opts.onMessage(`${s.name}: ${done}.`)
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
        damageMul: 1,
        marchMul: 1,
      }
      this.armies.push(army)
      site.army = army
    }

    const army = site.army
    army.owner = site.owner
    // Reconstitute: heal what survived, replace what did not. Same call whether
    // this is a new army or a rebuilt one, so there is only one place that knows
    // what an army is made of.
    const all = Sim.alive(army)
    // The engine is set aside and put straight back. It is never rebuilt by a
    // reconstitution and — the part that bites — never caught by the retire
    // loop below, which kills anything the new roster did not ask for.
    const siege = all.filter((u) => u.def.role === 'siege')
    const survivors = all.filter((u) => u.def.role !== 'siege')
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
    army.units.push(...siege)
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
      // Routing is about having nobody left who can fight *units*. A trebuchet
      // cannot, so a bearer and an engine alone must go home rather than the
      // engine marching on by itself.
      const fighters = alive.filter((u) => u.def.role !== 'bearer' && u.def.role !== 'siege')
      if (fighters.length === 0 && alive.length > 0 && army.order !== 'return') {
        army.order = 'return'
        army.targetSiteId = -1
        if (army.owner === 0) this.opts.onMessage('An army has routed and is marching home.')
      }

      // What the home city's links are worth, read fresh every tick so that
      // cutting a caravan is felt on the next swing rather than the next battle.
      army.damageMul = this.linkedTo(army.homeSiteId, 'mithril') ? RULES.node.mithrilDamage : 1
      army.marchMul = this.linkedTo(army.homeSiteId, 'horse') ? RULES.node.horseMarch : 1

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
          // A siege train is a visible, slow, interceptable commitment — that
          // is the cost of the only thing that cracks a fort.
          const siegeMul = Sim.hasSiege(army) ? RULES.siege.march : 1
          const step = Math.min(d, RULES.army.march * army.marchMul * siegeMul * dt)
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

      // A wagon is walked by its caravan, not by the combat loop. It never
      // acquires, never chases, and never stops for a fight it cannot join.
      if (u.wagon) {
        u.target = null
        u.targetWizard = null
        u.animT += dt
        continue
      }

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
          const dmg = u.def.dps * this.damageMul(u) * dt
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
        // An army standing on its objective may fight anywhere on that pad.
        //
        // Without this, a fort beat any number of armies. A city's towers stand
        // at 0.55 of a 48-unit pad — 26 out — so a swordsman needed to reach 24
        // from the army's anchor and the 22-unit chase leash stopped it two
        // units short, every time. Only the archer could answer, one bow
        // against two towers, and six soldiers stood in range being shot while
        // physically unable to close. The leash is there to stop an army
        // dissolving into a skirmish line across the countryside, which is a
        // rule about *travelling*, not about the fight it came to have.
        // Widened, like the build costs: `RULES` is `as const`, so every number
        // in it is a literal type until something says otherwise.
        let leash: number = RULES.army.leash
        const target = this.siteById(army.targetSiteId)
        if (target && Math.hypot(target.x - army.ax, target.z - army.az) < target.radius * 1.2) {
          leash = Math.max(leash, target.radius * 0.9)
        }
        return { x: army.ax + ox, z: army.az + oz, leash }
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
    // A trebuchet throws at walls and at nothing else. It cannot hit a soldier,
    // which is why an army needs its escort as much as the escort needs it.
    if (u.def.role === 'siege') {
      let best: SimUnit | null = null
      let bestD = u.def.range
      for (const t of this.units) {
        if (t.dead || !t.tower || t.owner === u.owner) continue
        const d = Math.hypot(t.x - u.x, t.z - u.z)
        if (d < bestD) {
          bestD = d
          best = t
        }
      }
      u.targetWizard = null
      u.target = best
      return
    }

    u.target = null
    u.targetWizard = null
    if (u.def.dps <= 0) return

    let best: SimUnit | null = null
    let bestScore = Infinity
    const reach = anchor.leash + u.def.range
    // How far this unit will *look*, which must never be shorter than how far
    // it may *go*. The two were independent — 32 to notice, but a leash widened
    // to the pad once the army arrived — and a fort sits right on the seam: its
    // towers stand 31 units out from the middle of a city, so whether a soldier
    // engaged the second tower came down to which formation slot it happened to
    // be standing in. Two armies took one tower, then stalled beside the other
    // for four minutes without ever seeing it.
    const aggro = Math.max(RULES.army.aggro, anchor.leash)

    for (const o of this.units) {
      if (o.dead || o.owner === u.owner) continue
      if (o.owner < 0 && u.owner < 0) continue
      const d = Math.hypot(o.x - u.x, o.z - u.z)
      if (d > aggro) continue
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
      if (d > aggro) continue
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
    // Scaled by the same march buff the anchor uses. Buffing one and not the
    // other would leave every unit permanently trailing its own formation.
    const move = Math.min(d, u.def.speed * this.marchMul(u) * dt)
    const nx = u.x + (dx / d) * move
    const nz = u.z + (dz / d) * move
    // Never step outside the leash while chasing. Walking home is exempt, or a
    // unit knocked past its own leash could never get back inside it.
    if (!home && Math.hypot(nx - anchor.x, nz - anchor.z) > anchor.leash) return
    u.x = nx
    u.z = nz
    u.flip = dx < 0
  }

  /** Damage and march multipliers for a unit, via the army it belongs to. */
  private damageMul(u: SimUnit): number {
    return u.armyId < 0 ? 1 : (this.armyById(u.armyId)?.damageMul ?? 1)
  }

  private marchMul(u: SimUnit): number {
    return u.armyId < 0 ? 1 : (this.armyById(u.armyId)?.marchMul ?? 1)
  }

  /**
   * Send the wagon, and keep holding the queue until it gets there.
   *
   * The build finishing is not the item finishing: §3.4 of the full doc prices
   * a connection in *travel*, and this is where that happens. The city's queue
   * stays occupied for the whole journey, so a node on the far side of the
   * island costs several armies' worth of production and a node next door costs
   * almost nothing — a distance rule with no distance formula in it.
   */
  private launchCaravan(site: SiteState, nodeId: number): void {
    const node = this.siteById(nodeId)
    if (!node) return

    const u = this.spawnUnit(WAGON_DEF, site.owner, site.x, site.z)
    u.wagon = true
    this.caravans.push({
      id: this.nextCaravanId++,
      owner: site.owner,
      homeSiteId: site.id,
      nodeSiteId: nodeId,
      unit: u,
      live: false,
      toNode: true,
    })

    const travel = Math.hypot(node.x - site.x, node.z - site.z) / RULES.caravan.speed
    site.queue = {
      item: 'caravan',
      remaining: travel,
      total: travel,
      targetId: nodeId,
      travelling: true,
    }
    if (site.owner === 0) this.opts.onMessage(`${site.name}: a caravan sets out for ${node.name}.`)
  }

  private updateCaravans(dt: number): void {
    for (const c of [...this.caravans]) {
      const node = this.siteById(c.nodeSiteId)
      const home = this.siteById(c.homeSiteId)

      // Severed: the wagon is dead, or the city that sent it changed hands.
      if (c.unit.dead || !node || !home || home.owner !== c.owner) {
        this.severCaravan(c)
        continue
      }

      const dest = c.toNode ? node : home
      const dx = dest.x - c.unit.x
      const dz = dest.z - c.unit.z
      const d = Math.hypot(dx, dz)

      if (d > 4) {
        const move = Math.min(d, RULES.caravan.speed * dt)
        c.unit.x += (dx / d) * move
        c.unit.z += (dz / d) * move
        c.unit.flip = dx < 0
        c.unit.anim = 'walk'
        // The held queue's bar tracks the wagon itself rather than a countdown,
        // so what the player watches is the thing that is actually happening.
        if (!c.live && home.queue?.travelling) {
          home.queue.remaining = d / RULES.caravan.speed
        }
        continue
      }

      if (!c.live) {
        // Arrival, and this is what claims the node — no wizard involved. The
        // army camped here sees the site turn its own colour and marches home
        // on the rule it already had.
        c.live = true
        node.owner = c.owner
        node.regenT = 0
        for (const u of node.defenders) u.dead = true
        node.defenders = []
        if (home.queue?.travelling) home.queue = null
        if (c.owner === 0) this.opts.onMessage(`${node.name} now supplies ${home.name}.`)
      }
      c.toNode = !c.toNode
    }
  }

  /** Cut a link. The buff is computed from live caravans, so this is the whole of it. */
  private severCaravan(c: Caravan): void {
    this.caravans = this.caravans.filter((x) => x !== c)
    c.unit.dead = true

    const node = this.siteById(c.nodeSiteId)
    if (node && node.owner === c.owner) {
      node.owner = NOBODY
      node.regenT = 0
    }
    const home = this.siteById(c.homeSiteId)
    if (home?.queue?.travelling && home.queue.targetId === c.nodeSiteId) home.queue = null
    if (c.owner === 0 && node) this.opts.onMessage(`The caravan to ${node.name} is lost.`)
  }

  /**
   * Is somebody hostile standing in this site's clearing?
   *
   * Nobody rebuilds a wall with the enemy in the courtyard. Without this, a
   * besieged city re-raises its towers every forty-five seconds for as long as
   * it is being held, so an army that had already won had to keep winning —
   * and an assault whose wizard was dead or elsewhere could never resolve.
   */
  private contested(site: SiteState): boolean {
    for (const u of this.units) {
      if (u.dead || u.owner === site.owner || u.owner < 0) continue
      if (u.siteId === site.id) continue
      if (Math.hypot(u.x - site.x, u.z - site.z) < site.radius) return true
    }
    return false
  }

  private updateSites(dt: number): void {
    for (const site of this.sites) {
      site.defenders = site.defenders.filter((u) => !u.dead || u.deadT < 2.5)
      const living = site.defenders.filter((u) => !u.dead)

      // A cleared lair leaves its hoard on the ground for whoever flies over it.
      if (site.kind === 'lair' && site.cache && living.length === 0) this.dropCache(site)

      // A damaged fort repairs itself — but only through the queue, so a city
      // patching its walls is a city building nothing else. That is what makes
      // an attack too weak to win still worth launching.
      //
      // Auto-queued rather than offered, because no owner would ever choose not
      // to repair; the choice is the other direction, and `queueBuild` gives it
      // to them by letting any real order push a repair aside.
      if (site.fort && site.owner >= 0 && !site.queue && !this.contested(site)) {
        const towers = living.filter((u) => u.tower)
        const hurt =
          towers.length < TOWER_OFFSETS.length || towers.some((u) => u.hp < u.def.hp - 0.5)
        if (hurt) this.queueBuild(site, 'repair')
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
    siege: SiegeEngines,
    frame: TerrainFrame,
    dimAt: (x: number, z: number) => number,
  ): void {
    unitLayer.begin(frame)
    boardLayer.begin(frame)
    banners.begin(frame)
    siege.begin(frame)

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
      if (u.def.role === 'siege') {
        siege.push(u.x, u.z, 11, u.owner >= 0 ? FACTIONS[u.owner].tint : NEUTRAL_TINT, dim, u.flip)
        continue
      }
      if (u.tower || u.wagon) {
        boardLayer.push({
          sprite: (u.wagon ? 'pickup.wagon' : 'mod.tower') as SpriteKey,
          x: u.x,
          z: u.z,
          dim,
          tint: u.owner >= 0 ? FACTIONS[u.owner].tint : NEUTRAL_TINT,
          scale: u.wagon ? 0.7 : 0.8,
          discRadius: u.wagon ? 2 : undefined,
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
    siege.end()
  }
}
