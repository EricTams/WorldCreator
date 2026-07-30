/**
 * The same seed, built two ways, so the difference can be looked at.
 *
 * This was written to settle an argument. `tools/board.ts` had always eroded and
 * amplified before placing anything, and the game never did either — erosion was
 * reachable only from the GUI button — so one seed grew two islands and every
 * headless measurement was about the one nobody had seen. Printing both tables
 * side by side is what made that undeniable: 1 capital of 15 within 40 units of
 * a counterpart.
 *
 * It is kept because the two stages still both exist. A match is played on
 * `refine`; a terrain slider mid-drag shows `generate`. This tool is how you
 * check that a measurement is about the first one.
 *
 * Rendering offline rather than pressing "▶ Erode + amplify" in the app is
 * deliberate: that button re-plans the world and calls `sim.reset`, which throws
 * away the match on screen and the camera looking at it.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildBoard } from './board'
import type { Board, BoardStage } from './board'
import { terrainHeightAt, worldHalfExtent } from '../src/world/terrainQuery'
import { encodePng } from './png.mjs'

// Off the working directory, not off `import.meta.url`: these tools run as a
// bundle in `node_modules/.cache`, so a path relative to the module lands inside
// `node_modules`. npm always runs a script from the package root.
const OUT_DIR = resolve(process.cwd(), 'runs')

/** Image size. Independent of grid resolution, so both stages draw comparably. */
const IMG = 720

/** How close two capitals have to be to count as the same one, in world units. */
const SAME = 40

interface Args {
  seeds: string[]
  png: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { seeds: [], png: true }
  for (const a of argv) {
    if (a === '--no-png') out.png = false
    else if (!a.startsWith('--')) out.seeds.push(a)
  }
  if (out.seeds.length === 0) out.seeds = ['karomi']
  return out
}

interface Town {
  name: string
  x: number
  z: number
}

/** The capitals, named. `placeCities` returns positions; `planGameMap` names them. */
function towns(board: Board): Town[] {
  return board.plan.sites
    .filter((s) => s.kind === 'city')
    .map((s) => ({ name: s.name, x: s.x, z: s.z }))
}

function nearest(t: Town, others: Town[]): { town: Town; dist: number } | null {
  let best: Town | null = null
  let bestD = Infinity
  for (const o of others) {
    const d = Math.hypot(o.x - t.x, o.z - t.z)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best ? { town: best, dist: bestD } : null
}

// --- drawing -----------------------------------------------------------------

/**
 * Top-down height, sea flooded blue, a marker on every capital.
 *
 * Heights come through `terrainHeightAt` rather than off the raw grid so the
 * coastal shelf is in the picture — the same step the mesh and every height
 * query apply. Without it the two stages would be shaded on different scales.
 */
function draw(board: Board, marks: Town[]): Buffer {
  const { frame, params } = board
  const half = worldHalfExtent(frame)
  const data = Buffer.alloc(IMG * IMG * 4)

  const sea = params.shape.seaLevel * params.render.heightScale

  // Land is shaded against its own range, not the map's: the tallest peak sets
  // white, so a flatter island still reads rather than going uniformly dark.
  let peak = sea
  for (let py = 0; py < IMG; py++) {
    for (let px = 0; px < IMG; px++) {
      const x = ((px + 0.5) / IMG) * 2 * half - half
      const z = ((py + 0.5) / IMG) * 2 * half - half
      const h = terrainHeightAt(frame, x, z)
      if (h > peak) peak = h
    }
  }
  const span = Math.max(1e-5, peak - sea)

  for (let py = 0; py < IMG; py++) {
    for (let px = 0; px < IMG; px++) {
      const x = ((px + 0.5) / IMG) * 2 * half - half
      const z = ((py + 0.5) / IMG) * 2 * half - half
      const h = terrainHeightAt(frame, x, z)
      const i = (py * IMG + px) * 4

      if (h <= sea) {
        // Depth-shaded water, so the shelf and the deep are distinguishable.
        const d = Math.min(1, (sea - h) / Math.max(1e-5, sea * 0.6))
        data[i] = Math.round(20 + (1 - d) * 40)
        data[i + 1] = Math.round(60 + (1 - d) * 70)
        data[i + 2] = Math.round(110 + (1 - d) * 90)
      } else {
        const t = Math.min(1, (h - sea) / span)
        // Green at the shore climbing to bare rock, so relief is legible at a
        // glance without a hillshade.
        data[i] = Math.round(70 + t * 175)
        data[i + 1] = Math.round(110 + t * 135)
        data[i + 2] = Math.round(60 + t * 165)
      }
      data[i + 3] = 255
    }
  }

  for (const t of marks) {
    const px = Math.round(((t.x + half) / (2 * half)) * IMG)
    const py = Math.round(((t.z + half) / (2 * half)) * IMG)
    // A ringed dot: dark halo so it stays visible on both pale rock and water.
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const r = Math.hypot(dx, dy)
        if (r > 6) continue
        const qx = px + dx
        const qy = py + dy
        if (qx < 0 || qy < 0 || qx >= IMG || qy >= IMG) continue
        const i = (qy * IMG + qx) * 4
        const inner = r <= 3
        data[i] = inner ? 255 : 0
        data[i + 1] = inner ? 40 : 0
        data[i + 2] = inner ? 40 : 0
        data[i + 3] = 255
      }
    }
  }

  return encodePng({ width: IMG, height: IMG, data })
}

// --- report ------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function num(v: number, n: number): string {
  const s = Math.round(v).toString()
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

function report(seed: string, stages: Record<string, Board>): void {
  const gen = towns(stages.generate)
  const ref = towns(stages.refine)

  const grid = (b: Board) => `${b.heightmap.size}² at ${b.frame.cellSize} u/cell`
  console.log(`\n=== ${seed} ===`)
  console.log(`  generate (the raw slider preview): ${grid(stages.generate)}`)
  console.log(`  refine   (the island played on):   ${grid(stages.refine)}`)

  console.log('\n  generate stage                 refine stage                   nearest')
  console.log('  ' + '-'.repeat(76))
  for (const t of gen) {
    const n = nearest(t, ref)
    const counterpart = n ? `${pad(n.town.name, 14)}${num(n.town.x, 6)},${num(n.town.z, 6)}` : '—'
    const gap = n ? `${num(n.dist, 6)} u` : ''
    console.log(`  ${pad(t.name, 14)}${num(t.x, 6)},${num(t.z, 6)}   ${counterpart}   ${gap}`)
  }

  // The headline number: how many capitals survive the stage change in place.
  const matched = gen.filter((t) => {
    const n = nearest(t, ref)
    return n !== null && n.dist <= SAME
  }).length
  console.log(
    `\n  ${matched} of ${gen.length} capitals within ${SAME} u of a counterpart` +
      ` — the two stages are ${matched === gen.length ? 'the same island' : 'different islands'}.`,
  )
}

// --- main --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
if (args.png) mkdirSync(OUT_DIR, { recursive: true })

for (const seed of args.seeds) {
  const stages: Record<string, Board> = {}
  for (const stage of ['generate', 'refine'] as BoardStage[]) {
    // `flatten: false` — the terraces are cut after placement and would only
    // smooth the picture, not move a capital.
    stages[stage] = buildBoard(seed, { stage, flatten: false })
  }

  report(seed, stages)

  if (args.png) {
    for (const stage of ['generate', 'refine'] as BoardStage[]) {
      const board = stages[stage]
      const file = resolve(OUT_DIR, `board-${seed}-${stage}.png`)
      writeFileSync(file, draw(board, towns(board)))
      console.log(`  wrote ${file}`)
    }
  }
}
