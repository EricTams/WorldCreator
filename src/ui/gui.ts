import GUI from 'lil-gui'
import type { ViewPreset } from '../render/camera'
import type { WorldParams } from '../world/params'

export interface GuiCallbacks {
  /** A parameter that feeds the noise pipeline changed — rerun stages 1-5. */
  regenerate(): void
  /** Only affects meshing/scene (colour, scale, sun, water) — no regeneration. */
  refresh(): void
  randomizeSeed(): void
  erode(): void
  revert(): void
  preset(p: ViewPreset): void
  /** Surface detail is pure shader uniforms — no remesh, no regeneration. */
  detailChanged(): void
  /** Avatar settings that only need re-syncing, not regeneration. */
  avatarChanged(): void
  /** Drop the avatar back at the map centre. */
  recallAvatar(): void
}

export interface GuiHandles {
  gui: GUI
  /** Reflect externally-changed values (e.g. the randomised seed) in the UI. */
  refreshDisplay(): void
  setErosionBusy(busy: boolean): void
}

export function buildGui(params: WorldParams, cb: GuiCallbacks): GuiHandles {
  const gui = new GUI({ title: 'WorldCreator', width: 320 })

  const regen = () => cb.regenerate()
  const refresh = () => cb.refresh()

  // --- World ---
  const world = gui.addFolder('World')
  world.add(params, 'seed').name('seed').onFinishChange(regen)
  world.add({ randomize: () => cb.randomizeSeed() }, 'randomize').name('randomize seed')
  world
    .add(params, 'mapSize', [128, 256, 512, 1024])
    .name('map size (cells)')
    .onChange(regen)

  // --- Noise ---
  const noise = gui.addFolder('Noise (base shape)')
  noise.add(params.noise, 'enabled').onChange(regen)
  noise.add(params.noise, 'octaves', 1, 10, 1).onChange(regen)
  noise.add(params.noise, 'frequency', 0.2, 8, 0.05).onChange(regen)
  noise.add(params.noise, 'lacunarity', 1.2, 3.5, 0.05).onChange(regen)
  noise.add(params.noise, 'persistence', 0.1, 0.9, 0.01).onChange(regen)

  // --- Warp ---
  const warp = gui.addFolder('Domain warp')
  warp.add(params.warp, 'enabled').onChange(regen)
  warp.add(params.warp, 'strength', 0, 0.6, 0.005).onChange(regen)
  warp.add(params.warp, 'frequency', 0.2, 5, 0.05).onChange(regen)

  // --- Ridges ---
  const ridges = gui.addFolder('Ridged mountains')
  ridges.add(params.ridges, 'enabled').onChange(regen)
  ridges.add(params.ridges, 'threshold', 0, 1, 0.01).onChange(regen)
  ridges.add(params.ridges, 'strength', 0, 1, 0.01).onChange(regen)
  ridges.add(params.ridges, 'octaves', 1, 8, 1).onChange(regen)
  ridges.add(params.ridges, 'frequency', 0.5, 10, 0.1).onChange(regen)

  // --- Shape ---
  const shape = gui.addFolder('Shape & coast')
  shape.add(params.shape, 'redistribution', 0.4, 3, 0.05).onChange(regen)
  shape.add(params.shape, 'normalize').name('normalize range').onChange(regen)
  shape.add(params.shape, 'islandMask').name('island mask').onChange(regen)
  shape.add(params.shape, 'falloffStart', 0.1, 1, 0.01).onChange(regen)
  shape.add(params.shape, 'falloffPower', 0.5, 6, 0.1).onChange(regen)
  // Sea level is a rendering concern only — the generator never reads it, so
  // moving it just recolours and repositions the water plane.
  shape.add(params.shape, 'seaLevel', 0, 0.9, 0.005).name('sea level').onChange(refresh)

  // --- Erosion ---
  const erosion = gui.addFolder('Hydraulic erosion')
  const erodeBtn = erosion
    .add({ run: () => cb.erode() }, 'run')
    .name('▶ Erode + amplify')
  const revertBtn = erosion
    .add({ revert: () => cb.revert() }, 'revert')
    .name('↺ Revert to un-eroded')
  erosion.add(params.erosion, 'droplets', 10_000, 600_000, 10_000)
  erosion.add(params.erosion, 'radius', 1, 8, 1)
  erosion.add(params.erosion, 'inertia', 0, 0.6, 0.01)
  erosion.add(params.erosion, 'capacityFactor', 0.5, 12, 0.1).name('capacity')
  erosion.add(params.erosion, 'erodeSpeed', 0.005, 0.5, 0.005).name('erode speed')
  erosion.add(params.erosion, 'depositSpeed', 0.005, 0.5, 0.005).name('deposit speed')
  erosion.add(params.erosion, 'minSlope', 0.0005, 0.02, 0.0005).name('min slope')
  erosion.add(params.erosion, 'evaporation', 0.001, 0.1, 0.001)
  erosion.add(params.erosion, 'gravity', 0.5, 20, 0.5)
  erosion.add(params.erosion, 'maxLifetime', 5, 100, 1).name('droplet lifetime')
  erosion.close()

  // --- Amplification ---
  const amp = gui.addFolder('Detail amplification')
  amp.add(params.amplify, 'enabled')
  amp.add(params.amplify, 'levels', 0, 3, 1).name('subdivisions (×2 each)')
  amp.add(params.amplify, 'amplitude', 0, 0.05, 0.001).name('detail height')
  amp.add(params.amplify, 'persistence', 0.2, 0.9, 0.05).name('falloff / level')
  amp.add(params.amplify, 'frequencyScale', 0.04, 0.4, 0.01).name('detail frequency')
  amp.add(params.amplify, 'ridged', 0, 1, 0.05).name('rockiness')
  amp.add(params.amplify, 'slopeLo', 0, 2, 0.05).name('slope: start')
  amp.add(params.amplify, 'slopeHi', 0.1, 4, 0.05).name('slope: full')
  amp.add(params.amplify, 'flatFloor', 0, 0.5, 0.01).name('detail on flats')
  amp.close()

  // --- Look ---
  const look = gui.addFolder('Look')
  look.add(params.render, 'heightScale', 5, 200, 1).name('height scale').onChange(refresh)
  look.add(params.render, 'cellSize', 0.25, 4, 0.25).name('cell size').onChange(refresh)
  look.add(params.render, 'sunAzimuth', 0, 360, 1).name('sun azimuth').onChange(refresh)
  look.add(params.render, 'sunElevation', 2, 88, 1).name('sun elevation').onChange(refresh)
  look.add(params.render, 'showWater').name('water').onChange(refresh)
  look.add(params.render, 'wireframe').onChange(refresh)

  // --- Surface detail ---
  const detailChanged = () => cb.detailChanged()
  const det = gui.addFolder('Surface detail')
  det.add(params.render.detail, 'enabled').onChange(detailChanged)
  det.add(params.render.detail, 'scale', 1, 40, 0.5).name('grain size (m)').onChange(detailChanged)
  det
    .add(params.render.detail, 'macroScale', 10, 300, 1)
    .name('mottle size (m)')
    .onChange(detailChanged)
  det
    .add(params.render.detail, 'normalStrength', 0, 2, 0.01)
    .name('bump strength')
    .onChange(detailChanged)
  det
    .add(params.render.detail, 'albedoStrength', 0, 1, 0.01)
    .name('colour variation')
    .onChange(detailChanged)

  // --- Avatar ---
  const avatarChanged = () => cb.avatarChanged()
  const av = gui.addFolder('Avatar')
  av.add(params.avatar, 'enabled').onChange(avatarChanged)
  av.add({ v: () => cb.recallAvatar() }, 'v').name('⌖ Recall to centre')
  av.add(params.avatar, 'fly').name('fly mode (Space / Shift)')
  av.add(params.avatar, 'walkSpeed', 2, 150, 1).name('walk speed').onChange(avatarChanged)
  av.add(params.avatar, 'flySpeed', 5, 300, 1).name('fly speed').onChange(avatarChanged)
  av.add(params.avatar, 'scale', 0.5, 8, 0.1).onChange(avatarChanged)
  av.add(params.avatar, 'followCamera').name('camera follows').onChange(avatarChanged)

  // --- Camera ---
  const cam = gui.addFolder('Camera')
  cam.add(params.camera, 'autoRecenter').name('auto north-up')
  cam.add(params.camera, 'recenterDelay', 0.2, 10, 0.1).name('delay (s)')
  cam.add(params.camera, 'recenterPitch', 5, 85, 1).name('resting pitch°')
  cam.add(params.camera, 'recenterSpeed', 0.3, 8, 0.1).name('settle speed')
  // Re-applies the follow view so the new distance takes effect immediately
  // rather than waiting for the next time the preset is clicked.
  cam
    .add(params.camera, 'followDistance', 4, 160, 1)
    .name('follow distance')
    .onChange(() => cb.preset('follow'))
  cam.add(params.camera, 'followLag', 0, 1.5, 0.01).name('follow lag (s)')
  cam.add(params.camera, 'followLeash', 1, 60, 1).name('max trail')
  cam.add(params.camera, 'restoreDistance').name('restore distance')
  cam
    .add({ v: () => cb.preset('populous') }, 'v')
    .name('Populous view (whole map)')
  cam
    .add({ v: () => cb.preset('magicCarpet') }, 'v')
    .name('Magic Carpet view (ground)')
  cam.add({ v: () => cb.preset('follow') }, 'v').name('Behind the avatar')

  return {
    gui,
    refreshDisplay: () => gui.controllersRecursive().forEach((c) => c.updateDisplay()),
    setErosionBusy: (busy: boolean) => {
      erodeBtn.name(busy ? '… eroding' : '▶ Erode')
      if (busy) {
        erodeBtn.disable()
        revertBtn.disable()
      } else {
        erodeBtn.enable()
        revertBtn.enable()
      }
    },
  }
}
