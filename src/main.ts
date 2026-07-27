import * as THREE from 'three'
import { Avatar } from './game/avatar'
import { Keyboard } from './game/input'
import { createCameraRig, type ViewInsets, type ViewPreset } from './render/camera'
import { CardLayer, type CardSpec } from './render/cardLayer'
import { createScene } from './render/scene'
import { loadSpriteAtlas } from './render/spriteAtlas'
import type { SpriteKey } from './render/spriteAtlas'
import { TerrainMesh } from './render/terrainMesh'
import type { TerrainFrame } from './world/terrainQuery'
import { Compass } from './ui/compass'
import { Credits } from './ui/credits'
import { DPad } from './ui/dpad'
import { setTouchMode, startTouchDetection } from './ui/touchMode'
import { buildGui } from './ui/gui'
import { Heightmap } from './world/heightmap'
import { defaultParams } from './world/params'
import { BIOMES, buildBiomeField } from './world/biome'
import type { BiomeField } from './world/biome'
import { placeCities } from './world/cities'
import type { City } from './world/cities'
import { FogGrid } from './world/fog'
import { FogTexture } from './render/fogTexture'
import { FogOfWar } from './game/fogOfWar'
import {
  flattenSitePads,
  ringDecorations,
  scatterDecorations,
  settlementLayout,
} from './world/sites'
import type { DecoSpot, SitePad } from './world/sites'
import { terrainHeightAt } from './world/terrainQuery'
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
  ...coastShelf(),
})
terrain.setDetail(params.render.detail)
scene.scene.add(terrain.group)

const keys = new Keyboard()
const avatar = new Avatar()
scene.scene.add(avatar.object)
// Added alongside the avatar rather than inside it: the shadow lies on the
// terrain in world space, and everything in `avatar.object` is measured from a
// frame that hovers, yaws and scales with the figure.
scene.scene.add(avatar.shadow.object)
const compass = new Compass(document.body)
// Touch movement. It feeds the same movement codes into `keys`, so nothing
// downstream — the avatar, the fog, the follow camera — knows it exists.
const dpad = new DPad(document.body, keys)
// Built last of the HUD so the flag it sets finds every piece already on the
// page; the panel itself is created further down and styles itself on the
// next frame either way.
startTouchDetection()
// The art licence asks for attribution on screen, not just in the repo.
new Credits(document.body)

const fogGrid = new FogGrid()
const fogTexture = new FogTexture(fogGrid)
const fogOfWar = new FogOfWar(fogGrid)

const atlas = loadSpriteAtlas(scene.renderer.capabilities.getMaxAnisotropy())
/**
 * Instance budget for the whole board.
 *
 * Large on purpose. Vegetation in this art style is *cover*, not garnish, and
 * cover is set by the ratio of prop size to spacing — so halving the sprites
 * means halving the lattice, which quadruples the count. At a 2 m lattice over
 * a 2 km island that is around 160k props.
 *
 * It stays one draw call. The buffers cost roughly 170 bytes an instance, so
 * this reserves about 30 MB — against a terrain that runs to 185 MB of vertex
 * data at full amplification. Fog culling means only the explored fraction is
 * ever submitted, which early on is a small part of it.
 */
const CARD_CAPACITY = 180000
const cards = new CardLayer({ atlas, capacity: CARD_CAPACITY })
scene.scene.add(cards.object)

/**
 * World units per cell of the *current* heightmap.
 *
 * Amplification subdivides the grid after generation, so the render grid can be
 * several times finer than `mapSize`. Deriving the cell size from the world
 * width keeps the island exactly the same size on screen however many levels
 * are applied — otherwise amplifying would silently quadruple the world.
 */
function effectiveCellSize(): number {
  const worldWidth = params.mapSize * params.render.cellSize
  const cells = current ? current.size - 1 : params.mapSize
  return worldWidth / Math.max(1, cells)
}

/** Everything the avatar needs to sit on the current terrain. */
function terrainFrame(): TerrainFrame | null {
  if (!current) return null
  return {
    heightmap: current,
    cellSize: effectiveCellSize(),
    heightScale: params.render.heightScale,
    seaLevel: params.shape.seaLevel,
    ...coastShelf(),
  }
}

/**
 * The coastal step, converted from the world units the GUI speaks to the
 * normalised heights the heightfield does.
 *
 * One function, because the mesh and every height query have to be shaping the
 * ground identically — a shelf under the terrain but not under the avatar puts
 * it knee-deep in its own beach.
 */
function coastShelf(): { shelfRise: number; shelfBand: number } {
  const scale = Math.max(1e-5, params.render.heightScale)
  return {
    shelfRise: params.render.coastStep / scale,
    shelfBand: params.render.coastBand / scale,
  }
}

function syncAvatarVisibility(): void {
  avatar.object.visible = params.avatar.enabled
  // The shadow is a sibling, so it doesn't inherit the avatar's visibility —
  // and hiding the figure has to take its shadow with it, or the map is left
  // with a dark spot sliding around on ground nothing is standing over.
  avatar.shadow.object.visible = params.avatar.enabled && params.avatar.shadow
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
let openedOnAvatar = false
let stats = {
  genMs: 0,
  erodeMs: 0,
  amplifyMs: 0,
  eroded: false,
  progress: 0,
  phase: '' as string,
}

function post(msg: WorkerRequest, transfer?: Transferable[]): void {
  worker.postMessage(msg, transfer ?? [])
}

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const msg = event.data

  // Drop responses from superseded jobs — the user has moved a slider since.
  if (msg.jobId !== jobId) return

  if (msg.type === 'progress') {
    stats.progress = msg.frac
    stats.phase = msg.phase
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
    stats.amplifyMs = 0
    stats.eroded = false
    // Snapshot before the site pads are cut, so Revert goes back to the
    // untouched surface and the pads are then re-cut from scratch.
    baseHeights = heights.slice()
    current = new Heightmap(msg.size, heights)
    // A new island is a new map to learn. Erosion and look changes are not.
    fogGrid.setWorld(params.mapSize * params.render.cellSize)
    fogGrid.reset()
    fogOfWar.invalidate()
    cutSitePads()
    rebuildMesh(true)
    // Open on the avatar rather than the overview — the close third-person
    // framing is the default view now. Only on the very first build, so later
    // regenerates don't yank you back out of whatever you were looking at.
    if (!openedOnAvatar) {
      openedOnAvatar = true
      if (params.avatar.enabled) rig.apply('follow', params.camera)
    }
  } else {
    stats.erodeMs = msg.erodeMs
    stats.amplifyMs = msg.amplifyMs
    stats.eroded = true
    stats.progress = 0
    stats.phase = ''
    erosionBusy = false
    gui.setErosionBusy(false)
    current = new Heightmap(msg.size, heights)
    // Erosion recarves the valleys and amplification refines the grid, so the
    // pads have to be cut again — they were levelled into a surface that no
    // longer exists.
    cutSitePads()
    // Amplification changes the grid resolution, so the camera limits, water
    // and avatar footing all need re-deriving — but not the framing.
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
      type: 'refine',
      jobId,
      params: structuredClone(params),
      // The simulation grid, not the current one — a previous refine may have
      // left `current` subdivided, and re-refining that would compound.
      size: params.mapSize + 1,
      heights: copy.buffer as ArrayBuffer,
    },
    [copy.buffer as ArrayBuffer],
  )
}

function revertErosion(): void {
  if (!baseHeights) return
  // Back to the simulation grid, which is what baseHeights is sized for —
  // `current` may have been subdivided by amplification since.
  current = new Heightmap(params.mapSize + 1, baseHeights.slice())
  stats.eroded = false
  stats.erodeMs = 0
  stats.amplifyMs = 0
  // baseHeights predates the pads, so they have to be re-cut into the restored
  // surface rather than surviving the revert.
  cutSitePads()
  rebuildMesh(false)
  updateStatus()
}

const PLAYER_TINT = 0x4a80c0
const NEUTRAL_TINT = 0x9aa4ae

/**
 * How wide a settlement is, as a multiple of its town card's width.
 *
 * These are the ring the buildings stand on, town included — not a band around
 * something in the middle, because there is nothing in the middle. The plaza the
 * ring encloses is about two town-widths across, which is room for an army to
 * form up in without the village reading as a racetrack with a keep on it.
 *
 * The band between them is narrow on purpose. A wide band is a blob of houses; a
 * narrow one is a street with a frontage, and the frontage is what makes the
 * empty ground inside look enclosed rather than merely unoccupied.
 */
const VILLAGE_INNER = 0.92
const VILLAGE_OUTER = 1.16
/**
 * Margin between the village's own footprint and the edge of the levelled
 * terrace.
 *
 * The footprint is the ring plus half a town, since the town now stands *on*
 * the ring and sweeps its own width as it yaw-billboards. Getting this wrong
 * shows as the tallest card in the game standing half off its terrace.
 */
const VILLAGE_MARGIN = 1.06

/**
 * The placed world: the capitals, the territories they define, and every card
 * standing on it.
 *
 * Held rather than recomputed because the pads are cut from it *before* the
 * cards are seated on the result — two calls that disagreed would level the
 * ground in one place and put the town in another. `planWorld` runs once per new
 * heightmap, from `cutSitePads`.
 */
interface WorldPlan {
  cities: City[]
  field: BiomeField | null
  /** Cities and their villages, in card order. */
  sites: CardSpec[]
  /**
   * The levelled ground each village stands on, centred on its plaza.
   *
   * Not carried by the town card the way it used to be. A card's pad is centred
   * on the card, and the town now stands on the rim of its own circle — hanging
   * the terrace off it would level a disc pushed a full ring-radius north of the
   * village and leave the southern houses on whatever slope was there. The
   * clearing belongs to the settlement, so the settlement holds it.
   */
  plazas: SitePad[]
  /**
   * Capitals whose surroundings stay permanently on the map.
   *
   * The player's own, and only theirs. Feeding every city here would put all six
   * territories on the map before the avatar had moved, which is the one thing
   * fog of war exists to prevent. Rival capitals become permanent when there is
   * something that tracks having found them.
   */
  owned: { x: number; z: number }[]
}
let plan: WorldPlan | null = null

/**
 * Site the capitals and grow their settlements.
 *
 * Order matters: cities are scored against the terrain as generated, and the
 * biome field is then seeded from where they landed, so a territory is the land
 * around its capital rather than a random disc that happens to contain one.
 * Flattening comes after — it only touches ground under pads chosen here.
 */
function planWorld(): WorldPlan | null {
  const frame = terrainFrame()
  if (!frame) return null

  const townWidth = cards.spriteWidth('city.castle')
  const clearing = (townWidth * VILLAGE_OUTER + townWidth * 0.5) * VILLAGE_MARGIN
  const cities = params.biome.enabled
    ? placeCities(params.seed, frame, { count: params.biome.cities, clearing })
    : []

  const field = params.biome.enabled
    ? buildBiomeField(
        params.seed,
        params.mapSize * params.render.cellSize,
        params.biome,
        cities,
      )
    : null

  const settlements = settlementLayout(cities, params.seed, {
    inner: townWidth * VILLAGE_INNER,
    outer: townWidth * VILLAGE_OUTER,
    townWidth,
  })

  // Every card in a village stands on the village's terrace, so none of them cut
  // ground of their own or push the treeline outward: `padScale: 0` turns off
  // both. That now includes the town — the clearing it used to carry has moved
  // to `plazas`, which is centred where the village is rather than where its
  // largest building happens to stand.
  const sites: CardSpec[] = settlements.map((s) => ({
    sprite: BIOMES[s.city.biome].faction as SpriteKey,
    x: s.town.x,
    z: s.town.z,
    tint: s.city.player ? PLAYER_TINT : NEUTRAL_TINT,
    padScale: 0,
  }))

  // Houses keep a little legibility, unlike scenery — a cluster of buildings is
  // how a settlement reads from altitude, and letting them shrink away leaves
  // one lonely town.
  for (const s of settlements) {
    for (const spot of s.buildings) {
      sites.push({
        sprite: spot.sprite as SpriteKey,
        x: spot.x,
        z: spot.z,
        scale: 0.9 + spot.size * 0.25,
        padScale: 0,
        discRadius: 0,
        legibility: 0.5,
      })
    }
  }

  const plazas: SitePad[] = cities.map((c) => ({ x: c.x, z: c.z, radius: clearing }))
  const owned = cities.filter((c) => c.player).map((c) => ({ x: c.x, z: c.z }))
  return { cities, field, sites, plazas, owned }
}

/**
 * Size jitter for decoration, either side of `DECO_SCALE_MID`.
 *
 * Mid is 1: everything renders at one pixel size. This was 2.4 on the theory
 * that the art was not drawn to a common scale — but it is. The whole pack is
 * built on a 16px grid, where a tree and a creature each occupy one cell and a
 * town occupies four, and the ground tiles are on that same grid. Scaling the
 * trees up made a tree pixel two and a half times a building pixel and four
 * times a ground texel, which is exactly the mismatch that reads as three
 * different art styles sharing a screen.
 *
 * The jitter stays: identical trees in a row read as a stamp, and a little
 * variation is not a scale conflict.
 */
const DECO_SCALE_MID = 1
const DECO_SCALE_JITTER = 0.3

/**
 * Turn the scatter into cards.
 *
 * `padScale: 0` means the ground is left alone — a tree should sit in the
 * landscape, not level it.
 */
function decorationCards(spots: DecoSpot[]): CardSpec[] {
  return spots.map((spot) => ({
    sprite: spot.sprite as SpriteKey,
    x: spot.x,
    z: spot.z,
    scale: DECO_SCALE_MID - DECO_SCALE_JITTER / 2 + spot.size * DECO_SCALE_JITTER,
    padScale: 0,
    discRadius: 0,
    // Scenery, not a landmark: let it shrink into the landscape with distance
    // instead of swelling to the same on-screen minimum the buildings hold.
    legibility: 0,
  }))
}

/**
 * Site the cards on a newly generated or newly eroded heightmap.
 *
 * Order matters and is the whole point: level the pads *first*, then seat the
 * cards on the levelled result. Seating first would put every card on ground
 * that is about to move.
 *
 * This mutates `current`, so it must run exactly once per new heightmap — from
 * the worker's `done` and from a revert, never from a look-only refresh, or the
 * graded skirts compound into craters.
 */
function cutSitePads(): void {
  if (!current) return
  // Plan first, then cut. This is the only place the plan is made, which is what
  // guarantees the terraces and the towns standing on them agree.
  plan = planWorld()
  if (!plan) return
  flattenSitePads(current, effectiveCellSize(), [
    ...cards.padsFor(plan.sites),
    ...plan.plazas,
  ])
}

/**
 * Rebuild every card from the current parameters.
 *
 * Split from the pad cutting above because the two have opposite rules: pads
 * mutate the heightmap and must run exactly once per new terrain, while the
 * decoration depends on look settings — scatter density, sprite scale — that
 * change without the terrain changing at all. Folding them together meant
 * adjusting scatter did nothing until the next regenerate.
 *
 * The sites themselves come from the plan rather than being rebuilt here. They
 * cannot move without the terraces under them moving too, which is why the two
 * territory controls that would move them regenerate instead of refreshing.
 */
function buildCards(): void {
  if (!current || !plan) return
  const { sites, field } = plan

  const frame = terrainFrame()
  if (!frame) return

  // Spacing tracks the tree's own width rather than a fixed world distance, so
  // rescaling every sprite keeps the scatter equally dense instead of thinning
  // it out.
  const treeWidth = 15 * (cards.scale / 16) * DECO_SCALE_MID

  // A settlement's treeline belongs outside the whole village, so it stands off
  // the plaza rather than off any one card in it — every village card carries
  // `padScale: 0` and asks for no ring of its own. `decoRingsFor` is still
  // consulted for anything else that gets sited later; zero-radius entries are
  // dropped so the scatter's avoid test isn't walking a list of hundreds of
  // buildings that block nothing.
  const clearings = [
    ...cards.decoRingsFor(sites),
    ...plan.plazas.map((p) => ({ ...p, radius: p.radius * 1.08 })),
  ].filter((pad) => pad.radius > 0)

  // Rings first: a site's own clearing gets a denser fringe than open country.
  // Then dress the rest of the island, keeping clear of those clearings.
  const seaY = params.shape.seaLevel * params.render.heightScale
  const rings = ringDecorations(clearings, params.seed, field, {
    spacing: treeWidth * 1.35,
  }).filter((spot) => terrainHeightAt(frame, spot.x, spot.z) > seaY + 1)

  const scatter = params.render.scatter
    ? scatterDecorations(
        {
          hm: current,
          cellSize: effectiveCellSize(),
          heightScale: params.render.heightScale,
          seaLevel: params.shape.seaLevel,
        },
        field,
        params.seed,
        {
          spacing: params.render.scatterSpacing,
          blobScale: params.render.scatterBlob,
          avoid: clearings,
          maxCount: CARD_CAPACITY - sites.length - rings.length,
        },
      )
    : []

  cards.set([...sites, ...decorationCards(rings), ...decorationCards(scatter)], frame)
}

/**
 * Re-seat existing cards after the surface moved under them.
 *
 * Cards store XZ only, so this is all a look change costs them. It must go
 * through `terrainFrame()` — amplification subdivides the grid, and reading
 * `params.render.cellSize` directly would put every card eight times off centre
 * at the default amplification, which looks like a placement bug rather than a
 * grounding one.
 */


/** Rebuild geometry from `current`. `refit` also re-frames the camera. */
function rebuildMesh(refit: boolean): void {
  if (!current) return
  // The *plan's* field, not a fresh one. The colour of every vertex asks it
  // whose land it is standing on, and so does every scattered tree — so the two
  // have to be asking the same object. Building one here meant the ground was
  // painted from a randomly seeded field while the trees came from the
  // city-seeded one, which put snow-laden firs and ice crystals on swamp.
  terrain.setBiomeField(plan?.field ?? null)
  terrain.build(current, {
    cellSize: effectiveCellSize(),
    heightScale: params.render.heightScale,
    seaLevel: params.shape.seaLevel,
    wireframe: params.render.wireframe,
    ...coastShelf(),
  })
  applySceneParams()
  if (refit) {
    rig.fitToWorld(terrain.worldSize, params.render.heightScale)
  }
  // The surface moved underneath it, so re-seat rather than leave it floating
  // or buried. Keeps its XZ unless the map size changed the world extent.
  // Scale first: ride height is measured in body heights, so placing the
  // avatar before its scale is applied seats it at the unscaled altitude.
  syncAvatarVisibility()
  settleAvatar(refit)
  // Cards are rebuilt, not just re-grounded: a look change can alter which
  // props exist, not merely where they stand.
  buildCards()
  // A regenerate resets the avatar to the map centre, which is a teleport, not
  // movement — the camera should be there already rather than flying across.
  if (refit) rig.snapFollow()
}

/**
 * Camera settings the rig can't apply on its own.
 *
 * The north lock is the rig's business, but it also decides how the cards face:
 * with the view pinned due south they can point in one fixed direction, and
 * only an orbitable view needs them tracking the camera.
 */
function applyCameraParams(): void {
  cards.setBillboard(!params.camera.lockNorth)
  // The sprites are drawn in a high-angle oblique view, so leaning them to the
  // camera's own pitch is what presents them undistorted. Tied to the resting
  // pitch rather than set as a constant, so tilting the view keeps them square.
  cards.setTilt(params.camera.recenterPitch)
}

/**
 * Put the view back where it starts: the close third-person framing on the
 * avatar, snapped rather than flown so it doesn't sweep across the island.
 *
 * Reset means reset — it turns camera-follow back on rather than framing the
 * avatar once and letting it wander back out of shot. One key, one predictable
 * outcome, whatever state the camera was left in.
 *
 * Only a hidden avatar leaves nothing to frame, and then the overview is the
 * one sensible default.
 */
function resetCamera(): void {
  if (!params.avatar.enabled) {
    rig.apply('populous', params.camera)
    return
  }
  params.avatar.followCamera = true
  // Re-points the rig at the avatar, and the checkbox has to show what actually
  // happened or the panel is lying about the state of the camera.
  syncAvatarVisibility()
  gui.refreshDisplay()
  rig.apply('follow', params.camera)
}

/** Scene-level settings that don't require re-meshing. */
function applySceneParams(): void {
  const extent = terrain.worldSize || 256
  scene.setEnvironment(params.shape.seaLevel, params.render.heightScale, extent)
  scene.setSun(params.render.sunAzimuth, params.render.sunElevation, extent)
  terrain.setDetail(params.render.detail)
  terrain.setSaturation(params.render.saturation)
  const ground = groundSettings()
  terrain.setGround(ground)
  // The sea is the terrain's own surface now — see terrainMaterial.ts. All the
  // plane past the map's edge has to do is continue it, which means matching
  // both the colour and the atmospheric treatment the terrain is using.
  terrain.setWater({ enabled: params.render.showWater, shoreBand: params.render.shoreFade })
  scene.setOcean(params.render.showWater, !ground.exact)
  applyFog()
}

/**
 * Ground tile settings with the scale resolved.
 *
 * Both `cards.scale` and `ground.scale` mean "world units per 16 source
 * pixels", so tying them together is what makes one ground texel the same size
 * on screen as one pixel of the buildings standing on it.
 */
/**
 * Apply the fog to everything that can be culled by it.
 *
 * Three levels, cheapest first: whole terrain tiles that nothing has explored
 * are hidden, every card standing in the dark is dropped from the instance
 * buffers, and the terrain shader discards what is left over the boundary. The
 * first two are why zooming out over an unexplored island is nearly free.
 */
function applyFog(): void {
  const worldSize = params.mapSize * params.render.cellSize
  fogGrid.setWorld(worldSize)
  const on = params.fog.enabled && !params.fog.revealAll
  fogTexture.sync(fogGrid)
  terrain.setFog(fogTexture.texture, worldSize, on)
  terrain.cullByFog(on ? (x0, z0, x1, z1) => fogGrid.maxExploredIn(x0, z0, x1, z1) : null)
  const frame = terrainFrame()
  if (frame) cards.cullByFog(on ? (x, z) => fogGrid.exploredAt(x, z) : null, frame)
}

function groundSettings() {
  const g = params.render.ground
  return { ...g, scale: g.matchPropScale ? cards.scale : g.scale }
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
  const grid = current ? current.size - 1 : params.mapSize
  parts.push(
    grid === params.mapSize
      ? `seed ${params.seed}   ${params.mapSize}²`
      : `seed ${params.seed}   ${params.mapSize}² → ${grid}²`,
  )
  parts.push(`${(terrain.triangleCount / 1000).toFixed(0)}k tris`)

  // The world scale is derived from a traversal time, so show that time rather
  // than making it something you have to trust or re-derive.
  const worldWidth = params.mapSize * params.render.cellSize
  const speed = params.avatar.fly ? params.avatar.flySpeed : params.avatar.walkSpeed
  if (speed > 0) {
    const secs = Math.round(worldWidth / speed)
    const mm = Math.floor(secs / 60)
    const ss = String(secs % 60).padStart(2, '0')
    parts.push(`${worldWidth} across · ${mm}:${ss} to cross @ ${speed}/s`)
  }

  if (params.fog.enabled && !params.fog.revealAll) {
    const tiles = terrain.visibleTiles
    parts.push(
      `explored ${(fogGrid.exploredFraction() * 100).toFixed(0)}%` +
        `   ·   ${tiles.shown}/${tiles.total} tiles drawn`,
    )
  }

  parts.push(`gen ${stats.genMs.toFixed(0)} ms`)
  if (erosionBusy) {
    parts.push(
      stats.phase === 'amplify'
        ? 'amplifying…'
        : `eroding ${(stats.progress * 100).toFixed(0)}%`,
    )
  } else if (stats.eroded) {
    parts.push(`eroded ${(stats.erodeMs / 1000).toFixed(2)} s`)
    if (stats.amplifyMs > 0) {
      parts.push(`amplified ${(stats.amplifyMs / 1000).toFixed(2)} s`)
    }
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
  preset: (p: ViewPreset) => rig.apply(p, params.camera),
  detailChanged: () => {
    terrain.setDetail(params.render.detail)
    terrain.setSaturation(params.render.saturation)
    terrain.setGround(groundSettings())
  },
  cameraChanged: () => applyCameraParams(),
  fogChanged: () => {
    fogOfWar.invalidate()
    applyFog()
    updateStatus()
  },
  resetFog: () => {
    fogGrid.reset()
    fogOfWar.invalidate()
    applyFog()
    updateStatus()
  },
  avatarChanged: () => {
    // Same ordering reason as in rebuildMesh: scale feeds ride height.
    syncAvatarVisibility()
    settleAvatar(false)
    updateStatus()
  },
  recallAvatar: () => {
    settleAvatar(true)
    // Teleporting the avatar must not make the camera chase it across the map.
    rig.snapFollow()
    if (params.avatar.followCamera) rig.apply('follow', params.camera)
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
      dpad,
      /** `__world.touchMode(true)` to preview the phone HUD on a desktop. */
      touchMode: setTouchMode,
      resetCamera,
      cards,
      scene,
      terrain,
      buildBiomeField,
      /** The placed capitals and their villages, as of the last pad cut. */
      plan: () => plan,
      /** Drop the avatar somewhere — `__world.goto(...__world.plan().cities[3])`. */
      goto: (x: number, z: number) => {
        const frame = terrainFrame()
        if (!frame) return
        avatar.placeAt(frame, x, z, params.avatar)
        rig.snapFollow()
      },
    },
  })
}

// --- loop -------------------------------------------------------------------

/**
 * How much of the canvas is hidden, and by what.
 *
 * Two sources, because they cover different things and neither knows about the
 * other. `env(safe-area-inset-*)` — republished as custom properties in
 * index.html — is the hardware: the notch and the home bar. The visual viewport
 * is the browser's own furniture: the toolbar a phone keeps at the bottom in
 * landscape, which overlays the page rather than shortening it, since `#app` is
 * `inset: 0` of the *layout* viewport and that is measured with the bars away.
 *
 * The larger of the two wins per edge. They overlap on a phone that has both,
 * and adding them would double-count the overlap and over-correct.
 */
function canvasInsets(w: number, h: number): ViewInsets {
  const css = getComputedStyle(document.documentElement)
  const env = (name: string): number => parseFloat(css.getPropertyValue(name)) || 0

  const insets = {
    left: env('--inset-left'),
    top: env('--inset-top'),
    right: env('--inset-right'),
    bottom: env('--inset-bottom'),
  }

  const vv = window.visualViewport
  // Ignore a pinch-zoomed viewport: the page forbids zooming, so a scale other
  // than 1 is a transient the framing should not chase.
  if (vv && Math.abs(vv.scale - 1) < 0.01) {
    insets.left = Math.max(insets.left, vv.offsetLeft)
    insets.top = Math.max(insets.top, vv.offsetTop)
    insets.right = Math.max(insets.right, w - vv.offsetLeft - vv.width)
    insets.bottom = Math.max(insets.bottom, h - vv.offsetTop - vv.height)
  }
  return insets
}

function onResize(): void {
  const w = appEl.clientWidth
  const h = appEl.clientHeight
  scene.resize(w, h)
  rig.resize(w, h, canvasInsets(w, h))
  // The cards' legibility floor is measured in real pixels, so it has to be
  // re-derived whenever the viewport or the field of view changes.
  cards.setViewport(h, rig.camera.fov)
}

// Watch the element, not the window.
//
// They are the same box — `#app` is `inset: 0` — but not the same *event*. A
// phone changes shape at moments the window event reports late, or reports with
// the dimensions it had a moment ago: turning it from portrait to landscape is
// the one that matters here, since that is how every phone session starts. A
// ResizeObserver fires off the box actually changing, so the render buffer
// follows the screen instead of trailing it, and it covers the cases no resize
// event fires for at all — a webview's chrome appearing, or the address bar
// collapsing after the first scroll.
new ResizeObserver(onResize).observe(appEl)
// The visual viewport moves without the layout viewport changing at all — a
// toolbar sliding away uncovers part of the canvas without resizing it — so the
// observer above never hears about it.
window.visualViewport?.addEventListener('resize', onResize)
window.visualViewport?.addEventListener('scroll', onResize)
// The observer's first callback is a frame away, and the first frame should not
// be drawn at the renderer's default size.
onResize()

/**
 * Register the service worker — see public/sw.js for what it is for.
 *
 * Production only. In development the whole point is that a reload shows the
 * edit you just made, and a worker sitting between the page and the dev server
 * is a machine for making that untrue.
 *
 * The build SHA rides on the URL rather than being baked into the worker, which
 * is what makes an update land: the browser compares the script *URL* and its
 * bytes, so a new build is unambiguously a new worker, and the old one's caches
 * are dropped as it activates. Registered after load so it never competes with
 * the terrain for the first paint, and a failure is logged rather than thrown —
 * offline support is a nicety, and the game runs without it.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js?v=${__BUILD_SHA__}`)
      .catch((err) => console.warn('[sw] registration failed', err))
  })
}

rig.fitToWorld(params.mapSize * params.render.cellSize, params.render.heightScale)
rig.apply('populous')
applyCameraParams()

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

  if (frame && params.fog.enabled && !params.fog.revealAll) {
    const seaY = params.shape.seaLevel * params.render.heightScale
    if (
      fogOfWar.update(
        dt,
        params.fog,
        avatar.position.x,
        avatar.position.z,
        avatar.position.y - seaY,
        params.render.heightScale,
        // A settlement puts its surroundings on the map for good — `reveal`'s
        // permanent channel, which existed for exactly this and had nothing to
        // feed it while the sites were a hardcoded list.
        plan?.owned ?? [],
      )
    ) {
      applyFog()
      // The readout reports what is actually being drawn, so it has to move
      // when the fog does.
      updateStatus()
    }
  }

  if (keys.consumePress('KeyC')) resetCamera()
  keys.endFrame()

  rig.update(dt, params.camera)
  compass.update(rig.camera, rig.isSettling())
  scene.renderer.render(scene.scene, rig.camera)
})

regenerate()
