import { terrainHeightAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'
import { MAX_TIER, RULES } from './rules'
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

function think(sim: Sim, w: Wizard): void {
  // 1. Keep the queue busy, in priority order.
  //
  //    Army first — an AI with no army does nothing at all. Then the economy,
  //    then the walls, then growth, then reinforce. Tiering up sits *after* the
  //    fort deliberately: a bigger city the AI cannot defend is a bigger prize
  //    for whoever takes it.
  //
  //    Each call is allowed to fail. `queueBuild` refuses anything the city
  //    cannot afford or has already built, so this reads as a wish list and the
  //    sim decides — which is exactly what the player's greyed-out buttons do.
  for (const site of sim.sitesOf(w.faction)) {
    if (site.kind !== 'city') continue
    if (site.queue && site.queue.item !== 'repair') continue

    // Having an army at all outranks everything. Reinforcing a damaged one is
    // the *last* resort, or a city that lost two soldiers would spend the rest
    // of the match topping them up and never build a thing.
    if (!site.army) sim.queueBuild(site, 'army')
    else if (!site.shrine) sim.queueBuild(site, 'shrine')
    else if (!site.market) sim.queueBuild(site, 'market')
    else if (!site.fort) sim.queueBuild(site, 'fort')
    else if (site.tier < MAX_TIER) sim.queueBuild(site, 'tier')
    else if (!site.siegeWorks) sim.queueBuild(site, 'siegeWorks')
    // Once the works stand, keep exactly one engine on the road. This is the
    // rule the player actually sees: sooner or later a slow column with a
    // trebuchet in it comes over the hill towards their walls.
    else if (!Sim.hasSiege(site.army)) sim.queueBuild(site, 'trebuchet')
    else sim.queueBuild(site, 'army')
  }

  // 1b. Link what the armies have cleared.
  //
  //     Separate from the wish list above because a caravan is the one order
  //     that names a place, and the place is what decides whether it is worth
  //     giving: the nearest Town-or-better city with a free queue sends it, so
  //     the buff lands where the wagon has the shortest road to walk.
  for (const node of sim.sites) {
    if (node.kind !== 'node' || !sim.canLinkTo(node.id)) continue
    const city = nearestSite(
      sim,
      node.x,
      node.z,
      (s) => s.kind === 'city' && s.owner === w.faction && !s.queue,
    )
    if (city) sim.queueBuild(city, 'caravan', node.id)
  }

  // 2. Somebody is close to winning: everything goes at their points.
  const leader = sim.wizards.find((o) => o.faction !== w.faction && o.charge >= 60)
  const owned = sim.sitesOf(w.faction).length

  for (const army of sim.armiesOf(w.faction)) {
    if (Sim.alive(army).length < 4) continue
    if (army.order === 'march' || army.order === 'camp') continue

    let target: SiteState | null = null
    if (leader) {
      target = nearestSite(sim, army.ax, army.az, (s) => s.kind === 'point' && s.owner === leader.faction)
    }
    if (!target) {
      const siege = Sim.hasSiege(army)
      // Mines and towns early, points once there is an economy behind them.
      target = nearestSite(sim, army.ax, army.az, (s) => {
        if (s.owner === w.faction) return false
        if (s.kind === 'point') return owned >= 3
        if (s.kind === 'lair') return false
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

  const army = sim.armiesOf(w.faction).find((a) => a.order === 'march' || a.order === 'camp')
  if (army) {
    w.goalX = army.ax
    w.goalZ = army.az
  }
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
