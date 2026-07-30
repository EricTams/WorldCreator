/**
 * What the roads came out as — printed, not flown over.
 *
 *   npm run audit-roads -- karomi atlas verdant
 *
 * Roads are the hardest thing on this map to judge from the camera, because the
 * rule that decides them is non-local: a road is drawn only where a route
 * between two neighbours passes through vegetation, so what you see in any one
 * valley tells you nothing about whether the tuning is right. Both failure modes
 * are invisible up close and obvious here:
 *
 *   too little   almost nothing paved, and the few stretches that survive are
 *                in one or two territories. The cut thresholds are too strict.
 *   too blobby   many short paths and a low units-per-path figure. A road that
 *                averages under about 60 units is not reading as a line; it is
 *                erasing a copse and leaving a bare patch. `CUT_MIN_RUN`.
 *
 * The per-territory split is the other thing worth watching. Roads follow cover,
 * so the wooded territories should carry nearly all of them and the Ashlands
 * almost none — that asymmetry is the feature. What would be wrong is a
 * territory with real cover and no roads at all.
 */
import { buildBiomeField, BIOMES, sampleBiomeAt } from '../src/world/biome'
import { capitalClearing, makeStandField } from '../src/world/sites'
import { ROAD_CELL, ROUTE_CELL, buildRoadNetwork } from '../src/world/roads'
import { ROAD_MATERIALS } from '../src/assets/roads'
import { buildBoard } from './board'

const seeds = process.argv.slice(2)
if (seeds.length === 0) seeds.push('karomi', 'atlas')

for (const seed of seeds) {
  const { params, heightmap, frame, cities, plan } = buildBoard(seed)
  const worldSize = (heightmap.size - 1) * frame.cellSize
  const field = buildBiomeField(seed, worldSize, params.biome, cities)
  const stands = makeStandField(field, seed, params.render.scatterBlob)

  const started = process.hrtime.bigint()
  const net = buildRoadNetwork(
    {
      hm: heightmap,
      cellSize: frame.cellSize,
      heightScale: frame.heightScale,
      seaLevel: frame.seaLevel,
    },
    plan.sites,
    field,
    stands,
    { worldSize, plazaRadius: capitalClearing() },
  )
  const ms = Number(process.hrtime.bigint() - started) / 1e6

  const byMaterial = ROAD_MATERIALS.map(() => 0)
  let paved = 0
  for (const c of net.cells) {
    if (!c) continue
    paved++
    byMaterial[c - 1]++
  }

  // A "cut" is a contiguous paved run within one route, not a whole route: a
  // route commonly crosses two woods with a field between them, and counting
  // that as one cut would report a mean length twice what is actually drawn.
  const cuts: { length: number; x: number; z: number }[] = []
  let failed = 0
  let routedLength = 0
  for (const r of net.routes) {
    if (r.points.length === 0) {
      failed++
      continue
    }
    routedLength += (r.points.length - 1) * ROUTE_CELL
    let run: { x: number; z: number }[] = []
    for (let i = 0; i <= r.points.length; i++) {
      if (i < r.points.length && r.paved[i]) {
        run.push(r.points[i])
        continue
      }
      if (run.length > 1) {
        const mid = run[run.length >> 1]
        cuts.push({ length: (run.length - 1) * ROUTE_CELL, x: mid.x, z: mid.z })
      }
      run = []
    }
  }

  const lengths = cuts.map((c) => c.length)
  const total = lengths.reduce((a, b) => a + b, 0)
  const perBiome = BIOMES.map(() => 0)
  for (const c of cuts) perBiome[sampleBiomeAt(field, c.x, c.z).a] += c.length

  console.log(`\n=== ${seed} ===`)
  console.log(
    `  ${ms.toFixed(0)}ms   ${net.size}² grid   ${paved} cells paved ` +
      `(${((paved * ROAD_CELL * ROAD_CELL) / 1000).toFixed(0)}k u²)`,
  )
  console.log(
    `  ${net.routes.length} links routed (${failed} unroutable), ` +
      `${routedLength.toFixed(0)}u of route, ${((total / Math.max(1, routedLength)) * 100).toFixed(0)}% of it paved`,
  )
  console.log(
    `  ${cuts.length} cuts, ${total.toFixed(0)}u total, ` +
      `${cuts.length ? (total / cuts.length).toFixed(0) : 0}u mean, ` +
      `${lengths.length ? Math.min(...lengths).toFixed(0) : 0}u shortest`,
  )
  console.log(
    '  surface  ' +
      ROAD_MATERIALS.map((m, i) => `${m} ${byMaterial[i]}`).join('  '),
  )
  console.log(
    '  by territory  ' +
      BIOMES.map((b, i) => `${b.id} ${perBiome[i].toFixed(0)}u`).join('  '),
  )
}
