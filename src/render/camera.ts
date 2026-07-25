import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export type ViewPreset = 'populous' | 'magicCarpet'

export interface CameraRig {
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  /**
   * Reconfigure clip planes and zoom limits for a world of the given extent,
   * so the same rig covers whole-map strategy zoom and near-ground flight.
   */
  fitToWorld(extent: number, heightScale: number): void
  apply(preset: ViewPreset): void
  resize(aspect: number): void
  update(): void
}

export function createCameraRig(domElement: HTMLElement): CameraRig {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 8000)
  const controls = new OrbitControls(camera, domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.screenSpacePanning = false

  let extent = 256
  let heightScale = 60

  function fitToWorld(newExtent: number, newHeightScale: number): void {
    extent = Math.max(newExtent, 1)
    heightScale = newHeightScale
    camera.near = Math.max(0.1, extent / 4000)
    // Far enough to contain the oversized sea plane, which the fog fades out
    // long before this distance.
    camera.far = extent * 30
    camera.updateProjectionMatrix()

    controls.minDistance = extent * 0.02
    controls.maxDistance = extent * 4
    // Stop the camera dropping below the ground plane when orbiting low.
    controls.maxPolarAngle = Math.PI * 0.495
    controls.target.set(0, 0, 0)
  }

  function apply(preset: ViewPreset): void {
    if (preset === 'populous') {
      // High and angled, whole island framed — the strategy view.
      const d = extent * 0.9
      camera.position.set(d * 0.62, d * 0.66, d * 0.62)
      controls.target.set(0, heightScale * 0.18, 0)
    } else {
      // Down at the deck, looking out across the terrain.
      const d = extent * 0.16
      camera.position.set(d, heightScale * 0.42, d)
      controls.target.set(0, heightScale * 0.3, 0)
    }
    controls.update()
  }

  function resize(aspect: number): void {
    camera.aspect = aspect
    camera.updateProjectionMatrix()
  }

  return {
    camera,
    controls,
    fitToWorld,
    apply,
    resize,
    update: () => controls.update(),
  }
}
