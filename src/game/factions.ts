import type { UnitKey } from '../render/spriteAtlas'

/**
 * Who fights, with what, and how well.
 *
 * Every sprite key here is a real entry in `assets/units.ts` — the packer built
 * that file from `UNIT_ROSTERS` in `tools/spriteManifest.mjs`, and the rosters
 * below are a gameplay reading of the same list. The mapping is the one written
 * down in `docs/first-playable.md` §5, kept here rather than there because a
 * table in a document cannot fail to compile when the art moves.
 *
 * Numbers are `docs/first-playable.md` §10 verbatim. They are first-tuning
 * values and are meant to be edited together, which is why they live in one
 * table rather than being scattered across the systems that read them.
 */

/**
 * Row order in every creature sheet, from `TempArt/tips.txt`.
 *
 * Written down once. Four separate callers indexing row 4 for "dead" is how a
 * sheet with a sixth special row eventually gets read off-by-one.
 */
export const UNIT_ANIM = {
  idle: 0,
  walk: 1,
  attack: 2,
  hurt: 3,
  death: 4,
} as const

export type AnimName = keyof typeof UNIT_ANIM

/** Frames per second for the 4-frame cycles. Slow — the art is 4 frames. */
export const ANIM_FPS = 6

/** What a unit is for. Drives targeting preference and nothing else. */
export type Role = 'foot' | 'ranged' | 'fast' | 'bearer' | 'tower' | 'siege'

export interface UnitStats {
  role: Role
  hp: number
  /** Damage per second while in range of its target. */
  dps: number
  /** Attack reach in world units. */
  range: number
  /** Movement speed in world units per second. */
  speed: number
  /** Card scale multiplier. Big monsters should look like big monsters. */
  scale: number
}

/**
 * The four line units, before a sprite is attached.
 *
 * Melee reach is 2 units — about one body width at the shared pixel scale, so
 * "in range" looks like contact rather than like two figures swinging at each
 * other across a gap.
 *
 * Ranged reach is deliberately small, and this is the number the whole combat
 * scale is built around. A battle has to *fit on screen*: an archer that opened
 * fire at 40 units started fights well outside the frame at the follow camera,
 * so the player heard about a battle in the army panel rather than watching one.
 * At 16 the archers are a visible step behind their own front line rather than
 * a separate event happening somewhere off-camera.
 */
export const ARCHETYPE: Record<Role, UnitStats> = {
  foot: { role: 'foot', hp: 60, dps: 6, range: 2, speed: 4, scale: 1 },
  ranged: { role: 'ranged', hp: 35, dps: 8, range: 16, speed: 4, scale: 1 },
  // Twice the march speed, which is what lets it get across a fight and onto
  // the enemy's ranged line — the job the full doc gives the fast slot.
  fast: { role: 'fast', hp: 45, dps: 8, range: 2, speed: 8, scale: 1 },
  // A non-combatant. Zero dps is load-bearing: the rout rule below reads "if the
  // bearer is the last one alive", and a bearer that could win a fight on its
  // own would make that unreachable.
  bearer: { role: 'bearer', hp: 40, dps: 0, range: 0, speed: 4, scale: 0.9 },
  /**
   * A fort tower, and the number the whole siege system hangs off.
   *
   * Two of these measure 600 x 24 = 14,400 by `groupPower` below — about 1.6
   * armies. That is deliberate and it is the keystone of `second-playable.md`:
   * one ordinary army must *fail* against a forted city, or siege is a solution
   * with no problem. At the old 200/10 a fort came to 8,000, slightly weaker
   * than the single army sent to take it, and nobody would ever have built a
   * trebuchet.
   *
   * The 30-unit reach is what a trebuchet's 55 has to beat.
   */
  tower: { role: 'tower', hp: 300, dps: 12, range: 30, speed: 0, scale: 1 },
  /**
   * The trebuchet. Three numbers, each doing one job.
   *
   * 40 damage against a 300-hit-point tower is 7.5 seconds a tower, against a
   * fort that repairs itself whole in 45 — siege out-damages repair about six to
   * one, which is what makes it the *only* way one city cracks another.
   *
   * 55 reach beats the tower's 30, so the engine works from outside the fort's
   * answer and the defender has to come out. That is the full doc's "compels the
   * opponent to respond with an army", arrived at from geometry rather than
   * asserted.
   *
   * And 80 health means the sortie that reaches it wins: one fast unit kills it
   * in ten seconds. Strong, slow and fragile at once is the only version of
   * siege that starts a fight instead of ending one.
   */
  siege: { role: 'siege', hp: 80, dps: 40, range: 55, speed: 4, scale: 1.2 },
}

export interface UnitDef extends UnitStats {
  sprite: UnitKey
  name: string
}

function unit(sprite: UnitKey, name: string, role: Role, over: Partial<UnitStats> = {}): UnitDef {
  return { ...ARCHETYPE[role], ...over, sprite, name }
}

/**
 * What a Monster Graveyard sends to the city that links it.
 *
 * A seventh body in an army that otherwise has six, and the first unit in the
 * game that is not bought — it arrives because of something you connected on
 * the map, which is the whole argument for connection resources being more
 * interesting than a stockpile.
 *
 * From the unused `wizards` roster, so that a wild thing never reads as any
 * faction's own troops — the same rule the Great Elf garrisons follow.
 *
 * Deliberately *not* a new role. It fights as heavy infantry, which means the
 * rout rule already counts it as a fighter and the damage model already knows
 * what to do with it. This is one strong unit on one condition, not the special
 * unit *system*, which is still deferred with artifacts and heroes.
 */
export const GRAVEYARD_MONSTER: UnitDef = unit('unit.wizards.golem', 'Golem', 'foot', {
  hp: 180,
  dps: 16,
  scale: 1.3,
})

/** A wizard's army, in the order units are spawned. */
export interface ArmyRoster {
  /** Three foot, one ranged, one fast, one bearer — the full doc's §4.1 default. */
  foot: UnitDef
  ranged: UnitDef
  fast: UnitDef
  bearer: UnitDef
}

export interface FactionDef {
  id: string
  name: string
  /** Ground-disc and HUD colour. */
  tint: number
  /** The `city.*` sprite its capital is drawn with. */
  city: 'city.castle' | 'city.necropolis' | 'city.stronghold'
  /** The creature that stands in for this faction's wizard. */
  wizard: UnitKey
  roster: ArmyRoster
}

/**
 * The three playable wizards.
 *
 * The player is Castle because it is the one roster the pack draws with a full
 * nine tiers and the most legible silhouettes; the two AI wizards are the two
 * rosters that read least like it at a glance, which matters more than balance
 * when three armies can meet in the same valley.
 *
 * `wizard` is a creature sprite because the pack has no wizard: the `wizards/`
 * folder's mage sheet is a duplicate of the djinn's, and only the mage *icons*
 * are real (see `tools/spriteManifest.mjs`). A lich and a shaman are the two
 * sheets that read as spellcasters, so the AI wizards fly as those. The player's
 * own wizard is the 3D carpet avatar and needs no sprite at all.
 */
export const FACTIONS: FactionDef[] = [
  {
    id: 'castle',
    name: 'Castle',
    tint: 0x4a80c0,
    city: 'city.castle',
    wizard: 'unit.castle.monk',
    roster: {
      foot: unit('unit.castle.swordsman', 'Swordsman', 'foot'),
      ranged: unit('unit.castle.archer', 'Archer', 'ranged'),
      fast: unit('unit.castle.cavalier', 'Cavalier', 'fast'),
      bearer: unit('unit.castle.peasant', 'Bearer', 'bearer'),
    },
  },
  {
    id: 'necropolis',
    name: 'Necropolis',
    tint: 0x9c5fc0,
    city: 'city.necropolis',
    wizard: 'unit.necropolis.lich',
    roster: {
      foot: unit('unit.necropolis.zombie', 'Zombie', 'foot'),
      ranged: unit('unit.necropolis.ghost', 'Ghost', 'ranged'),
      fast: unit('unit.necropolis.spider', 'Spider', 'fast'),
      bearer: unit('unit.necropolis.skeleton', 'Bearer', 'bearer'),
    },
  },
  {
    id: 'stronghold',
    name: 'Stronghold',
    tint: 0xc06a3a,
    city: 'city.stronghold',
    wizard: 'unit.stronghold.shaman',
    roster: {
      foot: unit('unit.stronghold.wolf_rider', 'Wolf Rider', 'foot'),
      ranged: unit('unit.stronghold.centaur', 'Centaur', 'ranged'),
      fast: unit('unit.stronghold.harpy', 'Harpy', 'fast'),
      bearer: unit('unit.stronghold.goblin', 'Bearer', 'bearer'),
    },
  },
]

/** Neutral ground colour, for anything nobody owns. */
export const NEUTRAL_TINT = 0x9aa4ae

/**
 * What defends each kind of site.
 *
 * Drawn from the rosters no wizard uses, so "wild" never looks like somebody's
 * army — a player who sees centaurs knows Stronghold is here, and that reading
 * has to stay reliable. Great Elf holds the towns, elementals the mines, and the
 * demons of the Dark Bastion the lairs.
 */
/**
 * Roughly how hard a group is to kill, for sizing garrisons against armies.
 *
 * Lanchester's square law, which is the right model here because everything
 * targets the nearest enemy and fights to the death: the winner of an attrition
 * fight is the side with the greater `total damage x total health`, not the
 * side with more of either alone. Halving a group's health hurts it exactly as
 * much as halving its damage, and a group with both is four times the problem.
 *
 * The bearer contributes health and no damage, so it correctly counts for
 * nothing here — an army is five fighting units and a flag.
 *
 * A standard six-unit army measures **8,840** — 260 health by 34 damage, the
 * bearer correctly counting for nothing. The garrison tables below are written
 * as multiples of that, which is the only way these numbers mean anything: a
 * lair is not "325 hit points", it is "four fifths of an army".
 *
 * That figure was wrong in `docs/first-playable.md` (it said 5,700) and the
 * multiples quoted in the tables below were scaled to it. The garrisons play
 * well and none of them changed; the labels did. `docs/second-playable.md` §1
 * carries the corrected table, and the old doc now says so at the point of use.
 */
export function groupPower(units: readonly UnitDef[]): number {
  let hp = 0
  let dps = 0
  for (const u of units) {
    if (u.dps <= 0) continue
    hp += u.hp
    dps += u.dps
  }
  return hp * dps
}

/** A standard six-unit army, by `groupPower`. The unit every garrison is quoted in. */
export const ARMY_POWER = 8840

/**
 * Difficulty bands, in multiples of a standard army.
 *
 * Absolute, never relative to what the player currently fields. A lair reads
 * three stars in minute two and in minute fifty, which is the whole point: the
 * rating is something you learn once rather than a moving judgement about your
 * present army. The alternative — scoring against your strongest troops — makes
 * the same building read differently every ten minutes and teaches nothing.
 *
 * Every band is occupied by something on the board, so all five stars mean
 * something rather than the top two being decorative.
 */
const STAR_BANDS = [0.25, 0.6, 1.0, 1.8]

/**
 * How hard this garrison is, from one star to five.
 *
 * Lives here rather than in the UI because it is a reading of the tables
 * directly above it, and a copy kept anywhere else would quietly stop matching
 * them the first time a garrison is retuned. A wrong star is worse than none:
 * it is the game telling the player something false about what they are about
 * to fly into.
 */
export function starsFor(units: readonly UnitDef[]): number {
  const armies = groupPower(units) / ARMY_POWER
  let stars = 1
  for (const band of STAR_BANDS) {
    if (armies > band) stars++
  }
  return Math.min(5, stars)
}

export const GARRISONS: Record<string, UnitDef[]> = {
  /**
   * A neutral town. ~0.35 armies: one healthy army takes it and walks away with
   * casualties, which is what "the primary expansion mechanism" has to mean.
   *
   * This was four defenders including a second archer — a near-run thing that
   * cost five of six units every time. Expansion that has to be paid for with a
   * whole army does not happen twice, and the whole opening of the match is
   * built on it happening repeatedly.
   */
  town: [
    unit('unit.greatElf.dwarf', 'Dwarf', 'foot'),
    unit('unit.greatElf.hunter', 'Hunter', 'ranged'),
    unit('unit.greatElf.deer', 'Stag', 'fast'),
  ],
  /**
   * A bandit camp, ~0.14 armies and the smallest fight on the board.
   *
   * Melee only, and that is the whole design: three imps cannot answer a wizard
   * who stands at the edge of the 24-unit pad and throws, because the wizard's
   * reach is 15 and theirs is contact. So a camp is the one site a wizard clears
   * alone without spending health — the mana is the price — which is what gives
   * the opening minutes something to do that is not escorting an army.
   *
   * Weak individually on purpose too: 40 HP is under two fireballs, so the fight
   * is short enough to be worth flying to.
   */
  camp: [
    unit('unit.darkBastion.imp', 'Imp', 'foot', { hp: 40, dps: 4, scale: 0.85 }),
    unit('unit.darkBastion.imp', 'Imp', 'foot', { hp: 40, dps: 4, scale: 0.85 }),
    unit('unit.darkBastion.imp', 'Imp', 'foot', { hp: 40, dps: 4, scale: 0.85 }),
  ],
  /** A gold vein, ~0.15 armies. Soloable by a careful wizard, trivial to an army. */
  mine: [
    unit('unit.elementals.stone_elemental', 'Stone Elemental', 'foot'),
    unit('unit.elementals.fire_elemental', 'Fire Elemental', 'ranged'),
  ],
  /**
   * A connection resource, ~0.53 armies.
   *
   * Harder than a town on purpose. A town is the primary expansion mechanism
   * and has to stay repeatably affordable; a node is optional, permanent, and
   * buffs every army a city ever fields, so it should cost a real fight. Great
   * Elf again, because "wild" has to keep reading as wild.
   */
  node: [
    unit('unit.greatElf.treant', 'Treant', 'foot', { hp: 100, dps: 10, scale: 1.2 }),
    unit('unit.greatElf.satyr', 'Satyr', 'fast'),
    unit('unit.greatElf.druid', 'Druid', 'ranged'),
  ],
  /** A lair, ~0.81 armies: two armies, or one and a wizard willing to spend mana. */
  lair: [
    unit('unit.darkBastion.hell_hound', 'Hell Hound', 'fast'),
    unit('unit.darkBastion.gog', 'Gog', 'ranged'),
    unit('unit.darkBastion.demon', 'Demon', 'foot'),
    unit('unit.darkBastion.pit_fiend', 'Pit Fiend', 'foot', { hp: 90, dps: 9 }),
  ],
  /**
   * A Point of Power, ~1.21 armies — and it comes back for whoever holds it.
   *
   * Deliberately out of reach of the one army a starting wizard has. Taking a
   * point is the thing a second and third city are *for*.
   */
  point: [
    unit('unit.elementals.magma_elemental', 'Magma Elemental', 'foot', { hp: 90, dps: 9 }),
    unit('unit.elementals.storm_elemental', 'Storm Elemental', 'ranged', { hp: 50 }),
    unit('unit.elementals.ice_elemental', 'Ice Elemental', 'fast'),
    unit('unit.elementals.diamond_elemental', 'Diamond Elemental', 'foot', { hp: 120, dps: 10 }),
  ],
  /**
   * A monument, ~0.72 armies — between a node and a lair.
   *
   * It has to need an army. A monument's buff lands on the wizard's whole realm
   * for as long as it is held, which is a bigger prize than any single city's
   * node, so it cannot be something a wizard picks up alone on the way past.
   * Ranged defenders are what enforce that: a stand-off does not work here the
   * way it does at a camp.
   *
   * The four elementals nobody else uses. Elementals already hold the mines and
   * the Points of Power, so bound spirits guarding a temple reads as the same
   * kind of wild magic rather than as a new faction nobody has met.
   */
  monument: [
    unit('unit.elementals.water_elemental', 'Water Elemental', 'foot', { hp: 75, dps: 8 }),
    unit('unit.elementals.mind_elemental', 'Mind Elemental', 'ranged', { hp: 40, dps: 8 }),
    unit('unit.elementals.magic_elemental', 'Magic Elemental', 'ranged', { hp: 40, dps: 9 }),
    unit('unit.elementals.wind_elemental', 'Wind Elemental', 'fast', { hp: 45, dps: 7 }),
  ],
  /**
   * The six outpost patrols — each one a building's garrison *and* the thing
   * that building sells.
   *
   * What guards it is what you get, so the player learns each outpost's price
   * by fighting it once. All six come from the `wizards` roster and the Great
   * Elf leftovers, which no faction fields: a hired thing must not read as a
   * raised thing, the same rule `GRAVEYARD_MONSTER` follows for the same
   * reason. Ownership is legible from the tint disc and the banner, as it is
   * for every other site on the board.
   *
   * They answer six different questions rather than sitting on one power
   * curve — the cheapest is not simply the worst.
   */
  /** The default line. Two bodies and something that reaches. ~0.35 armies. */
  'outpost.watchfort': [
    unit('unit.wizards.gargoyle', 'Gargoyle', 'foot', { hp: 70, dps: 7 }),
    unit('unit.wizards.gargoyle', 'Gargoyle', 'foot', { hp: 70, dps: 7 }),
    unit('unit.wizards.naga', 'Naga', 'ranged', { hp: 45, dps: 10 }),
  ],
  /** One expensive heavy hitter. ~0.30 armies in a single body. */
  'outpost.arena': [
    unit('unit.wizards.titan', 'Titan', 'foot', { hp: 160, dps: 16, scale: 1.3 }),
  ],
  /** The cheapest thing on the board. Kills wagons; loses to armies. ~0.12. */
  'outpost.wayhouse': [
    unit('unit.wizards.gremlin', 'Gremlin', 'foot', { hp: 35, dps: 5, scale: 0.85 }),
    unit('unit.wizards.gremlin', 'Gremlin', 'foot', { hp: 35, dps: 5, scale: 0.85 }),
    unit('unit.wizards.gremlin', 'Gremlin', 'foot', { hp: 35, dps: 5, scale: 0.85 }),
  ],
  /** Fast raiders that run down stragglers and caravans. ~0.22 armies. */
  'outpost.blackMarket': [
    unit('unit.wizards.lion', 'Manticore', 'fast', { hp: 65, dps: 11 }),
    unit('unit.wizards.lion', 'Manticore', 'fast', { hp: 65, dps: 11 }),
  ],
  /** Armoured, slow, hard to shift. ~0.29 armies of pure staying power. */
  'outpost.warren': [
    unit('unit.greatElf.dwarf', 'Dwarf', 'foot', { hp: 90, dps: 6, speed: 3 }),
    unit('unit.greatElf.dwarf', 'Dwarf', 'foot', { hp: 90, dps: 6, speed: 3 }),
    unit('unit.greatElf.dwarf', 'Dwarf', 'foot', { hp: 90, dps: 6, speed: 3 }),
  ],
  /** Reach, with something small and quick in front of it. ~0.26 armies. */
  'outpost.wardens': [
    unit('unit.wizards.djinn', 'Djinn', 'ranged', { hp: 60, dps: 12 }),
    unit('unit.greatElf.pixie', 'Pixie', 'fast', { hp: 35, dps: 6 }),
  ],
  /**
   * The hardest garrison on the map, ~2.49 armies, guarding the central points.
   * Deliberately not clearable by one army, or by two.
   */
  dragon: [
    unit('unit.darkBastion.devil', 'Devil', 'foot', { hp: 140, dps: 14, scale: 1.25 }),
    unit('unit.darkBastion.efreet', 'Efreet', 'ranged', { hp: 70, dps: 11 }),
    unit('unit.darkBastion.efreet', 'Efreet', 'ranged', { hp: 70, dps: 11 }),
    unit('unit.darkBastion.pit_fiend', 'Pit Fiend', 'foot', { hp: 90, dps: 9 }),
    unit('unit.darkBastion.hell_hound', 'Hell Hound', 'fast'),
  ],
}
