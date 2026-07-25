import { createCameraRig, type ViewPreset } from './render/camera'
import { createScene } from './render/scene'
import { TerrainMesh } from './render/terrainMesh'
import { buildGui } from './ui/gui'
import { Heightmap } from './world/heightmap'
import { defaultParams } from './world/params'
import { randomSeed } from './world/prng'
import type { WorkerRequest, WorkerResponse } from './world/protocol'

const appEl = document.getElementById('app')!
const statusEl = document.getElementById('status')!

const params = defaultParams()

const scene = createScene(appEl)
const rig = createCameraRig(scene.renderer.domElement)
const terrain = new TerrainMesh({
  cellSize: params.render.cellSize,
  heightScale: params.render.heightScale,
  seaLevel: params.shape.seaLevel,
  tileSize: 64,
  wireframe: params.render.wireframe,
})
scene.scene.add(terrain.group)

// --- generation worker -------------------------------------------------------

const worker = new Worker(new URL('./world/worker.ts', import.meta.url), {
  type: 'module',
})

let jobId = 0
/** Heights as generated, before any erosion — the source for Erode and Revert. */
let baseHeights: Float32Array | null = null
let current: Heightmap | null = null
let erosionBusy = false
let stats = { genMs: 0, erodeMs: 0, eroded: false, progress: 0 }

function post(msg: WorkerRequest, transfer?: Transferable[]): void {
  worker.postMessage(msg, transfer ?? [])
}

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const msg = event.data

  // Drop responses from superseded jobs — the user has moved a slider since.
  if (msg.jobId !== jobId) return

  if (msg.type === 'progress') {
    stats.progress = msg.frac
    updateStatus()
    return
  }

  if (msg.type === 'error') {
    erosionBusy = false
    gui.setErosionBusy(false)
    statusEl.textContent = `error: ${msg.message}`
    console.error('[worker]', msg.message)
    return
  }

  const heights = new Float32Array(msg.heights)

  if (msg.phase === 'generate') {
    stats.genMs = msg.ms
    stats.erodeMs = 0
    stats.eroded = false
    baseHeights = heights.slice()
    current = new Heightmap(msg.size, heights)
    rebuildMesh(true)
  } else {
    stats.erodeMs = msg.ms
    stats.eroded = true
    stats.progress = 0
    erosionBusy = false
    gui.setErosionBusy(false)
    current = new Heightmap(msg.size, heights)
    rebuildMesh(false)
  }
  updateStatus()
}

// --- actions ----------------------------------------------------------------

let regenQueued = false

/** Coalesce slider drags to at most one regeneration per frame. */
function regenerate(): void {
  if (regenQueued) return
  regenQueued = true
  requestAnimationFrame(() => {
    regenQueued = false
    jobId++
    erosionBusy = false
    gui.setErosionBusy(false)
    post({ type: 'generate', jobId, params: structuredClone(params) })
  })
}

function runErosion(): void {
  if (!baseHeights || !current || erosionBusy) return
  jobId++
  erosionBusy = true
  stats.progress = 0
  gui.setErosionBusy(true)
  updateStatus()
  // Always erode the pristine generated heights rather than an already-eroded
  // map, so repeated runs with different settings are comparable and Revert
  // always has somewhere to go back to. Send a copy — the buffer is
  // transferred away, and the original has to survive here.
  const copy = baseHeights.slice()
  post(
    {
      type: 'erode',
      jobId,
      params: structuredClone(params),
      size: current.size,
      heights: copy.buffer as ArrayBuffer,
    },
    [copy.buffer as ArrayBuffer],
  )
}

function revertErosion(): void {
  if (!baseHeights || !current) return
  current = new Heightmap(current.size, baseHeights.slice())
  stats.eroded = false
  stats.erodeMs = 0
  rebuildMesh(false)
  updateStatus()
}

/** Rebuild geometry from `current`. `refit` also re-frames the camera. */
function rebuildMesh(refit: boolean): void {
  if (!current) return
  terrain.build(current, {
    cellSize: params.render.cellSize,
    heightScale: params.render.heightScale,
    seaLevel: params.shape.seaLevel,
    wireframe: params.render.wireframe,
  })
  applySceneParams()
  if (refit) {
    rig.fitToWorld(terrain.worldSize, params.render.heightScale)
  }
}

/** Scene-level settings that don't require re-meshing. */
function applySceneParams(): void {
  const extent = terrain.worldSize || 256
  scene.setEnvironment(params.shape.seaLevel, params.render.heightScale, extent)
  scene.setSun(params.render.sunAzimuth, params.render.sunElevation, extent)
  scene.water.visible = params.render.showWater
}

/** A look-only change: re-mesh for colour/scale, but skip the noise pipeline. */
function refreshLook(): void {
  if (!current) {
    applySceneParams()
    return
  }
  rebuildMesh(false)
}

function updateStatus(): void {
  const parts: string[] = []
  parts.push(`seed ${params.seed}   ${params.mapSize}²`)
  parts.push(`${(terrain.triangleCount / 1000).toFixed(0)}k tris`)
  parts.push(`gen ${stats.genMs.toFixed(0)} ms`)
  if (erosionBusy) {
    parts.push(`eroding ${(stats.progress * 100).toFixed(0)}%`)
  } else if (stats.eroded) {
    parts.push(`eroded ${(stats.erodeMs / 1000).toFixed(2)} s`)
  }
  statusEl.textContent = parts.join('   ·   ')
}

// --- gui --------------------------------------------------------------------

const gui = buildGui(params, {
  regenerate,
  refresh: refreshLook,
  randomizeSeed: () => {
    params.seed = randomSeed()
    gui.refreshDisplay()
    regenerate()
  },
  erode: runErosion,
  revert: revertErosion,
  preset: (p: ViewPreset) => rig.apply(p),
})

// Console handle for tuning without round-tripping through the panel:
//   __world.params.erosion.erodeSpeed = 0.02; __world.erode()
if (import.meta.env.DEV) {
  Object.assign(window, {
    __world: {
      params,
      regenerate,
      erode: runErosion,
      revert: revertErosion,
      heights: () => current,
      gui,
    },
  })
}

// --- loop -------------------------------------------------------------------

function onResize(): void {
  const w = appEl.clientWidth
  const h = appEl.clientHeight
  scene.resize(w, h)
  rig.resize(w / Math.max(1, h))
}
window.addEventListener('resize', onResize)
onResize()

rig.fitToWorld(params.mapSize * params.render.cellSize, params.render.heightScale)
rig.apply('populous')

scene.renderer.setAnimationLoop(() => {
  rig.update()
  scene.renderer.render(scene.scene, rig.camera)
})

regenerate()
