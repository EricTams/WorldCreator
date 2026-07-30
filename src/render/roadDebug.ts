import * as THREE from 'three'
import type { RoadNetwork } from '../world/roads'
import { terrainDrawnHeightAt } from '../world/terrainQuery'
import type { TerrainFrame } from '../world/terrainQuery'

/**
 * The road network as the router meant it, drawn over everything.
 *
 * This exists because the drawn road is deliberately not the whole story. A
 * route is paved only where it cuts through vegetation, so most of what the
 * router decided is invisible by design — and that makes the two questions you
 * actually want to ask indistinguishable on the ground:
 *
 *   "there is no road between these two places" — because no route was found,
 *   or because the route ran through open field and correctly paved nothing?
 *
 *   "this road stops here" — because the wood stops here, or because the
 *   minimum-run filter ate the next stretch?
 *
 * So this draws the intended thing beside the drawn thing, colour-coded:
 *
 *   red        routed and not paved. Should sit over bare ground.
 *   pale red   routed and paved. Should sit exactly under drawn road.
 *   yellow     a link whose two ends the terrain could not connect at all.
 *   white      a cross at each place being linked.
 *
 * Depth testing is off and the render order is last, so the lines are legible
 * through hills and through the road they are describing — which is the point.
 * It is a debug instrument, so it also ignores fog: it shows the whole network
 * at once, including the parts the player has not found.
 */

/** Clearance above the surface. Larger than the road's, so it reads as over it. */
const LIFT = 0.6

/** Marker half-size at a linked place, in world units. */
const NODE_MARK = 4

/**
 * Red, and bright.
 *
 * The first pass used green for paved and amber for unpaved, which is the
 * obvious semantic choice and was nearly invisible: this map is green grass and
 * tan roads, so both lines landed on top of something their own colour and hue.
 * A debug overlay's only real job is to be unmissable, so the palette is picked
 * against the *board* rather than for its own internal logic — red is the one
 * hue the island never uses.
 *
 * The paved/unpaved split survives as lightness rather than hue, so both stay
 * red and both stay bright. Failures move to yellow: they are rare and want to
 * stand out from the red rather than blend into it.
 */
const UNPAVED = new THREE.Color(0xff1a1a)
const PAVED = new THREE.Color(0xff9a9a)
const FAILED = new THREE.Color(0xffe000)
const NODE = new THREE.Color(0xffffff)

/** Glyphs in the atlas, in order. Digits index themselves; `.` and `-` follow. */
const GLYPHS = '0123456789.-'
/** Atlas cell, in pixels. */
const GLYPH_PX = 32

/**
 * World height of a drawn glyph, and the advance between them.
 *
 * Three glyphs come to 4.7 units against tiles 5 apart, so consecutive labels
 * sit shoulder to shoulder without overlapping.
 */
const GLYPH_H = 2.6
const GLYPH_W = GLYPH_H * 0.6

/**
 * Billboarded, not laid flat on the ground.
 *
 * Flat was the first attempt and is unreadable: the camera looks at the ground
 * at a shallow angle, so ground-plane text is foreshortened into ellipses — the
 * digits came out as red ovals with no legible shape at all. Offsetting the
 * corners in *view* space instead keeps every label square-on to the camera and
 * the same world size at any angle, which is the only orientation a number is
 * any use in.
 */
const LABEL_VERTEX = /* glsl */ `
attribute vec2 offset;
varying vec2 vUv;
varying vec3 vColor;

void main() {
  vUv = uv;
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xy += offset;
  gl_Position = projectionMatrix * mv;
}
`

const LABEL_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vColor;

void main() {
  vec4 texel = texture2D(uMap, vUv);
  if (texel.a < 0.35) discard;
  // The sheet is a white glyph with a black rim. Tint the white and leave the
  // rim alone, so the outline still separates the number from whatever it is
  // standing on.
  gl_FragColor = vec4(mix(vec3(0.0), vColor, texel.r), texel.a);
  #include <colorspace_fragment>
}
`

/**
 * A digit sheet, drawn at load into a canvas.
 *
 * Generated rather than shipped for the same reason the detail texture is: the
 * page stays self-contained, with no font to load and nothing to 404. It is
 * also the only text this renderer draws — everything else the player reads is
 * DOM — and one label per road tile is far too many for DOM nodes.
 */
function makeGlyphTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = GLYPH_PX * GLYPHS.length
  canvas.height = GLYPH_PX
  const ctx = canvas.getContext('2d')!
  ctx.font = `bold ${GLYPH_PX - 8}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Black rim under white fill. The overlay is read against grass, sand, snow
  // and basalt, and no single ink colour survives all four — an outline does.
  ctx.lineWidth = 5
  ctx.strokeStyle = '#000'
  ctx.fillStyle = '#fff'
  for (let i = 0; i < GLYPHS.length; i++) {
    const cx = i * GLYPH_PX + GLYPH_PX / 2
    ctx.strokeText(GLYPHS[i], cx, GLYPH_PX / 2)
    ctx.fillText(GLYPHS[i], cx, GLYPH_PX / 2)
  }
  const tex = new THREE.CanvasTexture(canvas)
  // Unflipped, matching the sprite and road sheets: v runs down the image, so
  // the rects above are in canvas coordinates. Left at the default the glyphs
  // upload upside down and every number reads mirrored top to bottom.
  tex.flipY = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export class RoadDebugLayer {
  readonly object: THREE.Group
  private lines: THREE.LineSegments
  private labels: THREE.Mesh
  private geometry = new THREE.BufferGeometry()
  private labelGeometry = new THREE.BufferGeometry()
  private material: THREE.LineBasicMaterial
  private labelMaterial: THREE.ShaderMaterial
  private glyphs: THREE.CanvasTexture

  constructor() {
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      // The three properties that make this an overlay rather than geometry.
      // Without `depthTest: false` the lines are buried by the very road they
      // are meant to be compared against, which is the one view that makes the
      // overlay useless.
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    })
    this.lines = new THREE.LineSegments(this.geometry, this.material)
    this.lines.frustumCulled = false
    this.lines.renderOrder = 999

    this.glyphs = makeGlyphTexture()
    this.labelMaterial = new THREE.ShaderMaterial({
      vertexShader: LABEL_VERTEX,
      fragmentShader: LABEL_FRAGMENT,
      uniforms: { uMap: { value: this.glyphs } },
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.labels = new THREE.Mesh(this.labelGeometry, this.labelMaterial)
    this.labels.frustumCulled = false
    // Above the lines, so a number is never half-hidden by the route it labels.
    this.labels.renderOrder = 1000

    this.object = new THREE.Group()
    this.object.add(this.lines)
    this.object.add(this.labels)
    this.object.visible = false
  }

  /**
   * Rebuild for a network. Null, or the layer switched off, clears it.
   *
   * Rebuilt with the roads themselves, on the same terrain, so the lines cannot
   * describe a network that is no longer the one on screen.
   */
  build(net: RoadNetwork | null, frame: TerrainFrame, enabled: boolean): void {
    this.geometry.dispose()
    this.geometry = new THREE.BufferGeometry()
    this.lines.geometry = this.geometry
    this.labelGeometry.dispose()
    this.labelGeometry = new THREE.BufferGeometry()
    this.labels.geometry = this.labelGeometry

    if (!net || !enabled) {
      this.object.visible = false
      return
    }

    const positions: number[] = []
    const colors: number[] = []

    const push = (
      x0: number,
      z0: number,
      x1: number,
      z1: number,
      c: THREE.Color,
    ): void => {
      positions.push(
        x0,
        terrainDrawnHeightAt(frame, x0, z0) + LIFT,
        z0,
        x1,
        terrainDrawnHeightAt(frame, x1, z1) + LIFT,
        z1,
      )
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }

    for (const r of net.routes) {
      if (r.points.length === 0) {
        // Nothing was routable. Draw the link as the crow would have flown, so
        // the failure is visible as a straight line between two places rather
        // than as an absence you have to notice.
        push(r.from.x, r.from.z, r.to.x, r.to.z, FAILED)
        continue
      }
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1]
        const b = r.points[i]
        // A segment counts as paved when both its ends are. The alternative —
        // either end — paints the first bare cell past a treeline green and
        // makes every cut look one segment longer than it is.
        push(a.x, a.z, b.x, b.z, r.paved[i - 1] && r.paved[i] ? PAVED : UNPAVED)
      }
    }

    // A cross at each linked place. Drawn after the routes so it sits on top
    // where several links meet, which is exactly where you want to see it.
    const seen = new Set<string>()
    for (const r of net.routes) {
      for (const p of [r.from, r.to]) {
        const key = `${Math.round(p.x)}:${Math.round(p.z)}`
        if (seen.has(key)) continue
        seen.add(key)
        push(p.x - NODE_MARK, p.z, p.x + NODE_MARK, p.z, NODE)
        push(p.x, p.z - NODE_MARK, p.x, p.z + NODE_MARK, NODE)
      }
    }

    if (positions.length === 0) {
      this.object.visible = false
      return
    }

    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    )
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    this.geometry.computeBoundingSphere()

    this.buildLabels(net, frame)
    this.object.visible = true
  }

  /**
   * A number on every routed tile: how much vegetation is there, as a multiple
   * of how much it takes to pave. 1.0 is exactly the bar.
   *
   * This is the number the cut rule decides on, printed where it was decided,
   * so the road and its reason can be read together. Where the two disagree the
   * disagreement is the interesting part — a tile scoring 0.4 that is paved
   * anyway was bridged across a hole in a wood; a tile scoring 2.0 that is bare
   * was in a run too short to draw.
   *
   * Coloured by verdict rather than by value: pale red where the tile was
   * paved, bright red where it was not, matching the route line under it.
   */
  private buildLabels(net: RoadNetwork, frame: TerrainFrame): void {
    // `position` is the label's anchor, repeated per corner; `offset` is the
    // corner in view-space units. The vertex shader adds the two, which is what
    // keeps the quad facing the camera. See `LABEL_VERTEX`.
    const positions: number[] = []
    const offsets: number[] = []
    const uvs: number[] = []
    const colors: number[] = []
    const index: number[] = []
    let quads = 0

    const du = 1 / GLYPHS.length

    for (const r of net.routes) {
      for (let i = 0; i < r.points.length; i++) {
        // Signed, and that matters more than it looks. Clamping at zero was
        // the first version and it hid the only thing worth knowing about a
        // road that did not happen: every cell on a bare route read "0.0"
        // whether it missed the bar by a hair or by two thresholds. A route
        // bottoming out at -0.7 is one worth reconsidering; one at -2.2 is
        // open pasture and always will be.
        const s = Math.min(9.9, Math.max(-9.9, r.score[i]))
        const text = s.toFixed(1)
        const c = r.paved[i] ? PAVED : UNPAVED
        const p = r.points[i]
        const y = terrainDrawnHeightAt(frame, p.x, p.z) + LIFT * 1.5
        const startX = -(text.length * GLYPH_W) / 2

        for (let g = 0; g < text.length; g++) {
          const gi = GLYPHS.indexOf(text[g])
          if (gi < 0) continue
          const ox0 = startX + g * GLYPH_W
          const ox1 = ox0 + GLYPH_W
          const oy0 = -GLYPH_H / 2
          const oy1 = GLYPH_H / 2
          const u0 = gi * du
          const u1 = u0 + du

          for (let k = 0; k < 4; k++) {
            positions.push(p.x, y, p.z)
            colors.push(c.r, c.g, c.b)
          }
          // Corners anticlockwise from bottom-left, with v flipped: the canvas
          // is authored top-down and read unflipped, as the other sheets are.
          offsets.push(ox0, oy0, ox1, oy0, ox1, oy1, ox0, oy1)
          uvs.push(u0, 1, u1, 1, u1, 0, u0, 0)

          const base = quads * 4
          index.push(base, base + 1, base + 2, base, base + 2, base + 3)
          quads++
        }
      }
    }

    if (quads === 0) return
    this.labelGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    )
    this.labelGeometry.setAttribute('offset', new THREE.Float32BufferAttribute(offsets, 2))
    this.labelGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    this.labelGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    this.labelGeometry.setIndex(index)
    this.labelGeometry.computeBoundingSphere()
  }

  dispose(): void {
    this.geometry.dispose()
    this.labelGeometry.dispose()
    this.material.dispose()
    this.labelMaterial.dispose()
    this.glyphs.dispose()
  }
}
