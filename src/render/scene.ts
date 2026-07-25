import * as THREE from 'three'
import { DEEP_SILT } from './colorRamp'

export interface SceneBundle {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  sun: THREE.DirectionalLight
  water: THREE.Mesh
  waterMaterial: THREE.MeshStandardMaterial
  setEnvironment(seaLevel: number, heightScale: number, extent: number): void
  setSun(azimuthDeg: number, elevationDeg: number, extent: number): void
  resize(width: number, height: number): void
}

export function createScene(canvasParent: HTMLElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
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
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6)
  scene.add(sun)
  scene.add(sun.target)

  // Sky/ground fill so shadowed slopes pick up bounce rather than going black.
  const hemi = new THREE.HemisphereLight(0xbcd8f0, 0x4a4033, 0.55)
  scene.add(hemi)

  // Open-ocean floor. The island mask drives the terrain's border down to
  // height 0, so without this the terrain's square edge is plainly visible:
  // inside it the translucent water composites over dark seabed, outside it
  // over bright sky. This plane continues the seabed to the horizon at the
  // same depth and colour, which makes the boundary vanish.
  const floorMaterial = new THREE.MeshStandardMaterial({
    // Vertex colours are authored in the linear working space, so the plane's
    // colour has to be specified the same way or it won't match the terrain.
    color: new THREE.Color().setRGB(
      DEEP_SILT[0],
      DEEP_SILT[1],
      DEEP_SILT[2],
      THREE.LinearSRGBColorSpace,
    ),
    roughness: 0.95,
    metalness: 0.0,
  })
  const oceanFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMaterial)
  oceanFloor.rotation.x = -Math.PI / 2
  scene.add(oceanFloor)

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x2f6f9e,
    transparent: true,
    opacity: 0.72,
    roughness: 0.12,
    metalness: 0.15,
    side: THREE.DoubleSide,
  })
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), waterMaterial)
  water.rotation.x = -Math.PI / 2
  water.renderOrder = 1
  scene.add(water)

  function setEnvironment(seaLevel: number, heightScale: number, extent: number): void {
    // The sea runs well past the island; its outer edge sits deep inside the
    // fog, so what you see is a horizon rather than a boundary.
    const span = extent * 40
    water.geometry.dispose()
    water.geometry = new THREE.PlaneGeometry(span, span)
    water.position.y = seaLevel * heightScale

    oceanFloor.geometry.dispose()
    oceanFloor.geometry = new THREE.PlaneGeometry(span, span)
    // Just below the terrain's zeroed border, so it reads as the same seabed
    // rather than a second surface, and doesn't z-fight with it.
    oceanFloor.position.y = -0.01 * heightScale

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
    // updateStyle must stay on: setPixelRatio scales the drawing buffer, and
    // without a matching CSS size the canvas lays out at buffer dimensions and
    // overflows the viewport by the pixel ratio.
    renderer.setSize(width, height)
  }

  return {
    renderer,
    scene,
    sun,
    water,
    waterMaterial,
    setEnvironment,
    setSun,
    resize,
  }
}
