import * as THREE from 'three'
import type { Heightmap } from '../world/heightmap'
import { writeTerrainColor } from './colorRamp'

export interface TerrainMeshOptions {
  cellSize: number
  heightScale: number
  seaLevel: number
  /** Cells per tile edge. */
  tileSize: number
  wireframe: boolean
}

interface Tile {
  mesh: THREE.Mesh
  geometry: THREE.BufferGeometry
  /** Cell range covered, x0/z0 inclusive, x1/z1 exclusive. */
  x0: number
  z0: number
  x1: number
  z1: number
}

/**
 * The terrain, meshed as a grid of tiles rather than one giant geometry.
 *
 * The tiling buys nothing visually — it exists so that terrain sculpting can
 * later rebuild only the handful of tiles a brush touched instead of
 * respecifying half a million vertices per mouse-move.
 */
export class TerrainMesh {
  readonly group = new THREE.Group()
  private tiles: Tile[] = []
  private material: THREE.MeshStandardMaterial
  private opts: TerrainMeshOptions
  private hm: Heightmap | null = null

  constructor(opts: TerrainMeshOptions) {
    this.opts = { ...opts }
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      wireframe: opts.wireframe,
    })
  }

  get triangleCount(): number {
    let n = 0
    for (const t of this.tiles) {
      const idx = t.geometry.getIndex()
      if (idx) n += idx.count / 3
    }
    return n
  }

  setWireframe(on: boolean): void {
    this.opts.wireframe = on
    this.material.wireframe = on
  }

  /** Full rebuild: allocates a fresh set of tiles for a new heightmap. */
  build(hm: Heightmap, opts: Partial<TerrainMeshOptions> = {}): void {
    Object.assign(this.opts, opts)
    this.material.wireframe = this.opts.wireframe
    this.hm = hm

    this.disposeTiles()

    const cells = hm.size - 1
    const tileSize = Math.max(8, Math.min(this.opts.tileSize, cells))
    const tilesPerSide = Math.ceil(cells / tileSize)

    for (let tz = 0; tz < tilesPerSide; tz++) {
      for (let tx = 0; tx < tilesPerSide; tx++) {
        const x0 = tx * tileSize
        const z0 = tz * tileSize
        const x1 = Math.min(x0 + tileSize, cells)
        const z1 = Math.min(z0 + tileSize, cells)
        if (x1 <= x0 || z1 <= z0) continue

        const geometry = new THREE.BufferGeometry()
        const mesh = new THREE.Mesh(geometry, this.material)
        mesh.frustumCulled = true
        const tile: Tile = { mesh, geometry, x0, z0, x1, z1 }
        this.fillTile(tile, hm)
        this.tiles.push(tile)
        this.group.add(mesh)
      }
    }
  }

  /**
   * Refresh geometry from the current heightmap without reallocating tiles.
   * `dirty` limits the work to tiles overlapping a cell rectangle — the hook
   * sculpting will use. Omit it to refresh everything.
   */
  refresh(
    hm: Heightmap,
    dirty?: { x0: number; z0: number; x1: number; z1: number },
  ): void {
    this.hm = hm
    for (const tile of this.tiles) {
      if (
        dirty &&
        (tile.x1 < dirty.x0 || tile.x0 > dirty.x1 || tile.z1 < dirty.z0 || tile.z0 > dirty.z1)
      ) {
        continue
      }
      this.fillTile(tile, hm)
    }
  }

  private fillTile(tile: Tile, hm: Heightmap): void {
    const { cellSize, heightScale, seaLevel } = this.opts
    const cells = hm.size - 1
    const vx = tile.x1 - tile.x0 + 1
    const vz = tile.z1 - tile.z0 + 1
    const vertexCount = vx * vz

    const positions = new Float32Array(vertexCount * 3)
    const normals = new Float32Array(vertexCount * 3)
    const colors = new Float32Array(vertexCount * 3)
    const uvs = new Float32Array(vertexCount * 2)

    // Centre the map on the origin so camera framing and orbit targeting are
    // independent of map size.
    const halfX = (cells * cellSize) / 2
    const halfZ = (cells * cellSize) / 2
    const invTwoCell = 1 / (2 * cellSize)

    let p = 0
    let uvi = 0
    for (let lz = 0; lz < vz; lz++) {
      const gz = tile.z0 + lz
      for (let lx = 0; lx < vx; lx++) {
        const gx = tile.x0 + lx
        const h = hm.get(gx, gz)

        positions[p] = gx * cellSize - halfX
        positions[p + 1] = h * heightScale
        positions[p + 2] = gz * cellSize - halfZ

        // Normals by central difference against the GLOBAL height array, not
        // from this tile's triangles. computeVertexNormals() would average
        // only the faces present in this geometry, so every vertex on a tile
        // border would get a normal derived from half its true neighbourhood
        // and the seams would show as hard creases under raking light. Reading
        // the shared array means two tiles that meet compute bit-identical
        // normals for their shared vertices.
        const hL = hm.getClamped(gx - 1, gz)
        const hR = hm.getClamped(gx + 1, gz)
        const hD = hm.getClamped(gx, gz - 1)
        const hU = hm.getClamped(gx, gz + 1)

        const dhdx = (hR - hL) * heightScale * invTwoCell
        const dhdz = (hU - hD) * heightScale * invTwoCell

        // Surface normal of y = f(x,z) is (-df/dx, 1, -df/dz), normalised.
        const nx = -dhdx
        const ny = 1
        const nz = -dhdz
        const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz)
        normals[p] = nx * invLen
        normals[p + 1] = ny * invLen
        normals[p + 2] = nz * invLen

        writeTerrainColor(colors, p, h, 1 - ny * invLen, seaLevel)

        uvs[uvi] = gx / cells
        uvs[uvi + 1] = gz / cells

        p += 3
        uvi += 2
      }
    }

    // Two triangles per cell, wound counter-clockwise seen from +Y so the
    // upward face is the front face.
    const quadCount = (vx - 1) * (vz - 1)
    const indices =
      vertexCount > 65535
        ? new Uint32Array(quadCount * 6)
        : new Uint16Array(quadCount * 6)

    let i = 0
    for (let lz = 0; lz < vz - 1; lz++) {
      for (let lx = 0; lx < vx - 1; lx++) {
        const a = lz * vx + lx
        const b = a + 1
        const c = a + vx
        const d = c + 1
        indices[i] = a
        indices[i + 1] = c
        indices[i + 2] = b
        indices[i + 3] = b
        indices[i + 4] = c
        indices[i + 5] = d
        i += 6
      }
    }

    const geo = tile.geometry
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
  }

  /** World-space extent, for camera framing. */
  get worldSize(): number {
    if (!this.hm) return 0
    return (this.hm.size - 1) * this.opts.cellSize
  }

  private disposeTiles(): void {
    for (const t of this.tiles) {
      this.group.remove(t.mesh)
      t.geometry.dispose()
    }
    this.tiles = []
  }

  dispose(): void {
    this.disposeTiles()
    this.material.dispose()
  }
}
