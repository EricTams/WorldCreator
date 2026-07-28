import * as THREE from 'three'
import type { Atlas } from './spriteAtlas'
import { terrainSampleAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'

/**
 * Cards that move, animate, or change hands — rewritten from scratch every
 * frame.
 *
 * `CardLayer` is the other half of this pair and deliberately the opposite
 * shape: it holds tens of thousands of props that are placed once, seated on
 * levelled pads, and then only ever culled by fog. Its whole design is that
 * nothing is rewritten per frame. Units walk, garrisons die, mines change
 * owner and swap sprite, and a Point of Power's disc changes colour mid-match —
 * none of which that layer can express without invalidating the buffers it
 * exists to keep still.
 *
 * So this one is unapologetically immediate-mode. `begin()`, `push()` per live
 * thing, `end()`. At the few hundred instances the board actually carries, the
 * per-frame buffer rewrite is far cheaper than the bookkeeping that would let it
 * be incremental — and it means the simulation never has to tell the renderer
 * that something changed, which is the class of bug that would otherwise show up
 * as a captured mine still flying neutral colours.
 *
 * Generic over the atlas so the same code draws creatures from `units.png` and
 * board pieces from `sprites.png`; one material binds one texture, so those are
 * two instances of this class rather than one.
 */

export interface BoardCard<K extends string> {
  sprite: K
  x: number
  z: number
  /** Height above the ground, for anything airborne. */
  lift?: number
  scale?: number
  /** Animation sheet indices; ignored by single-frame sprites. */
  frame?: number
  row?: number
  /** Mirror horizontally. Sprite sheets are drawn facing one way. */
  flip?: boolean
  /** Ground disc colour. Omit for no disc. */
  tint?: number
  discRadius?: number
  /**
   * Draw the ownership disc and nothing else.
   *
   * For the cities, whose building is a static card in the other layer — it is
   * placed once and never moves, but who owns it changes mid-match, and colour
   * is the one part of a site's appearance that has to be able to change.
   */
  discOnly?: boolean
  /** 1 fully lit, 0 fully dimmed and desaturated. Fog of war drives this. */
  dim?: number
  /** Multiplies the sprite's colour — used to flash a unit taking damage. */
  flash?: number
}

const UP = new THREE.Vector3(0, 1, 0)
const DISC_SEGMENTS = 20

/** Fraction of a card's height buried below the ground, so it reads as planted. */
const SINK = 0.05

function makeDiscGeometry(): THREE.BufferGeometry {
  const rings = [0, 0.62, 1]
  const alphas = [0.42, 0.34, 0]

  const positions: number[] = []
  const colors: number[] = []
  const index: number[] = []

  for (let r = 0; r < rings.length; r++) {
    const count = r === 0 ? 1 : DISC_SEGMENTS
    for (let s = 0; s < count; s++) {
      const a = (s / DISC_SEGMENTS) * Math.PI * 2
      positions.push(Math.cos(a) * rings[r], 0, Math.sin(a) * rings[r])
      colors.push(1, 1, 1, alphas[r])
    }
  }

  for (let s = 0; s < DISC_SEGMENTS; s++) {
    index.push(0, 1 + s, 1 + ((s + 1) % DISC_SEGMENTS))
  }
  const inner = 1
  const outer = 1 + DISC_SEGMENTS
  for (let s = 0; s < DISC_SEGMENTS; s++) {
    const n = (s + 1) % DISC_SEGMENTS
    index.push(inner + s, outer + s, outer + n)
    index.push(inner + s, outer + n, inner + n)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geo.setIndex(index)
  return geo
}

const VERTEX_HEAD = /* glsl */ `
attribute vec4 aUvRect;
attribute vec2 aSize;
attribute vec2 aDim;
varying float vDim;
varying float vFlash;

uniform float uPixelScale;
uniform float uMinScreenPx;
uniform float uMaxGrow;
uniform float uBillboard;
uniform vec2 uTilt;
`

const VERTEX_BODY = /* glsl */ `
  vDim = aDim.x;
  vFlash = aDim.y;

  vec3 cardAnchor = instanceMatrix[3].xyz;
  vec3 toCam = cameraPosition - cardAnchor;

  vec3 fwd = normalize(vec3(toCam.x, 0.0, toCam.z) + vec3(1e-5, 0.0, 1e-5));
  vec3 faceCam = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 right = mix(vec3(1.0, 0.0, 0.0), faceCam, uBillboard);

  // Same legibility floor the board's static cards use: a creature is 16 source
  // pixels and would be sub-pixel from the overview, where reading where the
  // armies are is the entire point of being zoomed out.
  float dist = length(toCam);
  float minWorldH = uMinScreenPx * dist / uPixelScale;
  float grow = clamp(minWorldH / max(aSize.y, 1e-4), 1.0, uMaxGrow);
  vec2 cardSize = aSize * grow;

  vec3 lean = mix(vec3(0.0, 0.0, 1.0), fwd, uBillboard);
  vec3 up = vec3(0.0, uTilt.y, 0.0) - lean * uTilt.x;

  vec3 transformed =
      right * (position.x * cardSize.x)
    + up * (position.y * cardSize.y);
`

const FRAGMENT_HEAD = /* glsl */ `
varying float vDim;
varying float vFlash;
`

const FRAGMENT_BODY = /* glsl */ `
  float cardLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb =
    mix(vec3(cardLum), diffuseColor.rgb, mix(0.35, 1.0, vDim)) * mix(0.45, 1.0, vDim);
  // A hit flash. Additive rather than a colour replace, so the silhouette stays
  // readable — a unit that turns into a white blob for two frames reads as a
  // rendering glitch rather than as damage.
  diffuseColor.rgb += vec3(0.9, 0.35, 0.25) * vFlash;
`

export interface BoardLayerOptions<K extends string> {
  atlas: Atlas<K>
  capacity: number
  /** World units per 16 source pixels. Shared with `CardLayer` — see its docs. */
  pixelScale?: number
  discs?: boolean
}

export class BoardLayer<K extends string> {
  readonly object = new THREE.Group()

  private atlas: Atlas<K>
  private pixelScale: number
  private capacity: number

  private standees: THREE.InstancedMesh
  private discs: THREE.InstancedMesh | null
  private cardMaterial: THREE.MeshBasicMaterial
  private discMaterial: THREE.MeshBasicMaterial | null

  private uvRect: THREE.InstancedBufferAttribute
  private size: THREE.InstancedBufferAttribute
  /** (dim, flash) packed — two scalars is one attribute slot rather than two. */
  private dim: THREE.InstancedBufferAttribute

  private uniforms = {
    uPixelScale: { value: 500 },
    uMinScreenPx: { value: 16 },
    uMaxGrow: { value: 5 },
    uBillboard: { value: 0 },
    uTilt: { value: new THREE.Vector2(0, 1) },
  }

  private count = 0
  private discCount = 0
  private frame: TerrainFrame | null = null

  private scratch = new THREE.Matrix4()
  private quat = new THREE.Quaternion()
  private normal = new THREE.Vector3()
  private position = new THREE.Vector3()
  private discScale = new THREE.Vector3()
  private colour = new THREE.Color()
  private rect = new THREE.Vector4()

  constructor(opts: BoardLayerOptions<K>) {
    this.atlas = opts.atlas
    this.capacity = opts.capacity
    this.pixelScale = opts.pixelScale ?? 2.5

    const quad = new THREE.PlaneGeometry(1, 1)
    quad.translate(0, 0.5, 0)

    this.uvRect = new THREE.InstancedBufferAttribute(new Float32Array(opts.capacity * 4), 4)
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(opts.capacity * 2), 2)
    this.dim = new THREE.InstancedBufferAttribute(new Float32Array(opts.capacity * 2), 2)
    quad.setAttribute('aUvRect', this.uvRect)
    quad.setAttribute('aSize', this.size)
    quad.setAttribute('aDim', this.dim)

    this.cardMaterial = new THREE.MeshBasicMaterial({
      map: opts.atlas.texture,
      alphaTest: 0.5,
      transparent: false,
      side: THREE.DoubleSide,
      fog: true,
    })
    this.cardMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
        .replace('#include <begin_vertex>', VERTEX_BODY)
        .replace(
          '#include <uv_vertex>',
          '#include <uv_vertex>\n  vMapUv = aUvRect.xy + uv * aUvRect.zw;',
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT_BODY}`)
    }
    this.cardMaterial.customProgramCacheKey = () => 'board-layer-v1'

    this.standees = new THREE.InstancedMesh(quad, this.cardMaterial, opts.capacity)
    this.standees.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.standees.frustumCulled = false
    this.standees.count = 0
    // Above the terrain and the static cards, so a unit standing on a town's
    // pad is not z-fought by the pad's own decoration.
    this.standees.renderOrder = 3

    if (opts.discs === false) {
      this.discs = null
      this.discMaterial = null
    } else {
      this.discMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
      this.discs = new THREE.InstancedMesh(
        makeDiscGeometry(),
        this.discMaterial,
        opts.capacity,
      )
      this.discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.discs.frustumCulled = false
      this.discs.count = 0
      this.discs.renderOrder = 2
      this.object.add(this.discs)
    }

    this.object.add(this.standees)
  }

  /** Start a frame. Everything pushed after this replaces the last frame's set. */
  begin(frame: TerrainFrame): void {
    this.frame = frame
    this.count = 0
    this.discCount = 0
  }

  push(card: BoardCard<K>): void {
    const frame = this.frame
    if (!frame || this.count >= this.capacity) return

    const sample = terrainSampleAt(frame, card.x, card.z)
    const ground = Math.max(sample.height, frame.seaLevel * frame.heightScale)

    if (this.discs && card.tint !== undefined) {
      const d = this.discCount++
      const radius = card.discRadius ?? 2
      this.normal.set(-sample.dx, 1, -sample.dz).normalize()
      this.quat.setFromUnitVectors(UP, this.normal)
      this.position.set(card.x, ground, card.z)
      this.discScale.set(radius, 1, radius)
      this.scratch.compose(this.position, this.quat, this.discScale)
      this.discs.setMatrixAt(d, this.scratch)
      this.colour.set(card.tint)
      this.discs.setColorAt(d, this.colour)
    }

    if (card.discOnly) return

    const i = this.count++

    this.atlas.uvRect(card.sprite, card.frame ?? 0, card.row ?? 0, this.rect)
    if (card.flip) {
      // Walk the u range backwards from its far edge. Mirroring in the uv rect
      // rather than by scaling the quad keeps the instance matrix a pure
      // translation, which the billboard shader relies on to find the anchor.
      this.rect.x += this.rect.z
      this.rect.z = -this.rect.z
    }
    this.uvRect.setXYZW(i, this.rect.x, this.rect.y, this.rect.z, this.rect.w)

    const px = this.atlas.pixelSize(card.sprite)
    const unit = (this.pixelScale / 16) * (card.scale ?? 1)
    const w = px.w * unit
    const h = px.h * unit
    this.size.setXY(i, w, h)
    this.dim.setXY(i, card.dim ?? 1, card.flash ?? 0)

    const y = ground - h * SINK + (card.lift ?? 0)
    this.scratch.makeTranslation(card.x, y, card.z)
    this.standees.setMatrixAt(i, this.scratch)
  }

  /** Commit the frame's cards to the GPU. */
  end(): void {
    this.standees.count = this.count
    this.uvRect.needsUpdate = true
    this.size.needsUpdate = true
    this.dim.needsUpdate = true
    this.standees.instanceMatrix.needsUpdate = true

    if (this.discs) {
      this.discs.count = this.discCount
      this.discs.instanceMatrix.needsUpdate = true
      if (this.discs.instanceColor) this.discs.instanceColor.needsUpdate = true
    }
  }

  setPixelScale(scale: number): void {
    this.pixelScale = scale
  }

  setViewport(heightPx: number, fovDeg: number): void {
    this.uniforms.uPixelScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360))
  }

  setMinScreenSize(px: number, maxGrow: number): void {
    this.uniforms.uMinScreenPx.value = px
    this.uniforms.uMaxGrow.value = maxGrow
  }

  setBillboard(on: boolean): void {
    this.uniforms.uBillboard.value = on ? 1 : 0
  }

  setTilt(degrees: number): void {
    const t = (Math.max(0, Math.min(90, degrees)) * Math.PI) / 180
    this.uniforms.uTilt.value.set(Math.sin(t), Math.cos(t))
  }

  setVisible(on: boolean): void {
    this.object.visible = on
  }

  dispose(): void {
    this.standees.geometry.dispose()
    this.cardMaterial.dispose()
    this.discs?.geometry.dispose()
    this.discMaterial?.dispose()
  }
}
