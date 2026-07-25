import * as THREE from 'three'
import { Avatar, type TerrainFrame } from './game/avatar'
import { Keyboard } from './game/input'
import { createCameraRig, type ViewPreset } from './render/camera'
import { createScene } from './render/scene'
import { TerrainMesh } from './render/terrainMesh'
import { Compass } from './ui/compass'
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
  maxAnisotropy: scene.renderer.capabilities.getMaxAnisotropy(),
})
terrain.setDetail(params.render.detail)
scene.scene.add(terrain.group)

const keys = new Keyboard()
const avatar = new Avatar()
scene.scene.add(avatar.object)
const compass = new Compass(document.body)

/** Everything the avatar needs to sit on the current terrain. */
function terrainFrame(): TerrainFrame | null {
  if (!current) return null
  return {
    heightmap: current,
    cellSize: params.render.cellSize,
    heightScale: params.render.heightScale,
    seaLevel: params.shape.seaLevel,
  }
}

function syncAvatarVisibility(): void {
  avatar.object.visible = params.avatar.enabled
  avatar.setScale(params.avatar.scale)
  rig.follow(params.avatar.enabled && params.avatar.followCamera ? avatar.position : null)
}

/**
 * Put the avatar somewhere sensible: keep its XZ if it already has one (so a
 * regenerate doesn't teleport you), otherwise start it at the map centre.
 */
function settleAvatar(reset: boolean): void {
  const frame = terrainFrame()
  if (!frame) return
  const x = reset ? 0 : avatar.position.x
  const z = reset ? 0 : avatar.position.z
  avatar.placeAt(frame, x, z, params.avatar)
}

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
  // The surface moved underneath it, so re-seat rather than leave it floating
  // or buried. Keeps its XZ unless the map size changed the world extent.
  settleAvatar(refit)
  syncAvatarVisibility()
}

/** Scene-level settings that don't require re-meshing. */
function applySceneParams(): void {
  const extent = terrain.worldSize || 256
  scene.setEnvironment(params.shape.seaLevel, params.render.heightScale, extent)
  scene.setSun(params.render.sunAzimuth, params.render.sunElevation, extent)
  scene.water.visible = params.render.showWater
  terrain.setDetail(params.render.detail)
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
  detailChanged: () => terrain.setDetail(params.render.detail),
  avatarChanged: syncAvatarVisibility,
  recallAvatar: () => {
    settleAvatar(true)
    if (params.avatar.followCamera) rig.apply('follow')
  },
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
      avatar,
      rig,
      keys,
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

const clock = new THREE.Clock()

scene.renderer.setAnimationLoop(() => {
  // Clamped so a backgrounded tab doesn't resume with a huge step that
  // teleports the avatar across the map.
  const dt = Math.min(clock.getDelta(), 0.1)

  const frame = terrainFrame()
  if (frame && params.avatar.enabled) {
    avatar.update(dt, keys, frame, params.avatar)
    avatar.updateMarkerVisibility(rig.camera)
  }

  rig.update(dt, params.camera)
  compass.update(rig.camera, rig.isSettling())
  scene.renderer.render(scene.scene, rig.camera)
})

regenerate()
