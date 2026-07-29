import type { FogGrid, FogParams } from '../world/fog'

/**
 * Drives the fog grid from what the player can currently see.
 *
 * Repainting is throttled and gated on movement rather than run every frame:
 * the grid is 16 metres per cell, so at 17 m/s the avatar covers a fifth of a
 * cell between ticks and the reveal edge is already smoother than the grid can
 * represent. Repainting harder would cost the same and show nothing.
 */
export class FogOfWar {
  private acc = 0
  private lastX = Number.NaN
  private lastZ = Number.NaN

  constructor(private grid: FogGrid) {}

  /** Force a repaint on the next tick, e.g. after a teleport or a reveal-all. */
  invalidate(): void {
    this.lastX = Number.NaN
    this.lastZ = Number.NaN
    this.acc = Infinity
  }

  /**
   * @param altitude height above sea level, for the flying sight bonus.
   * @param sites world positions that keep a permanent radius revealed. Each
   *        may name its own `radius`; without one it gets `p.siteRadius`. A
   *        held Observatory reveals far more ground than a town does, and that
   *        difference is the whole of what the monument is.
   * @returns whether the grid changed, so the caller can skip re-culling.
   */
  update(
    dt: number,
    p: FogParams,
    x: number,
    z: number,
    altitude: number,
    heightScale: number,
    sites: readonly { x: number; z: number; radius?: number }[],
  ): boolean {
    if (!p.enabled) return false

    this.acc += dt
    const moved = Math.hypot(x - this.lastX, z - this.lastZ)
    // Half a fog cell of movement, or the throttle expiring — whichever first.
    if (this.acc < 1 / Math.max(1, p.updateHz) && !(moved > 8)) return false
    this.acc = 0
    this.lastX = x
    this.lastZ = z

    // Height above the sea earns extra sight, so flying is scouting rather than
    // just fast travel.
    const alt = Math.max(0, Math.min(1, altitude / Math.max(1, heightScale * 0.6)))
    const radius = p.sightRadius * (1 + p.elevationBonus * alt)

    this.grid.beginTick()
    this.grid.reveal(x, z, radius)
    // Settlements you own stay on the map once found.
    for (const s of sites) this.grid.reveal(s.x, s.z, s.radius ?? p.siteRadius, true)
    return true
  }
}
