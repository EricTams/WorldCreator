import * as THREE from 'three'
import { Avatar } from './game/avatar'
import { Keyboard } from './game/input'
import { createCameraRig, type ViewPreset } from './render/camera'
import { CardLayer, type CardSpec } from './render/cardLayer'
import { BoardLayer } from './render/boardLayer'
import { Effects } from './render/effects'
import { Banners } from './render/banners'
import { createScene } from './render/scene'
import { loadSpriteAtlas, loadUnitAtlas } from './render/spriteAtlas'
import type { SpriteKey, UnitKey } from './render/spriteAtlas'
import { Sim, RULES } from './game/sim'
import type { Army, BuildItem, SiteState } from './game/sim'
import { Hud } from './ui/hud'
import { FACTIONS } from './game/factions'
import { planGameMap } from './world/gameMap'
import type { MapPlan } from './world/gameMap'
import { raycastTerrain } from './game/raycast'
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
import type { DecoSpot } from './world/sites'
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
 * The live half of the board.
 *
 * Two layers because two atlases, and two atlases because one material binds one
 * texture. `units` draws creatures from `units.png`; `board` draws the map pieces
 * that can change — a vein that becomes a mine, a disc that changes colour —
 * from the same `sprites.png` the static layer uses. Both are rewritten every
 * frame; see `render/boardLayer.ts` for why that is the cheap option here and
 * the wrong one for the 180k props above.
 *
 * 900 is far more than a match can field: about 150 garrison creatures, six
 * armies of six, towers, and the loose pickups.
 */
const unitAtlas = loadUnitAtlas(scene.renderer.capabilities.getMaxAnisotropy())
const unitLayer = new BoardLayer<UnitKey>({ atlas: unitAtlas, capacity: 900 })
const boardLayer = new BoardLayer<SpriteKey>({ atlas, capacity: 400 })
scene.scene.add(unitLayer.object)
scene.scene.add(boardLayer.object)

const effects = new Effects()
scene.scene.add(effects.object)

const banners = new Banners()
scene.scene.add(banners.object)
// The player flies their own colours, and every banner they raise matches.
avatar.setFactionColor(FACTIONS[0].tint)

/**
 * The match.
 *
 * Created once and reset onto each new island rather than rebuilt, so the HUD
 * can hold a reference to it for the lifetime of the page. Its two callbacks are
 * the only things it is allowed to reach out and touch: moving the avatar on
 * respawn (the one time the simulation, rather than the player, decides where
 * the wizard is) and putting a line of text on screen.
 */
const sim = new Sim({
  onRespawn: (x, z) => {
    const frame = terrainFrame()
    if (!frame) return
    avatar.placeAt(frame, x, z, params.avatar)
    // A respawn is a teleport, and the camera has to be *moved*, not flown.
    // `snapFollow` alone is not enough and is the opposite of enough: it sets
    // the lagged pivot equal to the target, which zeroes the frame's delta, and
    // the delta is the only thing that ever moves the eye. Snapping without
    // re-framing therefore pins the camera to wherever the wizard died. Same
    // pair the Recall button uses.
    rig.snapFollow()
    if (params.avatar.followCamera) rig.apply('follow', params.camera)
  },
  onMessage: (text) => hud.message(text),
})

const hud = new Hud(document.body, sim, {
  onOrder: (army: Army, siteId: number) => sim.orderArmy(army, siteId),
  onRecall: (army: Army) => sim.recallArmy(army),
  onBuild: (site: SiteState, item: BuildItem) => {
    if (!sim.queueBuild(site, item)) hud.message('Not enough gold.')
  },
  onConvert: (site: SiteState) => {
    if (!sim.beginConvert(sim.player, site)) hud.message('Nothing to consecrate here.')
  },
  onRestart: () => {
    params.seed = randomSeed()
    gui.refreshDisplay()
    regenerate()
  },
})

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
  avatar.setScale(params.avatar.scale)
  rig.follow(params.avatar.enabled && params.avatar.followCamera ? avatar.position : null)
}

/**
 * Put the avatar somewhere sensible: keep its XZ if it already has one (so a
 * regenerate doesn't teleport you), otherwise start it at its own capital.
 *
 * The capital rather than the map centre. The two are close — `cities.ts` hands
 * the player whichever capital is nearest the origin — but "close" was enough to
 * drop the wizard inside a *neutral* town's defensive fire on some seeds, and a
 * hundred hit points against two hunters is about six seconds. Starting on your
 * own doorstep is also simply what the game means: the match opens at home.
 */
function settleAvatar(reset: boolean): void {
  const frame = terrainFrame()
  if (!frame) return
  const home = reset && sim.ready ? sim.player : null
  const x = home ? home.x : reset ? 0 : avatar.position.x
  const z = home ? home.z : reset ? 0 : avatar.position.z
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

/**
 * How wide a settlement is, as a multiple of its town card's width.
 *
 * Sized against the *houses*, not against the town. A town is 64 px and a house
 * 12, so at the shared pixel scale the town is ten world units across and its
 * huts are two. A ring at two town-widths therefore leaves ten units of arc
 * between neighbours — five house-widths of empty grass — and reads as a castle
 * with some sheds near it rather than as a settlement. Pulled in to just clear
 * the town's own footprint, where the houses crowd it the way a village crowds
 * a keep.
 */
const VILLAGE_INNER = 0.78
const VILLAGE_OUTER = 1.35
/** Margin between the outermost hut and the edge of the levelled terrace. */
const VILLAGE_MARGIN = 1.18

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
  /** The board: who owns which capital, and where the mines and points are. */
  game: MapPlan
  /**
   * Stand-in cards for the game sites that are *not* cities.
   *
   * They are never handed to the static card layer — the dynamic one draws them,
   * because a vein becomes a mine and a disc changes colour. But they still have
   * to cut a levelled pad and hold the treeline back, and both of those are
   * computed from a `CardSpec`, so this is the shape they take to ask for them.
   */
  gamePads: CardSpec[]
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
  const clearing = townWidth * VILLAGE_OUTER * VILLAGE_MARGIN
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

  const game = planGameMap(params.seed, frame, cities, FACTIONS.length)

  // A wizard's capital is drawn with its faction's own castle rather than with
  // its territory's, so the three seats of power are recognisable on sight.
  // Neutral towns keep their biome's building — that variety is the map's, and
  // overriding all fifteen would make the island read as three colours.
  const capitalSprite = new Map<number, SpriteKey>()
  for (const site of game.sites) {
    if (site.kind !== 'city' || site.owner < 0 || site.cityIndex === undefined) continue
    capitalSprite.set(site.cityIndex, FACTIONS[site.owner].city)
  }

  const sites: CardSpec[] = cities.map((c, i) => ({
    sprite: capitalSprite.get(i) ?? (BIOMES[c.biome].faction as SpriteKey),
    x: c.x,
    z: c.z,
    // Ownership colour is the dynamic layer's job now: it has to change hands
    // mid-match, and a card in the static layer cannot. Suppressing the disc
    // here is what stops the two drawing one on top of the other.
    discRadius: 0,
    // One terrace for the whole village — see `CardSpec.clearing`.
    clearing,
  }))

  // Satellites sit on the town's terrace, so they neither cut ground of their
  // own nor push the treeline outward: `padScale: 0` turns off both. They keep
  // a little legibility, unlike scenery — a cluster of huts is how a settlement
  // reads from altitude, and letting them shrink away leaves one lonely town.
  for (const spot of settlementLayout(cities, params.seed, {
    inner: townWidth * VILLAGE_INNER,
    outer: townWidth * VILLAGE_OUTER,
  })) {
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

  const gamePads: CardSpec[] = game.sites
    .filter((s) => s.sprite !== null)
    .map((s) => ({
      sprite: s.sprite as SpriteKey,
      x: s.x,
      z: s.z,
      clearing: s.radius,
    }))

  const owned = cities.filter((c) => c.player).map((c) => ({ x: c.x, z: c.z }))
  return { cities, field, sites, game, gamePads, owned }
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
    ...cards.padsFor(plan.gamePads),
  ])
  // A new island is a new match. Erosion moves the coastline and so moves every
  // capital, which means the board this match was being played on no longer
  // exists — restarting is the honest answer, not a bug.
  sim.reset(plan.game)
  hud.reset()
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

  // Rings first: a site's own clearing gets a denser fringe than open country.
  // Then dress the rest of the island, keeping clear of those clearings.
  const seaY = params.shape.seaLevel * params.render.heightScale
  // The game sites want a treeline of their own, and want the open scatter kept
  // out of their clearings — a mine standing in a wood is a mine you cannot see.
  const clearings = [...cards.decoRingsFor(sites), ...cards.decoRingsFor(plan.gamePads)]
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
  // The live layers have to agree with the static one exactly, or a creature
  // standing next to a town faces a different way than the town does.
  for (const layer of [unitLayer, boardLayer]) {
    layer.setBillboard(!params.camera.lockNorth)
    layer.setTilt(params.camera.recenterPitch)
  }
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
      sim,
      hud,
      unitLayer,
      boardLayer,
      scene,
      terrain,
      buildBiomeField,
      /** The placed capitals and their villages, as of the last pad cut. */
      plan: () => plan,
      /** The current terrain, for driving the sim by hand from the console. */
      frame: () => terrainFrame(),
      /** Ground height at a world XZ — what a spell aimed at the map hits. */
      groundAt: (x: number, z: number) => {
        const frame = terrainFrame()
        return frame ? terrainHeightAt(frame, x, z) : 0
      },
      /** Drop the avatar somewhere — `__world.goto(...__world.plan().cities[3])`. */
      goto: (x: number, z: number) => {
        const frame = terrainFrame()
        if (!frame) return
        avatar.placeAt(frame, x, z, params.avatar)
        // Re-frame as well as snap — see the respawn callback for why snapping
        // on its own leaves the camera behind rather than bringing it along.
        rig.snapFollow()
        if (params.avatar.followCamera) rig.apply('follow', params.camera)
      },
    },
  })
}

// --- loop -------------------------------------------------------------------

function onResize(): void {
  const w = appEl.clientWidth
  const h = appEl.clientHeight
  scene.resize(w, h)
  rig.resize(w / Math.max(1, h))
  // The cards' legibility floor is measured in real pixels, so it has to be
  // re-derived whenever the viewport or the field of view changes.
  cards.setViewport(h, rig.camera.fov)
  unitLayer.setViewport(h, rig.camera.fov)
  boardLayer.setViewport(h, rig.camera.fov)
}
window.addEventListener('resize', onResize)
onResize()

rig.fitToWorld(params.mapSize * params.render.cellSize, params.render.heightScale)
rig.apply('populous')
applyCameraParams()

// --- pointing at the world ---------------------------------------------------

/**
 * Where on the ground the player just clicked.
 *
 * The ray comes from the camera through the pointer; the intersection is
 * `raycastTerrain`'s heightfield march rather than three's triangle raycaster,
 * for the reason given there — the terrain is millions of triangles and this is
 * on the click path.
 */
const pickRay = new THREE.Raycaster()
const pickNdc = new THREE.Vector2()

function pickGround(clientX: number, clientY: number): { x: number; y: number; z: number } | null {
  const frame = terrainFrame()
  if (!frame) return null
  const rect = scene.renderer.domElement.getBoundingClientRect()
  pickNdc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
  pickRay.setFromCamera(pickNdc, rig.camera)
  const o = pickRay.ray.origin
  const d = pickRay.ray.direction
  return raycastTerrain(frame, o.x, o.y, o.z, d.x, d.y, d.z)
}

/**
 * A click on the world, as opposed to a drag of the camera.
 *
 * OrbitControls owns the same button, so this cannot consume the event — it
 * watches instead, and only treats a press as a click if the pointer barely
 * moved and was not held. The tiny orbit nudge a "click" also produces is well
 * under a pixel and nobody has ever noticed it.
 */
let pressX = 0
let pressY = 0
let pressT = 0

const canvas = scene.renderer.domElement
canvas.addEventListener('pointerdown', (e) => {
  pressX = e.clientX
  pressY = e.clientY
  pressT = performance.now()
})

canvas.addEventListener('pointerup', (e) => {
  if (Hud.isHudTarget(e.target)) return
  if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > 6) return
  if (performance.now() - pressT > 450) return
  if (sim.winner >= 0) return

  const hit = pickGround(e.clientX, e.clientY)
  if (!hit) return

  // An army is waiting for a target: this click is its order, not a spell.
  if (hud.selectedArmy >= 0) {
    const army = sim.armyById(hud.selectedArmy)
    hud.selectedArmy = -1
    if (!army) return
    const target = nearestExploredSite(hit.x, hit.z)
    if (target) {
      sim.orderArmy(army, target.id)
      hud.message(`Marching on ${target.name}.`)
    } else {
      hud.message('No known site there. Armies march to places, not to points.')
    }
    return
  }

  castAtGround(hit)
})

/**
 * The nearest site to a map click that the player has actually seen.
 *
 * Orders are given to *places*, not to coordinates — that is the full doc's
 * command model, and it is also what makes a click forgiving: nobody can hit a
 * 40-unit pad from two thousand units up, so the click means "that one" and this
 * works out which. The fog check is what stops an army being sent to a lair
 * nobody has discovered.
 */
function nearestExploredSite(x: number, z: number): SiteState | null {
  const fogOn = params.fog.enabled && !params.fog.revealAll
  let best: SiteState | null = null
  let bestD = 320
  for (const site of sim.sites) {
    if (fogOn && fogGrid.exploredAt(site.x, site.z) < 0.18) continue
    const d = Math.hypot(site.x - x, site.z - z)
    if (d < bestD) {
      bestD = d
      best = site
    }
  }
  return best
}

function castAtGround(hit: { x: number; y: number; z: number }): void {
  const w = sim.player
  if (w.dead) return
  if (!sim.inFireballRange(w, hit.x, hit.z)) {
    hud.message('Out of range — fly closer.')
    return
  }
  if (w.mana < RULES.fireball.mana) {
    hud.message('Not enough mana.')
    return
  }
  sim.castFireball(w, hit.x, hit.z, hit.y + 1)
}

const clock = new THREE.Clock()

scene.renderer.setAnimationLoop(() => {
  // Clamped so a backgrounded tab doesn't resume with a huge step that
  // teleports the avatar across the map.
  const dt = Math.min(clock.getDelta(), 0.1)

  const frame = terrainFrame()
  const playing = sim.ready && sim.winner < 0
  const wizard = sim.ready ? sim.player : null

  // Sprint. Mana is the throttle rather than a cooldown, which makes the wizard's
  // one resource pay for both getting somewhere and doing something when it
  // arrives — the choice the full doc's boost charges would eventually make
  // properly, standing in for skiing until there is skiing.
  let speedScale = 1
  if (wizard && playing && !wizard.dead && keys.isDown('ShiftLeft') && wizard.mana > 0) {
    speedScale = RULES.wizard.sprint
    wizard.mana = Math.max(0, wizard.mana - RULES.wizard.sprintDrain * dt)
  }

  // A dead wizard is off the board: it cannot be driven, and the body should not
  // be standing in the field it just died in.
  const frozen = wizard?.dead ?? false
  avatar.object.visible = params.avatar.enabled && !frozen

  if (frame && params.avatar.enabled && !frozen) {
    avatar.update(dt, keys, frame, params.avatar, speedScale)
    avatar.updateMarkerVisibility(rig.camera)
  }

  if (frame && sim.ready) {
    sim.update(dt, frame, avatar.position.x, avatar.position.z, avatar.position.y)
    const fogOn = params.fog.enabled && !params.fog.revealAll
    sim.draw(unitLayer, boardLayer, banners, frame, fogOn ? (x, z) => fogGrid.exploredAt(x, z) : () => 1)
    effects.update(sim.projectiles, sim.blasts)
    hud.update(dt)
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

  // E consecrates whatever the wizard is standing on. A key as well as the
  // on-screen button because the button is under the cursor's usual resting
  // place and clicking it should never be the only way in.
  if (keys.consumePress('KeyE') && wizard && playing && !wizard.dead) {
    const under = sim.siteUnder(wizard)
    if (under && sim.canConvert(wizard, under)) sim.beginConvert(wizard, under)
    else if (under) hud.message(`${under.name} is still defended.`)
  }

  // F throws a fireball straight ahead, for playing without a mouse. It aims at
  // the middle of the screen, which is where the camera is already looking.
  if (keys.consumePress('KeyF') && playing) {
    const rect = scene.renderer.domElement.getBoundingClientRect()
    const hit = pickGround(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (hit) castAtGround(hit)
  }

  if (keys.consumePress('Escape')) hud.selectedArmy = -1

  keys.endFrame()

  rig.update(dt, params.camera)
  compass.update(rig.camera, rig.isSettling())
  scene.renderer.render(scene.scene, rig.camera)
})

regenerate()
