import * as THREE from 'three'
import { Avatar } from './game/avatar'
import { Keyboard } from './game/input'
import { createCameraRig, type ViewInsets, type ViewPreset } from './render/camera'
import { CardLayer, type CardSpec } from './render/cardLayer'
import { BoardLayer } from './render/boardLayer'
import { Effects } from './render/effects'
import { Banners } from './render/banners'
import { SiegeEngines } from './render/siege'
import { CastRange } from './render/castRange'
import { createScene } from './render/scene'
import { loadSpriteAtlas, loadUnitAtlas } from './render/spriteAtlas'
import type { SpriteKey, UnitKey } from './render/spriteAtlas'
import { Sim } from './game/sim'
import type { Army, SiteState } from './game/sim'
import { RULES } from './game/rules'
import type { BuildItem } from './game/rules'
import { Hud, SPELLS } from './ui/hud'
import { Menu } from './ui/menu'
import { FACTIONS } from './game/factions'
import {
  coastShelf as coastShelfFor,
  planWorld as planWorldCore,
  terrainFrameFor,
  worldCellSize,
} from './world/build'
import type { WorldPlan as CoreWorldPlan } from './world/build'
import { raycastTerrain } from './game/raycast'
import { TerrainMesh } from './render/terrainMesh'
import type { TerrainFrame } from './world/terrainQuery'
import { Compass } from './ui/compass'
import { NamePlates } from './ui/namePlates'
import { Credits } from './ui/credits'
import { DPad } from './ui/dpad'
import { setTouchMode, startTouchDetection } from './ui/touchMode'
import { buildGui } from './ui/gui'
import { Heightmap } from './world/heightmap'
import { defaultParams } from './world/params'
import { BIOMES, buildBiomeField } from './world/biome'
import { FogGrid } from './world/fog'
import { FogTexture } from './render/fogTexture'
import { FogOfWar } from './game/fogOfWar'
import {
  capitalClearing,
  flattenSitePads,
  makeStandField,
  ringDecorations,
  scatterDecorations,
} from './world/sites'
import type { DecoSpot } from './world/sites'
import { buildRoadNetwork, roadAt } from './world/roads'
import type { RoadNetwork } from './world/roads'
import { RoadLayer } from './render/roadLayer'
import { RoadDebugLayer } from './render/roadDebug'
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
// What each place is called and how hard it is, projected onto the map.
const namePlates = new NamePlates(document.body)
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

const roads = new RoadLayer(scene.renderer.capabilities.getMaxAnisotropy())
scene.scene.add(roads.object)
const roadDebug = new RoadDebugLayer()
scene.scene.add(roadDebug.object)
/**
 * Where the roads went, kept because the scatter has to agree with it.
 *
 * A road is a cut through the vegetation, so it is not enough for the road to
 * be drawn on top — the trees have to be absent from underneath it. The network
 * is therefore built before the cards and consulted while they are scattered.
 */
let roadNet: RoadNetwork | null = null

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
// Trebuchets, built from primitives because the art pack has no siege engine.
const siegeEngines = new SiegeEngines()
scene.scene.add(siegeEngines.object)

const castRange = new CastRange()
scene.scene.add(castRange.object)
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

/**
 * What is on top of the world: nothing, the pause card, or the main menu.
 *
 * Kept apart from `attract` rather than folded into one enum, because pausing a
 * demo has to resume *into* the demo. With one state that needs a second field
 * remembering where to go back to, which is the same two bits with a harder name.
 */
type MenuMode = 'playing' | 'paused' | 'menu'
let menuMode: MenuMode = 'playing'

/** Whether faction 0 is being flown by the AI while the camera watches it. */
let attract = false

const hud = new Hud(document.body, sim, {
  onOrder: (army: Army, siteId: number) => sim.orderArmy(army, siteId),
  onRecall: (army: Army) => sim.recallArmy(army),
  onBuild: (site: SiteState, item: BuildItem) => {
    // A caravan needs somewhere to go, so the button arms a pick and the next
    // map click finishes the order — the same two-step an army order uses.
    if (item === 'caravan') {
      hud.pendingCaravan = site
      hud.selectedArmy = -1
      hud.armedSpell = null
      hud.message('Pick a resource node for the caravan.')
      return
    }
    if (!sim.queueBuild(site, item)) hud.message('Not enough gold.')
  },
  onHire: (site: SiteState) => {
    if (!sim.hirePatrol(site)) hud.message(sim.patrolSpec(site).blocked ?? 'Cannot hire here.')
  },
  onConvert: (site: SiteState) => {
    if (!sim.beginConvert(sim.player, site)) hud.message('Nothing to consecrate here.')
  },
  // "New world" on the end card starts another match in whatever mode this one
  // was: a watcher who presses it wants the next demo, not a game to play.
  onRestart: () => startMatch(attract),
})

/**
 * Start a fresh match on a fresh island, played or watched.
 *
 * The one door into a match. It sets the mode *before* regenerating because the
 * flag has to be true by the time the worker comes back and `cutSitePads` resets
 * the simulation — that is where `allAi` is read, and reading it late would give
 * the first match of a demo a human faction 0 that nothing was driving.
 */
function startMatch(asAttract: boolean): void {
  attract = asAttract
  hud.setAttract(asAttract)
  document.body.classList.toggle('is-attract', asAttract)
  document.body.classList.remove('is-mainmenu')
  menuMode = 'playing'
  menu.hide()
  attractEndT = 0
  attractWasDead = false

  params.seed = randomSeed()
  gui.refreshDisplay()
  // A new match must open looking at your own wizard. Regenerating on its own
  // deliberately does *not* move the camera — dragging a terrain slider should
  // not yank you out of whatever you were inspecting — so starting a match is
  // the one case that asks for the framing back.
  reframeOnNextBuild = true
  regenerate(true)
}

/** Leave the match on screen and put the main menu over it. */
function openMainMenu(): void {
  menuMode = 'menu'
  document.body.classList.add('is-mainmenu')
  menu.showMain()
}

const menu = new Menu(document.body, {
  onResume: () => {
    menuMode = 'playing'
    menu.hide()
  },
  onExitToMenu: openMainMenu,
  onNewGame: () => startMatch(false),
  onAttract: () => startMatch(true),
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
  return worldCellSize(params, current ? current.size : params.mapSize + 1)
}

/** Everything the avatar needs to sit on the current terrain. */
function terrainFrame(): TerrainFrame | null {
  if (!current) return null
  return terrainFrameFor(params, current)
}

/**
 * The coastal step, converted from the world units the GUI speaks to the
 * normalised heights the heightfield does.
 *
 * One function, because the mesh and every height query have to be shaping the
 * ground identically — a shelf under the terrain but not under the avatar puts
 * it knee-deep in its own beach. It lives in `world/build.ts` so the headless
 * callers get the same shelf; this is the reader that already has `params`.
 */
function coastShelf(): { shelfRise: number; shelfBand: number } {
  return coastShelfFor(params)
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
/** Set by "New world": the next build should frame the wizard. See `onRestart`. */
let reframeOnNextBuild = false
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
    // A failed refine leaves an island nothing was ever sited on. Seat the world
    // on the raw heights rather than leaving the map empty and the flag armed
    // for whatever the next build turns out to be.
    if (refineOnBuild) {
      refineOnBuild = false
      if (current) seatNewIsland()
    }
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

    if (refineOnBuild && willRefine()) {
      // The island is not finished, so do not plan a world on it. Cities scored
      // against raw heights land in different places than cities scored against
      // eroded ones — that is the whole reason this refine exists — so planning
      // now would seat a village, restart the sim, and throw both away a third
      // of a second later. Show the ground and wait.
      rebuildMesh(false)
      runErosion()
      updateStatus()
      return
    }

    seatNewIsland()
  } else {
    stats.erodeMs = msg.erodeMs
    stats.amplifyMs = msg.amplifyMs
    stats.eroded = true
    stats.progress = 0
    stats.phase = ''
    erosionBusy = false
    gui.setErosionBusy(false)
    current = new Heightmap(msg.size, heights)

    if (refineOnBuild) {
      // This refine *was* the island's construction, so the new-map ceremony
      // happens here rather than after `generate` — including seating the avatar
      // at its capital, which only exists now.
      refineOnBuild = false
      seatNewIsland()
    } else {
      // A refine of an island already in play. Erosion recarves the valleys and
      // amplification refines the grid, so the pads have to be cut again — they
      // were levelled into a surface that no longer exists.
      cutSitePads()
      // Amplification changes the grid resolution, so the camera limits, water
      // and avatar footing all need re-deriving — but not the framing.
      rebuildMesh(false)
    }
  }
  updateStatus()
}

/**
 * Site the world on a finished island and point the camera at it.
 *
 * Called from whichever worker phase *completes* the island: `generate` when the
 * map is being previewed raw, `refine` when it is being built to be played on.
 * Keeping it in one function is what stops the two paths from drifting into
 * seating the avatar in one and forgetting to in the other.
 */
function seatNewIsland(): void {
  cutSitePads()
  rebuildMesh(true)
  // Open on the avatar rather than the overview — the close third-person
  // framing is the default view now. Only on the very first build, so later
  // regenerates don't yank you back out of whatever you were looking at.
  if (!openedOnAvatar || reframeOnNextBuild) {
    openedOnAvatar = true
    reframeOnNextBuild = false
    if (params.avatar.enabled) rig.apply('follow', params.camera)
  }
}

// --- actions ----------------------------------------------------------------

let regenQueued = false

/**
 * True when the pending `generate` is building an island to be *played* on, and
 * so has to be finished with a refine before anything is sited on it.
 */
let refineOnBuild = false

/** Whether a refine would actually change the ground, or is a no-op worth skipping. */
function willRefine(): boolean {
  return params.erosion.droplets > 0 || params.amplify.enabled
}

/**
 * Build a new island.
 *
 * `forPlay` is the difference between a match and a preview, and it decides
 * whether the island gets eroded and amplified before the capitals are sited on
 * it. Every match does; a slider drag does not.
 *
 * Not because raw ground is good enough to play on — it is the wrong island, and
 * siting on it is the bug this whole change exists to fix — but because
 * `regenerate` is wired to `onChange` on two dozen terrain sliders. Refining
 * each of those would put a third of a second of erosion and an 8.4M-triangle
 * mesh rebuild inside every frame of a drag. So dragging shows you the raw shape
 * moving under your hands, and the island is finished the moment a match starts.
 */
function regenerate(forPlay = false): void {
  // Coalesced calls within one frame OR together, so a slider moved in the same
  // frame a match starts cannot cancel the refine. The flag is then handed to
  // the job that actually goes out, and the next job sets its own.
  queuedForPlay = queuedForPlay || forPlay
  if (regenQueued) return
  regenQueued = true
  requestAnimationFrame(() => {
    regenQueued = false
    refineOnBuild = queuedForPlay
    queuedForPlay = false
    jobId++
    erosionBusy = false
    gui.setErosionBusy(false)
    post({ type: 'generate', jobId, params: structuredClone(params) })
  })
}
let queuedForPlay = false

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
 * The placed world: the capitals, the territories they define, and every card
 * standing on it.
 *
 * Held rather than recomputed because the pads are cut from it *before* the
 * cards are seated on the result — two calls that disagreed would level the
 * ground in one place and put the town in another. `planWorld` runs once per new
 * heightmap, from `cutSitePads`.
 */
interface WorldPlan extends CoreWorldPlan {
  /** Cities and their villages, in card order. */
  sites: CardSpec[]
}
let plan: WorldPlan | null = null

/**
 * Site the capitals and grow their settlements, then dress the result in cards.
 *
 * The siting itself is `world/build.ts` — the same function `tools/board.ts`
 * calls, so what the audits measure and what you are looking at are the same
 * island by construction rather than by two files agreeing to stay in step.
 * Everything below the call is the renderer's half: which sprite a capital wears
 * and what card sits where, none of which the headless side has an opinion on.
 */
function planWorld(): WorldPlan | null {
  const frame = terrainFrame()
  if (!frame) return null

  const core = planWorldCore(params, frame, FACTIONS.length)
  const { cities, game, settlements } = core

  // A wizard's capital is drawn with its faction's own castle rather than with
  // its territory's, so the three seats of power are recognisable on sight.
  // Neutral towns keep their biome's building — that variety is the map's, and
  // overriding all fifteen would make the island read as three colours.
  const capitalSprite = new Map<number, SpriteKey>()
  for (const site of game.sites) {
    if (site.kind !== 'city' || site.owner < 0 || site.cityIndex === undefined) continue
    capitalSprite.set(site.cityIndex, FACTIONS[site.owner].city)
  }

  // Every card in a village stands on the village's terrace, so none of them cut
  // ground of their own or push the treeline outward: `padScale: 0` turns off
  // both. That now includes the town — the clearing it used to carry has moved
  // to `plazas`, which is centred where the village is rather than where its
  // largest building happens to stand.
  const sites: CardSpec[] = settlements.map((s) => ({
    sprite: capitalSprite.get(cities.indexOf(s.city)) ?? (BIOMES[s.city.biome].faction as SpriteKey),
    x: s.town.x,
    z: s.town.z,
    // No tint, and no disc. Ownership is not a property of the map any more —
    // it changes hands mid-match, and a card in the static layer is written once
    // and never rewritten. The dynamic layer draws the owner's disc and raises
    // the banner over it; colouring the card here as well would leave a stale
    // second opinion under every town that changed hands.
    discRadius: 0,
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

  return { ...core, sites }
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
  // A new island is a new match. Erosion moves the coastline and so moves every
  // capital, which means the board this match was being played on no longer
  // exists — restarting is the honest answer, not a bug.
  sim.reset(plan.game, attract)
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

  // Roads before decoration, because they decide some of it. The network is
  // only drawn where it cuts through vegetation, which means it is laid out
  // against the same stand field the scatter is about to threshold — build it
  // once here and hand it to both, or the road appears in bare fields and the
  // trees grow back over the paving.
  const roadTerrain = {
    hm: current,
    cellSize: effectiveCellSize(),
    heightScale: params.render.heightScale,
    seaLevel: params.shape.seaLevel,
  }
  const stands = makeStandField(field, params.seed, params.render.scatterBlob)
  roadNet = params.render.roads
    ? buildRoadNetwork(roadTerrain, plan.game.sites, field, stands, {
        worldSize: (current.size - 1) * effectiveCellSize(),
        plazaRadius: capitalClearing(),
      })
    : null
  roads.build(roadNet, frame)
  roadDebug.build(roadNet, frame, params.render.roadDebug)

  // The verge, not the kerb. A prop is placed by its foot but drawn as a card
  // standing up from it, so a tree whose trunk is just off the paving still
  // hangs its canopy across the road. Half a tree's width of margin is what
  // makes the cut read as a cut from above.
  const net = roadNet
  const onRoad = net ? (x: number, z: number) => roadAt(net, x, z, treeWidth * 0.5) : undefined

  // Rings first: a site's own clearing gets a denser fringe than open country.
  // Then dress the rest of the island, keeping clear of those clearings.
  const seaY = params.shape.seaLevel * params.render.heightScale
  const rings = ringDecorations(clearings, params.seed, field, {
    spacing: treeWidth * 1.35,
  }).filter(
    (spot) =>
      terrainHeightAt(frame, spot.x, spot.z) > seaY + 1 && !onRoad?.(spot.x, spot.z),
  )

  const scatter = params.render.scatter
    ? scatterDecorations(roadTerrain, field, params.seed, {
        spacing: params.render.scatterSpacing,
        blobScale: params.render.scatterBlob,
        avoid: clearings,
        maxCount: CARD_CAPACITY - sites.length - rings.length,
        onRoad,
      })
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
  roads.setFog(fogTexture.texture, worldSize, on)
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
    // Say why the island is bare. Nothing is sited until the ground stops
    // moving, so for these few hundred milliseconds there are deliberately no
    // towns on the map and the reason should not look like a missing feature.
    if (refineOnBuild) parts.push('building the island…')
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
      menu,
      /** `__world.startMatch(true)` drops straight into a demo. */
      startMatch,
      mode: () => ({ menuMode, attract }),
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

/**
 * Seconds the end card has been up in attract, and whether the watched wizard
 * was dead last frame.
 *
 * The demo has to end its own matches — there is nobody to press the button —
 * and it has to notice a respawn, because respawning is a teleport and the
 * camera has to be carried rather than flown to the far side of the island.
 */
let attractEndT = 0
let attractWasDead = false

/** How long a finished attract match sits on its end card before the next one. */
const ATTRACT_END_HOLD = 12

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
  unitLayer.setViewport(h, rig.camera.fov)
  boardLayer.setViewport(h, rig.camera.fov)
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
  // Nothing on the map is orderable while a card is up or while the AI is
  // flying. The menu scrim already swallows its own clicks; this covers attract,
  // where the world is deliberately left uncovered to be watched.
  if (menuMode !== 'playing' || attract) return
  if (Hud.isHudTarget(e.target)) return
  if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > 6) return
  if (performance.now() - pressT > 450) return
  if (sim.winner >= 0) return

  const hit = pickGround(e.clientX, e.clientY)
  if (!hit) return

  // A click on the world only ever *completes* something the player has already
  // started — an army order or an armed spell. A bare click does nothing, which
  // is what stops looking around from costing mana.
  if (hud.armedSpell === 'fireball') {
    hud.armedSpell = null
    castAtGround(hit)
    return
  }

  // A caravan is waiting for a destination.
  if (hud.pendingCaravan) {
    const city = hud.pendingCaravan
    hud.pendingCaravan = null
    const target = nearestExploredSite(hit.x, hit.z, (s) => s.kind === 'node')
    if (!target) {
      hud.message('No known resource node there.')
    } else if (target.owner !== sim.player.faction) {
      // The wizard has to hold it before a city can be given it. Two different
      // failures, because they want two different things done about them.
      hud.message(
        sim.isCleared(target)
          ? `${target.name} is cleared — consecrate it before linking it.`
          : `${target.name} is still defended — send an army.`,
      )
    } else if (!sim.canLinkTo(target.id, sim.player.faction)) {
      hud.message(`${target.name} already supplies one of your cities.`)
    } else if (!sim.queueBuild(city, 'caravan', target.id)) {
      hud.message('Not enough gold.')
    } else {
      hud.message(`Caravan bound for ${target.name}.`)
    }
    return
  }

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
  }
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
function nearestExploredSite(
  x: number,
  z: number,
  pass?: (s: SiteState) => boolean,
): SiteState | null {
  const fogOn = params.fog.enabled && !params.fog.revealAll
  let best: SiteState | null = null
  let bestD = 320
  for (const site of sim.sites) {
    if (pass && !pass(site)) continue
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
  if (!sim.inCastRange(w, hit.x, hit.z)) {
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
  // A card on screen stops the match but not the picture: the world keeps being
  // drawn under the menu, it just stops moving. `humanDriving` is the narrower
  // question of whether *input* means anything — false in attract, where the
  // match is running perfectly well and nobody is holding the controls.
  const running = menuMode === 'playing'
  const playing = sim.ready && sim.winner < 0 && running
  const humanDriving = playing && !attract
  const wizard = sim.ready ? sim.player : null

  // Sprint. Mana is the throttle rather than a cooldown, which makes the wizard's
  // one resource pay for both getting somewhere and doing something when it
  // arrives — the choice the full doc's boost charges would eventually make
  // properly, standing in for skiing until there is skiing.
  let speedScale = 1
  if (wizard && humanDriving && !wizard.dead && keys.isDown('ShiftLeft') && wizard.mana > 0) {
    speedScale = RULES.wizard.sprint
    wizard.mana = Math.max(0, wizard.mana - RULES.wizard.sprintDrain * dt)
  }

  // A dead wizard is off the board: it cannot be driven, and the body should not
  // be standing in the field it just died in.
  const frozen = wizard?.dead ?? false
  avatar.object.visible = params.avatar.enabled && !frozen

  if (frame && params.avatar.enabled && !frozen) {
    // In attract the avatar is steered below, from the wizard the AI is flying;
    // paused, nothing steers it at all.
    if (humanDriving) avatar.update(dt, keys, frame, params.avatar, speedScale)
    avatar.updateMarkerVisibility(rig.camera)
  }

  if (frame && sim.ready) {
    // Stepped only while playing. Not stepped with dt = 0: the AI throws a
    // fireball on a condition rather than on a timer, so a zero-length tick is a
    // world that still fights, silently, behind the pause card.
    if (playing) {
      sim.update(dt, frame, avatar.position.x, avatar.position.z, avatar.position.y)
    }

    // Attract: the simulation flies faction 0, and the avatar follows it. This
    // is the whole of the camera work — the rig is already pointed at
    // `avatar.position` (see `syncAvatarVisibility`), so putting the avatar on
    // the wizard puts the camera on it too, with no camera code involved.
    if (attract && sim.ready) {
      const w = sim.player
      if (!w.dead) {
        avatar.driveTo(dt, frame, w.x, w.z, params.avatar)
        // A respawn is a teleport, and the camera has to be moved rather than
        // flown across the island. Same pair as the human respawn callback —
        // which the simulation does not fire here, because faction 0 is not the
        // player any more.
        if (attractWasDead) {
          rig.snapFollow()
          if (params.avatar.followCamera) rig.apply('follow', params.camera)
        }
      }
      attractWasDead = w.dead
    }

    const fogOn = params.fog.enabled && !params.fog.revealAll
    sim.draw(unitLayer, boardLayer, banners, siegeEngines, frame, fogOn ? (x, z) => fogGrid.exploredAt(x, z) : () => 1)
    // Plates last, so they are projected from the camera this frame actually
    // used. The camera is read here and nothing else — no framing, no zoom.
    namePlates.update(
      sim,
      rig.camera,
      scene.renderer.domElement.clientWidth,
      scene.renderer.domElement.clientHeight,
      (x, z) => terrainHeightAt(frame, x, z),
      fogOn ? (x, z) => fogGrid.exploredAt(x, z) : () => 1,
    )
    effects.update(sim.projectiles, sim.blasts)
    hud.update(dt)

    // Only while a spell is waiting on a click. Drawn permanently it is a ring
    // that follows you everywhere and stops meaning anything; drawn on arming it
    // answers the question the player is asking at exactly that moment.
    if (hud.armedSpell && !frozen) {
      castRange.show(frame, avatar.position.x, avatar.position.z, RULES.castRange)
    } else {
      castRange.hide()
    }
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
        // permanent channel, which existed for exactly this.
        //
        // Read from the simulation each tick rather than from a snapshot taken
        // at world build. `plan.owned` was the player's *starting* cities and
        // nothing else: a town captured in minute twenty lit nothing, one lost
        // lit the map for the rest of the match, and an Observatory had no way
        // to say it reveals four hundred units where a town reveals a hundred
        // and fifty.
        sim.revealedBy(sim.player.faction),
      )
    ) {
      applyFog()
      // The readout reports what is actually being drawn, so it has to move
      // when the fog does.
      updateStatus()
    }
  }

  if (keys.consumePress('KeyC')) resetCamera()

  // The spellbook's hotkeys, read straight off the hotbar's own table so a key
  // and its on-screen slot can never disagree about what they cast.
  if (humanDriving) {
    for (const spell of SPELLS) {
      if (keys.consumePress(spell.code)) hud.activate(spell.id)
    }
  }

  // Escape means "back out of the thing I am in the middle of", and the menu is
  // the outermost of those rather than a replacement for them: with a spell
  // armed or an army waiting for a target, the first press still cancels that,
  // and only a press with nothing pending opens the card. Otherwise arming a
  // fireball would make the pause key stop pausing.
  if (keys.consumePress('Escape')) {
    if (menuMode === 'playing') {
      const pending = hud.selectedArmy >= 0 || hud.armedSpell !== null || hud.pendingCaravan !== null
      if (pending && !attract) {
        hud.selectedArmy = -1
        hud.armedSpell = null
        hud.pendingCaravan = null
      } else {
        menuMode = 'paused'
        menu.showPause()
      }
    } else if (menuMode === 'paused') {
      menuMode = 'playing'
      menu.hide()
    }
    // On the main menu Escape has nowhere further out to go.
  }

  // The demo ends its own matches. A watcher can still press "New world" to cut
  // it short, or Escape out to the menu.
  if (attract && running && sim.ready && sim.winner >= 0) {
    attractEndT += dt
    if (attractEndT > ATTRACT_END_HOLD) startMatch(true)
  }

  keys.endFrame()

  rig.update(dt, params.camera)
  compass.update(rig.camera, rig.isSettling())
  scene.renderer.render(scene.scene, rig.camera)
})

// The first island is one you can play on, so it is built the whole way.
regenerate(true)
