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
 * It runs the shipped simulation rather than a model of it. The board comes
 * from `world/build.ts`, which is the function `main.ts` itself calls, and the
 * match is stepped by the same `Sim.update` the render loop drives. The only
 * concession is `allAi`, which hands faction 0 to `flyAi` as well. Everything a
 * run reports — how long the match took, when anybody reached tier 3, whether an
 * engine ever rolled — is therefore evidence about the game, not about the
 * harness.
 *
 * It did not used to be. This file kept a private copy of the board sequence
 * that flattened every site to `s.radius` — the defender leash, twenty-four to
 * forty-eight units — where the game terraces only the ground a building stands
 * on, and it eroded and amplified an island the game never refines. Every run in
 * `runs/*.jsonl` recorded before that copy was deleted was played on a board the
 * game does not build.
 *
 * Determinism: the sim reads no clock and no global RNG, so a seed names a
 * match exactly. Two runs of the same seed produce the same numbers, which is
 * what makes a retune a diff rather than an argument.
 */

import { buildBoard } from './board'
import type { BoardStage } from './board'
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
  /**
   * Which island to play on. `refine` is what every match gets and so is the
   * default; `--rough` skips amplification to iterate faster, and `--generate`
   * plays the raw preview, which no real match ever uses.
   */
  stage: BoardStage
  /** Append one JSON object per match here. */
  json: string | null
}

function parseArgs(argv: string[]): Args {
  const out: Args = { seeds: [], cap: 3600, dt: 0.1, stage: 'refine', json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seeds') out.seeds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--cap') out.cap = Number(argv[++i])
    else if (a === '--dt') out.dt = Number(argv[++i])
    else if (a === '--rough') out.stage = 'rough'
    else if (a === '--generate') out.stage = 'generate'
    else if (a === '--json') out.json = argv[++i]
    else if (!a.startsWith('--')) out.seeds.push(a)
  }
  if (out.seeds.length === 0) out.seeds = ['karomi', 'atlas', 'verdant', 'kestrel', 'orrery']
  return out
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
  const { frame, plan } = buildBoard(seed, { stage: args.stage })

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
    `, stage ${args.stage}` +
    (args.stage === 'refine'
      ? ' (the island the game plays on)'
      : ' (NOT the played island — a preview stage, for iterating faster)'),
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
