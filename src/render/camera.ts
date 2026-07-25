import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { CameraParams } from '../world/params'

export type ViewPreset = 'populous' | 'magicCarpet' | 'follow'

export interface CameraRig {
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  /**
   * Track a moving point. The camera keeps whatever orbit offset the user has
   * dragged out and translates with the target, rather than snapping to a
   * fixed chase position — so you can orbit freely while moving.
   */
  follow(target: THREE.Vector3 | null): void
  /**
   * Reconfigure clip planes and zoom limits for a world of the given extent,
   * so the same rig covers whole-map strategy zoom and near-ground flight.
   */
  fitToWorld(extent: number, heightScale: number): void
  apply(preset: ViewPreset): void
  resize(aspect: number): void
  update(dt: number, cam: CameraParams): void
  /** Seconds since the user last rotated. Exposed for the settling indicator. */
  idleTime(): number
  isSettling(): boolean
}

/** Signed shortest angular distance from `from` to `to`, in (-π, π]. */
function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

export function createCameraRig(domElement: HTMLElement): CameraRig {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 8000)
  const controls = new OrbitControls(camera, domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.screenSpacePanning = false

  let extent = 256
  let heightScale = 60
  let followTarget: THREE.Vector3 | null = null
  const lastTarget = new THREE.Vector3()
  const delta = new THREE.Vector3()

  // --- auto-recentre state ---
  const spherical = new THREE.Spherical()
  const offset = new THREE.Vector3()
  let idle = 0
  let dragging = false
  let settling = false
  // What the orbit angles were when we last wrote them. Anything that differs
  // next frame came from the user, which is how rotation is distinguished from
  // our own easing without OrbitControls telling us directly.
  let appliedTheta = Number.NaN
  let appliedPhi = Number.NaN

  controls.addEventListener('start', () => {
    dragging = true
  })
  controls.addEventListener('end', () => {
    dragging = false
  })

  function readOrbit(): void {
    offset.subVectors(camera.position, controls.target)
    spherical.setFromVector3(offset)
  }

  function writeOrbit(): void {
    offset.setFromSpherical(spherical)
    camera.position.copy(controls.target).add(offset)
  }

  /** Polar angle (from +Y) for a pitch expressed as degrees below horizontal. */
  function polarForPitch(pitchDeg: number): number {
    return THREE.MathUtils.clamp(
      Math.PI / 2 - THREE.MathUtils.degToRad(pitchDeg),
      0.02,
      Math.PI / 2 - 0.02,
    )
  }

  /**
   * Place the camera at a given distance and pitch, due south of the target so
   * that north (-Z) points up the screen. All the presets go through this, so
   * none of them start out fighting the auto-recentre.
   */
  function orbitTo(target: THREE.Vector3, distance: number, pitchDeg: number): void {
    spherical.set(distance, polarForPitch(pitchDeg), 0)
    controls.target.copy(target)
    writeOrbit()
  }

  function follow(target: THREE.Vector3 | null): void {
    followTarget = target
    if (target) lastTarget.copy(target)
  }

  function tick(dt: number, cam: CameraParams): void {
    if (followTarget) {
      delta.subVectors(followTarget, lastTarget)
      if (delta.lengthSq() > 0) {
        // Move the orbit pivot and the eye by the same amount, preserving the
        // user's chosen angle and distance. Translation only — the orbit
        // angles are untouched, so following never counts as rotating.
        controls.target.add(delta)
        camera.position.add(delta)
        lastTarget.copy(followTarget)
      }
    }

    if (cam.autoRecenter) {
      readOrbit()

      // Zooming changes radius and panning changes the target; neither touches
      // theta/phi, so only actual rotation restarts the countdown.
      const rotated =
        !Number.isNaN(appliedTheta) &&
        (Math.abs(shortestAngle(appliedTheta, spherical.theta)) > 1e-4 ||
          Math.abs(spherical.phi - appliedPhi) > 1e-4)

      if (dragging || rotated) {
        idle = 0
        settling = false
      } else {
        idle += dt
      }

      if (idle >= cam.recenterDelay) {
        const wantPhi = polarForPitch(cam.recenterPitch)
        const dTheta = shortestAngle(spherical.theta, 0)
        const dPhi = wantPhi - spherical.phi

        if (Math.abs(dTheta) < 1e-3 && Math.abs(dPhi) < 1e-3) {
          // Land it exactly, otherwise the easing chases the target forever
          // and the epsilon test above stays permanently tripped.
          spherical.theta = 0
          spherical.phi = wantPhi
          settling = false
        } else {
          // Frame-rate independent exponential ease.
          const k = 1 - Math.exp(-cam.recenterSpeed * dt)
          spherical.theta += dTheta * k
          spherical.phi += dPhi * k
          settling = true
        }
        writeOrbit()
      }

      readOrbit()
      appliedTheta = spherical.theta
      appliedPhi = spherical.phi
    } else {
      idle = 0
      settling = false
      appliedTheta = Number.NaN
      appliedPhi = Number.NaN
    }

    controls.update()
  }

  function fitToWorld(newExtent: number, newHeightScale: number): void {
    extent = Math.max(newExtent, 1)
    heightScale = newHeightScale
    // Depth precision is dominated by the near plane, and the shoreline is a
    // guaranteed coplanar case: the water plane and the terrain surface meet
    // exactly there. A near plane of extent/4000 left about 4cm of depth
    // resolution at normal viewing distance, so the whole beach band z-fought
    // and flickered as the camera moved. Keeping the ratio near 1:10000
    // instead of 1:120000 gives roughly an order of magnitude more precision;
    // nothing gets closer to the eye than this anyway.
    camera.near = Math.max(0.25, extent / 600)
    // Far enough to contain the sea plane, which the fog fades out long before.
    camera.far = extent * 16
    camera.updateProjectionMatrix()

    controls.minDistance = extent * 0.02
    controls.maxDistance = extent * 4
    // Stop the camera dropping below the ground plane when orbiting low.
    controls.maxPolarAngle = Math.PI * 0.495
    controls.target.set(0, 0, 0)
  }

  const presetTarget = new THREE.Vector3()

  function apply(preset: ViewPreset): void {
    if (preset === 'follow' && followTarget) {
      orbitTo(followTarget, extent * 0.09, 28)
      lastTarget.copy(followTarget)
    } else if (preset === 'populous') {
      // High and wide, whole island framed — the strategy view.
      presetTarget.set(0, heightScale * 0.18, 0)
      orbitTo(presetTarget, extent * 1.05, 38)
    } else {
      // Down at the deck, looking out across the terrain.
      presetTarget.set(0, heightScale * 0.3, 0)
      orbitTo(presetTarget, extent * 0.2, 12)
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
    follow,
    fitToWorld,
    apply,
    resize,
    update: tick,
    idleTime: () => idle,
    isSettling: () => settling,
  }
}
