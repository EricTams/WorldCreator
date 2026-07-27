import * as THREE from 'three'
import type { SpriteAtlas, SpriteKey } from './spriteAtlas'
import { terrainSampleAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'
import type { SitePad } from '../world/sites'

/**
 * Places and units, drawn as pixel-art cards standing on the terrain.
 *
 * Two instanced layers, one atlas, three draw calls total:
 *
 *   - a **standee**: a quad rooted at ground height that yaw-billboards toward
 *     the camera. It rotates about Y only and never pitches, so it reads as a
 *     cardboard figure standing on the landscape rather than an icon floating
 *     over it. Orbiting around a town walks around the town.
 *   - a **ground disc**: a decal conforming to the local slope underneath it,
 *     tinted by owner. It is what makes a site findable from strategy altitude,
 *     where a standee is nearly edge-on, and it gives ownership colour a place
 *     to live that isn't the sprite itself.
 *
 * Billboarding happens in the vertex shader, from `cameraPosition` and the
 * instance's own translation. Doing it on the CPU would mean rewriting a matrix
 * per card per frame for no benefit.
 */

/** World units a 16-pixel-tall sprite occupies. See `CardLayerOptions.pixelScale`. */
export const DEFAULT_PIXEL_SCALE = 2.5

export interface CardSpec {
  sprite: SpriteKey
  /** World XZ. Ground height is resolved by the layer, never stored by callers. */
  x: number
  z: number
  /** Per-card multiplier on the global scale. */
  scale?: number
  /** Ground disc colour, e.g. 0x4a80c0 for the player. */
  tint?: number
  /** Radius of the ground disc in world units. Defaults to the card's half-width. */
  discRadius?: number
  /**
   * Multiplier on this card's levelled pad. Raise it for something that should
   * command a clearing — a town with a plaza — and drop it for scatter that
   * should sit in the landscape rather than reshape it.
   */
  padScale?: number
  /**
   * World-unit radius of ground this card commands, replacing the radius
   * derived from its own width.
   *
   * For a cluster standing on one terrace. A settlement is a dozen cards, and
   * giving each its own pad would cut a dozen overlapping graded skirts into the
   * same hillside, which compound into a crater rather than into a plaza. So the
   * town carries a clearing big enough for the whole village and its satellites
   * carry `padScale: 0`.
   */
  clearing?: number
  /** Animation sheet indices; ignored by single-frame sprites. */
  frame?: number
  row?: number
  /** 1 fully lit, 0 fully dimmed and desaturated. Fog of war drives this. */
  dim?: number
  /**
   * How much of the distant-legibility floor this card gets. 1 for anything the
   * player needs to spot from the overview, 0 for scenery that should just
   * shrink with distance like the landscape it belongs to.
   */
  legibility?: number
}

export interface CardLayerOptions {
  atlas: SpriteAtlas
  /** Maximum simultaneous cards. Instance buffers are allocated once at this size. */
  capacity: number
  /**
   * World units per 16 source pixels.
   *
   * Everything on the board shares this — towns, lairs, pickups, trees, rocks,
   * and the ground tiles. That is the whole point of a single value: the art is
   * one 16px grid, so a 64px town is already meant to be four times a 15px tree,
   * and the moment vegetation got its own multiplier the trees came out larger
   * than the castles they were supposed to be standing around.
   *
   * At 2.5: a town is 10 units, a lair 5, a pickup 2.5, a tree 2.35 — about
   * 5.5 avatar-heights for the town. Halving this halves every one of those
   * together, which is the point of a single value; what it does *not* do is
   * preserve ground cover, since cover goes as the square of prop width over
   * spacing. Halving the props quarters the cover unless the scatter spacing
   * comes down with them.
   */
  pixelScale?: number
  showDiscs?: boolean
}

const UP = new THREE.Vector3(0, 1, 0)
const DISC_SEGMENTS = 24
/** Fraction of a card's height buried below the ground, so it reads as planted. */
const SINK = 0.05

/**
 * Levelled pad radius, as a multiple of the card's width.
 *
 * Half the width — just the circle the card's base can sweep — is the minimum
 * that stops it floating, and it looks it: the terrace hugs the sprite so
 * tightly that the building still reads as balanced on a hillside. It is also
 * barely three cells across at the default eight-unit cell size, so the flat
 * area is mostly lost to the grid.
 *
 * At 1.3 a town gets a clearing about three times its own width, which is what
 * makes it look like somewhere the ground was prepared for.
 */
const PAD_SCALE = 1.3

/**
 * Floor on the pad radius.
 *
 * Kept small deliberately. At quarter scale a town is only 4 units wide, so its
 * pad is about 5 — well under the 8-unit terrain cell, which means the levelled
 * terrace has all but stopped existing at the base grid resolution. That turns
 * out to be fine rather than a regression: the float-or-dig problem flattening
 * solved scales with the card's width, and a 4-unit card sweeps a 2-unit circle
 * over which this terrain barely moves. Forcing a larger floor would cut bald
 * patches far wider than the buildings standing on them.
 */
const MIN_PAD = 3

/**
 * Filled disc that fades out over its outer third, built by hand rather than
 * from CircleGeometry so the rim alpha can be baked into vertex colours. A
 * texture for this would be one more asset to justify.
 */
function makeDiscGeometry(): THREE.BufferGeometry {
  // Kept faint on purpose. The standee is rooted at the disc's centre, so the
  // disc's near half is legitimately in front of the card's base — that is real
  // geometry, not a bug, and the only way it stops reading as a wash over the
  // sprite is for it to be subtle.
  const rings = [0, 0.62, 1]
  const alphas = [0.26, 0.22, 0]

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

  // Fan from the centre vertex to the inner ring.
  for (let s = 0; s < DISC_SEGMENTS; s++) {
    index.push(0, 1 + s, 1 + ((s + 1) % DISC_SEGMENTS))
  }
  // Strip between the inner and outer rings.
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

const CARD_VERTEX_HEAD = /* glsl */ `
attribute vec4 aUvRect;
attribute vec2 aSize;
attribute float aDim;
attribute float aGrow;
varying float vDim;

uniform float uPixelScale;
uniform float uMinScreenPx;
uniform float uMaxGrow;
uniform float uBillboard;
uniform vec2 uTilt; // (sin, cos) of the lean-back angle
`

const CARD_VERTEX_BODY = /* glsl */ `
  vDim = aDim;

  // The instance matrix is a pure translation, so its fourth column is the
  // card's anchor: the world point its bottom edge is welded to.
  vec3 cardAnchor = instanceMatrix[3].xyz;
  vec3 toCam = cameraPosition - cardAnchor;

  // Flatten the view direction before building the basis — that is what makes
  // this a yaw billboard rather than a full one. The epsilon keeps the cross
  // product defined when the camera is directly overhead, where the flattened
  // vector would otherwise be zero and normalize() would return NaN.
  vec3 fwd = normalize(vec3(toCam.x, 0.0, toCam.z) + vec3(1e-5, 0.0, 1e-5));
  vec3 faceCam = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));

  // With the view locked north-up the camera is always due south, so the cards
  // need no tracking at all: a fixed east-west axis puts every one of them
  // square to the screen. That is strictly better than billboarding here —
  // a tracked card swivels a little as you walk past it, which reads as the
  // scenery watching you.
  vec3 right = mix(vec3(1.0, 0.0, 0.0), faceCam, uBillboard);

  // Hold a minimum on-screen height, up to a cap.
  //
  // Without this the whole board is unreadable from the overview: at an orbit
  // distance of ~2150 the frame spans over two thousand world units, so a 16-
  // unit town is about five pixels tall and a four-unit resource pile is one.
  // Growing everything uniformly would flatten the world into an icon sheet, so
  // instead each card grows only as far as it needs to clear the floor, and no
  // further than uMaxGrow. Big things stay honest; small things swell toward
  // legibility. At the follow camera nothing grows at all.
  //
  // aGrow is what keeps that from backfiring: scenery opts out. Trees exist to
  // frame a site, and when they swelled to the same floor the buildings did,
  // every location turned into a blob of foliage with something hidden in it.
  // Sites hold their minimum size; the woodland around them recedes with
  // distance the way it should.
  float dist = length(toCam);
  float minWorldH = uMinScreenPx * dist / uPixelScale;
  float grow = clamp(minWorldH * aGrow / max(aSize.y, 1e-4), 1.0, uMaxGrow);
  vec2 cardSize = aSize * grow;

  // Lean the card back, away from the camera, about its grounded bottom edge.
  //
  // This exists because the art is not drawn in elevation. The sprites carry a
  // built-in high-angle view — the Stronghold's palisade is a circle drawn as a
  // 0.72-ratio ellipse, about 44 degrees — so a bolt-upright card gets that
  // foreshortening applied twice and the buildings read as squashed. Leaning
  // the card to match the camera's pitch presents the art the way it was drawn.
  // At 0 it stands upright; at 90 it lies flat on the ground.
  vec3 lean = mix(vec3(0.0, 0.0, 1.0), fwd, uBillboard);
  vec3 up = vec3(0.0, uTilt.y, 0.0) - lean * uTilt.x;

  // The quad's origin sits at its bottom edge (see the geometry translate), so
  // the lean pivots around the point the card is planted at.
  vec3 transformed =
      right * (position.x * cardSize.x)
    + up * (position.y * cardSize.y);
`

const CARD_FRAGMENT_HEAD = /* glsl */ `
varying float vDim;
`

const CARD_FRAGMENT_BODY = /* glsl */ `
  // Dimming is desaturation plus a multiply, not a multiply alone: remembered
  // ground under fog of war loses its colour, and a card that kept full
  // saturation while the terrain around it went grey would read as lit.
  float cardLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb =
    mix(vec3(cardLum), diffuseColor.rgb, mix(0.35, 1.0, vDim)) * mix(0.45, 1.0, vDim);
`

export class CardLayer {
  readonly object = new THREE.Group()

  private atlas: SpriteAtlas
  private pixelScale: number
  private capacity: number

  private standees: THREE.InstancedMesh
  private discs: THREE.InstancedMesh
  private cardMaterial: THREE.MeshBasicMaterial
  private discMaterial: THREE.MeshBasicMaterial

  private uvRect: THREE.InstancedBufferAttribute
  private size: THREE.InstancedBufferAttribute
  private dim: THREE.InstancedBufferAttribute
  private grow: THREE.InstancedBufferAttribute

  /**
   * Owned by this instance, not module-level: two layers must not silently
   * share one uniforms object through an `onBeforeCompile` closure.
   */
  private uniforms = {
    /** Pixels per world unit at one unit of distance. Set from viewport + FOV. */
    uPixelScale: { value: 500 },
    uMinScreenPx: { value: 16 },
    /**
     * How far a card may swell to hold the on-screen floor.
     *
     * 5. A 20-unit town needs about 2.3x to hold 16 screen pixels from the
     * 2150-unit overview, so this leaves headroom for the smaller sites without
     * the violent inflation a 4-unit town required. That violence was visible:
     * at a cap of 12 a site was drawn twelve times oversize at range and at true
     * size up close, so approaching one made it shrink away under you.
     */
    uMaxGrow: { value: 5 },
    /** 0 = fixed south-facing (north-locked view), 1 = track the camera. */
    uBillboard: { value: 0 },
    /** (sin, cos) of the lean-back angle. Set via `setTilt`. */
    uTilt: { value: new THREE.Vector2(0, 1) },
  }

  private cards: CardSpec[] = []
  /**
   * The subset actually uploaded. Fog culling narrows this; everything else
   * works from `cards`, so a card hidden by fog is not forgotten, just not
   * submitted.
   */
  private visible: CardSpec[] = []
  /** Cards still in the dark. Drains into `visible` as the fog lifts. */
  private pending: CardSpec[] = []
  private mode: 'all' | 'fog' = 'all'
  private frame: TerrainFrame | null = null
  private scratch = new THREE.Matrix4()
  private quat = new THREE.Quaternion()
  private normal = new THREE.Vector3()
  private position = new THREE.Vector3()
  private discScale = new THREE.Vector3()
  private colour = new THREE.Color()

  /**
   * The patch of ground each card needs levelled, before any of them are seated.
   *
   * Deliberately independent of the terrain: card size follows from the sprite
   * and the scale alone, so the caller can flatten the heightmap first and then
   * seat the cards on the result. Doing it the other way round would seat them
   * on ground that is about to move.
   */
  padsFor(cards: readonly CardSpec[]): SitePad[] {
    return cards.map((card) => {
      // `padScale: 0` means "sit in the landscape, do not reshape it", and has
      // to short-circuit: the floor below would otherwise hand a tree a 3-unit
      // terrace. It never showed while only the site list was passed through
      // here, and it would have levelled the ground under every satellite the
      // moment a settlement was.
      if ((card.padScale ?? 1) <= 0) return { x: card.x, z: card.z, radius: 0 }
      if (card.clearing !== undefined) {
        return { x: card.x, z: card.z, radius: card.clearing }
      }
      const { w } = this.worldSize(card)
      const radius = Math.max(w * PAD_SCALE * (card.padScale ?? 1), MIN_PAD)
      return { x: card.x, z: card.z, radius }
    })
  }

  /**
   * Where decoration should ring each card.
   *
   * Deliberately not the levelled pad. The pad exists to stop a card floating
   * on a slope, so it shrinks with the card and can legitimately fall below one
   * terrain cell; a decoration ring exists to be *seen*, and needs to stand off
   * the building by a visible margin whatever the world scale is.
   */
  decoRingsFor(cards: readonly CardSpec[]): SitePad[] {
    return cards.map((card) => {
      if ((card.padScale ?? 1) <= 0) return { x: card.x, z: card.z, radius: 0 }
      // A settlement's treeline belongs outside the whole village, not around
      // the town card in the middle of it. Standing off the clearing rather than
      // the sprite is the difference between a wood at the edge of the fields
      // and a wood growing through the houses.
      const radius =
        card.clearing !== undefined
          ? card.clearing * 1.08
          : Math.max(this.worldSize(card).w * 1.9, 5)
      return { x: card.x, z: card.z, radius }
    })
  }

  /** World units per 16 source pixels, as currently applied. */
  get scale(): number {
    return this.pixelScale
  }

  /**
   * World width of a sprite at the current scale, before any per-card
   * multiplier.
   *
   * For callers sizing something *around* a card — the radius of a settlement,
   * the spacing of a treeline — which need the number before there is a card to
   * measure.
   */
  spriteWidth(key: SpriteKey): number {
    return this.atlas.pixelSize(key).w * (this.pixelScale / 16)
  }

  constructor(opts: CardLayerOptions) {
    this.atlas = opts.atlas
    this.capacity = opts.capacity
    this.pixelScale = opts.pixelScale ?? DEFAULT_PIXEL_SCALE

    // Origin at the bottom edge, so an instance translation is literally "where
    // this card touches the ground".
    const quad = new THREE.PlaneGeometry(1, 1)
    quad.translate(0, 0.5, 0)

    this.uvRect = new THREE.InstancedBufferAttribute(new Float32Array(opts.capacity * 4), 4)
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(opts.capacity * 2), 2)
    this.dim = new THREE.InstancedBufferAttribute(new Float32Array(opts.capacity), 1)
    this.grow = new THREE.InstancedBufferAttribute(new Float32Array(opts.capacity), 1)
    quad.setAttribute('aUvRect', this.uvRect)
    quad.setAttribute('aSize', this.size)
    quad.setAttribute('aDim', this.dim)
    quad.setAttribute('aGrow', this.grow)

    this.cardMaterial = new THREE.MeshBasicMaterial({
      map: opts.atlas.texture,
      // Alpha *test*, not blending. Tested cards write depth, so they sort
      // against the terrain and against each other for free; blended ones would
      // need a CPU sort every frame and would still fight the water plane.
      alphaTest: 0.5,
      transparent: false,
      // A yaw billboard can be caught edge-on for a frame during a fast orbit.
      side: THREE.DoubleSide,
      // The scene's distance fog is active and tuned to the island's extent;
      // an unfogged card pops out of a fogged landscape.
      fog: true,
    })
    this.cardMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${CARD_VERTEX_HEAD}`)
        .replace('#include <begin_vertex>', CARD_VERTEX_BODY)
        .replace(
          '#include <uv_vertex>',
          '#include <uv_vertex>\n  vMapUv = aUvRect.xy + uv * aUvRect.zw;',
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${CARD_FRAGMENT_HEAD}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${CARD_FRAGMENT_BODY}`)
    }
    // Must differ from the terrain's key, and from an unpatched basic material's
    // default. Bump the suffix whenever the injected GLSL changes.
    this.cardMaterial.customProgramCacheKey = () => 'card-layer-v1'

    this.standees = new THREE.InstancedMesh(quad, this.cardMaterial, opts.capacity)
    this.standees.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The shader expands each quad up to `aSize` away from its instance origin,
    // which three's instanced bounding sphere knows nothing about — leave the
    // cards uncullable rather than have towns vanish at the frame edge. A couple
    // of hundred instances is not a cost worth optimising.
    this.standees.frustumCulled = false
    this.standees.count = 0

    this.discMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      // A decal lying on the terrain is coplanar with it, and depth precision
      // can't resolve that at any zoom. Bias it towards the eye so it wins
      // consistently.
      // Kept small. The offset factor scales with the polygon's depth slope, and
      // a disc tilted to a hillside and viewed at 45 degrees has a steep one —
      // anything nearer -2 biases a tilted disc far enough forward to win
      // against the card standing on it.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })

    this.discs = new THREE.InstancedMesh(makeDiscGeometry(), this.discMaterial, opts.capacity)
    this.discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.discs.frustumCulled = false
    this.discs.count = 0
    this.discs.renderOrder = 2

    this.object.add(this.discs)
    this.object.add(this.standees)
    this.object.visible = opts.showDiscs !== false
    this.discs.visible = opts.showDiscs !== false
  }

  /** Replace the whole set of cards and seat them on the given terrain. */
  set(cards: CardSpec[], frame: TerrainFrame): void {
    if (cards.length > this.capacity) {
      console.warn(
        `CardLayer: ${cards.length} cards exceeds capacity ${this.capacity}; the rest are dropped.`,
      )
    }
    this.cards = cards.slice(0, this.capacity)
    this.visible = this.cards.slice()
    this.pending = []
    // Force the next cull to re-partition against the new set.
    this.mode = 'all'
    this.frame = frame
    this.writeInstances(frame)
  }

  /**
   * Re-seat every card on the current surface.
   *
   * Cards store XZ only, so this is the whole of what a terrain rebuild costs
   * them — regenerating, eroding, or dragging the height scale all move the
   * ground out from under them and all end here.
   */
  reground(frame: TerrainFrame): void {
    this.frame = frame
    const n = this.visible.length
    for (let i = 0; i < n; i++) {
      const card = this.visible[i]
      const { dx, dz } = terrainSampleAt(frame, card.x, card.z)
      const { w, h } = this.worldSize(card)

      // A single centre sample is the right answer *because* the ground under
      // each site has been levelled to a flat pad covering the card's footprint
      // (see flattenSitePads). On unflattened ground a yaw-billboarded card's
      // bottom edge sweeps a circle and would float at one end or dig in at the
      // other, changing as you orbit.
      const centre = terrainSampleAt(frame, card.x, card.z).height
      // A site at the waterline should stand on the sea, not under it.
      const ground = Math.max(centre, frame.seaLevel * frame.heightScale)
      // Bury a sliver so the card reads as planted rather than balanced on top.
      const y = ground - h * SINK

      this.scratch.makeTranslation(card.x, y, card.z)
      this.standees.setMatrixAt(i, this.scratch)

      const radius = card.discRadius ?? w * 0.42
      // Surface normal from the world-space derivatives, so the disc lies flat
      // on a slope instead of hovering over it at one edge. It sits at the
      // centre sample rather than the swept minimum — the disc conforms to the
      // ground, so it wants the ground it is actually on.
      this.normal.set(-dx, 1, -dz).normalize()
      this.quat.setFromUnitVectors(UP, this.normal)
      this.position.set(card.x, centre, card.z)
      this.discScale.set(radius, 1, radius)
      this.scratch.compose(this.position, this.quat, this.discScale)
      this.discs.setMatrixAt(i, this.scratch)
    }

    this.standees.count = n
    this.discs.count = n
    this.standees.instanceMatrix.needsUpdate = true
    this.discs.instanceMatrix.needsUpdate = true
  }

  /**
   * Everything one instance needs: its sprite rect, size, and its seat on the
   * terrain. Shared by the bulk rebuild and the append-only fog reveal.
   */
  private writeOne(i: number, card: CardSpec, frame: TerrainFrame): void {
    const rect = this.atlas.uvRect(card.sprite, card.frame ?? 0, card.row ?? 0)
    this.uvRect.setXYZW(i, rect.x, rect.y, rect.z, rect.w)

    const { w, h } = this.worldSize(card)
    this.size.setXY(i, w, h)
    this.dim.setX(i, card.dim ?? 1)
    this.grow.setX(i, card.legibility ?? 1)
    this.colour.set(card.tint ?? 0x9aa4ae)
    this.discs.setColorAt(i, this.colour)

    const { dx, dz } = terrainSampleAt(frame, card.x, card.z)
    const centre = terrainSampleAt(frame, card.x, card.z).height
    const ground = Math.max(centre, frame.seaLevel * frame.heightScale)
    const y = ground - h * SINK

    this.scratch.makeTranslation(card.x, y, card.z)
    this.standees.setMatrixAt(i, this.scratch)

    const radius = card.discRadius ?? w * 0.42
    this.normal.set(-dx, 1, -dz).normalize()
    this.quat.setFromUnitVectors(UP, this.normal)
    this.position.set(card.x, centre, card.z)
    this.discScale.set(radius, 1, radius)
    this.scratch.compose(this.position, this.quat, this.discScale)
    this.discs.setMatrixAt(i, this.scratch)
  }

  /** Appearance and placement for the currently visible subset. */
  private writeInstances(frame: TerrainFrame): void {
    this.writeAppearance()
    this.reground(frame)
  }

  setPixelScale(scale: number): void {
    this.pixelScale = scale
    if (this.frame) this.writeInstances(this.frame)
  }

  /**
   * Tell the layer how many pixels a world unit covers at unit distance, so the
   * minimum-on-screen-size floor is in real pixels. Must be re-called on resize
   * or the floor silently drifts with the window.
   */
  setViewport(heightPx: number, fovDeg: number): void {
    this.uniforms.uPixelScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360))
  }

  /** Legibility floor for distant cards, in CSS pixels, and its growth cap. */
  setMinScreenSize(px: number, maxGrow: number): void {
    this.uniforms.uMinScreenPx.value = px
    this.uniforms.uMaxGrow.value = maxGrow
  }

  /**
   * Whether cards track the camera. Only needed when the view can be orbited;
   * with north locked they face a fixed direction instead.
   */
  setBillboard(on: boolean): void {
    this.uniforms.uBillboard.value = on ? 1 : 0
  }

  /**
   * Lean-back angle in degrees: 0 stands the cards upright, 90 lays them flat.
   *
   * Match it to the camera's pitch to show the sprites at the angle they were
   * drawn for. Precomputed here rather than in the shader — it changes once per
   * setting, not once per vertex.
   */
  setTilt(degrees: number): void {
    const t = (Math.max(0, Math.min(90, degrees)) * Math.PI) / 180
    this.uniforms.uTilt.value.set(Math.sin(t), Math.cos(t))
  }

  setDiscsVisible(on: boolean): void {
    this.discs.visible = on
  }

  setVisible(on: boolean): void {
    this.object.visible = on
  }

  /**
   * Drop every card standing in unexplored ground.
   *
   * Cards are repacked contiguously and `count` is lowered, so fogged
   * decoration is not submitted at all rather than being drawn and discarded.
   * With a few thousand props on the board that is most of the layer's cost,
   * and it is why zooming out over unexplored country stays cheap.
   *
   * Pass null to show everything.
   */
  cullByFog(explored: ((x: number, z: number) => number) | null, frame: TerrainFrame): void {
    this.frame = frame

    if (!explored) {
      if (this.mode !== 'all') {
        this.mode = 'all'
        this.visible = this.cards.slice()
        this.pending = []
        this.writeInstances(frame)
      }
      return
    }

    // Switching into fog mode, or a fresh card set: partition once.
    if (this.mode !== 'fog') {
      this.mode = 'fog'
      this.visible = []
      this.pending = []
      for (const card of this.cards) {
        if (explored(card.x, card.z) >= 0.18) this.visible.push(card)
        else this.pending.push(card)
      }
      this.writeInstances(frame)
      return
    }

    // Steady state: append only.
    //
    // Explored ground never becomes unexplored, so the visible set only ever
    // grows — which means a fog tick never has to repack the instance buffers,
    // only write the handful of cards that just came into view. With tens of
    // thousands of props on the board, repacking at 6 Hz would cost more than
    // the culling saves.
    let appended = 0
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const card = this.pending[i]
      if (explored(card.x, card.z) < 0.18) continue
      // Swap-remove: order within the buffer is irrelevant.
      this.pending[i] = this.pending[this.pending.length - 1]
      this.pending.pop()
      if (this.visible.length >= this.capacity) break
      const index = this.visible.length
      this.visible.push(card)
      this.writeOne(index, card, frame)
      appended++
    }
    if (appended === 0) return

    this.standees.count = this.visible.length
    this.discs.count = this.visible.length
    this.uvRect.needsUpdate = true
    this.size.needsUpdate = true
    this.dim.needsUpdate = true
    this.grow.needsUpdate = true
    this.standees.instanceMatrix.needsUpdate = true
    this.discs.instanceMatrix.needsUpdate = true
    if (this.discs.instanceColor) this.discs.instanceColor.needsUpdate = true
  }

  private worldSize(card: CardSpec): { w: number; h: number } {
    const px = this.atlas.pixelSize(card.sprite)
    const unit = (this.pixelScale / 16) * (card.scale ?? 1)
    return { w: px.w * unit, h: px.h * unit }
  }

  /** Everything that depends on the sprite or the scale, but not on the terrain. */
  private writeAppearance(): void {
    for (let i = 0; i < this.visible.length; i++) {
      const card = this.visible[i]
      const rect = this.atlas.uvRect(card.sprite, card.frame ?? 0, card.row ?? 0)
      this.uvRect.setXYZW(i, rect.x, rect.y, rect.z, rect.w)

      const { w, h } = this.worldSize(card)
      this.size.setXY(i, w, h)
      this.dim.setX(i, card.dim ?? 1)
      this.grow.setX(i, card.legibility ?? 1)

      this.colour.set(card.tint ?? 0x9aa4ae)
      this.discs.setColorAt(i, this.colour)
    }

    this.uvRect.needsUpdate = true
    this.size.needsUpdate = true
    this.dim.needsUpdate = true
    this.grow.needsUpdate = true
    if (this.discs.instanceColor) this.discs.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.standees.geometry.dispose()
    this.discs.geometry.dispose()
    this.cardMaterial.dispose()
    this.discMaterial.dispose()
  }
}
