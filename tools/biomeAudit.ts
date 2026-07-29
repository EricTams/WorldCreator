/**
 * What the territory map actually came out as — measured, not eyeballed.
 *
 *   npm run audit-biomes -- karomi atlas verdant
 *
 * Territory problems are close to invisible in the app. The camera sees one
 * region at a time, fog of war hides the rest, and by the time you have flown
 * far enough to notice that one faction holds a quarter of the island you have
 * lost track of what the other quarter looked like. Every fault this file exists
 * to catch was caught by printing the map, not by flying over it:
 *
 *   - capitals confined to the middle of the map, leaving 43% of the land in a
 *     coastal ring that fell to whichever inland city happened to be nearest
 *   - Voronoi cells varying eight-fold in area, because nothing measured them
 *   - same-faction cells fusing, so fifteen territories rendered as six blobs
 *
 * So it runs the real pipeline headlessly — `generateHeightmap`, `placeCities`,
 * `buildBiomeField`, all with the shipped defaults — rasterises the result, and
 * prints the numbers plus an ASCII map with the capitals marked. It imports the
 * same modules the game does rather than reimplementing the sampling, so it
 * cannot drift from what the player sees.
 *
 * The three numbers worth watching:
 *
 *   max/min                 spread of territory size. Under ~3 is healthy;
 *                           anything near 8 means placement is not balancing.
 *   same-faction borders    must be 0. Any other number is a border between two
 *                           territories that will not read as one.
 *   largest blob            biggest contiguous run of one faction. Around 10%
 *                           of the island is right for fifteen capitals; 15%+
 *                           means cells are fusing.
 *
 * Land only, everywhere: seabed belongs to no territory and is excluded from
 * every area, share and adjacency below, the same way `cities.ts` excludes it.
 */
import { BIOMES, buildBiomeField, sampleBiomeAt } from '../src/world/biome'
import { terrainHeightAt, worldHalfExtent } from '../src/world/terrainQuery'
import { buildBoard } from './board'

const seeds = process.argv.slice(2)
if (seeds.length === 0) seeds.push('karomi')

for (const seedName of seeds) {
  // Built by `tools/board.ts`, which is the sequence the game uses.
  //
  // This file used to assemble its own: `generateHeightmap` with no erosion, no
  // amplification, and a frame missing the coastal shelf — so every height
  // query came back under sea level, `placeCities` returned an empty list, and
  // the audit crashed on the first territory it tried to name. It also
  // hardcoded a 60-unit capital clearing when the real figure is 17.6. It had
  // been reporting on a board the game does not build, and then on no board at
  // all.
  const { params, frame, cities } = buildBoard(seedName, { flatten: false })
  const worldSize = params.mapSize * params.render.cellSize
  const half = worldHalfExtent(frame)
  const seaY = frame.seaLevel * frame.heightScale
  const field = buildBiomeField(params.seed, worldSize, params.biome, cities)

  // Rasterise
  const N = 100
  const cellArea = ((2 * half) / N) ** 2
  const ownerCity = new Int32Array(N * N).fill(-1)
  const grid: string[] = []
  let land = 0
  const cityArea = new Float64Array(cities.length)
  const factionArea = new Float64Array(BIOMES.length)
  for (let j = 0; j < N; j++) {
    let row = ''
    for (let i = 0; i < N; i++) {
      const x = -half + ((i + 0.5) / N) * 2 * half
      const z = -half + ((j + 0.5) / N) * 2 * half
      if (terrainHeightAt(frame, x, z) <= seaY) {
        row += '.'
        continue
      }
      land++
      // nearest seed with the same warp sampleBiomeAt uses, detail octave included
      const wx = x * field.warpScale
      const wz = z * field.warpScale
      const dx = x * field.detailScale
      const dz = z * field.detailScale
      const px = x + field.warpX(wx, wz) * field.warpAmount + field.warpX(dx, dz) * field.detailAmount
      const pz = z + field.warpZ(wx, wz) * field.warpAmount + field.warpZ(dx, dz) * field.detailAmount
      let best = -1
      let bd = Infinity
      for (let k = 0; k < field.seeds.length; k++) {
        const d = Math.hypot(field.seeds[k].x - px, field.seeds[k].z - pz)
        if (d < bd) { bd = d; best = k }
      }
      ownerCity[j * N + i] = best
      cityArea[best] += cellArea
      const s = sampleBiomeAt(field, x, z)
      const b = s.t > 0.5 ? s.b : s.a
      factionArea[b] += cellArea
      row += 'ABCDEF'[b]
    }
    grid.push(row)
  }

  // mark cities
  const gridArr = grid.map((r) => r.split(''))
  cities.forEach((c, k) => {
    const i = Math.floor(((c.x + half) / (2 * half)) * N)
    const j = Math.floor(((c.z + half) / (2 * half)) * N)
    if (i >= 0 && i < N && j >= 0 && j < N) gridArr[j][i] = String.fromCharCode(48 + (k % 10))
  })

  // How much land lies outside the disc capitals are allowed to be placed in?
  let outside = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -half + ((i + 0.5) / N) * 2 * half
      const z = -half + ((j + 0.5) / N) * 2 * half
      if (terrainHeightAt(frame, x, z) <= seaY) continue
      if (Math.hypot(x, z) > half * 0.62) outside++
    }
  }

  // Largest contiguous same-faction blob, in land cells.
  const seen = new Uint8Array(N * N)
  const blobs: { b: number; n: number }[] = []
  for (let s = 0; s < N * N; s++) {
    if (seen[s] || ownerCity[s] < 0) continue
    const fac = cities[ownerCity[s]].biome
    let n = 0
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const c = stack.pop()!
      n++
      const ci = c % N
      const cj = (c / N) | 0
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di
        const nj = cj + dj
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue
        const t = nj * N + ni
        if (seen[t] || ownerCity[t] < 0) continue
        if (cities[ownerCity[t]].biome !== fac) continue
        seen[t] = 1
        stack.push(t)
      }
    }
    blobs.push({ b: fac, n })
  }
  blobs.sort((p, q) => q.n - p.n)

  // Same-faction contact in the field as actually rendered: pairs of touching
  // land cells owned by different capitals that were nonetheless given the same
  // faction. Each such pair is a border that will not read as a border.
  const contact = new Set<string>()
  let borderCells = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = ownerCity[j * N + i]
      if (a < 0) continue
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const ni = i + di
        const nj = j + dj
        if (ni >= N || nj >= N) continue
        const b = ownerCity[nj * N + ni]
        if (b < 0 || b === a) continue
        borderCells++
        if (cities[a].biome === cities[b].biome) {
          contact.add(a < b ? `${a}-${b}` : `${b}-${a}`)
        }
      }
    }
  }

  const totalLand = land * cellArea
  console.log(`\n=== seed "${seedName}" — world ${worldSize.toFixed(0)}u, land ${(totalLand / 1e6).toFixed(2)} km² (${((land / (N * N)) * 100).toFixed(0)}% of map) ===`)
  console.log(`cities requested ${params.biome.cities}, placed ${cities.length}`)
  const shares = Array.from(cityArea, (a, k) => ({ k, a, pct: (a / totalLand) * 100, b: cities[k].biome }))
  shares.sort((p, q) => q.a - p.a)
  console.log('per-city land share (largest first):')
  for (const s of shares) {
    console.log(
      `  city ${String(s.k).padStart(2)} ${BIOMES[s.b].id.padEnd(9)} ` +
      `(${cities[s.k].x.toFixed(0).padStart(6)},${cities[s.k].z.toFixed(0).padStart(6)}) ` +
      `${s.pct.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(s.pct))}`,
    )
  }
  const ideal = 100 / cities.length
  console.log(`ideal share ${ideal.toFixed(1)}%  max/min = ${(shares[0].pct / shares[shares.length - 1].pct).toFixed(1)}x`)
  // Placement used to be confined to the middle 62% of the map. This tracks
  // whether the coastal band it excluded is now actually being settled: that
  // band is over 40% of the island's land, and leaving it capital-less was the
  // single largest source of oversized territories.
  const outerCities = cities.filter((c) => Math.hypot(c.x, c.z) > half * 0.62).length
  console.log(
    `coastal band (beyond 0.62*half): ${((outside / land) * 100).toFixed(0)}% of the land, ` +
      `${outerCities} capitals sited in it`,
  )
  console.log(
    `contiguous same-faction blobs: ${blobs.length}; largest ` +
      blobs.slice(0, 5).map((b) => `${BIOMES[b.b].id} ${((b.n / land) * 100).toFixed(0)}%`).join(', '),
  )
  console.log(
    `same-faction borders (invisible territory lines): ${contact.size}` +
      (contact.size ? ` — ${[...contact].join(' ')}` : ''),
  )
  console.log('per-faction land share:')
  BIOMES.forEach((b, i) => {
    console.log(`  ${'ABCDEF'[i]} ${b.id.padEnd(9)} ${((factionArea[i] / totalLand) * 100).toFixed(1).padStart(5)}%`)
  })
  console.log(gridArr.map((r) => r.join('')).join('\n'))
}
