/**
 * What an unattended match actually does — measured, not remembered.
 *
 *   npm run match -- --seeds karomi,atlas,verdant
 *   npm run match -- --seeds karomi --json runs/baseline.jsonl
 *
 * `docs/second-playable.md` §10 ends on a number nobody could reproduce: a full
 * three-wizard match finished in nineteen minutes with no wizard ever reaching
 * tier 3, so the Siege Works was never built and the trebuchet — the whole
 * point of that milestone — never appeared in a game nobody was steering. That
 * number came from a throwaway harness on a flat test board, and the doc says
 * plainly that the retune it implies wants the *real generated island*. This is
 * that harness, in the tree, so the claim can be checked and re-checked.
 *
 * It runs the shipped simulation rather than a model of it. The board is built
 * by the same calls `main.ts` makes in the same order, and the match is stepped
 * by the same `Sim.update` the render loop drives. The only concession is
 * `allAi`, which hands faction 0 to `flyAi` as well. Everything a run reports —
 * how long the match took, when anybody reached tier 3, whether an engine ever
 * rolled — is therefore evidence about the game, not about the harness.
 *
 * Determinism: the sim reads no clock and no global RNG, so a seed names a
 * match exactly. Two runs of the same seed produce the same numbers, which is
 * what makes a retune a diff rather than an argument.
 *
 * One honest difference from the game: scenery-card pads are not flattened
 * here, because choosing them is a renderer job. Units move in pure XZ and
 * ground height only reaches the wizard's hover and a projectile's impact test,
 * so nothing the harness measures depends on it — but it is a difference, and
 * it is printed in the banner rather than buried in a comment.
 */

import { defaultParams } from '../src/world/params'
import { generateHeightmap } from '../src/world/generate'
import { erode } from '../src/world/erosion'
import { amplify } from '../src/world/amplify'
import { placeCities } from '../src/world/cities'
import { planGameMap, planPoints } from '../src/world/gameMap'
import { capitalClearing, flattenSitePads } from '../src/world/sites'
import type { SitePad } from '../src/world/sites'
import { makeRng } from '../src/world/prng'
import type { TerrainFrame } from '../src/world/terrainQuery'
import { Sim } from '../src/game/sim'
import { FACTIONS } from '../src/game/factions'
import { MAX_TIER } from '../src/game/rules'

// --- arguments ---------------------------------------------------------------

interface Args {
  seeds: string[]
  /** Give up after this many simulated seconds. */
  cap: number
  /** Simulated seconds per step. */
  dt: number
  /** Skip amplification: faster to iterate on, slightly different ground. */
  rough: boolean
  /** Append one JSON object per match here. */
  json: string | null
}

function parseArgs(argv: string[]): Args {
  const out: Args = { seeds: [], cap: 3600, dt: 0.1, rough: false, json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seeds') out.seeds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--cap') out.cap = Number(argv[++i])
    else if (a === '--dt') out.dt = Number(argv[++i])
    else if (a === '--rough') out.rough = true
    else if (a === '--json') out.json = argv[++i]
    else if (!a.startsWith('--')) out.seeds.push(a)
  }
  if (out.seeds.length === 0) out.seeds = ['karomi', 'atlas', 'verdant', 'kestrel', 'orrery']
  return out
}

// --- the board ---------------------------------------------------------------

/**
 * Build the island exactly as `main.ts` does.
 *
 * The order is the part that matters and it is not obvious: sites are scored
 * against the *refined* heights, so erosion and amplification have to happen
 * before `planGameMap`, and the pads are cut afterwards from what it chose.
 * Planning against the raw heightmap would put mines on slopes the real game
 * would have rejected, and the harness would be measuring a different island.
 */
function buildBoard(seed: string, rough: boolean): { frame: TerrainFrame; plan: ReturnType<typeof planGameMap> } {
  const params = defaultParams()
  params.seed = seed

  let hm = generateHeightmap(params)
  if (params.erosion.droplets > 0) {
    erode(hm, params.erosion, params.shape.seaLevel, makeRng(params.seed, 'erosion'))
  }
  if (params.amplify.enabled && !rough) {
    hm = amplify(hm, params.amplify, params.seed).heightmap
  }

  const worldWidth = params.mapSize * params.render.cellSize
  const scale = Math.max(1e-5, params.render.heightScale)
  const frame: TerrainFrame = {
    heightmap: hm,
    cellSize: worldWidth / (hm.size - 1),
    heightScale: params.render.heightScale,
    seaLevel: params.shape.seaLevel,
    // The coastal step, in the normalised heights the heightfield speaks —
    // `main.ts` `coastShelf()`, which every height query has to agree with.
    shelfRise: params.render.coastStep / scale,
    shelfBand: params.render.coastBand / scale,
  }

  const clearing = capitalClearing()
  const points = planPoints(params.seed, frame)
  const cities = placeCities(params.seed, frame, {
    count: params.biome.cities,
    clearing,
    reserved: points.map((p) => ({ x: p.x, z: p.z, radius: p.radius + clearing })),
  })
  const plan = planGameMap(params.seed, frame, cities, FACTIONS.length, points)

  const plazas: SitePad[] = cities.map((c) => ({ x: c.x, z: c.z, radius: clearing }))
  const pads: SitePad[] = plan.sites.map((s) => ({ x: s.x, z: s.z, radius: s.radius }))
  flattenSitePads(hm, frame.cellSize, [...plazas, ...pads])

  return { frame, plan }
}

// --- one match ---------------------------------------------------------------

interface WizardReport {
  faction: string
  /** Simulated seconds at which this wizard first reached each tier, per city. */
  reachedTier: (number | null)[]
  firstSiegeWorks: number | null
  /** Distinct trebuchets fielded over the match. */
  trebuchets: number
  sites: number
  cities: number
  /** Monuments held at the end — the realm buffs this wizard finished with. */
  monuments: number
  /** Outposts held, and how many of them had a patrol standing on them. */
  outposts: number
  patrols: number
  charge: number
  deaths: number
}

interface MatchReport {
  seed: string
  /** Simulated seconds. */
  length: number
  /** Faction index, or -1 if the cap was hit with nobody at 100%. */
  winner: number
  timedOut: boolean
  sitesOnBoard: number
  wizards: WizardReport[]
}

function runMatch(seed: string, args: Args): MatchReport {
  const { frame, plan } = buildBoard(seed, args.rough)

  const sim = new Sim({
    onRespawn: () => {},
    onMessage: () => {},
    allAi: true,
  })
  sim.reset(plan)

  const reports: WizardReport[] = FACTIONS.map((f) => ({
    faction: f.name,
    reachedTier: new Array(MAX_TIER + 1).fill(null),
    firstSiegeWorks: null,
    trebuchets: 0,
    sites: 0,
    cities: 0,
    monuments: 0,
    outposts: 0,
    patrols: 0,
    charge: 0,
    deaths: 0,
  }))

  // Trebuchets are counted by identity rather than by presence: an engine that
  // is built, walks to a wall and dies is the event worth counting, and a
  // sampled "is one alive right now" would miss exactly the ones that did their
  // job. Army ids are never reused, so the pair is stable.
  const seenTrebuchets = new Set<string>()
  const wasDead = FACTIONS.map(() => false)

  let sampleT = 0
  while (sim.winner < 0 && sim.elapsed < args.cap) {
    sim.update(args.dt, frame, 0, 0, 0)

    // Ten simulated seconds is far finer than any of these events moves, and
    // walking every site every tick would dominate the run.
    sampleT += args.dt
    if (sampleT < 10) continue
    sampleT = 0

    for (let f = 0; f < FACTIONS.length; f++) {
      const r = reports[f]
      const owned = sim.sitesOf(f)
      for (const s of owned) {
        if (s.kind !== 'city') continue
        if (r.reachedTier[s.tier] === null) r.reachedTier[s.tier] = sim.elapsed
        if (s.siegeWorks && r.firstSiegeWorks === null) r.firstSiegeWorks = sim.elapsed
      }
      for (const army of sim.armiesOf(f)) {
        for (const u of army.units) {
          if (u.def.role !== 'siege') continue
          const key = `${army.id}:${u.id}`
          if (seenTrebuchets.has(key)) continue
          seenTrebuchets.add(key)
          r.trebuchets++
        }
      }
      const w = sim.wizards[f]
      if (w.dead && !wasDead[f]) r.deaths++
      wasDead[f] = w.dead
    }
  }

  for (let f = 0; f < FACTIONS.length; f++) {
    const owned = sim.sitesOf(f)
    reports[f].sites = owned.length
    reports[f].cities = owned.filter((s) => s.kind === 'city').length
    // Monuments and outposts are the milestone's new content. A wizard that
    // never takes one is the failure to watch for — a whole family of sites
    // that exists on the board and never enters a match.
    reports[f].monuments = owned.filter((s) => s.kind === 'monument').length
    const posts = owned.filter((s) => s.kind === 'outpost')
    reports[f].outposts = posts.length
    reports[f].patrols = posts.filter((s) => s.defenders.some((u) => !u.dead)).length
    reports[f].charge = sim.wizards[f].charge
  }

  return {
    seed,
    length: sim.elapsed,
    winner: sim.winner,
    timedOut: sim.winner < 0,
    sitesOnBoard: plan.sites.length,
    wizards: reports,
  }
}

// --- reporting ---------------------------------------------------------------

function mmss(seconds: number | null): string {
  if (seconds === null) return '  —  '
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2)}:${String(s).padStart(2, '0')}`
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function printMatch(m: MatchReport): void {
  const outcome = m.timedOut
    ? `no winner (capped at ${mmss(m.length)})`
    : `${FACTIONS[m.winner].name} wins at ${mmss(m.length)}`
  console.log(`\n=== seed "${m.seed}" — ${outcome}, ${m.sitesOnBoard} sites on the board ===`)
  console.log(
    '  wizard     sites  cities  mon  post/pat  charge   tier2    tier3   siege works  trebuchets  deaths',
  )
  for (const w of m.wizards) {
    console.log(
      `  ${w.faction.padEnd(10)} ${String(w.sites).padStart(5)}  ${String(w.cities).padStart(6)}` +
        `  ${String(w.monuments).padStart(3)}  ${String(w.outposts).padStart(4)}/${String(w.patrols).padEnd(3)}` +
        `  ${w.charge.toFixed(0).padStart(5)}%  ${mmss(w.reachedTier[2])}  ${mmss(w.reachedTier[3])}` +
        `       ${mmss(w.firstSiegeWorks)}  ${String(w.trebuchets).padStart(10)}  ${String(w.deaths).padStart(6)}`,
    )
  }
}

/**
 * The three numbers this harness exists to move.
 *
 * Stated as targets rather than assertions: the harness reports, and a human
 * decides whether the board or the numbers are what wants changing.
 */
function printSummary(matches: MatchReport[]): void {
  const lengths = matches.map((m) => m.length)
  const withTreb = matches.filter((m) => m.wizards.some((w) => w.trebuchets > 0)).length
  const tier3Times = matches.flatMap((m) =>
    m.wizards.map((w) => w.reachedTier[3]).filter((t): t is number => t !== null),
  )
  const timedOut = matches.filter((m) => m.timedOut).length

  console.log(`\n=== ${matches.length} matches ===`)
  console.log(`  match length      median ${mmss(median(lengths))}  (target 30:00–40:00)`)
  console.log(`  reached tier 3    ${tier3Times.length} of ${matches.length * FACTIONS.length} wizards` +
    (tier3Times.length ? `, earliest ${mmss(Math.min(...tier3Times))}` : ''))
  console.log(`  trebuchet fielded ${withTreb} of ${matches.length} matches  (target: most)`)
  if (timedOut) console.log(`  hit the cap       ${timedOut} of ${matches.length} matches`)
}

// --- main --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))

console.log(
  `match harness — ${args.seeds.length} seed(s), dt ${args.dt}s, cap ${mmss(args.cap)}` +
    (args.rough ? ', ROUGH (no amplification — ground differs from the game)' : '') +
    '\nscenery pads are not flattened headless; nothing measured here depends on them.',
)

const matches: MatchReport[] = []
for (const seed of args.seeds) {
  const started = Date.now()
  const m = runMatch(seed, args)
  matches.push(m)
  printMatch(m)
  console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s wall)`)
}
printSummary(matches)

if (args.json) {
  const fs = await import('node:fs')
  fs.writeFileSync(args.json, matches.map((m) => JSON.stringify(m)).join('\n') + '\n')
  console.log(`\nwrote ${matches.length} rows to ${args.json}`)
}
