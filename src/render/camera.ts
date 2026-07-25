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
  /** Drop the lagged pivot straight onto the target, skipping the catch-up. */
  snapFollow(): void
  /**
   * Reconfigure clip planes and zoom limits for a world of the given extent,
   * so the same rig covers whole-map strategy zoom and near-ground flight.
   */
  fitToWorld(extent: number, heightScale: number): void
  apply(preset: ViewPreset, cam?: CameraParams): void
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
  // The camera orbits `pivot`, a damped point chasing the avatar — not the
  // avatar itself. That trailing is the whole point: locked rigidly, movement
  // reads as the world sliding past a fixed rig rather than the avatar moving.
  const pivot = new THREE.Vector3()
  const lastPivot = new THREE.Vector3()
  let pivotReady = false
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
  let appliedRadius = Number.NaN
  // Non-zero only while the follow view is the chosen framing. The overview
  // presets leave it at 0 so that deliberately pulling back to look at the
  // whole map is never undone two seconds later.
  let restingDistance = 0

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
    if (!target) {
      pivotReady = false
      return
    }
    if (!pivotReady) snapFollow()
  }

  function snapFollow(): void {
    if (!followTarget) return
    pivot.copy(followTarget)
    lastPivot.copy(followTarget)
    pivotReady = true
  }

  function tick(dt: number, cam: CameraParams): void {
    if (followTarget) {
      if (cam.followLag > 0.001) {
        // Frame-rate independent exponential chase.
        pivot.lerp(followTarget, 1 - Math.exp(-dt / cam.followLag))
      } else {
        pivot.copy(followTarget)
      }

      // Leash: at a sprint the exponential chase would settle at an arbitrary
      // trailing distance and walk the avatar off the edge of the frame, so
      // cap how far behind the pivot is ever allowed to sit.
      const gap = pivot.distanceTo(followTarget)
      if (gap > cam.followLeash) {
        pivot.lerp(followTarget, (gap - cam.followLeash) / gap)
      }

      delta.subVectors(pivot, lastPivot)
      if (delta.lengthSq() > 0) {
        // Move the orbit pivot and the eye by the same amount, preserving the
        // user's chosen angle and distance. Translation only — the orbit
        // angles are untouched, so following never counts as rotating.
        controls.target.add(delta)
        camera.position.add(delta)
        lastPivot.copy(pivot)
      }
    }

    if (cam.autoRecenter) {
      readOrbit()

      // Zooming changes radius and panning changes the target; neither touches
      // theta/phi, so only actual rotation restarts the countdown.
      // Distance is only part of the resting view in the follow framing.
      // Applying it unconditionally drags the camera out of the whole-map
      // overview and into the hillside a couple of seconds after load.
      const restoringDistance =
        cam.restoreDistance && followTarget !== null && restingDistance > 0

      const rotated =
        !Number.isNaN(appliedTheta) &&
        (Math.abs(shortestAngle(appliedTheta, spherical.theta)) > 1e-4 ||
          Math.abs(spherical.phi - appliedPhi) > 1e-4)

      // Zoom normally leaves the countdown alone, since radius isn't part of
      // the resting orientation. Once distance is being restored it *is* part
      // of it, and ignoring zoom would undo the user's scroll the instant they
      // made it.
      const zoomed =
        restoringDistance &&
        !Number.isNaN(appliedRadius) &&
        Math.abs(spherical.radius - appliedRadius) > Math.max(1e-3, appliedRadius * 1e-4)

      if (dragging || rotated || zoomed) {
        idle = 0
        settling = false
      } else {
        idle += dt
      }

      if (idle >= cam.recenterDelay) {
        const wantPhi = polarForPitch(cam.recenterPitch)
        const dTheta = shortestAngle(spherical.theta, 0)
        const dPhi = wantPhi - spherical.phi
        const dR = restoringDistance ? restingDistance - spherical.radius : 0

        // Frame-rate independent exponential ease.
        const k = 1 - Math.exp(-cam.recenterSpeed * dt)
        let done = true

        if (Math.abs(dTheta) < 1e-3 && Math.abs(dPhi) < 1e-3) {
          // Land it exactly, otherwise the easing chases the target forever
          // and the epsilon test above stays permanently tripped.
          spherical.theta = 0
          spherical.phi = wantPhi
        } else {
          spherical.theta += dTheta * k
          spherical.phi += dPhi * k
          done = false
        }

        if (restoringDistance) {
          if (Math.abs(dR) < 0.01) {
            spherical.radius = restingDistance
          } else {
            spherical.radius += dR * k
            done = false
          }
        }

        settling = !done
        writeOrbit()
      }

      readOrbit()
      appliedTheta = spherical.theta
      appliedPhi = spherical.phi
      appliedRadius = spherical.radius
    } else {
      idle = 0
      settling = false
      appliedTheta = Number.NaN
      appliedPhi = Number.NaN
      appliedRadius = Number.NaN
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

    // Absolute-ish rather than a fraction of extent: the close third-person
    // distance is set by how big the avatar is, not how big the map is, and a
    // proportional floor would forbid it entirely on a large map.
    controls.minDistance = Math.max(1, extent * 0.002)
    controls.maxDistance = extent * 4
    // Stop the camera dropping below the ground plane when orbiting low.
    controls.maxPolarAngle = Math.PI * 0.495
    controls.target.set(0, 0, 0)
  }

  const presetTarget = new THREE.Vector3()

  function apply(preset: ViewPreset, cam?: CameraParams): void {
    if (preset === 'follow' && followTarget) {
      snapFollow()
      restingDistance = cam?.followDistance ?? 22
      orbitTo(followTarget, restingDistance, cam?.recenterPitch ?? 30)
      lastPivot.copy(pivot)
    } else if (preset === 'populous') {
      // High and wide, whole island framed — the strategy view.
      restingDistance = 0
      presetTarget.set(0, heightScale * 0.18, 0)
      orbitTo(presetTarget, extent * 1.05, 38)
    } else {
      // Down at the deck, looking out across the terrain.
      restingDistance = 0
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
    snapFollow,
    fitToWorld,
    apply,
    resize,
    update: tick,
    idleTime: () => idle,
    isSettling: () => settling,
  }
}
