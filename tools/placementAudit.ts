/**
 * Did the board actually get built? — measured, over many seeds.
 *
 *   npm run audit-placement
 *   npm run audit-placement -- 40
 *
 * `spread` fails silently by design: it walks the candidate list, places what it
 * can, and returns. A seed that fits only sixteen of twenty-five camps produces
 * a map that looks exactly like a map, and nothing anywhere says otherwise. The
 * third playable found this the hard way — one seed placed *none* of its ten
 * mines — and the lesson it wrote down is that any pass which can come up short
 * has to be checked from outside the game.
 *
 * So this plans the real board on N seeds through the same `planGameMap` the
 * renderer calls, and reports:
 *
 *   buildable        how much of the island passed the slope and elevation
 *                    tests at all — the pool every site is drawn from
 *   placed           per kind, against `expectedSiteCounts`. Any shortfall is a
 *                    failure, not a note.
 *   nearest          median and minimum distance between any two sites, which
 *                    is what "how full does the island feel" actually means
 *   city-to-city     minimum separation between capitals. This is the number
 *                    that keeps two wizards from starting as neighbours, and
 *                    the spacing rework must not have moved it.
 *
 * Exits non-zero if any seed comes up short, so it can gate a change rather
 * than merely describe one.
 */
import { expectedSiteCounts } from '../src/world/gameMap'
import type { SiteKind } from '../src/world/gameMap'
import { terrainHeightAt, terrainSlopeAt, worldHalfExtent } from '../src/world/terrainQuery'
import { buildBoard } from './board'

const seedCount = Number(process.argv[2]) || 20
const FACTIONS = 3

/** Same tests `buildable` applies, so the pool reported is the pool used. */
const MAX_SLOPE = 0.24
const MIN_BAND = 0.05
const MAX_BAND = 0.62
const GRID = 128

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = values.slice().sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

let failures = 0
const allNearest: number[] = []
const allCityGaps: number[] = []
const allBuildable: number[] = []
const allArmSpread: number[] = []
const allFairness: number[] = []

console.log(`Planning ${seedCount} seeds…\n`)

for (let n = 0; n < seedCount; n++) {
  const seedName = `audit-${n}`
  // No pad flattening: this reads positions only, and cutting 135 terraces per
  // seed would dominate the run for a number nothing here looks at.
  const { frame, cities, plan } = buildBoard(seedName, { flatten: false, factions: FACTIONS })
  const half = worldHalfExtent(frame)
  const seaY = frame.seaLevel * frame.heightScale

  // How much ground was ever on offer. Same grid and same tests as `buildable`.
  const step = (half * 2) / GRID
  let cells = 0
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = -half + (i + 0.5) * step
      const z = -half + (j + 0.5) * step
      const height = terrainHeightAt(frame, x, z)
      if (height <= seaY) continue
      const e = (height / frame.heightScale - frame.seaLevel) / (1 - frame.seaLevel)
      if (e < MIN_BAND || e > MAX_BAND) continue
      if (terrainSlopeAt(frame, x, z) > MAX_SLOPE) continue
      cells++
    }
  }
  const area = cells * step * step
  allBuildable.push(area)

  // Counts, against the generator's own expectations.
  const expected = expectedSiteCounts(cities.length)
  const actual: Partial<Record<SiteKind, number>> = {}
  for (const s of plan.sites) actual[s.kind] = (actual[s.kind] ?? 0) + 1

  const short: string[] = []
  let total = 0
  let wanted = 0
  for (const kind of Object.keys(expected) as SiteKind[]) {
    const got = actual[kind] ?? 0
    total += got
    wanted += expected[kind]
    if (got < expected[kind]) short.push(`${kind} ${got}/${expected[kind]}`)
  }

  // Spacing. Nearest neighbour over every pair, which is what density means on
  // the ground rather than in a count.
  const nearest: number[] = []
  for (let i = 0; i < plan.sites.length; i++) {
    let best = Infinity
    for (let j = 0; j < plan.sites.length; j++) {
      if (i === j) continue
      const d = Math.hypot(plan.sites[i].x - plan.sites[j].x, plan.sites[i].z - plan.sites[j].z)
      if (d < best) best = d
    }
    if (best < Infinity) nearest.push(best)
  }
  allNearest.push(...nearest)

  const cityCoords = plan.sites.filter((s) => s.kind === 'city')
  let minCityGap = Infinity
  for (let i = 0; i < cityCoords.length; i++) {
    for (let j = i + 1; j < cityCoords.length; j++) {
      const d = Math.hypot(cityCoords[i].x - cityCoords[j].x, cityCoords[i].z - cityCoords[j].z)
      if (d < minCityGap) minCityGap = d
    }
  }
  allCityGaps.push(minCityGap)

  // Is the X actually an X, and is it fair?
  //
  // The four arms should sit at equal radius, and every wizard should start the
  // same distance from its own nearest point. Both are the property the shape
  // exists to guarantee, and neither is visible from inside the game — a skewed
  // X still looks like five standing stones.
  const pts = plan.sites.filter((s) => s.kind === 'point')
  const armRadii = pts.map((p) => Math.hypot(p.x, p.z)).sort((a, b) => a - b)
  // The centre is the smallest radius; the arms are the rest.
  const armSpread = armRadii.length > 1 ? armRadii[armRadii.length - 1] - armRadii[1] : 0
  allArmSpread.push(armSpread)

  const capitalSites = plan.capitals.map((id) => plan.sites.find((s) => s.id === id))
  const openings = capitalSites.map((c) => {
    if (!c) return Infinity
    let best = Infinity
    for (const p of pts) {
      const d = Math.hypot(p.x - c.x, p.z - c.z)
      if (d < best) best = d
    }
    return best
  })
  const fairness = Math.max(...openings) - Math.min(...openings)
  allFairness.push(fairness)

  const ok = short.length === 0
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${seedName.padEnd(10)} ` +
      `sites ${String(total).padStart(3)}/${wanted}  ` +
      `buildable ${String(cells).padStart(5)} cells (${(area / 1000).toFixed(0)}k u²)  ` +
      `nearest med ${median(nearest).toFixed(0)} min ${Math.min(...nearest).toFixed(0)}  ` +
      `city-gap ${minCityGap.toFixed(0)}  ` +
      `arm-spread ${armSpread.toFixed(0)}  opening-gap ${fairness.toFixed(0)}` +
      (ok ? '' : `\n     short: ${short.join(', ')}`),
  )
}

const avgArea = allBuildable.reduce((a, b) => a + b, 0) / allBuildable.length
console.log(`
Across ${seedCount} seeds
  buildable area      ${(avgArea / 1000).toFixed(0)}k u² average
  nearest neighbour   median ${median(allNearest).toFixed(0)}, min ${Math.min(...allNearest).toFixed(0)}
  seconds of flight   ${(median(allNearest) / 17).toFixed(1)}s between sites at cruise
  min city-to-city    ${Math.min(...allCityGaps).toFixed(0)} (worst seed)
  X arm spread        ${median(allArmSpread).toFixed(0)} median, ${Math.max(...allArmSpread).toFixed(0)} worst
                      (how unequal the four arms' radii are — 0 is a perfect X)
  opening fairness    ${median(allFairness).toFixed(0)} median, ${Math.max(...allFairness).toFixed(0)} worst
                      (spread between wizards' distance to their nearest point)
  seeds short         ${failures}`)

if (failures > 0) {
  console.log(`\n${failures} of ${seedCount} seeds could not place the whole board.`)
  process.exit(1)
}
