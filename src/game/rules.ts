/**
 * Every number the match is played on, in one table.
 *
 * This is `docs/first-playable.md` §10 plus `docs/second-playable.md` §11. Kept
 * together deliberately: these are tuning values chosen to be *consistent*
 * rather than correct, and they are meaningless individually — fireball damage
 * only means something against the unit HP it is aimed at, and mana regen only
 * means something against the fireball cost. Tuning is editing this file, not
 * hunting through the systems that read it.
 *
 * It lives apart from `sim.ts` for the same reason: the numbers are the part a
 * designer edits, and they should not require scrolling past sixteen hundred
 * lines of simulation to find.
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
    /**
     * Gold per second, by tier. A Village pays 10 a minute, a City 20.
     *
     * Tiering up never pays for itself on income alone inside a match — the
     * ~18 minutes it takes to earn back 200 gold is most of the game. You tier
     * up for what it unlocks; the income is a consolation prize, and it is
     * meant to read that way.
     */
    income: [10 / 60, 15 / 60, 20 / 60],
    /** Extra gold per second once a Market stands. */
    marketIncome: 10 / 60,
    /** Cost, seconds, of each queue item. */
    build: {
      army: { gold: 100, time: 60, label: 'Train Army', tier: 1 },
      shrine: { gold: 100, time: 60, label: 'Shrine', tier: 1 },
      tier: { gold: 0, time: 0, label: 'Tier Up', tier: 1 },
      fort: { gold: 150, time: 90, label: 'Fort', tier: 2 },
      market: { gold: 150, time: 75, label: 'Market', tier: 2 },
      caravan: { gold: 50, time: 30, label: 'Caravan', tier: 2 },
      siegeWorks: { gold: 250, time: 90, label: 'Siege Works', tier: 3 },
      trebuchet: { gold: 200, time: 90, label: 'Trebuchet', tier: 3 },
      /**
       * Free, auto-queued, and the only item that yields to anything else.
       *
       * A city with broken walls and an idle queue fixes them; a city with
       * something better to do builds that instead. That one rule is what makes
       * an attack too weak to win still worth launching — it is the full doc's
       * §4.5 economic suppression, and it costs one flag on one queue item.
       */
      repair: { gold: 0, time: 45, label: 'Repair', tier: 1 },
    },
    /**
     * Cost and time to reach the next tier, indexed by the tier being left.
     *
     * City was 400 and is now 300 — the one price this milestone moved, and the
     * only one it needed to. Tier 3 gates the Siege Works, which gates the
     * trebuchet, so 400 was the first of three payments totalling nine hundred
     * gold before an engine could exist at all; measured over eight unattended
     * matches, half the wizards never made the first one. At 300 the ladder
     * reaches tier 3 for twelve wizards in twenty-four rather than ten, the
     * earliest by minute eleven, and engines start appearing in matches nobody
     * is steering. `second-playable.md` §10 offered this as one of three guesses
     * at the pacing problem; it turned out not to be the problem, but it is a
     * real part of the fix.
     */
    tierUp: [
      { gold: 200, time: 90 },
      { gold: 300, time: 120 },
    ],
  },
  mine: { income: 15 / 60 },
  /**
   * The connection resources, and what a live link does to its city.
   *
   * Binary: on while the caravan runs, off the instant it dies. Three buffs
   * that answer three different questions — hit harder, arrive sooner, come
   * back cheaper — which is what makes "which node do I want" a real question
   * rather than a shopping list.
   */
  node: {
    /** Damage multiplier for units from a Mithril-linked city. */
    mithrilDamage: 1.3,
    /** March multiplier for armies from a Horse-Plains-linked city. */
    horseMarch: 1.3,
    /** Reconstitution cost and time multiplier at a Granary-linked city. */
    granaryRecon: 0.6,
    /**
     * What a Ley-Spring-linked city's Shrine is worth, as a multiple.
     *
     * The one node that is worth nothing on its own: no Shrine, no effect. That
     * is deliberate — it is the first connection whose value depends on what
     * has already been built, which makes linking it a decision about the city
     * rather than a decision about the map.
     */
    leyShrine: 2,
    /** Trebuchet cost and build-time multiplier at an Ironwood-linked city. */
    ironwoodCost: 0.6,
    /** Trebuchet health multiplier at an Ironwood-linked city. */
    ironwoodHp: 1.5,
    /**
     * Crystal Fissure: extra wizard max mana, and like a Ley Spring it needs
     * the linked city to have a Shrine — the pool is a property of what you
     * have built, not of what you have merely walked past.
     */
    crystalMana: 25,
    /** Gem Pit: health multiplier on this city's army — Mithril's mirror. */
    gemHp: 1.3,
    /** Sulfur Vent: damage multiplier on this city's ranged unit only. */
    sulfurRanged: 1.5,
    /** Quicksilver Spring: build-time multiplier for everything this city makes. */
    quicksilverTime: 0.75,
  },
  caravan: {
    /** Wagon health. Unarmed: anything hostile kills it in seconds. */
    hp: 60,
    /** Wagon speed, slower than a marching army. */
    speed: 3,
  },
  /**
   * What holding each monument is worth, for as long as you hold it.
   *
   * Every one of these pays the *wizard* rather than a city, which is the axis
   * the board was missing: a node buffs the town it supplies and a mine feeds
   * the gold pile, so until now the only thing on the map addressed to the one
   * piece the player actually controls was a Point of Power.
   *
   * They answer eight different questions on purpose — cast more, hit more
   * often, survive more, see more, come back closer, come back sooner, claim
   * faster, earn more — so which monument is worth a march is a decision rather
   * than a strictly-better list.
   *
   * Nothing here regrows a garrison. A monument you hold is defended by
   * whatever you left standing on it and by nothing else, which is what makes
   * an outpost next door worth taking.
   */
  monument: {
    /** Temple: mana a second, on top of the base 2 and any shrines. */
    templeMana: 3,
    /** Oasis: what the wizard's health ceiling becomes. */
    oasisHp: 150,
    /** Observatory: world units of map kept permanently revealed. */
    observatoryReveal: 400,
    /** Library: seconds to respawn, instead of `wizard.respawn`. */
    libraryRespawn: 7,
    /** Sphinx: multiplier on the consecration channel. */
    sphinxConvert: 0.5,
    /** Standing Shrine: multiplier on the fireball cooldown. */
    shrineCooldown: 0.6,
    /** Wayfarers' Post: extra gold per second, for every city you own. */
    tradingPostIncome: 5 / 60,
  },
  /**
   * Hiring a patrol at an outpost.
   *
   * The first place a wizard turns gold straight into soldiers without a city
   * queue. Priced off `groupPower` so the six outposts are comparable by the
   * same measure the garrison tables are written in, rather than by six numbers
   * chosen one at a time.
   *
   * A patrol that dies is gone: replacing it is a fresh purchase, which makes
   * an outpost a running cost rather than a fortification you buy once.
   */
  outpost: {
    /** Gold per 1,000 of `groupPower`, rounded to the nearest 5. */
    goldPerPower: 55,
    /** Radius of the circuit a patrol walks around its outpost. */
    beat: 100,
    /** Seconds to walk a full lap, which sets how fast it moves round it. */
    lap: 90,
  },
  siege: {
    /** The escorting army's march multiplier while a trebuchet lives. */
    march: 0.6,
  },
  startingGold: 150,
  /** Seconds for a cleared neutral garrison to come back. */
  garrisonRegen: 300,
  /** Seconds for a held Point of Power to regrow its guard for its owner. */
  pointRegen: 180,
  /** Charge percent per second, per held point: 1% per 12 s. */
  chargePerPoint: 1 / 12,
} as const

export type BuildItem = keyof typeof RULES.city.build

/** Village, Town, City — the tier a site is at, indexed from 1. */
export const TIER_NAMES = ['', 'Village', 'Town', 'City'] as const

export const MAX_TIER = 3
