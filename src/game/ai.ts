import { terrainHeightAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'
import { MAX_TIER, RULES } from './rules'
import type { BuildItem } from './rules'
import { Sim } from './sim'
import type { SiteState, Wizard } from './sim'

/**
 * An AI wizard's whole brain.
 *
 * Deliberately a script, not a planner. It plays by exactly the player's rules —
 * same two spells, same costs, same queue, no vision cheats and no economy bonus
 * — and the bar it has to clear is "applies credible pressure", not "plays well".
 * Anything cleverer would be tuning a system nobody has played against yet.
 *
 * It lives outside `Sim` because it is a *client* of the simulation rather than
 * part of it: everything below goes through the same public commands the HUD
 * calls, which is the property that keeps the AI honest. If a move needed a
 * private of `Sim` to work, that would be the tell that the player could not
 * make the same move.
 */
export function flyAi(sim: Sim, w: Wizard, dt: number, frame: TerrainFrame): void {
  // A consecration is a stance: grounded, silent, and it takes ten seconds.
  // Thinking mid-channel would only ever break it — a fireball cancels the
  // channel by rule, and re-deciding where to fly is meaningless while the
  // wizard cannot move.
  if (w.channelSiteId >= 0) return

  w.thinkT -= dt
  if (w.thinkT <= 0) {
    w.thinkT = 1.5
    think(sim, w)
  }

  // Fireball whatever is closest, if anything is in reach. The AI aims at a
  // body rather than at the ground, which is the same shot the player takes.
  if (w.cooldown <= 0 && w.mana > RULES.fireball.mana * 2) {
    let best: { x: number; z: number } | null = null
    // The AI plays by the player's range, not by its own. Reading the rule
    // rather than repeating the number is what keeps that true when it moves.
    let bestD: number = RULES.castRange
    for (const u of sim.units) {
      if (u.dead || u.owner === w.faction) continue
      const d = Math.hypot(u.x - w.x, u.z - w.z)
      if (d < bestD) {
        bestD = d
        best = u
      }
    }
    if (best) {
      sim.castFireball(w, best.x, best.z, terrainHeightAt(frame, best.x, best.z) + 1)
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

/**
 * How far a city will send a caravan, in world units.
 *
 * At the wagon's 3 m/s this is about two and a half minutes of held queue,
 * which is the price of the link — see the note where it is used.
 */
const CARAVAN_REACH = 450

function think(sim: Sim, w: Wizard): void {
  // 1. Keep the queue busy, in priority order — and *save* for the top of the
  //    list rather than spending underneath it.
  //
  //    The saving is the part that had to be learned. The wish list is allowed
  //    to fail, which is right, and `queueBuild` refuses what a city cannot
  //    afford, which is also right; but a refusal used to fall through to the
  //    next wish, and the caravan below is half the price of an army. So a
  //    capital sitting on 95 gold was refused its 100-gold army and then
  //    successfully bought a 50-gold caravan with the same money, over and over,
  //    for the whole match. Two of three wizards in an unattended match never
  //    fielded a single army. The queue was always busy; it was busy with the
  //    cheapest thing on the list.
  //
  //    So a wish that is merely unaffordable stops the list. A wish that is
  //    impossible *here* — a trebuchet with no Siege Works — is skipped, or the
  //    city would save forever for something it can never buy.
  const capitalId = sim.capitalOf(w.faction)
  const capital = sim.siteById(capitalId)
  const capitalGrown = !!capital && capital.owner === w.faction && capital.tier >= MAX_TIER

  for (const site of sim.sitesOf(w.faction)) {
    if (site.kind !== 'city') continue
    if (site.queue && site.queue.item !== 'repair') continue

    for (const item of wishList(site, site.id === capitalId, capitalGrown)) {
      // Merely unaffordable: stop here and save for it. Impossible here — a
      // trebuchet with no Siege Works — skip, or the city saves forever for
      // something it can never buy.
      if (sim.saving(site, item)) break
      if (sim.buildBlocked(site, item)) continue
      sim.queueBuild(site, item)
      break
    }
  }

  // 1b. Link what the armies have cleared.
  //
  //     Separate from the wish list above because a caravan is the one order
  //     that names a place, and the place is what decides whether it is worth
  //     giving: the nearest Town-or-better city with a free queue sends it, so
  //     the buff lands where the wagon has the shortest road to walk.
  //
  //     Never from a city that has no army. That single condition is the fix
  //     for the starvation above, and it is enough: a city that has already
  //     raised its troops is a city with spare money by definition.
  //
  //     Deliberately *not* also blocked while the city is saving. Tried that,
  //     and it was too blunt — a capital saving four hundred gold for tier 3 is
  //     saving for several minutes, and refusing a fifty-gold caravan for the
  //     whole of it meant armies sat camped on nodes they had already cleared,
  //     waiting for a wagon that was never commissioned. A caravan is cheap,
  //     quick, and permanent; interleaving one costs the tier-up half a minute.
  for (const node of sim.sites) {
    if (node.kind !== 'node' || !sim.canLinkTo(node.id, w.faction)) continue
    const city = nearestSite(
      sim,
      node.x,
      node.z,
      (s) => s.kind === 'city' && s.owner === w.faction && !s.queue && !!s.army,
    )
    // And only if the road is short enough to be worth the queue it costs.
    //
    // The queue is held from commission until the wagon arrives, which is the
    // whole price of a caravan — so a node 800 units away is four and a half
    // minutes during which that city builds nothing else. The AI was paying
    // that at its *capital*, the most valuable queue on the board, because it
    // simply picked whichever city was nearest the node and never asked how far
    // that was. `CARAVAN_REACH` at 3 m/s is about two and a half minutes, which
    // is the most a city should mortgage for a buff.
    if (city && Math.hypot(city.x - node.x, city.z - node.z) < CARAVAN_REACH) {
      sim.queueBuild(city, 'caravan', node.id)
    }
  }

  // 1b. Man the outposts you hold.
  //
  // A patrol is bought outright rather than queued, so it competes with nothing
  // — no city gives up a build slot for it. That makes it the one purchase the
  // AI can always make when it is flush, and it buys the thing this AI is worst
  // at: holding ground it has already taken without parking an army on it.
  //
  // Gated on having spare money rather than made unconditional, so a wizard
  // saving for a tier-up is not quietly drained by outposts it happens to own.
  for (const site of sim.sitesOf(w.faction)) {
    if (site.kind !== 'outpost') continue
    const { gold, blocked } = sim.patrolSpec(site)
    if (blocked) continue
    if (w.gold < gold * 2) continue
    sim.hirePatrol(site)
  }

  // 2. Somebody is close to winning: everything goes at their points.
  const leader = sim.wizards.find((o) => o.faction !== w.faction && o.charge >= 60)
  const owned = sim.sitesOf(w.faction).length

  const free = sim.armiesOf(w.faction).filter((army) => {
    if (Sim.alive(army).length < 4) return false
    if (army.order === 'march') return false

    const campingOn = army.order === 'camp' ? sim.siteById(army.targetSiteId) : undefined
    // Camping holds ground until the wizard arrives to consecrate it — so it
    // is only worth anything while there is still something here for a wizard
    // to *do*. A site already ours, a burnt-out lair, a camp whose cache is on
    // the floor: all finished, and an army standing over one is guarding a job
    // that is already done.
    //
    // This replaces a narrower exception for cleared nodes, which existed
    // because a node could not be consecrated at all and its guard therefore
    // waited on a caravan that might never come — six soldiers once stood on
    // one for half an hour while their wizard held three cities and no points.
    // Nodes are consecrated now, so the special case is gone; the general
    // question it was a special case of is what actually needed asking.
    //
    // It matters more than it used to. With ninety-odd sites, armies clear
    // ground far faster than one wizard can follow them round it, and a rule
    // that pins every army to whatever it last took leaves nothing free — and
    // a Point of Power needs two free armies or nobody goes at all. That is
    // exactly what happened: charge sat at 0% for four matches in five.
    if (campingOn && sim.canClaim(w, campingOn)) return false

    // An army whose city has a Siege Works goes home to be given the engine.
    //
    // A trebuchet can only be attached to troops standing at home and idle, so
    // an army that is anywhere else is an army that can never receive one. It
    // is not enough to stop *sending* it out — that was the first attempt, and
    // it left armies parked on the nodes they had already cleared while their
    // capital sat on five hundred gold with an empty queue and a Siege Works it
    // had no use for. Four matches raised the works; not one fielded an engine.
    // It has to actually be recalled.
    //
    // Bounded: it ends when the trebuchet is built, and the city is saving for
    // exactly that. And it yields to the endgame — once somebody is about to
    // win, an engine is a luxury nobody has time for.
    const home = sim.siteById(army.homeSiteId)
    if (home && home.siegeWorks && !Sim.hasSiege(army) && !leader) {
      if (army.order !== 'return') sim.recallArmy(army)
      return false
    }
    return true
  })

  // Two armies go at a Point of Power together, or neither goes at all.
  //
  // A point is guarded at about 1.2 armies and the central one at 2.5, so one
  // army sent alone is one army thrown away — and the AI sends its armies at
  // whatever is *nearest* them individually, which meant each one walked into
  // the same garrison a few minutes apart and died separately. Wizards sat on
  // three cities at 0% charge for an hour: they were attacking the points the
  // whole time, one army at a time, and losing every time.
  //
  // So points are attacked only when there are at least two free armies to do
  // it with, and then every free army goes to the same one. Concentration of
  // force is the one piece of generalship this AI needs, because it is the only
  // objective on the map that a single city's army cannot take.
  if (!leader && owned >= 3 && free.length >= 2) {
    const anchor = free[0]
    const point = nearestSite(
      sim,
      anchor.ax,
      anchor.az,
      (s) => s.kind === 'point' && s.owner !== w.faction,
    )
    if (point) {
      for (const army of free) sim.orderArmy(army, point.id)
      free.length = 0
    }
  }

  for (const army of free) {
    let target: SiteState | null = null
    if (leader) {
      target = nearestSite(sim, army.ax, army.az, (s) => s.kind === 'point' && s.owner === leader.faction)
    }
    if (!target) {
      const siege = Sim.hasSiege(army)
      // Mines and towns early, points once there is an economy behind them.
      target = nearestSite(sim, army.ax, army.az, (s) => {
        if (s.owner === w.faction) return false
        // Never alone — the block above is the only thing that sends armies at
        // a point, and it sends all of them.
        if (s.kind === 'point') return false
        // A lair measures about four fifths of an army, so it is a real fight
        // and it pays a real purse — but only once there is an economy behind
        // it. Early on those same six soldiers should be taking a town, which
        // is worth income forever rather than gold once.
        if (s.kind === 'lair') return owned >= 3
        // A monument measures about 0.72 armies and pays its wizard for as
        // long as it is held, which makes it worth more than a lair and worth
        // it sooner. Gated all the same: chasing a Temple before there is a
        // second city to pay for the army is how a wizard ends a match with
        // one good buff and nothing to use it on.
        if (s.kind === 'monument') return owned >= 2
        // An outpost is the cheapest defence on the board and the only one that
        // moves. Worth taking early — its patrol holds ground the army would
        // otherwise have to stand on itself.
        if (s.kind === 'outpost') return owned >= 2
        // A camp is wizard-sized work. Sending six soldiers to kill three imps
        // for a hundred gold is an army out of position for two minutes.
        if (s.kind === 'camp') return false
        // Don't throw an army at walls it cannot break. A forted enemy city
        // measures about 1.6 armies, so this is not caution — it is the
        // arithmetic, and it is what makes the AI go and build an engine
        // instead of feeding its soldiers to a tower one wave at a time.
        if (s.kind === 'city' && s.owner >= 0 && s.fort && !siege) return false
        return true
      })
    }
    if (target) sim.orderArmy(army, target.id)
  }

  // 3. The wizard: run home when hurt, otherwise go claim whatever its armies
  //    have already cleared, otherwise follow the fighting.
  if (w.hp < 30) {
    const home = nearestSite(sim, w.x, w.z, (s) => s.owner === w.faction && s.kind === 'city')
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
  const camps = sim
    .armiesOf(w.faction)
    .filter((a) => a.order === 'camp')
    .map((a) => sim.siteById(a.targetSiteId))
    .filter((s): s is SiteState => !!s && sim.canClaim(w, s))

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
    const near = nearestSite(sim, w.x, w.z, (s) => sim.canClaim(w, s))
    if (near && Math.hypot(near.x - w.x, near.z - w.z) < 420) claimable = near
  }

  if (claimable) {
    w.goalX = claimable.x
    w.goalZ = claimable.z
    if (sim.inCastRange(w, claimable.x, claimable.z)) sim.beginConvert(w, claimable)
    return
  }

  // Loot on the ground outranks everything else that is merely nice to do. An
  // army that cleared a lair and left its hoard lying there did the work for
  // nothing, and the wizard is the only thing on the map that can pick it up.
  let purse: { x: number; z: number } | null = null
  let purseD = 500
  for (const g of sim.pickups) {
    const d = Math.hypot(g.x - w.x, g.z - w.z)
    if (d < purseD) {
      purseD = d
      purse = g
    }
  }
  if (purse) {
    w.goalX = purse.x
    w.goalZ = purse.z
    return
  }

  // Nothing to claim: go and burn a camp. Three imps and a purse, in this
  // wizard's own back yard, paid for with mana that was otherwise regenerating
  // into a full bar — which is the same trade the player is being taught to
  // make in the opening minutes.
  //
  // Only with mana to spend. A wizard that flies to a camp it cannot burn is a
  // wizard standing in a fight it declined to have.
  if (w.mana > RULES.fireball.mana * 4) {
    const camp = nearestSite(sim, w.x, w.z, (s) => s.kind === 'camp' && !sim.isCleared(s))
    if (camp && Math.hypot(camp.x - w.x, camp.z - w.z) < 400) {
      standOff(w, camp)
      return
    }
  }

  const army = sim.armiesOf(w.faction).find((a) => a.order === 'march' || a.order === 'camp')
  if (army) {
    w.goalX = army.ax
    w.goalZ = army.az
  }
}

/**
 * Hover at the edge of a site's pad rather than over the middle of it.
 *
 * This is the whole reason a melee garrison is safe to solo from the air, and
 * it is pure geometry rather than a rule: defenders may operate to 0.8 of the
 * pad radius, and the wizard reaches 15. Sitting a little outside the pad
 * leaves the wizard able to hit them while they walk to the end of their leash
 * and stop, several metres short of anything they can do about it.
 *
 * Hovering over the centre instead puts the wizard inside the leash, where
 * "melee only" stops meaning anything — combat distance here is horizontal, so
 * altitude is not cover.
 */
function standOff(w: Wizard, site: SiteState): void {
  const dx = w.x - site.x
  const dz = w.z - site.z
  const d = Math.hypot(dx, dz) || 1
  const stand = site.radius + 4
  w.goalX = site.x + (dx / d) * stand
  w.goalZ = site.z + (dz / d) * stand
}

/**
 * What a city would like to build next, best first.
 *
 * The capital grows and everything else holds — which is the whole pacing fix.
 * The old list was the same everywhere: army, shrine, market, fort, then tier.
 * Spread over five or six towns that is five or six forts before anybody's
 * *first* tier-up, so the four hundred gold for a City never came free before
 * the charge race was already decided, and the Siege Works it gates was never
 * built in an unattended match. `second-playable.md` §10 named three possible
 * fixes for that; this is the one that changes no price the player also pays.
 *
 * So: one city climbs to City and builds the engines, and the rest buy an army,
 * a shrine and a market and then stop. A village that has stopped is not idle —
 * it is paying for the capital's next tier.
 *
 * Reinforcing sits last everywhere. Put it any higher and a city that lost two
 * soldiers spends the rest of the match topping them up and never builds a
 * thing.
 */
function wishList(site: SiteState, isCapital: boolean, capitalGrown: boolean): BuildItem[] {
  const out: BuildItem[] = []

  // An AI with no army does nothing at all, so this outranks everything.
  if (!site.army) out.push('army')
  if (!site.shrine) out.push('shrine')

  // A badly mauled army is rebuilt *before* the city grows, and this exception
  // is load-bearing now that the list saves rather than falling through. Saving
  // four hundred gold for a tier-up means buying nothing else in the meantime,
  // so with reinforcement sitting at the bottom of the list a capital would
  // watch its only army get chewed down to two soldiers and keep saving. Every
  // wizard stalled on one city.
  //
  // Two thirds, so this is a wreck being rebuilt rather than a scratch being
  // buffed out — the reason reinforcement is otherwise last has not gone away.
  if (site.army && Sim.armyStrength(site.army) < 0.66) out.push('army')

  if (isCapital) {
    // Walls before growth, and only here. This is the one city that must not
    // fall: it is where the wizard respawns, it is the only city that starts at
    // Town, and losing it means losing the queue, the army being paid for and
    // the tier that was saved up for.
    //
    // It also has to come before the tier-ups specifically because of what the
    // army does. The moment an army is whole the AI marches it out, and a
    // capital with no fort and no army standing in it is *cleared* — so an
    // enemy wizard can fly in and consecrate it in ten seconds. With walls last
    // on this list that window never closed: two wizards took turns walking
    // into each other's empty capital for a whole match, and because capture
    // destroys the army in production neither could ever raise a garrison.
    // Towers do not march away.
    if (!site.fort) out.push('fort')
    if (site.tier < MAX_TIER) out.push('tier')
    if (!site.siegeWorks) out.push('siegeWorks')
    // Once the works stand, keep exactly one engine on the road. This is the
    // rule the player actually sees: sooner or later a slow column with a
    // trebuchet in it comes over the hill towards their walls.
    if (site.army && !Sim.hasSiege(site.army)) out.push('trebuchet')
    if (!site.market) out.push('market')
  } else {
    if (!site.market) out.push('market')
    // A village fortifies and grows only once the capital is finished. Walls on
    // a village are walls the capital's tier-up paid for.
    if (capitalGrown) {
      if (!site.fort) out.push('fort')
      if (site.tier < MAX_TIER) out.push('tier')
    }
  }

  out.push('army')
  return out
}

function nearestSite(
  sim: Sim,
  x: number,
  z: number,
  pass: (s: SiteState) => boolean,
): SiteState | null {
  let best: SiteState | null = null
  let bestD = Infinity
  for (const s of sim.sites) {
    if (!pass(s)) continue
    const d = Math.hypot(s.x - x, s.z - z)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}
