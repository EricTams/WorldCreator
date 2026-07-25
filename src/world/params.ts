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

export interface RenderParams {
  /** World units per grid cell. */
  cellSize: number
  /** World units spanned by a normalised height of 1.0. */
  heightScale: number
  sunAzimuth: number
  sunElevation: number
  wireframe: boolean
  showWater: boolean
  detail: DetailParams
}

export interface AvatarParams {
  enabled: boolean
  walkSpeed: number
  flySpeed: number
  hover: number
  fly: boolean
  scale: number
  followCamera: boolean
}

export interface CameraParams {
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
      // 2 levels takes the default 256 simulation grid to a 1024 render grid
      // (2.1M triangles). 3 is 8.4M and wants LOD first.
      levels: 2,
      amplitude: 0.012,
      persistence: 0.55,
      frequencyScale: 0.16,
      ridged: 0.5,
      slopeLo: 0.15,
      slopeHi: 1.2,
      flatFloor: 0.08,
    },
    render: {
      // Relief is really the ratio of heightScale to the map's world width.
      // At cellSize 1 / heightScale 60 a 256-cell map was 256 wide and 60 tall
      // — about 23%, which is alpine, and unpleasant to traverse. Widening the
      // cells and lowering the height puts it near 8%: still clearly hilly,
      // but you can cross a valley without scaling a wall.
      cellSize: 2,
      heightScale: 42,
      sunAzimuth: 135,
      sunElevation: 32,
      wireframe: false,
      showWater: true,
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
      walkSpeed: 34,
      flySpeed: 60,
      hover: 0,
      fly: false,
      scale: 2.2,
      followCamera: true,
    },
    camera: {
      autoRecenter: true,
      recenterDelay: 2.5,
      recenterPitch: 45,
      recenterSpeed: 2.2,
      followDistance: 22,
      // 0.35s / 12 units let the avatar drift to almost half the frame width
      // when strafing, which at this distance put it behind the control panel.
      // Lateral movement is the binding case: moving north mostly adds depth,
      // but strafing turns trail directly into screen offset.
      followLag: 0.22,
      followLeash: 7,
      restoreDistance: true,
    },
  }
}

/** Deep copy — used to snapshot params alongside a generated heightmap. */
export function cloneParams(p: WorldParams): WorldParams {
  return structuredClone(p)
}
