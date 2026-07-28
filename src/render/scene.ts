import * as THREE from 'three'
import { DEEP_SILT, WATER_DEEP } from './colorRamp'

export interface SceneBundle {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  sun: THREE.DirectionalLight
  setEnvironment(seaLevel: number, heightScale: number, extent: number): void
  setSun(azimuthDeg: number, elevationDeg: number, extent: number): void
  /**
   * Match the open sea to the sea the terrain paints on itself.
   *
   * `fogged` has to track the terrain material's own fog flag, which "exact
   * tile pixels" turns off — a fogged ocean meeting an unfogged one draws the
   * terrain's square edge across the water in plain sight.
   */
  setOcean(water: boolean, fogged: boolean): void
  resize(width: number, height: number): void
}

export function createScene(canvasParent: HTMLElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // No tone mapping, deliberately. ACES is a film curve: it rolls off highlights
  // and desaturates as it does, which is what you want for a rendered scene and
  // exactly what you do not want for pixel art. The terrain is coloured with
  // values lifted straight out of the artist's tilesets, and a filmic curve
  // turns those into pastels — a saturated tileset green measured on screen came
  // back visibly greyer than the sprites standing on it. Off, a sampled colour
  // survives to the framebuffer as the colour it was sampled as.
  renderer.toneMapping = THREE.NoToneMapping
  canvasParent.appendChild(renderer.domElement)

  const SKY = 0x8fb8d8
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(SKY)
  // Fog in the sky colour does double duty: aerial perspective on distant
  // terrain, and it dissolves the far edge of the water plane into the
  // horizon so the sea doesn't visibly end in a square.
  scene.fog = new THREE.Fog(SKY, 1, 2)

  // A low sun rakes across the terrain and makes relief legible — a high sun
  // flattens everything out. Also the condition under which normal seams would
  // be most visible, which is exactly when you want to be looking.
  // Flat-ish lighting, for the same reason there is no tone curve. The source
  // art has no lighting model at all — a tile is one colour — so the more of the
  // final pixel is shading, the less of it is the artist's palette. A low sun
  // and a strong sky term keep enough directional cue to read the relief while
  // leaving the flat ground close to the colour it was authored as.
  const sun = new THREE.DirectionalLight(0xfff3e0, 1.15)
  scene.add(sun)
  scene.add(sun.target)

  // Sky/ground fill so shadowed slopes pick up bounce rather than going black.
  const hemi = new THREE.HemisphereLight(0xbcd8f0, 0x8a8478, 1.5)
  scene.add(hemi)

  // The open sea, past the terrain's square edge.
  //
  // The terrain draws its own water (see terrainMaterial.ts) but the terrain is
  // 2 km of it and the horizon is not — without this the map ends in a visible
  // square with sky beyond. The island mask drives the border down to height 0,
  // which is the sea's deepest colour, so continuing that one colour outwards
  // makes the boundary disappear.
  //
  // Basic, not standard: the terrain paints its sea unlit, and a lit plane
  // butted against an unlit one is exactly the seam this is here to avoid.
  const oceanMaterial = new THREE.MeshBasicMaterial({
    // Vertex colours are authored in the linear working space, so the plane's
    // colour has to be specified the same way or it won't match the terrain.
    color: new THREE.Color(),
    // Free orbit can put the eye under the waterline out over open water, and a
    // single-sided sea shows sky from below.
    side: THREE.DoubleSide,
  })
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), oceanMaterial)
  ocean.rotation.x = -Math.PI / 2
  scene.add(ocean)

  /** Whether the terrain is drawing water, which decides this plane's job. */
  let waterOn = true
  let seaY = 0
  let bedY = 0

  function layoutOcean(): void {
    // A little below the terrain's waterline, so inside the map the terrain
    // always wins the depth test and the two never share a plane. The step is
    // invisible: it happens a kilometre out, in the same colour, and the fog
    // has most of it by then.
    ocean.position.y = waterOn ? seaY - 2 : bedY
    const c = waterOn ? WATER_DEEP : DEEP_SILT
    oceanMaterial.color.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace)
  }

  function setOcean(water: boolean, fogged: boolean): void {
    waterOn = water
    if (oceanMaterial.fog !== fogged) {
      oceanMaterial.fog = fogged
      oceanMaterial.needsUpdate = true
    }
    layoutOcean()
  }

  function setEnvironment(seaLevel: number, heightScale: number, extent: number): void {
    seaY = seaLevel * heightScale
    // Just below the terrain's zeroed border, so with the water off it reads as
    // the same seabed rather than a second surface, and doesn't z-fight with it.
    bedY = -0.02 * heightScale

    // The sea runs well past the island; its outer edge sits deep inside the
    // fog, so what you see is a horizon rather than a boundary.
    // Kept within the far plane with room to spare; the fog has fully taken
    // over by extent*9, so the sea's outer edge is never visible anyway.
    const span = extent * 20
    ocean.geometry.dispose()
    ocean.geometry = new THREE.PlaneGeometry(span, span)
    layoutOcean()

    const fog = scene.fog as THREE.Fog
    fog.near = extent * 1.5
    fog.far = extent * 9
  }

  function setSun(azimuthDeg: number, elevationDeg: number, extent: number): void {
    const az = (azimuthDeg * Math.PI) / 180
    const el = (elevationDeg * Math.PI) / 180
    const dist = Math.max(extent, 1) * 2
    sun.position.set(
      Math.cos(el) * Math.sin(az) * dist,
      Math.sin(el) * dist,
      Math.cos(el) * Math.cos(az) * dist,
    )
    sun.target.position.set(0, 0, 0)
    sun.target.updateMatrixWorld()
  }

  function resize(width: number, height: number): void {
    // Drawing buffer only — `updateStyle: false`. The canvas's *display* size is
    // CSS's job (it fills `#app`, see index.html), and handing it to this
    // function instead was a phone bug: `setSize` writes an inline pixel size,
    // so the canvas was however big the last measurement said, anchored at the
    // top-left of a full-screen `#app`. Turning the phone from portrait to
    // landscape resized the window before the measurement caught up, which left
    // a 390x844 canvas on an 844x390 screen — and the avatar, still dead centre
    // of the canvas, sitting off the bottom edge of the display.
    //
    // Sized by CSS the canvas always covers the screen, so a stale measurement
    // costs a frame of slightly wrong aspect rather than a view shoved into a
    // corner. It is also why `setPixelRatio` is safe here: without a CSS size a
    // canvas lays out at its buffer dimensions and overflows the viewport by the
    // pixel ratio, which is what the old comment here was guarding against.
    renderer.setSize(width, height, false)
  }

  return {
    renderer,
    scene,
    sun,
    setEnvironment,
    setSun,
    setOcean,
    resize,
  }
}
