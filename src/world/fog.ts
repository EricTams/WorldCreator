/**
 * Fog of war, as a visibility grid over the world.
 *
 * Unexplored ground is not drawn at all rather than dimmed. That is a gameplay
 * decision first — a map you have to walk to learn is the point — but it also
 * makes the fog the cheapest culling the renderer has: terrain tiles wholly
 * inside the fog are skipped, and every decoration in them stops being
 * submitted. Zooming out over an unexplored island costs almost nothing,
 * because almost nothing is there yet.
 *
 * Pure TypeScript, no three.js.
 */

/** Bytes per cell: R = ever explored, G = currently visible. */
const CHANNELS = 2

export interface FogParams {
  enabled: boolean
  /** Draw everything regardless — debug, and it must not erase progress. */
  revealAll: boolean
  /** Sight radius in world units at ground level. */
  sightRadius: number
  /** Extra sight as a fraction of radius when flying high. */
  elevationBonus: number
  /** Radius a friendly settlement keeps permanently revealed. */
  siteRadius: number
  /** Reveal repaints per second. */
  updateHz: number
}

export class FogGrid {
  /** Cells per side. Fixed, so changing map size never reallocates. */
  readonly size = 128
  readonly data: Uint8Array
  /** Bumped whenever the data changed, so the texture upload can be lazy. */
  version = 0

  private worldSize = 2048

  constructor() {
    this.data = new Uint8Array(this.size * this.size * CHANNELS)
  }

  setWorld(worldSize: number): void {
    this.worldSize = Math.max(1, worldSize)
  }

  /** Forget everything. Called when a genuinely new world is generated. */
  reset(): void {
    this.data.fill(0)
    this.version++
  }

  /** Everything explored. Used by the reveal-all debug toggle's "bake" path. */
  revealEverything(): void {
    this.data.fill(255)
    this.version++
  }

  /** Clear only the currently-visible channel, before repainting it. */
  beginTick(): void {
    const d = this.data
    for (let i = 1; i < d.length; i += CHANNELS) d[i] = 0
  }

  /**
   * Paint a sight circle.
   *
   * `permanent` writes only the explored channel, for things that reveal a
   * region once — a settlement's surroundings stay on the map after you leave.
   */
  reveal(x: number, z: number, radius: number, permanent = false): void {
    if (radius <= 0) return
    const n = this.size
    const cell = this.worldSize / n
    const half = this.worldSize / 2

    const cx = (x + half) / cell
    const cz = (z + half) / cell
    const r = radius / cell
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(n - 1, Math.ceil(cx + r))
    const z0 = Math.max(0, Math.floor(cz - r))
    const z1 = Math.min(n - 1, Math.ceil(cz + r))
    if (x0 > x1 || z0 > z1) return

    const d = this.data
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx + 0.5 - cx
        const dz = gz + 0.5 - cz
        const t = Math.sqrt(dx * dx + dz * dz) / r
        if (t >= 1) continue
        // Full strength across most of the disc, easing only at the rim, so the
        // edge is soft without the middle of your own sight being murky.
        const f = t <= 0.72 ? 1 : 1 - (t - 0.72) / 0.28
        const v = Math.round(f * 255)
        const i = (gz * n + gx) * CHANNELS
        if (v > d[i]) d[i] = v
        if (!permanent && v > d[i + 1]) d[i + 1] = v
      }
    }
    this.version++
  }

  /** Bilinear explored value at a world position, 0..1. Matches the shader. */
  exploredAt(x: number, z: number): number {
    const n = this.size
    const half = this.worldSize / 2
    const u = ((x + half) / this.worldSize) * n - 0.5
    const v = ((z + half) / this.worldSize) * n - 0.5
    const x0 = Math.floor(u)
    const z0 = Math.floor(v)
    const fx = u - x0
    const fz = v - z0

    const at = (gx: number, gz: number): number => {
      const cx = gx < 0 ? 0 : gx > n - 1 ? n - 1 : gx
      const cz = gz < 0 ? 0 : gz > n - 1 ? n - 1 : gz
      return this.data[(cz * n + cx) * CHANNELS] / 255
    }

    const a = at(x0, z0) * (1 - fx) + at(x0 + 1, z0) * fx
    const b = at(x0, z0 + 1) * (1 - fx) + at(x0 + 1, z0 + 1) * fx
    return a * (1 - fz) + b * fz
  }

  /**
   * Highest explored value anywhere in a world-space rectangle.
   *
   * This is what lets whole terrain tiles be skipped: if the brightest cell a
   * tile covers is still dark, nothing in that tile can be visible.
   */
  maxExploredIn(x0: number, z0: number, x1: number, z1: number): number {
    const n = this.size
    const cell = this.worldSize / n
    const half = this.worldSize / 2
    // One cell of margin, because the shader samples bilinearly and can reach
    // just past the rectangle's own cells.
    const gx0 = Math.max(0, Math.floor((x0 + half) / cell) - 1)
    const gx1 = Math.min(n - 1, Math.ceil((x1 + half) / cell) + 1)
    const gz0 = Math.max(0, Math.floor((z0 + half) / cell) - 1)
    const gz1 = Math.min(n - 1, Math.ceil((z1 + half) / cell) + 1)

    let best = 0
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const v = this.data[(gz * n + gx) * CHANNELS]
        if (v > best) best = v
      }
    }
    return best / 255
  }

  /** Fraction of the grid explored, for the status bar. */
  exploredFraction(): number {
    const d = this.data
    let seen = 0
    for (let i = 0; i < d.length; i += CHANNELS) if (d[i] > 127) seen++
    return seen / (this.size * this.size)
  }
}
