/**
 * Every knob the generator exposes. This object is what the GUI binds to and
 * what gets posted to the worker, so it must stay structured-clone friendly:
 * plain data only, no functions, no class instances.
 *
 * Heights produced by the pipeline are normalised to roughly [0, 1]. World
 * units are applied only at mesh-build time via `cellSize` / `heightScale`.
 * Keeping the heightmap unit-free is what lets the erosion constants below
 * stay meaningful across map sizes.
 */

export interface NoiseParams {
  enabled: boolean
  octaves: number
  frequency: number
  lacunarity: number
  persistence: number
}

export interface WarpParams {
  enabled: boolean
  strength: number
  frequency: number
}

export interface RidgeParams {
  enabled: boolean
  /** Base height above which ridges start blending in. */
  threshold: number
  /** How strongly ridges replace the base shape at full weight. */
  strength: number
  octaves: number
  frequency: number
}

export interface ShapeParams {
  /** h = pow(h, k). >1 flattens lowlands and sharpens peaks. */
  redistribution: number
  /**
   * Rescale the finished heightmap so its range fills [0, 1]. Without this the
   * peak lands wherever the noise happens to put it (typically ~0.75 once the
   * island mask has pulled things down), the top of the colour ramp is
   * unreachable, and the erosion constants shift meaning every time you change
   * an octave count.
   */
  normalize: boolean
  islandMask: boolean
  /** Normalised radius (0..1) at which the falloff to sea begins. */
  falloffStart: number
  /** Higher = a harder, more cliff-like coastal falloff. */
  falloffPower: number
  seaLevel: number
}

export interface ErosionParams {
  droplets: number
  radius: number
  /** 0 = follow the gradient exactly, 1 = ignore it and carry straight on. */
  inertia: number
  capacityFactor: number
  minSlope: number
  erodeSpeed: number
  depositSpeed: number
  evaporation: number
  gravity: number
  maxLifetime: number
  initialWater: number
  initialSpeed: number
}

/** The biome ground tiles lifted from the overworld tilesets. */
export interface GroundParams {
  enabled: boolean
  /**
   * Take the tile scale from the sprite cards instead of `scale`, so one ground
   * texel covers exactly one sprite pixel.
   *
   * Both are "world units per 16 source pixels", so matching them is just
   * assignment — but they are authored in different files and drifted apart
   * immediately when they were independent, leaving the ground three times
   * coarser than the props standing on it.
   */
  matchPropScale: boolean
  /** World units per repeat of the 16px tile, when not matching the props. */
  scale: number
  /** How strongly it modulates the elevation banding, 0..1. */
  strength: number
  /** Fully textured within this distance; flat biome colour beyond fadeFar. */
  fadeNear: number
  fadeFar: number
  /**
   * Fraction of the ground covered by the textured alternate, 0..1, laid in
   * soft blobs over the flat fill.
   *
   * Honest by construction: the blob noise is near-normal with mean 0.5 and
   * sd 0.158, and the shader maps this onto that measured span, so 0.5 really
   * does cover about half.
   */
  density: number
  /**
   * How strongly the alternate's grain shows where it is laid, 0..1.
   *
   * Each biome sheet carries two ground surfaces: a flat fill and, directly
   * beneath it, a textured alternate in the same palette. Together with
   * `density` this is what stops a territory reading as one flat colour.
   */
  baseStrength: number
  /**
   * World units either side of a territory border kept as flat fill, with no
   * textured patch laid over it.
   *
   * A border reads as a border when two flat colours meet along it. Let the
   * grain run up to the edge from both sides and the eye has no line to find —
   * the two territories fray into each other instead of meeting. This is also
   * what gives the colour cross-fade (`biome.blend`) clean ground to happen on.
   */
  borderSolid: number
  /** Draw the terrain as flat albedo, ignoring every light in the scene. */
  unshaded: boolean
  /** Draw the biome's actual tile texels, not a colour derived from them. */
  exact: boolean
}

export interface DetailParams {
  enabled: boolean
  /** World units per repeat of the fine grain. */
  scale: number
  /** World units per repeat of the broad mottling. */
  macroScale: number
  normalStrength: number
  albedoStrength: number
}

export interface AmplifyParams {
  enabled: boolean
  /** Resolution doublings applied after erosion. Each one quadruples triangles. */
  levels: number
  /** Detail height at the first level, in normalised height units. */
  amplitude: number
  /** Amplitude falloff per level. */
  persistence: number
  /** Detail frequency as a fraction of the grid resolution. */
  frequencyScale: number
  /** 0 = rounded swells, 1 = sharp rocky creases. */
  ridged: number
  /** Slope below which detail is suppressed. */
  slopeLo: number
  /** Slope at which detail reaches full strength. */
  slopeHi: number
  /** How much detail flat ground keeps. */
  flatFloor: number
}

import type { BiomeParams } from './biome'
import type { FogParams } from './fog'

export interface RenderParams {
  /** World units per grid cell. */
  cellSize: number
  /** World units spanned by a normalised height of 1.0. */
  heightScale: number
  sunAzimuth: number
  sunElevation: number
  wireframe: boolean
  showWater: boolean
  /**
   * World units of water depth spanned by the bright coastal rim, before the
   * sea settles into its open-water blue.
   *
   * Purely a look, and note that it does not soften the waterline: the water is
   * opaque right up to the edge, and the coast holds together because the sea
   * is part of the terrain surface — see `render/terrainMaterial.ts`.
   */
  shoreFade: number
  /**
   * World units the ground steps up on the land side of the waterline, and down
   * on the water side. See `shelfHeight` in `world/terrainQuery.ts`.
   *
   * This is what draws the coastline, now that nothing paints it. Zero gives
   * back the old behaviour: territory colour running straight into the sea with
   * no edge of its own, which on flat ground is barely a coast at all.
   */
  coastStep: number
  /**
   * World units of *elevation* either side of the waterline over which the step
   * eases back to the terrain's own height.
   *
   * Elevation, not distance along the ground — so on a flat shore the lip runs
   * a long way inland. That is harmless where a colour band was not: lifting a
   * wide area by a near-constant amount is invisible, whereas painting it was
   * the whole problem.
   */
  coastBand: number
  /** Dress the whole island with biome-appropriate props, not just the sites. */
  scatter: boolean
  /**
   * Lay roads between neighbouring places, and cut the vegetation for them.
   *
   * A look toggle rather than a terrain one — roads change nothing the
   * simulation reads — but it does move props, because the scatter has to leave
   * the paving clear. See `world/roads.ts`.
   */
  roads: boolean
  /** World units between scatter candidates. Lower is denser and costlier. */
  scatterSpacing: number
  /** World units across a typical stand of vegetation. */
  scatterBlob: number
  /**
   * Saturation applied after tone mapping. 1 leaves the tone-mapped result
   * alone. See terrainMaterial.ts.
   */
  saturation: number
  ground: GroundParams
  detail: DetailParams
}

export interface AvatarParams {
  enabled: boolean
  walkSpeed: number
  flySpeed: number
  /**
   * Ride height, in multiples of the avatar's own height rather than world
   * units — so rescaling the avatar keeps it at the same apparent altitude.
   */
  hover: number
  fly: boolean
  scale: number
  /**
   * Cast a round shadow straight down onto the ground.
   *
   * A hovering figure and the ground under it are drawn at different depths, so
   * without one you can't tell which side of a shoreline you're over — and the
   * disc conforms to the surface, so it also shows you the slope you're about
   * to land on.
   */
  shadow: boolean
  followCamera: boolean
}

export interface CameraParams {
  /**
   * Pin the view to north-up: orbiting the yaw is disabled entirely, and the
   * camera always sits due south of its target.
   *
   * This is a genre decision rather than a convenience. A fixed compass makes
   * the map's geography stable — a place stays north-east of another place, and
   * you learn the island's shape rather than re-reading it from every angle,
   * which is how the strategy games this is aiming at behave. It also lets the
   * sprite cards face a known direction instead of swivelling to track the
   * camera, so they read as standing scenery rather than as billboards.
   *
   * Pitch and zoom are still free.
   */
  lockNorth: boolean
  /** Drift back to north-up at a fixed pitch once rotation stops. */
  autoRecenter: boolean
  /** Seconds of no rotation before the drift begins. */
  recenterDelay: number
  /** Resting pitch, in degrees below horizontal. */
  recenterPitch: number
  /** Ease rate; higher settles faster. */
  recenterSpeed: number
  /** Resting orbit distance while following the avatar, in world units. */
  followDistance: number
  /**
   * Seconds for the orbit pivot to catch up to the avatar. 0 locks the camera
   * rigidly to it; a little lag lets the avatar pull ahead of centre when it
   * starts moving and settle back when it stops, which is what reads as motion.
   */
  followLag: number
  /** Hard cap on how far the pivot may trail, so the avatar can't leave frame. */
  followLeash: number
  /** Also ease the orbit distance back to followDistance when settling. */
  restoreDistance: boolean
}

export interface WorldParams {
  seed: string
  biome: BiomeParams
  fog: FogParams
  /** Cells per side. Vertices per side is this + 1. */
  mapSize: number
  noise: NoiseParams
  warp: WarpParams
  ridges: RidgeParams
  shape: ShapeParams
  erosion: ErosionParams
  amplify: AmplifyParams
  render: RenderParams
  avatar: AvatarParams
  camera: CameraParams
}

export function defaultParams(): WorldParams {
  return {
    seed: 'karomi',
    // 256 by default rather than 512: generation plus remeshing stays under a
    // frame, so dragging a slider updates live. 512 is one dropdown away.
    mapSize: 256,
    biome: {
      enabled: true,
      // Capitals, not territories — there are more cities than factions, so a
      // faction holds several and its territory is however many of those cells
      // happen to adjoin. Fifteen on a 2 km island puts one within about a
      // twenty-second ride of anywhere, which is what makes the map feel settled
      // rather than like six castles in a wilderness.
      cities: 15,
      // A border, not a gradient. The tile art this is matching changes biome
      // from one tile to the next, so the transition wants to be about as wide
      // as the terrain grid can express and no wider — at the default 2 km / 256
      // that is 8 m a cell, and `blend` is in distance-difference units worth
      // about half that on the ground (see `sampleBiomeAt`). 16 therefore fades
      // over roughly one cell: crisp, but not stair-stepped along the grid.
      //
      // This was 260, which faded over a third of a territory's width and turned
      // the whole map into one continuous wash. Fifteen territories were being
      // generated and none of them had an interior that was unambiguously its
      // own colour.
      blend: 16,
      // Roughly a tenth of the island, so borders wander noticeably without
      // detaching from the seed that owns them.
      warp: 180,
    },
    fog: {
      enabled: true,
      revealAll: false,
      // 180 m of sight on a 2 km island: a straight crossing sweeps a 360 m
      // corridor, so learning the whole map is several deliberate journeys
      // rather than one lap. It is also far wider than the follow camera's
      // view, so you never ride into a wall of fog at ground level.
      sightRadius: 180,
      elevationBonus: 0.8,
      siteRadius: 150,
      updateHz: 6,
    },
    noise: {
      enabled: true,
      octaves: 6,
      frequency: 2.2,
      lacunarity: 2.0,
      persistence: 0.5,
    },
    warp: {
      enabled: true,
      strength: 0.18,
      frequency: 1.4,
    },
    ridges: {
      enabled: true,
      threshold: 0.55,
      // Softened from 0.6: full-strength ridges give knife-edge spines that
      // are dramatic from orbit but miserable to actually move across.
      strength: 0.4,
      octaves: 5,
      frequency: 3.0,
    },
    shape: {
      // Below the old 1.35 — less peak-sharpening, broader valley floors.
      redistribution: 1.1,
      normalize: true,
      islandMask: true,
      falloffStart: 0.55,
      falloffPower: 2.2,
      seaLevel: 0.32,
    },
    erosion: {
      droplets: 80_000,
      radius: 3,
      // Low inertia makes droplets hug the steepest descent, which on the
      // island mask's smooth cone combs a fan of parallel gullies. A little
      // more lets them wander and merge into branching channels.
      inertia: 0.12,
      capacityFactor: 4,
      // Heights are normalised to [0,1] across the whole map, so a single cell
      // step on a steep mountainside is only ~0.015. The published defaults
      // for this algorithm (erodeSpeed 0.3) assume far more relief per cell and
      // here they level every slope to flat in a handful of steps. These rates
      // are scaled down to match.
      minSlope: 0.002,
      erodeSpeed: 0.045,
      depositSpeed: 0.1,
      evaporation: 0.01,
      gravity: 4,
      maxLifetime: 45,
      initialWater: 1,
      initialSpeed: 1,
    },
    amplify: {
      enabled: true,
      // 3 levels: the 256 simulation grid renders at 2048, so a triangle is
      // one world unit even though the island is now 2 km across. At 2 levels
      // triangles are 2 m and the faceting shows at the close follow distance.
      // Costs 8.4M triangles and ~185 MB of vertex buffers — drop to 2 if a
      // machine can't hold that.
      levels: 3,
      amplitude: 0.012,
      persistence: 0.55,
      frequencyScale: 0.16,
      ridged: 0.5,
      slopeLo: 0.15,
      slopeHi: 1.2,
      flatFloor: 0.08,
    },
    render: {
      // The island is 2 km across (256 cells x 8 units, reading 1 unit as 1 m).
      // Sized from the traversal target rather than picked: crossing in two
      // minutes at a speed that reads as fast needs roughly this much world.
      // At 512 units the same two minutes meant 4.3 m/s — under one
      // body-length per second for a 5 m avatar, which is a crawl however
      // close the camera sits.
      cellSize: 8,
      // Relief is the ratio of heightScale to world width: 101 over 2048 is
      // just under 5%, so a ~100 m high point on a 2 km island. Gentler than
      // the 8% the terrain was first tuned to, which read as steep to fly
      // across. Nothing else has to follow — sea level is normalised and
      // scales with it, so the coastline doesn't move.
      heightScale: 101,
      sunAzimuth: 135,
      sunElevation: 32,
      wireframe: false,
      showWater: true,
      // About 5 % of the height range, so the fade covers the shallow band where
      // seabed and sea surface are within a depth quantum of each other while
      // staying narrow enough to still read as a coastline.
      // Wider than it was, because the shelf drops the seabed at the water's
      // edge — the rim has to span that drop or the coast starts at open-sea
      // blue and the bright shallow tone is never seen at all.
      shoreFade: 10,
      coastStep: 3,
      coastBand: 9,
      scatter: true,
      roads: true,
      // A 2 m lattice, halved again by the diagonal checkerboard.
      //
      // Ground cover depends on the *ratio* of prop width to spacing, not on
      // either alone — measured, it runs at about 0.18 x (tree / spacing)^2. So
      // when the sprites halved, this halved with them: 2.34 over 2 is the same
      // 1.17 ratio 4.7 over 4 was, and the island looks equally wooded, just at
      // finer grain. The cost is four times the props, which is why the card
      // capacity is what it is.
      scatterSpacing: 2,
      // Stands roughly 170 m across — big enough to ride into and out of, small
      // enough that a territory holds several.
      scatterBlob: 170,
      // 1, not the boost first guessed at. Measured: once the ramps were
      // authored in the art's own colours, the rendered meadow came out at
      // saturation 0.68 against the source art's 0.73 — the washout was the
      // muted hand-picked palette, not the tone mapping. Pushing to 1.45 on top
      // drove whole channels to 0 and 255; the slider stays for taste.
      saturation: 1,
      ground: {
        enabled: true,
        matchPropScale: true,
        // Only consulted when matchPropScale is off.
        scale: 3,
        // Modulate, don't replace — elevation banding and the slope rock
        // override still have to show through. 0.5 was too timid to read: the
        // blobs were there and measurable but invisible at the follow camera.
        strength: 0.85,
        // Texture near, flat colour far. A 16px tile smaller than a pixel is
        // crawling static, and the overview wants readable colour anyway.
        fadeNear: 140,
        fadeFar: 460,
        // Each biome sheet carries two ground surfaces — a flat fill and a
        // textured alternate in the same palette. A third of the ground takes
        // the alternate, in soft blobs, so a territory reads as varied without
        // losing the flat colour that makes it identifiable.
        //
        // Down from 0.5, and now honoured by both ground paths. The `exact`
        // path ignored blobs entirely and laid the tileset over every square
        // metre, which is what made the whole island read as grain rather than
        // as flat territories with texture in them.
        density: 0.33,
        baseStrength: 0.85,
        // Two flat colours meeting is what makes a border read as a line. A
        // patch of grain running up to the edge frays it, so the ground is held
        // flat for this many world units either side — a little over three
        // terrain cells, and wide enough to contain the colour cross-fade
        // (`biome.blend`) with room to spare.
        borderSolid: 26,
        /** Draw the terrain as flat albedo, with no lighting. */
        unshaded: false,
        exact: true,
      },
      detail: {
        enabled: true,
        // Tuned against an avatar roughly 5 world units tall: the fine grain
        // wants to be a bit smaller than the figure, the macro mottling much
        // larger, so the two read as material and as terrain variation rather
        // than as one uniform fizz.
        scale: 9,
        macroScale: 70,
        normalStrength: 0.55,
        albedoStrength: 0.3,
      },
    },
    avatar: {
      enabled: true,
      // 2048 world units / 17 per second = 120 s to cross the island, which
      // is the number this whole scale was derived from. Both modes run at
      // top speed by default so the figure holds whichever you're in.
      walkSpeed: 17,
      flySpeed: 17,
      // In body heights, so this figure is unaffected by rescaling the avatar:
      // shrinking the body shrinks the ride height with it, in proportion.
      hover: 4,
      fly: false,
      // 1.66 local units tall, so this puts the figure at ~1.8 world units —
      // person-sized against a 2 km island, and it carries the ride height
      // down with it since hover is measured in body heights.
      scale: 1.1,
      shadow: true,
      followCamera: true,
    },
    camera: {
      lockNorth: true,
      autoRecenter: true,
      recenterDelay: 2.5,
      recenterPitch: 45,
      recenterSpeed: 2.2,
      // The visible ground is roughly the orbit distance across, so top speed
      // crosses a frame in a bit under two seconds. That optical flow is what
      // makes movement feel fast — the absolute speed on its own doesn't.
      followDistance: 30,
      // 0.35s / 12 units let the avatar drift to almost half the frame width
      // when strafing, which at this distance put it behind the control panel.
      // Lateral movement is the binding case: moving north mostly adds depth,
      // but strafing turns trail directly into screen offset.
      followLag: 0.22,
      // Scaled down with the closer camera: trail is only meaningful as a
      // fraction of the visible frame, and 7 at 15 units puts the avatar as
      // far off-centre as 12 did at 22.
      followLeash: 5,
      restoreDistance: true,
    },
  }
}

/** Deep copy — used to snapshot params alongside a generated heightmap. */
export function cloneParams(p: WorldParams): WorldParams {
  return structuredClone(p)
}
