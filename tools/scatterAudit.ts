/**
 * What each territory actually scattered — counted, not eyeballed.
 *
 *   npm run audit-scatter -- karomi atlas verdant
 *
 * Scatter is the one thing on the map you cannot judge from the camera. It sees
 * one territory at a time, and a territory reads as "a bit bare" over a range
 * of nearly two orders of magnitude — which is how the Ashlands shipped at half
 * a prop per thousand square units, about two hundred things in a region the
 * size of a quarter of the island, and read merely as sparse.
 *
 * The number that matters is **props per 1000 u² of the territory's own land**,
 * because raw counts track territory area and territory area varies four-fold
 * between seeds. Two seeds are enough to see past that; more is better.
 *
 * The trap this exists to expose: `Biome.density` is a *percentile* on a
 * near-normal noise field, not the fraction of candidates kept. It is therefore
 * violently non-linear in the tails. Measured on the Ashlands, 0.24 gives 4 per
 * 1000 and 0.36 gives 23 — a factor of six across a range that reads like a
 * factor of one and a half. Never tune `density` by reasoning about it; run
 * this, move it, run it again.
 *
 * `standScale` deliberately does *not* move these numbers. It decides how the
 * cover is gathered — many copses or few masses — while `density` decides how
 * much of it there is. If a `standScale` edit changes props per 1000 u² by more
 * than sampling noise, something is wrong.
 */
import { BIOMES, buildBiomeField, sampleBiomeAt } from '../src/world/biome'
import { scatterDecorations } from '../src/world/sites'
import { buildBoard } from './board'

const seeds = process.argv.slice(2)
if (seeds.length === 0) seeds.push('karomi', 'atlas')

/** Cells per side of the land-area raster. 220 over 2 km is ~9 units a cell. */
const AREA_GRID = 220

const totals = BIOMES.map(() => ({ props: 0, area: 0 }))

for (const seed of seeds) {
  const { params, heightmap, frame, cities } = buildBoard(seed)
  const worldWidth = params.mapSize * params.render.cellSize
  const field = buildBiomeField(seed, worldWidth, params.biome, cities)

  // No `avoid` and no cap: this measures what the territory grows, not what
  // survives the site pads. Pads take a fixed bite that has nothing to do with
  // the tuning being checked, and the cap would silently truncate the last
  // territories scanned and make them look barren.
  const spots = scatterDecorations(
    { hm: heightmap, cellSize: frame.cellSize, heightScale: frame.heightScale, seaLevel: frame.seaLevel },
    field,
    seed,
    {
      spacing: params.render.scatterSpacing,
      blobScale: params.render.scatterBlob,
      avoid: [],
      maxCount: Number.MAX_SAFE_INTEGER,
    },
  )

  // Land only. Seabed belongs to no territory, the same exclusion `cities.ts`
  // and the biome audit make.
  const half = worldWidth / 2
  const cell = worldWidth / AREA_GRID
  const land = BIOMES.map(() => 0)
  for (let i = 0; i < AREA_GRID; i++) {
    for (let j = 0; j < AREA_GRID; j++) {
      const x = -half + (i + 0.5) * cell
      const z = -half + (j + 0.5) * cell
      const gx = Math.round((x + half) / frame.cellSize)
      const gz = Math.round((z + half) / frame.cellSize)
      if (gx < 0 || gz < 0 || gx >= heightmap.size || gz >= heightmap.size) continue
      if (heightmap.data[gz * heightmap.size + gx] <= frame.seaLevel) continue
      land[sampleBiomeAt(field, x, z).a]++
    }
  }

  const per = BIOMES.map(() => ({ total: 0, tree: 0, litter: 0, relief: 0 }))
  for (const s of spots) {
    const p = per[sampleBiomeAt(field, s.x, s.z).a]
    p.total++
    if (s.sprite.startsWith('mount.')) p.relief++
    else if (s.sprite.startsWith('prop.')) p.litter++
    else p.tree++
  }

  console.log(`\n=== ${seed} — ${spots.length} props ===`)
  console.log('territory      props   per 1k u²   tree%  litter%  relief%   cover   stand')
  for (let i = 0; i < BIOMES.length; i++) {
    const b = BIOMES[i]
    const area = (land[i] * cell * cell) / 1000
    const p = per[i]
    totals[i].props += p.total
    totals[i].area += area
    const pct = (n: number) => (p.total ? Math.round((n / p.total) * 100) : 0)
    const rate = area > 0 ? p.total / area : 0
    console.log(
      `${b.id.padEnd(12)} ${String(p.total).padStart(7)}  ${rate.toFixed(2).padStart(9)}` +
        `   ${String(pct(p.tree)).padStart(4)}  ${String(pct(p.litter)).padStart(6)}` +
        `  ${String(pct(p.relief)).padStart(6)}   ${b.density.toFixed(2)}  ` +
        `${(b.standScale * params.render.scatterBlob).toFixed(0).padStart(4)}u`,
    )
  }
}

console.log(`\nAcross ${seeds.length} seed${seeds.length === 1 ? '' : 's'} — props per 1000 u², emptiest first`)
const ranked = BIOMES.map((b, i) => ({
  id: b.id,
  rate: totals[i].area > 0 ? totals[i].props / totals[i].area : 0,
})).sort((a, b) => a.rate - b.rate)
for (const r of ranked) console.log(`  ${r.id.padEnd(12)} ${r.rate.toFixed(2).padStart(7)}`)
