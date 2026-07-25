/**
 * A square grid of normalised heights.
 *
 * Deliberately a thin view over a Float32Array rather than a data structure
 * that owns its storage, so the buffer can be transferred across the worker
 * boundary and re-wrapped on the other side without a copy.
 */
export class Heightmap {
  /** Vertices per side. */
  readonly size: number
  readonly data: Float32Array

  constructor(size: number, data?: Float32Array) {
    this.size = size
    this.data = data ?? new Float32Array(size * size)
    if (this.data.length !== size * size) {
      throw new Error(`Heightmap: expected ${size * size} values, got ${this.data.length}`)
    }
  }

  index(x: number, z: number): number {
    return z * this.size + x
  }

  get(x: number, z: number): number {
    return this.data[z * this.size + x]
  }

  set(x: number, z: number, v: number): void {
    this.data[z * this.size + x] = v
  }

  /** Edge-clamped read. Used by normal calculation at the map border. */
  getClamped(x: number, z: number): number {
    const s = this.size
    const cx = x < 0 ? 0 : x >= s ? s - 1 : x
    const cz = z < 0 ? 0 : z >= s ? s - 1 : z
    return this.data[cz * s + cx]
  }

  clone(): Heightmap {
    return new Heightmap(this.size, this.data.slice())
  }

  minMax(): { min: number; max: number } {
    let min = Infinity
    let max = -Infinity
    const d = this.data
    for (let i = 0; i < d.length; i++) {
      if (d[i] < min) min = d[i]
      if (d[i] > max) max = d[i]
    }
    return { min, max }
  }
}

/**
 * Bilinearly interpolated height and gradient at floating-point grid
 * coordinates. The caller must guarantee 0 <= x < size-1 and 0 <= z < size-1,
 * because this reads the cell at (floor(x)+1, floor(z)+1) without bounds
 * checks — the droplet loop runs this millions of times, so the check lives
 * at the call site instead.
 */
export function sampleHeightAndGradient(
  data: Float32Array,
  size: number,
  x: number,
  z: number,
): { height: number; gradX: number; gradZ: number } {
  const cx = x | 0
  const cz = z | 0
  const fx = x - cx
  const fz = z - cz

  const i = cz * size + cx
  const hNW = data[i]
  const hNE = data[i + 1]
  const hSW = data[i + size]
  const hSE = data[i + size + 1]

  const gradX = (hNE - hNW) * (1 - fz) + (hSE - hSW) * fz
  const gradZ = (hSW - hNW) * (1 - fx) + (hSE - hNE) * fx

  const height =
    hNW * (1 - fx) * (1 - fz) +
    hNE * fx * (1 - fz) +
    hSW * (1 - fx) * fz +
    hSE * fx * fz

  return { height, gradX, gradZ }
}
