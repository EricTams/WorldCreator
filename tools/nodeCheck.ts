/**
 * Does each connection resource actually do what the doc claims?
 *
 *   npm run check-nodes
 *
 * The match harness measures whether the game *paces* well; this asks the much
 * narrower question of whether a rule fires at all. Both matter and neither
 * substitutes for the other: an unattended match can look perfectly healthy
 * while a buff nobody happened to link does nothing whatsoever.
 *
 * It drives the shipped `Sim` through its public commands on a flat four-site
 * board — no terrain, no renderer — because every rule here is about links and
 * rosters rather than about ground.
 */

import { RULES } from '../src/game/rules'
import { ARMY_POWER, FACTIONS, GARRISONS, GRAVEYARD_MONSTER, groupPower, starsFor } from '../src/game/factions'
import { Sim } from '../src/game/sim'
import { MONUMENT_KINDS, OUTPOST_KINDS } from '../src/world/gameMap'
import type { MapPlan, MonumentKind, ResourceKind } from '../src/world/gameMap'
import type { TerrainFrame } from '../src/world/terrainQuery'
import { Heightmap } from '../src/world/heightmap'

function board(resource: ResourceKind, monument: MonumentKind = 'temple'): MapPlan {
  return {
    capitals: [0, 1, 2],
    sites: [
      { id: 0, kind: 'city', x: 0, z: 0, owner: 0, garrison: null, radius: 48, name: 'Home', sprite: null },
      { id: 1, kind: 'city', x: 900, z: 0, owner: 1, garrison: null, radius: 48, name: 'A', sprite: null },
      { id: 2, kind: 'city', x: -900, z: 0, owner: 2, garrison: null, radius: 48, name: 'B', sprite: null },
      { id: 3, kind: 'node', x: 120, z: 0, owner: -1, garrison: null, radius: 34, name: 'Node', sprite: 'vein.ore', resource },
      { id: 4, kind: 'monument', x: -120, z: 0, owner: -1, garrison: null, radius: 36, name: 'Monument', sprite: 'mod.temple', monument },
      { id: 5, kind: 'outpost', x: 0, z: 160, owner: -1, garrison: 'outpost.watchfort', radius: 30, name: 'Outpost', sprite: 'mod.fort', outpost: 'watchfort' },
    ],
  }
}

const flat = new Heightmap(8, new Float32Array(64).fill(0.5))
// No coastal shelf: the board is a featureless plateau well above sea level, so
// there is no shoreline for a shelf to step. Stated rather than omitted — every
// other frame in the tree carries these, and leaving them off a real island is
// what once made an audit see no land at all.
const frame: TerrainFrame = {
  heightmap: flat,
  cellSize: 100,
  heightScale: 100,
  seaLevel: 0.1,
  shelfRise: 0,
  shelfBand: 0,
}

/** A sim with faction 0 rich and its capital grown, so orders are never refused for price. */
function rig(resource: ResourceKind, monument: MonumentKind = 'temple'): Sim {
  const sim = new Sim({ onRespawn: () => {}, onMessage: () => {}, allAi: false })
  sim.reset(board(resource, monument))
  const home = sim.siteById(0)!
  home.tier = 3
  sim.wizards[0].gold = 9999
  return sim
}

/** Step until `done`, or give up. Returns whether it happened. */
function until(sim: Sim, done: () => boolean, seconds = 900): boolean {
  for (let i = 0; i < seconds * 10 && !done(); i++) sim.update(0.1, frame, 0, 0, 0)
  return done()
}

/**
 * Fly the wizard to a site and consecrate it, through the shipped commands.
 *
 * The player wizard's position is whatever `update` is told it is, so holding
 * the same coordinates for the length of the channel is what standing still
 * means here. Written the long way round rather than assigning `site.owner`,
 * because "a node must be consecrated before it can be linked" is one of the
 * rules under test — a harness that sets ownership directly would pass whether
 * or not the rule survived.
 */
function consecrate(sim: Sim, siteId: number, seconds = 60): boolean {
  const site = sim.siteById(siteId)!
  const w = sim.player
  for (let i = 0; i < seconds * 10 && site.owner !== w.faction; i++) {
    sim.update(0.1, frame, site.x, site.z, 0)
    if (w.channelSiteId !== site.id && sim.canConvert(w, site)) sim.beginConvert(w, site)
  }
  return site.owner === w.faction
}

/**
 * Take the node, then commission a caravan and run until the link is live.
 *
 * Two steps, because they answer two questions: consecration decides *whose*
 * the node is, and the caravan decides *which city* it supplies.
 */
function link(sim: Sim, resource: ResourceKind): boolean {
  if (!consecrate(sim, 3)) return false
  sim.queueBuild(sim.siteById(0)!, 'caravan', 3)
  return until(sim, () => sim.linkedTo(0, resource))
}

/**
 * Wipe the home army so the next `raiseArmy` is a real rebuild.
 *
 * Every wizard opens with an army already standing at home, and a whole army
 * is refused a reconstitution with 'Army ready' — so a test that links a node
 * and then asks for troops gets the ones it already had, built before the link
 * existed, and every buff reads as doing nothing.
 */
function wipeArmy(sim: Sim): void {
  const army = sim.siteById(0)!.army
  if (!army) return
  // Health, not the `dead` flag: `armyStrength` measures hit points, so an army
  // of corpses at full HP still reports as whole and the rebuild is refused
  // with 'Army ready'.
  for (const u of army.units) u.hp = 0
  sim.update(0.1, frame, 0, 0, 0)
}

/** Build (or rebuild) the home army and run until it is standing there. */
function raiseArmy(sim: Sim): void {
  const home = sim.siteById(0)!
  sim.wizards[0].gold = 9999
  sim.queueBuild(home, 'army')
  until(sim, () => home.queue === null)
  if (home.army) home.army.order = 'idle'
}

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label} — ${detail}`)
}

console.log('\nLey Spring — a linked city doubles what its Shrine contributes')
{
  const plainSim = rig('mithril')
  plainSim.siteById(0)!.shrine = true
  plainSim.wizards[0].mana = 0
  plainSim.update(1, frame, 0, 0, 0)
  const plain = plainSim.wizards[0].mana

  const sim = rig('ley')
  sim.siteById(0)!.shrine = true
  const linked = link(sim, 'ley')
  sim.wizards[0].mana = 0
  sim.update(1, frame, 0, 0, 0)
  const ley = sim.wizards[0].mana

  check(
    'shrine regen doubles',
    linked && Math.abs(ley - plain - RULES.wizard.manaPerShrine) < 0.05,
    `+${plain.toFixed(2)}/s plain, +${ley.toFixed(2)}/s linked`,
  )

  const noShrine = rig('ley')
  const linked2 = link(noShrine, 'ley')
  noShrine.wizards[0].mana = 0
  noShrine.update(1, frame, 0, 0, 0)
  check(
    'worth nothing without one',
    linked2 && noShrine.wizards[0].mana < plain,
    `+${noShrine.wizards[0].mana.toFixed(2)}/s linked but shrineless`,
  )
}

console.log('\nIronwood Grove — cheaper engines that stand up longer')
{
  const sim = rig('ironwood')
  const home = sim.siteById(0)!
  home.siegeWorks = true
  const plainCost = sim.buildSpec(home, 'trebuchet').gold
  const linked = link(sim, 'ironwood')
  const cheapCost = sim.buildSpec(home, 'trebuchet').gold
  check(
    'trebuchet costs less',
    linked && cheapCost === Math.round(plainCost * RULES.node.ironwoodCost),
    `${plainCost}g plain, ${cheapCost}g with a Grove`,
  )

  raiseArmy(sim)
  sim.queueBuild(home, 'trebuchet')
  until(sim, () => !!home.army && Sim.hasSiege(home.army))
  const engine = home.army?.units.find((u) => u.def.role === 'siege')

  const plainSim = rig('mithril')
  const plainHome = plainSim.siteById(0)!
  plainHome.siegeWorks = true
  raiseArmy(plainSim)
  plainSim.queueBuild(plainHome, 'trebuchet')
  until(plainSim, () => !!plainHome.army && Sim.hasSiege(plainHome.army))
  const plainEngine = plainHome.army?.units.find((u) => u.def.role === 'siege')

  check(
    'trebuchet is sturdier',
    !!engine && !!plainEngine && engine.def.hp === Math.round(plainEngine.def.hp * RULES.node.ironwoodHp),
    `${plainEngine?.def.hp ?? '—'} HP plain, ${engine?.def.hp ?? '—'} HP with a Grove`,
  )
  // The buff is a clone. If it were written onto the shared archetype instead,
  // this unlinked engine would have come out buffed too.
  check(
    'shared archetype untouched',
    plainEngine?.def.hp === 80,
    `an unlinked city still builds an ${plainEngine?.def.hp ?? '—'} HP engine`,
  )
}

console.log('\nMonster Graveyard — a seventh unit that outlives its link')
{
  const sim = rig('monster')
  const home = sim.siteById(0)!
  const linked = link(sim, 'monster')
  raiseArmy(sim)
  const count = () => home.army!.units.filter((u) => u.def === GRAVEYARD_MONSTER).length
  const living = () => home.army!.units.filter((u) => u.def === GRAVEYARD_MONSTER && !u.dead).length

  check('a golem joins', linked && count() === 1, `${count()} golem in a ${home.army!.units.length}-unit army`)

  raiseArmy(sim)
  check('never duplicated', count() === 1, `${count()} after reconstituting while linked`)

  // Kill the wagon: the link severs, and the golem must not fall over with it.
  for (const c of sim.caravans) c.unit.hp = 0
  until(sim, () => !sim.linkedTo(0, 'monster'), 30)
  check('survives the sever', living() === 1, `${living()} still standing once the wagon is dead`)

  raiseArmy(sim)
  check('kept, not re-raised', count() === 1, `${count()} after reconstituting unlinked — the same one`)

  const never = rig('mithril')
  raiseArmy(never)
  const none = never.siteById(0)!.army!.units.filter((u) => u.def === GRAVEYARD_MONSTER).length
  check('none without a link', none === 0, `${none} golems at an unlinked city`)
}

console.log('\nCamps — a garrison the wizard can out-range')
{
  const camp = GARRISONS.camp
  const roster = FACTIONS[0].roster
  const army = groupPower([roster.foot, roster.foot, roster.foot, roster.ranged, roster.fast, roster.bearer])
  const power = groupPower(camp)
  check('small enough to solo', power / army < 0.2, `${power} = ${(power / army).toFixed(2)} armies`)
  check(
    'melee only',
    camp.every((u) => u.range <= 4),
    `longest reach ${Math.max(...camp.map((u) => u.range))}, wizard reaches ${RULES.castRange}`,
  )
  // The stand-off ring `ai.ts` uses has to sit outside a defender's leash and
  // still inside the wizard's reach of it, or "melee only" means nothing.
  const pad = 24
  const leash = pad * 0.8
  const stand = pad + 4
  check(
    'stand-off geometry holds',
    stand - leash > 2 && stand - leash < RULES.castRange,
    `wizard ${stand} out, defenders reach ${leash.toFixed(1)}, gap ${(stand - leash).toFixed(1)} vs reach ${RULES.castRange}`,
  )
}

console.log('\nThe four new nodes — and the archetypes they must not touch')
{
  // Gem Pit: this city's army is sturdier, and nobody else's is.
  const gem = rig('gem')
  link(gem, 'gem')
  wipeArmy(gem)
  raiseArmy(gem)
  const gemFoot = gem.siteById(0)!.army!.units.find((u) => u.def.role === 'foot')!
  const plainArmy = rig('mithril')
  wipeArmy(plainArmy)
  raiseArmy(plainArmy)
  const plainFoot = plainArmy.siteById(0)!.army!.units.find((u) => u.def.role === 'foot')!
  check(
    'a Gem Pit toughens the army',
    gemFoot.def.hp === Math.round(plainFoot.def.hp * RULES.node.gemHp),
    `${plainFoot.def.hp} HP plain, ${gemFoot.def.hp} HP linked`,
  )
  // The archetype is shared by every army of that faction on the map. If the
  // buff had been written onto it rather than onto a clone, this untouched
  // roster entry would carry it too.
  check(
    'the shared roster is untouched',
    FACTIONS[0].roster.foot.hp === plainFoot.def.hp,
    `roster still ${FACTIONS[0].roster.foot.hp} HP`,
  )

  // Sulfur Vent: the ranged unit hits harder and only the ranged unit does.
  const sulfur = rig('sulfur')
  link(sulfur, 'sulfur')
  wipeArmy(sulfur)
  raiseArmy(sulfur)
  const units = sulfur.siteById(0)!.army!.units
  const ranged = units.find((u) => u.def.role === 'ranged')!
  const foot = units.find((u) => u.def.role === 'foot')!
  check(
    'a Sulfur Vent sharpens the ranged line',
    ranged.def.dps === Math.round(FACTIONS[0].roster.ranged.dps * RULES.node.sulfurRanged),
    `${FACTIONS[0].roster.ranged.dps} dps plain, ${ranged.def.dps} dps linked`,
  )
  check(
    'and nothing else in the army',
    foot.def.dps === FACTIONS[0].roster.foot.dps,
    `foot still ${foot.def.dps} dps`,
  )

  // Quicksilver Spring: everything this city builds arrives sooner.
  const quick = rig('quicksilver')
  const quickHome = quick.siteById(0)!
  quickHome.siegeWorks = true
  const before = quick.buildSpec(quickHome, 'shrine').time
  link(quick, 'quicksilver')
  const after = quick.buildSpec(quickHome, 'shrine').time
  check(
    'a Quicksilver Spring shortens the queue',
    after === Math.round(before * RULES.node.quicksilverTime),
    `${before}s plain, ${after}s linked`,
  )

  // Crystal Fissure: a deeper pool, and nothing at all without a Shrine.
  const crystal = rig('crystal')
  crystal.siteById(0)!.shrine = true
  const baseCap = crystal.wizardCaps(crystal.player).mana
  link(crystal, 'crystal')
  check(
    'a Crystal Fissure deepens the pool',
    crystal.wizardCaps(crystal.player).mana === baseCap + RULES.node.crystalMana,
    `${baseCap} plain, ${crystal.wizardCaps(crystal.player).mana} linked`,
  )
  const noShrine = rig('crystal')
  link(noShrine, 'crystal')
  check(
    'and nothing without a Shrine',
    noShrine.wizardCaps(noShrine.player).mana === RULES.wizard.mana,
    `${noShrine.wizardCaps(noShrine.player).mana} linked but shrineless`,
  )
}

console.log('\nMonuments — realm buffs that last exactly as long as you hold them')
{
  // Each one is measured against the same rig without it, and then measured
  // again after the site changes hands. A buff that fires but never stops is
  // the more dangerous half of the bug, and it is invisible in a match.
  const held = (kind: MonumentKind): Sim => {
    const sim = rig('mithril', kind)
    consecrate(sim, 4)
    return sim
  }

  const temple = held('temple')
  temple.wizards[0].mana = 0
  temple.update(1, frame, 0, 0, 0)
  const plainMana = rig('mithril')
  plainMana.wizards[0].mana = 0
  plainMana.update(1, frame, 0, 0, 0)
  check(
    'a Temple pays mana',
    Math.abs(temple.wizards[0].mana - plainMana.wizards[0].mana - RULES.monument.templeMana) < 0.05,
    `+${plainMana.wizards[0].mana.toFixed(2)}/s plain, +${temple.wizards[0].mana.toFixed(2)}/s held`,
  )
  // Take it away and the mana has to go with it, on the next tick.
  temple.siteById(4)!.owner = 1
  temple.wizards[0].mana = 0
  temple.update(1, frame, 0, 0, 0)
  check(
    'and stops the moment it is lost',
    Math.abs(temple.wizards[0].mana - plainMana.wizards[0].mana) < 0.05,
    `+${temple.wizards[0].mana.toFixed(2)}/s once it changed hands`,
  )

  const oasis = held('oasis')
  check(
    'an Oasis raises the health ceiling',
    oasis.wizardCaps(oasis.player).hp === RULES.monument.oasisHp &&
      rig('mithril').wizardCaps(rig('mithril').player).hp === RULES.wizard.hp,
    `${RULES.wizard.hp} plain, ${oasis.wizardCaps(oasis.player).hp} held`,
  )

  const shrine = held('shrine')
  shrine.castFireball(shrine.player, shrine.player.x + 5, shrine.player.z, 0)
  const fast = shrine.player.cooldown
  const plainCd = rig('mithril')
  plainCd.castFireball(plainCd.player, plainCd.player.x + 5, plainCd.player.z, 0)
  check(
    'a Standing Shrine shortens the cooldown',
    Math.abs(fast - plainCd.player.cooldown * RULES.monument.shrineCooldown) < 0.01,
    `${plainCd.player.cooldown.toFixed(2)}s plain, ${fast.toFixed(2)}s held`,
  )

  const sphinx = held('sphinx')
  // It already consecrated the monument itself; time the node instead.
  const t0 = sphinx.elapsed
  consecrate(sphinx, 3)
  const sphinxTook = sphinx.elapsed - t0
  const plainConv = rig('mithril')
  const p0 = plainConv.elapsed
  consecrate(plainConv, 3)
  const plainTook = plainConv.elapsed - p0
  check(
    'a Sphinx halves the channel',
    sphinxTook < plainTook * 0.75,
    `${plainTook.toFixed(1)}s plain, ${sphinxTook.toFixed(1)}s held`,
  )

  const sanctum = held('sanctum')
  check(
    'a Sanctum is somewhere to come back to',
    sanctum.revealedBy(0).length > 0 && sanctum.siteById(4)!.owner === 0,
    `${sanctum.sitesOf(0).length} sites hold the realm`,
  )

  const observatory = held('observatory')
  const wide = observatory.revealedBy(0).find((s) => s.radius !== undefined)
  check(
    'an Observatory reveals further than a town',
    wide?.radius === RULES.monument.observatoryReveal,
    `${wide?.radius ?? '—'} units, against a settlement's default`,
  )

  // One of each on the map, so a duplicate can never be worth anything. The
  // rule is enforced by placement rather than by the sim, so this checks the
  // table that placement reads.
  check(
    'no monument kind appears twice',
    new Set(MONUMENT_KINDS).size === MONUMENT_KINDS.length,
    `${MONUMENT_KINDS.length} kinds, ${new Set(MONUMENT_KINDS).size} distinct`,
  )
}

console.log('\nOutposts — what guards it is what it sells')
{
  const sim = rig('mithril')
  const post = sim.siteById(5)!
  const table = GARRISONS[`outpost.${post.outpost}`]

  check(
    'a neutral outpost is garrisoned by its own patrol',
    post.defenders.length === table.length,
    `${post.defenders.length} defenders, table of ${table.length}`,
  )
  check(
    'and cannot be hired from before it is taken',
    sim.patrolSpec(post).blocked === 'Not yours',
    `${sim.patrolSpec(post).blocked}`,
  )

  // Clear it, take it, and buy back the very thing that was defending it.
  // Both flags: nothing outside combat turns zero health into a corpse, and
  // `isCleared` reads `dead` rather than hit points.
  for (const u of post.defenders) {
    u.hp = 0
    u.dead = true
  }
  sim.update(0.1, frame, 0, 0, 0)
  const took = consecrate(sim, 5)
  const spec = sim.patrolSpec(post)
  check('the wizard may consecrate an outpost', took, `owner ${post.owner}`)
  check('and then hire', spec.blocked === null && spec.gold > 0, `${spec.gold}g, ${spec.label}`)

  const before = sim.wizards[0].gold
  const hired = sim.hirePatrol(post)
  check(
    'hiring costs gold and musters the patrol',
    hired && sim.wizards[0].gold === before - spec.gold && post.defenders.length === table.length,
    `paid ${before - sim.wizards[0].gold}g for ${post.defenders.length}`,
  )
  check(
    'one patrol at a time',
    sim.patrolSpec(post).blocked === 'Patrol on duty',
    `${sim.patrolSpec(post).blocked}`,
  )
  check(
    'the patrol belongs to the wizard',
    post.defenders.every((u) => u.owner === 0),
    `owners ${[...new Set(post.defenders.map((u) => u.owner))].join(',')}`,
  )

  // It walks. The anchor moves round a circuit, which is the whole difference
  // between a patrol and a garrison.
  const start = { x: post.defenders[0].x, z: post.defenders[0].z }
  for (let i = 0; i < 400; i++) sim.update(0.1, frame, 0, 0, 0)
  const moved = Math.hypot(post.defenders[0].x - start.x, post.defenders[0].z - start.z)
  check('and it walks a beat', moved > 20, `${moved.toFixed(0)} units from where it mustered`)

  // A dead patrol stays dead: it is a running cost, not a fortification.
  for (const u of post.defenders) {
    u.hp = 0
    u.dead = true
  }
  sim.update(0.1, frame, 0, 0, 0)
  for (let i = 0; i < RULES.garrisonRegen * 12; i++) sim.update(0.1, frame, 0, 0, 0)
  check(
    'a lost patrol never regrows for free',
    post.defenders.filter((u) => !u.dead).length === 0,
    `${post.defenders.filter((u) => !u.dead).length} alive after ${RULES.garrisonRegen}s`,
  )

  // Every kind must actually be priced and named, or a building on the board
  // sells nothing and the panel has no button to draw.
  const unpriced = OUTPOST_KINDS.filter((k) => !GARRISONS[`outpost.${k}`]?.length)
  check('every outpost kind has a patrol', unpriced.length === 0, `${OUTPOST_KINDS.length} kinds, ${unpriced.length} empty`)
}

console.log('\nStar ratings — what the plate promises about a fight')
{
  // The bands each garrison is expected to land in. Written out rather than
  // computed, because this is the check: if a garrison is retuned across a
  // band boundary the plate starts telling the player something false, and
  // that is worse than showing no rating at all.
  const expected: [string, number][] = [
    ['camp', 1],
    ['mine', 1],
    ['town', 2],
    ['node', 2],
    ['monument', 3],
    ['lair', 3],
    ['point', 4],
    ['dragon', 5],
  ]
  for (const [key, want] of expected) {
    const got = starsFor(GARRISONS[key])
    check(
      `${key} rates ${want}`,
      got === want,
      `${(groupPower(GARRISONS[key]) / ARMY_POWER).toFixed(2)} armies → ${got}★`,
    )
  }
  // Every band occupied, or the top of the scale is decoration.
  const used = new Set(expected.map(([, n]) => n))
  check('all five bands are used', used.size === 5, `${used.size} distinct ratings`)

  // A site with nothing defending it has no rating at all, and a cleared one
  // keeps its count — the plate darkens rather than emptying.
  const sim = rig('mithril')
  const home = sim.siteById(0)!
  check('an ungarrisoned site rates nothing', sim.starsOf(home) === 0, `${sim.starsOf(home)}★`)
  const post = sim.siteById(5)!
  const full = sim.starsOf(post)
  for (const u of post.defenders) {
    u.hp = 0
    u.dead = true
  }
  sim.update(0.1, frame, 0, 0, 0)
  check(
    'a cleared site keeps its rating',
    sim.starsOf(post) === full && sim.garrisonHealth(post) === 0,
    `${sim.starsOf(post)}★ at ${(sim.garrisonHealth(post) * 100).toFixed(0)}% strength`,
  )
}

console.log('\nThe holding rule — the wizard claims, the caravan assigns')
{
  // A node cannot be linked before it is held.
  const sim = rig('mithril')
  const node = sim.siteById(3)!
  check(
    'unheld node refuses a caravan',
    !sim.canLinkTo(3, 0) && !sim.queueBuild(sim.siteById(0)!, 'caravan', 3),
    `owner ${node.owner}, queue ${sim.siteById(0)!.queue?.item ?? 'empty'}`,
  )

  // And the wizard can take one, which is the half of the rule that used to be
  // forbidden outright.
  const took = consecrate(sim, 3)
  check('the wizard may consecrate a node', took && node.owner === 0, `owner ${node.owner}`)
  check('holding it is enough to link it', sim.canLinkTo(3, 0), `canLinkTo ${sim.canLinkTo(3, 0)}`)

  // Losing the wagon costs the assignment, not the ground. This is the whole
  // reason the two were separated: a raider two hundred metres away should not
  // be able to undo a consecration nobody contested.
  const live = until(sim, () => {
    if (!sim.siteById(0)!.queue) sim.queueBuild(sim.siteById(0)!, 'caravan', 3)
    return sim.linkedTo(0, 'mithril')
  })
  const wagon = sim.units.find((u) => u.wagon && !u.dead)
  if (wagon) wagon.dead = true
  sim.update(0.1, frame, 0, 0, 0)
  check(
    'a dead wagon drops the link',
    live && !sim.linkedTo(0, 'mithril'),
    `linked ${sim.linkedTo(0, 'mithril')}`,
  )
  check('but not the ground', node.owner === 0, `owner ${node.owner}`)
  check('so it can be linked again', sim.canLinkTo(3, 0), `canLinkTo ${sim.canLinkTo(3, 0)}`)

  // Lairs and camps stay unclaimable. The rule opened nodes up; it must not
  // have opened these, or a wizard hovers over a burnt camp for the rest of
  // the match.
  const burnable = rig('mithril')
  const w = burnable.player
  for (const kind of ['lair', 'camp'] as const) {
    const site = { ...burnable.siteById(3)!, id: 99, kind, defenders: [] }
    check(
      `a ${kind} is still burned, not taken`,
      !burnable.canClaim(w, site as typeof site & { kind: typeof kind }),
      `canClaim ${burnable.canClaim(w, site as never)}`,
    )
  }
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
