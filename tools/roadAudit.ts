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
import { ROAD_CELL, buildRoadNetwork } from '../src/world/roads'
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

  // Path length in world units, and where each path's midpoint fell. A path is
  // the run of cells actually paved, so its length is the length of the cut.
  const lengths = net.paths.map((p) => p.length * ROAD_CELL * 2)
  const total = lengths.reduce((a, b) => a + b, 0)
  const perBiome = BIOMES.map(() => 0)
  for (let i = 0; i < net.paths.length; i++) {
    const mid = net.paths[i][net.paths[i].length >> 1]
    if (mid) perBiome[sampleBiomeAt(field, mid.x, mid.z).a] += lengths[i]
  }

  console.log(`\n=== ${seed} ===`)
  console.log(
    `  ${ms.toFixed(0)}ms   ${net.size}² grid   ${paved} cells paved ` +
      `(${((paved * ROAD_CELL * ROAD_CELL) / 1000).toFixed(0)}k u²)`,
  )
  console.log(
    `  ${net.paths.length} cuts, ${total.toFixed(0)}u total, ` +
      `${net.paths.length ? (total / net.paths.length).toFixed(0) : 0}u mean, ` +
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
