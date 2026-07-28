import * as THREE from 'three'
import type { Heightmap } from '../world/heightmap'
import { BIOMES, sampleBiomeAt } from '../world/biome'
import type { BiomeField } from '../world/biome'
import { BiomeTexture } from './biomeTexture'
import { writeTerrainColor } from './colorRamp'
import { shelfHeight } from '../world/terrainQuery'
import {
  createTerrainMaterial,
  type DetailSettings,
  type GroundSettings,
  type TerrainMaterial,
  type WaterSettings,
} from './terrainMaterial'

export interface TerrainMeshOptions {
  cellSize: number
  heightScale: number
  seaLevel: number
  /** Normalised height of the coastal step. See `shelfHeight`. */
  shelfRise: number
  /** Normalised height either side of the waterline over which it eases out. */
  shelfBand: number
  /** Cells per tile edge. */
  tileSize: number
  wireframe: boolean
  /** From renderer.capabilities.getMaxAnisotropy(). */
  maxAnisotropy?: number
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
  private surface: TerrainMaterial
  private material: THREE.MeshStandardMaterial
  private opts: TerrainMeshOptions
  private hm: Heightmap | null = null
  /** Null paints every band from the default palette — biomes switched off. */
  private biomeField: BiomeField | null = null
  private biomeMap = new BiomeTexture()

  /** Must be set before `build`; it is read per vertex while filling tiles. */
  setBiomeField(field: BiomeField | null): void {
    this.biomeField = field
  }

  constructor(opts: TerrainMeshOptions) {
    this.opts = { ...opts }
    this.surface = createTerrainMaterial(opts.maxAnisotropy ?? 1)
    this.material = this.surface.material
    this.material.wireframe = opts.wireframe
  }

  setDetail(d: DetailSettings): void {
    this.surface.setDetail(d)
  }

  setSaturation(v: number): void {
    this.surface.setSaturation(v)
  }

  setGround(g: GroundSettings): void {
    this.surface.setGround(g)
  }

  setWater(w: WaterSettings): void {
    this.surface.setWater(w)
  }

  setFog(texture: THREE.Texture | null, worldSize: number, enabled: boolean): void {
    this.surface.setFog(texture, worldSize, enabled)
  }

  /**
   * Hide tiles nothing has explored.
   *
   * The fragment shader already discards fogged ground, but a discarded
   * fragment still costs a vertex transform and a texture fetch to reach. At
   * 256 tiles over a 2 km island, dropping the ones that are entirely unseen is
   * the difference between paying for the whole map and paying for the part you
   * have walked. `coverage` returns the brightest explored value in a tile's
   * world-space footprint.
   */
  cullByFog(coverage: ((x0: number, z0: number, x1: number, z1: number) => number) | null): void {
    const { cellSize } = this.opts
    const half = this.hm ? ((this.hm.size - 1) * cellSize) / 2 : 0
    for (const tile of this.tiles) {
      if (!coverage) {
        tile.mesh.visible = true
        continue
      }
      const x0 = tile.x0 * cellSize - half
      const x1 = tile.x1 * cellSize - half
      const z0 = tile.z0 * cellSize - half
      const z1 = tile.z1 * cellSize - half
      tile.mesh.visible = coverage(x0, z0, x1, z1) >= 0.18
    }
  }

  /** Visible tiles over total, for the status bar. */
  get visibleTiles(): { shown: number; total: number } {
    let shown = 0
    for (const t of this.tiles) if (t.mesh.visible) shown++
    return { shown, total: this.tiles.length }
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
    // The fragment shader needs the waterline in world units to know not to lay
    // a territory's ground tiles on the seabed. Vertex Y is `h * heightScale`,
    // so the waterline is the sea level on that same scale.
    this.surface.setSeaY(this.opts.seaLevel * this.opts.heightScale)
    this.hm = hm

    this.disposeTiles()

    const cells = hm.size - 1
    // Re-bake which tileset floors each point. Here rather than in `refresh`,
    // because it depends on the biome field and the world extent, and erosion
    // moves neither.
    const worldSize = cells * this.opts.cellSize
    this.surface.setBiomeMap(this.biomeMap.update(this.biomeField, worldSize), worldSize)
    // Scale the tile with the grid so the tile count — and therefore the draw
    // call count — stays near 16×16 whatever the resolution. A fixed 64-cell
    // tile would mean 1024 draw calls once amplification reaches 2048².
    const target = Math.max(32, Math.min(256, Math.round(cells / 16)))
    const tileSize = Math.max(8, Math.min(target, cells))
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
    const { cellSize, heightScale, seaLevel, shelfRise, shelfBand } = this.opts
    // The coastal step, applied to every sample this tile reads — the vertex it
    // is placing and the four neighbours its normal is derived from — so that
    // the surface and its lighting are describing the same shape.
    const shelf = (h: number): number => shelfHeight(h, seaLevel, shelfRise, shelfBand)
    const field = this.biomeField
    const cells = hm.size - 1
    const vx = tile.x1 - tile.x0 + 1
    const vz = tile.z1 - tile.z0 + 1
    const vertexCount = vx * vz

    const positions = new Float32Array(vertexCount * 3)
    const normals = new Float32Array(vertexCount * 3)
    const colors = new Float32Array(vertexCount * 3)
    const uvs = new Float32Array(vertexCount * 2)
    /**
     * Water depth from the terrain's own height, before the shelf moved it.
     *
     * The shader could subtract the vertex's Y from the waterline and save an
     * attribute, and did — but the shelf steps the ground *over* sea level
     * rather than through it, so no vertex sits at the waterline any more and
     * the crossing lands halfway between the two that straddle it. The coast
     * then snapped to the middle of every cell: a hard 8-metre staircase, worst
     * on exactly the flat shores the shelf exists to give an edge to.
     *
     * So the shape of the coast and the shape of the ground come from different
     * numbers. Geometry gets the shelf, and the waterline is drawn from the
     * unshelved field, where it sits wherever the terrain actually crosses sea
     * level — smooth, and finer than a cell. What that costs is water climbing
     * the first metre or two of the bank, which is what water does.
     */
    const seaDepths = new Float32Array(vertexCount)

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
        positions[p + 1] = shelf(h) * heightScale
        positions[p + 2] = gz * cellSize - halfZ
        seaDepths[p / 3] = (seaLevel - h) * heightScale

        // Normals by central difference against the GLOBAL height array, not
        // from this tile's triangles. computeVertexNormals() would average
        // only the faces present in this geometry, so every vertex on a tile
        // border would get a normal derived from half its true neighbourhood
        // and the seams would show as hard creases under raking light. Reading
        // the shared array means two tiles that meet compute bit-identical
        // normals for their shared vertices.
        const hL = shelf(hm.getClamped(gx - 1, gz))
        const hR = shelf(hm.getClamped(gx + 1, gz))
        const hD = shelf(hm.getClamped(gx, gz - 1))
        const hU = shelf(hm.getClamped(gx, gz + 1))

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

        if (field) {
          // Sampled per vertex from world XZ, so territory borders follow the
          // warped bisector rather than the mesh tiling.
          //
          // Colours only. Which *tileset* floors a point is no longer a vertex
          // quantity at all — it is an index, and indices cannot be interpolated
          // between vertices without naming tilesets that neither vertex holds.
          // That now lives in `biomeTexture.ts`, sampled per fragment.
          const s = sampleBiomeAt(field, positions[p], positions[p + 2])
          writeTerrainColor(colors, p, BIOMES[s.a].ramp, s.t > 0 ? BIOMES[s.b].ramp : null, s.t)
        } else {
          writeTerrainColor(colors, p)
        }

        uvs[uvi] = gx / cells
        uvs[uvi + 1] = gz / cells

        p += 3
        uvi += 2
      }
    }

    // Two triangles per cell, wound counter-clockwise seen from +Y so the
    // upward face is the front face. Split along the b–c diagonal, which
    // `terrainDrawnHeightAt` mirrors so that decals lying on the ground sample
    // the surface this actually draws — change one and change the other.
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
    geo.setAttribute('aSeaDepth', new THREE.BufferAttribute(seaDepths, 1))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
    // The vertex shader lifts submerged vertices up to the waterline, and
    // bounds computed from the positions on the CPU know nothing about it. A
    // tile lying entirely on the seabed would otherwise be frustum-culled while
    // the sea it draws is still on screen.
    const lift = seaLevel * heightScale
    geo.boundingSphere!.radius += lift
    geo.boundingBox!.max.y = Math.max(geo.boundingBox!.max.y, lift)
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
    this.biomeMap.dispose()
    this.surface.dispose()
  }
}
