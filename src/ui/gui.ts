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
  /**
   * A camera setting that something outside the rig has to follow — the north
   * lock also decides whether the sprite cards track the camera. Uniform writes
   * only, so it sits in the same cost tier as `detailChanged`.
   */
  cameraChanged(): void
  /** Fog settings — uniform writes and a re-cull, no remesh. */
  fogChanged(): void
  /** Wipe everything the player has explored. */
  resetFog(): void
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

  // --- Territories ---
  // Regions are authored rather than simulated: a capital is sited on ground
  // that suits a capital, and its territory is the land around it. So which land
  // is whose is a design decision, not an emergent property of a moisture field.
  //
  // "cities" is not "territories" — there are more cities than factions, so a
  // faction holds several and its territory is however many of their cells
  // adjoin. Raising it makes the map busier *and* its territories more
  // interlocked, which is not what a region count would have done.
  //
  // The first two regenerate rather than refresh. They move the capitals, and a
  // capital stands on a terrace cut into the heightmap — moving one means
  // re-cutting the ground under it, which can only be done from the pristine
  // generated surface. The last two only bend borders and are free.
  const bio = gui.addFolder('Territories')
  bio.add(params.biome, 'enabled').name('biomes').onChange(regen)
  bio.add(params.biome, 'cities', 1, 30, 1).name('cities').onChange(regen)
  bio.add(params.biome, 'blend', 0, 200, 2).name('border blend (m)').onChange(refresh)
  bio.add(params.biome, 'warp', 0, 500, 10).name('border wander (m)').onChange(refresh)
  // Scatter is what makes a territory legible — this art has no ground texture,
  // so vegetation density is the terrain detail.
  bio.add(params.render, 'scatter').name('scatter props').onChange(refresh)
  bio
    .add(params.render, 'scatterSpacing', 2, 40, 0.5)
    .name('scatter spacing (m)')
    .onChange(refresh)
  bio
    .add(params.render, 'scatterBlob', 40, 500, 10)
    .name('stand size (m)')
    .onChange(refresh)

  // --- Fog of war ---
  // Unexplored ground is not drawn at all, which is also the renderer's
  // cheapest culling: fogged tiles and every prop in them are skipped.
  const fog = gui.addFolder('Fog of war')
  fog.add(params.fog, 'enabled').name('fog of war').onChange(() => cb.fogChanged())
  fog.add(params.fog, 'revealAll').name('reveal all').onChange(() => cb.fogChanged())
  fog.add(params.fog, 'sightRadius', 40, 500, 10).name('sight (m)').onChange(() => cb.fogChanged())
  fog
    .add(params.fog, 'elevationBonus', 0, 2, 0.1)
    .name('altitude bonus')
    .onChange(() => cb.fogChanged())
  fog.add({ v: () => cb.resetFog() }, 'v').name('↺ Forget the map')

  // --- Look ---
  const look = gui.addFolder('Look')
  look.add(params.render, 'heightScale', 5, 200, 1).name('height scale').onChange(refresh)
  look.add(params.render, 'cellSize', 0.25, 4, 0.25).name('cell size').onChange(refresh)
  look.add(params.render, 'sunAzimuth', 0, 360, 1).name('sun azimuth').onChange(refresh)
  look.add(params.render, 'sunElevation', 2, 88, 1).name('sun elevation').onChange(refresh)
  look.add(params.render, 'showWater').name('water').onChange(refresh)
  look.add(params.render, 'shoreFade', 0.5, 30, 0.5).name('shallows (m)').onChange(refresh)
  look.add(params.render, 'coastStep', 0, 10, 0.25).name('coast step (m)').onChange(refresh)
  look.add(params.render, 'coastBand', 1, 30, 0.5).name('coast band (m)').onChange(refresh)
  look.add(params.render, 'wireframe').onChange(refresh)
  // Flat albedo, no lights. The source art has no lighting model — a tile is one
  // colour — so this is the only way to see the palette without the renderer's
  // shading on top of it.
  look
    .add(params.render.ground, 'unshaded')
    .name('unshaded terrain')
    .onChange(refresh)
  // Draws the biome's actual tile rather than a colour sampled from it. Implies
  // unshaded — a lit tile is not the tile.
  look
    .add(params.render.ground, 'exact')
    .name('exact tile pixels')
    .onChange(refresh)

  // --- Surface detail ---
  const detailChanged = () => cb.detailChanged()
  const det = gui.addFolder('Surface detail')
  // The one genuine terrain texture in the art pack: each biome's self-tiling
  // fill tile, lifted out of its autotile sheet.
  det.add(params.render.ground, 'enabled').name('ground texture').onChange(detailChanged)
  det
    .add(params.render.ground, 'matchPropScale')
    .name('texel = sprite pixel')
    .onChange(detailChanged)
  det
    .add(params.render.ground, 'scale', 0.5, 16, 0.25)
    .name('ground tile (m)')
    .onChange(detailChanged)
  det
    .add(params.render.ground, 'strength', 0, 1, 0.05)
    .name('ground strength')
    .onChange(detailChanged)
  det
    .add(params.render.ground, 'baseStrength', 0, 1, 0.05)
    .name('texture grain')
    .onChange(detailChanged)
  det
    .add(params.render.ground, 'density', 0, 1, 0.02)
    .name('texture cover')
    .onChange(detailChanged)
  det
    .add(params.render.ground, 'borderSolid', 0, 120, 2)
    .name('flat at borders (m)')
    .onChange(detailChanged)
  det
    .add(params.render.ground, 'fadeFar', 100, 1200, 20)
    .name('ground fade (m)')
    .onChange(detailChanged)
  det
    .add(params.render, 'saturation', 0.5, 2.5, 0.05)
    .name('saturation')
    .onChange(detailChanged)
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
  av.add(params.avatar, 'fly').name('fly mode')
  av
    .add(params.avatar, 'hover', 0, 12, 0.25)
    .name('hover (body heights)')
    .onChange(avatarChanged)
  av.add(params.avatar, 'walkSpeed', 2, 150, 1).name('walk speed').onChange(avatarChanged)
  av.add(params.avatar, 'flySpeed', 5, 300, 1).name('fly speed').onChange(avatarChanged)
  av.add(params.avatar, 'scale', 0.5, 8, 0.1).onChange(avatarChanged)
  av.add(params.avatar, 'shadow').name('ground shadow').onChange(avatarChanged)
  av.add(params.avatar, 'followCamera').name('camera follows').onChange(avatarChanged)

  // --- Camera ---
  const cam = gui.addFolder('Camera')
  cam
    .add(params.camera, 'lockNorth')
    .name('lock north up')
    .onChange(() => cb.cameraChanged())
  cam.add(params.camera, 'autoRecenter').name('auto north-up')
  cam.add(params.camera, 'recenterDelay', 0.2, 10, 0.1).name('delay (s)')
  // Also leans the sprite cards, which are drawn for a high-angle view and only
  // look undistorted when they match the camera's pitch.
  cam
    .add(params.camera, 'recenterPitch', 5, 85, 1)
    .name('resting pitch°')
    .onChange(() => cb.cameraChanged())
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

  // Collapsed to its title bar on load. The panel is a tuning tool, not part of
  // playing, and on a phone an open one covers most of the screen — so the map
  // is what you land on, and the controls are one tap away.
  gui.close()

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
