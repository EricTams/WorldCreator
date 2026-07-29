import * as THREE from 'three'
import type { Atlas } from './spriteAtlas'
import { terrainDrawnHeightAt, terrainSampleAt } from '../world/terrainQuery'
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

/**
 * Disc radius, in world units, above which the circle is conformed to the
 * terrain per-vertex instead of laid on a plane through its centre.
 *
 * The threshold exists because two genuinely different things are drawn with the
 * same circle. A unit's marker is a couple of units across — smaller than the
 * figure standing on it — so the ground beneath it *is* a plane, the centre
 * normal describes that plane, and there are several hundred of them a frame.
 * A site's ownership decal is 19 to 44 units across (`site.radius` scaled, and
 * that is the defenders' leash, not a measure of the building): it reaches well
 * past the levelled plaza at its centre and out over whatever the landscape is
 * doing, and there are at most a few dozen.
 *
 * A flat circle that wide is what the clipping complaint was about. Past the
 * plaza the ground rolls, and a rigid plane through the middle of it buries its
 * uphill half in the hillside and floats the downhill half in the air — the
 * centre tilt actively making it worse, because tipping the disc to match the
 * slope is exactly what drives its uphill rim into the ground.
 *
 * 6 puts every unit, wagon and wizard marker on the cheap instanced path and
 * every site decal on the conformed one, with a wide margin either side.
 */
const CONFORM_ABOVE = 6

/**
 * Rings of a conformed disc and their opacity, as fractions of the radius.
 *
 * The same ramp the flat disc uses — flat-ish out to 0.62, then fading to
 * nothing at the rim — but sampled at five radii rather than three. The extra
 * rings are not about the ramp; they are what lets the disc find relief
 * *inside* itself. With a centre and a rim alone a ridge running under the
 * middle of a 40-unit decal is spanned by straight edges and reads as flat
 * ground, which is the same failure in a subtler costume.
 */
const CONFORM_RINGS = [0, 0.35, 0.62, 0.83, 1]
const CONFORM_ALPHA = [0.42, 0.38, 0.34, 0.15, 0]

/**
 * Vertices around each ring of a conformed disc.
 *
 * 24 puts the rim samples about 11 world units apart on the largest decal on
 * the board, which is a little over one 8-unit terrain cell — close enough to
 * the grid's own resolution that what the chords cut off is the sub-cell detail
 * amplification added, not the shape of the hill.
 */
const CONFORM_SEGMENTS = 24

/**
 * How many conformed discs may be in flight at once.
 *
 * Only sites reach the threshold, and a generated map carries well under a
 * hundred of them. Overflow falls back to the flat instanced disc rather than
 * dropping the decal — worst case a site draws the way it used to, which is a
 * blemish, where a missing ownership colour is misinformation.
 */
const CONFORM_CAPACITY = 128

/**
 * Clearance above the sampled surface, as a fraction of the disc's radius.
 *
 * The vertices land exactly on the drawn mesh, so all this has to clear is the
 * chord sag between them — hence scaling with the radius, since a wider disc
 * spans more ground between samples and sags further. It is affordable because
 * the outer ring is fully transparent: at the rim, where the lift is a real gap
 * you could see under, there is nothing drawn to see.
 */
const CONFORM_LIFT = 0.03

/**
 * Indices one conformed disc contributes: a fan of `CONFORM_SEGMENTS` triangles
 * from the centre, then two triangles per segment for each strip between
 * successive rings. Derived rather than written down so the ring list stays the
 * only place the tessellation is decided.
 */
const INDICES_PER_CONFORMED_DISC =
  CONFORM_SEGMENTS * 3 + (CONFORM_RINGS.length - 2) * CONFORM_SEGMENTS * 6

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

/** Unit-circle XZ per vertex of one conformed disc — the shape, before a radius. */
function makeConformUnitDisc(): { xz: Float32Array; alpha: Float32Array } {
  const xz: number[] = []
  const alpha: number[] = []
  for (let r = 0; r < CONFORM_RINGS.length; r++) {
    const count = r === 0 ? 1 : CONFORM_SEGMENTS
    for (let s = 0; s < count; s++) {
      const a = (s / CONFORM_SEGMENTS) * Math.PI * 2
      xz.push(Math.cos(a) * CONFORM_RINGS[r], Math.sin(a) * CONFORM_RINGS[r])
      alpha.push(CONFORM_ALPHA[r])
    }
  }
  return { xz: new Float32Array(xz), alpha: new Float32Array(alpha) }
}

/**
 * Winding for `count` conformed discs packed back to back into one buffer.
 *
 * Built once and never touched: only the vertex positions move, and how many
 * discs are live is expressed with a draw range rather than by rewriting this.
 */
function makeConformIndex(count: number, verticesPerDisc: number): Uint32Array {
  const index: number[] = []
  for (let d = 0; d < count; d++) {
    const base = d * verticesPerDisc
    // Fan from the centre vertex out to the first ring.
    for (let s = 0; s < CONFORM_SEGMENTS; s++) {
      index.push(base, base + 1 + s, base + 1 + ((s + 1) % CONFORM_SEGMENTS))
    }
    // Strips between successive rings.
    for (let r = 1; r < CONFORM_RINGS.length - 1; r++) {
      const inner = base + 1 + (r - 1) * CONFORM_SEGMENTS
      const outer = inner + CONFORM_SEGMENTS
      for (let s = 0; s < CONFORM_SEGMENTS; s++) {
        const n = (s + 1) % CONFORM_SEGMENTS
        index.push(inner + s, outer + s, outer + n)
        index.push(inner + s, outer + n, inner + n)
      }
    }
  }
  return new Uint32Array(index)
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
  /**
   * The large discs, conformed to the terrain. Not instanced — an instance is
   * one matrix applied to one shared shape, and the whole point here is that
   * every disc is a different shape, because every disc is lying on different
   * ground. So they are packed back to back into one buffer instead, which is
   * still one draw call.
   */
  private conformed: THREE.Mesh | null
  private conformedPos: THREE.BufferAttribute | null = null
  private conformedColor: THREE.BufferAttribute | null = null
  /** Unit-circle XZ pairs and rim alpha for one conformed disc. */
  private conformUnit = makeConformUnitDisc()
  /**
   * What is already sitting in each conformed slot: x, z, radius, the height of
   * the ground at its centre, and its tint.
   *
   * The point of remembering is that a site's decal is a *static* thing wearing
   * a dynamic layer's clothes. Where a town is does not change, and neither does
   * the hill it stands on; the only thing about it that ever changes is whose
   * colour it is flying. Resampling ninety-seven heights per decal per frame to
   * rediscover that would cost around 1.5 ms a frame across a full board — an
   * order of magnitude more than everything else this layer does — so a slot
   * whose key still matches keeps the vertices it already has.
   *
   * The centre height is in the key rather than some flag the terrain code
   * would have to remember to set: erosion and pad-flattening both mutate the
   * heightmap in place, so object identity is not evidence that the ground
   * stayed put, and a probe that answers "is this still the same hill" for the
   * price of one lookup is worth more than a promise.
   */
  private conformKey = new Float32Array(CONFORM_CAPACITY * 5)
  private conformPosDirty = false
  private conformColorDirty = false
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
  private conformCount = 0
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
      this.conformed = null
    } else {
      this.discMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        // A conformed disc wrapping over a crest turns its far side away from
        // the eye; one-sided, it would tear along the ridge line. The flat
        // discs want this too, for the frame a tilted one is caught edge-on.
        side: THREE.DoubleSide,
        fog: true,
        // Depth bias only, and worth being clear about what it can and cannot
        // do: it settles the tie where a disc is *coplanar* with the terrain.
        // It has never had anything to say about a disc that actually passes
        // through the ground, which is a geometry problem and is what the
        // conformed path exists to solve.
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

      this.conformed = this.makeConformedMesh(this.discMaterial)
      this.object.add(this.conformed)
    }

    this.object.add(this.standees)
  }

  /**
   * The single mesh every conformed disc is packed into.
   *
   * Shares the flat discs' material: the tint travels in the vertex colour here
   * instead of in `instanceColor`, and both end up multiplying the same rim
   * alpha ramp, so the two paths are indistinguishable on screen — which is the
   * point. Nothing about a site should change except that its decal now lies on
   * the ground.
   */
  private makeConformedMesh(material: THREE.MeshBasicMaterial): THREE.Mesh {
    const verts = this.conformUnit.alpha.length
    const geo = new THREE.BufferGeometry()

    this.conformedPos = new THREE.BufferAttribute(
      new Float32Array(CONFORM_CAPACITY * verts * 3),
      3,
    )
    this.conformedPos.setUsage(THREE.DynamicDrawUsage)
    this.conformedColor = new THREE.BufferAttribute(
      new Float32Array(CONFORM_CAPACITY * verts * 4),
      4,
    )
    this.conformedColor.setUsage(THREE.DynamicDrawUsage)

    geo.setAttribute('position', this.conformedPos)
    geo.setAttribute('color', this.conformedColor)
    geo.setIndex(new THREE.BufferAttribute(makeConformIndex(CONFORM_CAPACITY, verts), 1))
    geo.setDrawRange(0, 0)

    const mesh = new THREE.Mesh(geo, material)
    // The vertices are world-space and written after construction, so three's
    // bounding sphere — computed once, from a buffer that was all zeros at the
    // time — describes a point at the origin rather than sites scattered over a
    // 2 km island. Culling on that would drop every decal on the map.
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    return mesh
  }

  /** Start a frame. Everything pushed after this replaces the last frame's set. */
  begin(frame: TerrainFrame): void {
    this.frame = frame
    this.count = 0
    this.discCount = 0
    this.conformCount = 0
  }

  push(card: BoardCard<K>): void {
    const frame = this.frame
    if (!frame || this.count >= this.capacity) return

    const sample = terrainSampleAt(frame, card.x, card.z)
    const ground = Math.max(sample.height, frame.seaLevel * frame.heightScale)

    if (this.discs && card.tint !== undefined) {
      const radius = card.discRadius ?? 2
      // Big enough to reach past the ground it was placed on, so it has to be
      // laid on the surface rather than on a plane standing in for it.
      const conformed =
        radius > CONFORM_ABOVE && this.pushConformedDisc(frame, card.x, card.z, radius, card.tint)
      if (!conformed) {
        const d = this.discCount++
        this.normal.set(-sample.dx, 1, -sample.dz).normalize()
        this.quat.setFromUnitVectors(UP, this.normal)
        this.position.set(card.x, ground, card.z)
        this.discScale.set(radius, 1, radius)
        this.scratch.compose(this.position, this.quat, this.discScale)
        this.discs.setMatrixAt(d, this.scratch)
        this.colour.set(card.tint)
        this.discs.setColorAt(d, this.colour)
      }
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

  /**
   * Lay one disc on the surface, vertex by vertex. Returns false when the
   * conformed buffer is full, so the caller can fall back to a flat one.
   *
   * Heights come from `terrainDrawnHeightAt` rather than from the bilinear
   * field the rest of this layer samples, and the distinction is not academic
   * here. The field is a curved surface through the grid corners; the mesh
   * draws two flat triangles per cell, and at 8 world units between corners the
   * two disagree by metres on a ridge. A decal seated on the field is therefore
   * *underneath* the ground it is supposed to be lying on wherever the terrain
   * is convex — which is the second half of the clipping, and the half that
   * survives however carefully the disc is tilted.
   *
   * The waterline is a floor, as it is for the standees: a coastal site's decal
   * belongs on the sea beside it rather than on the seabed under it.
   */
  private pushConformedDisc(
    frame: TerrainFrame,
    x: number,
    z: number,
    radius: number,
    tint: number,
  ): boolean {
    const pos = this.conformedPos
    const col = this.conformedColor
    if (!pos || !col || this.conformCount >= CONFORM_CAPACITY) return false

    const { xz, alpha } = this.conformUnit
    const slot = this.conformCount++
    const base = slot * alpha.length
    const seaY = frame.seaLevel * frame.heightScale
    const centre = Math.max(terrainDrawnHeightAt(frame, x, z), seaY)

    const key = this.conformKey
    const k = slot * 5
    const sameShape =
      key[k] === x && key[k + 1] === z && key[k + 2] === radius && key[k + 3] === centre
    const sameTint = key[k + 4] === tint
    if (sameShape && sameTint) return true

    key[k] = x
    key[k + 1] = z
    key[k + 2] = radius
    key[k + 3] = centre
    key[k + 4] = tint
    this.colour.set(tint)
    const lift = radius * CONFORM_LIFT

    for (let i = 0; i < alpha.length; i++) {
      if (!sameShape) {
        const px = x + xz[i * 2] * radius
        const pz = z + xz[i * 2 + 1] * radius
        pos.setXYZ(base + i, px, Math.max(terrainDrawnHeightAt(frame, px, pz), seaY) + lift, pz)
      }
      col.setXYZW(base + i, this.colour.r, this.colour.g, this.colour.b, alpha[i])
    }
    if (!sameShape) this.conformPosDirty = true
    this.conformColorDirty = true
    return true
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

    if (this.conformed && this.conformedPos && this.conformedColor) {
      // How many discs are live is a draw range, not a rewrite: the index buffer
      // is the same winding every frame and the discs are packed from zero.
      this.conformed.geometry.setDrawRange(0, this.conformCount * INDICES_PER_CONFORMED_DISC)
      this.conformed.visible = this.conformCount > 0
      // Uploaded only when a slot actually moved or changed hands. In the steady
      // state — nothing captured, nothing eroded — this whole mesh costs the
      // frame one draw call and nothing else.
      if (this.conformPosDirty) this.conformedPos.needsUpdate = true
      if (this.conformColorDirty) this.conformedColor.needsUpdate = true
      this.conformPosDirty = false
      this.conformColorDirty = false
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
    this.conformed?.geometry.dispose()
    this.discMaterial?.dispose()
  }
}
