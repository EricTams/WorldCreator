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
export type Role = 'foot' | 'ranged' | 'fast' | 'bearer' | 'tower'

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
 */
export const ARCHETYPE: Record<Role, UnitStats> = {
  foot: { role: 'foot', hp: 60, dps: 6, range: 2, speed: 4, scale: 1 },
  ranged: { role: 'ranged', hp: 35, dps: 8, range: 40, speed: 4, scale: 1 },
  // Twice the march speed, which is what lets it get across a fight and onto
  // the enemy's ranged line — the job the full doc gives the fast slot.
  fast: { role: 'fast', hp: 45, dps: 8, range: 2, speed: 8, scale: 1 },
  // A non-combatant. Zero dps is load-bearing: the rout rule below reads "if the
  // bearer is the last one alive", and a bearer that could win a fight on its
  // own would make that unreachable.
  bearer: { role: 'bearer', hp: 40, dps: 0, range: 0, speed: 4, scale: 0.9 },
  tower: { role: 'tower', hp: 200, dps: 10, range: 60, speed: 0, scale: 1 },
}

export interface UnitDef extends UnitStats {
  sprite: UnitKey
  name: string
}

function unit(sprite: UnitKey, name: string, role: Role, over: Partial<UnitStats> = {}): UnitDef {
  return { ...ARCHETYPE[role], ...over, sprite, name }
}

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
 * A standard army measures about 5700. The garrison tables below are written as
 * multiples of that, which is the only way these numbers mean anything: a lair
 * is not "325 hit points", it is "one and a quarter armies".
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

export const GARRISONS: Record<string, UnitDef[]> = {
  /**
   * A neutral town. ~0.55 armies: one healthy army takes it and walks away with
   * casualties, which is what "the primary expansion mechanism" has to mean.
   *
   * This was four defenders including a second archer, and measured out at 0.9
   * armies — a near-run thing that cost five of six units every time. Expansion
   * that has to be paid for with a whole army does not happen twice, and the
   * whole opening of the match is built on it happening repeatedly.
   */
  town: [
    unit('unit.greatElf.dwarf', 'Dwarf', 'foot'),
    unit('unit.greatElf.hunter', 'Hunter', 'ranged'),
    unit('unit.greatElf.deer', 'Stag', 'fast'),
  ],
  /** A gold vein, ~0.23 armies. Soloable by a careful wizard, trivial to an army. */
  mine: [
    unit('unit.elementals.stone_elemental', 'Stone Elemental', 'foot'),
    unit('unit.elementals.fire_elemental', 'Fire Elemental', 'ranged'),
  ],
  /** A lair, ~1.25 armies: two armies, or one and a wizard willing to spend mana. */
  lair: [
    unit('unit.darkBastion.hell_hound', 'Hell Hound', 'fast'),
    unit('unit.darkBastion.gog', 'Gog', 'ranged'),
    unit('unit.darkBastion.demon', 'Demon', 'foot'),
    unit('unit.darkBastion.pit_fiend', 'Pit Fiend', 'foot', { hp: 90, dps: 9 }),
  ],
  /**
   * A Point of Power, ~1.9 armies — and it comes back for whoever holds it.
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
   * The hardest garrison on the map, ~3.8 armies, guarding the central points.
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
