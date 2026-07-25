# WorldCreator

Procedural terrain generation in the browser. TypeScript + Three.js + Vite, deployed to GitHub Pages.

**Live: https://erictams.github.io/WorldCreator/**

A seeded noise pipeline builds a finite island, hydraulic erosion carves drainage
networks into it, and everything is exposed as live controls. This is the
foundation for a game in the Populous / Magic Carpet mould — a bounded,
deformable landscape you can view from strategy altitude or from the deck.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle into dist/
npm run typecheck  # tsc --noEmit
```

Pushing to `main` builds and deploys to GitHub Pages automatically.

## How it's laid out

```
src/
  world/     the generator — pure TypeScript, imports nothing from Three.js
  render/    turns a height array into meshes
  ui/        the lil-gui control panel
```

The split matters. `world/` takes `(seed, params)` and returns a
`Float32Array` of heights; it has no idea a renderer exists. That's what lets it
run inside a Web Worker, stay testable, and makes the 3D library a swappable
detail rather than a foundation.

## The generation pipeline

Six stages, each toggleable in the panel so you can see what it contributes.

| # | Stage | What it does |
|---|-------|--------------|
| 1 | **FBM base** | Sums octaves of simplex noise, each at higher frequency and lower amplitude. The raw shape. |
| 2 | **Domain warp** | Offsets the sample position by a *second* noise field before evaluating the base. The cheapest way to make noise stop looking like noise — ridges bend and braid instead of running straight. |
| 3 | **Ridged mountains** | A `1 - abs(noise)` layer blended in only above a height threshold. Sharp spines at altitude, rounded lowlands. |
| 4 | **Redistribution** | `h = pow(h, k)`. Above 1 flattens valleys and sharpens peaks; below 1 does the reverse. |
| 5 | **Island mask** | Radial falloff from the map centre, so the land descends into water at the edges. |
| 5b | **Normalise** | Rescales the result to fill `[0, 1]`. Without it the peak lands wherever the noise happens to put it (~0.75 after masking), the top of the colour ramp is unreachable, and the erosion constants shift meaning whenever you change an octave count. |
| 6 | **Hydraulic erosion** | Droplet simulation — see below. |

Same seed always produces the same island, erosion included.

### Hydraulic erosion

Particle-based (the Beyer / Lague droplet model). Droplets spawn on land, roll
downhill, pick up sediment where they move fast down steep slopes, and drop it
where they slow down or run uphill. What emerges is drainage: valleys that
branch, join and reach the sea. Layered noise alone will never give you that.

Two things worth knowing if you tune it:

- **Droplets spawn on land only.** Spawning uniformly across the map wastes most
  of them on the flat sea floor outside the island mask, where the gradient is
  zero and they die on their first step.
- **The rate constants are scaled down from the published defaults.** Heights are
  normalised across the whole map, so one cell step on a steep mountainside is
  only ~0.015. The usual `erodeSpeed: 0.3` assumes far more relief per cell and
  here it levels every slope flat within a few steps.

Erosion always runs against the *un-eroded* heights, so repeated runs with
different settings are comparable and **Revert** always has somewhere to go back
to.

## Performance

At 512² (524k triangles): generation ~105 ms, erosion ~0.4 s for 80k droplets.
Both run in a Web Worker, so the camera stays interactive throughout. Noise
parameters regenerate live as you drag; erosion is an explicit button because
it's three orders of magnitude slower.

The map defaults to 256² so the tweak loop stays under a frame. 512² looks
considerably better once you've stopped fiddling — the drainage networks only
really read as dendritic at that resolution.

## Implementation notes

**Tiled meshing.** The terrain is built as a grid of 64-cell tiles rather than
one geometry. This buys nothing visually — it exists so terrain sculpting can
later rebuild only the tiles a brush touched instead of respecifying half a
million vertices per mouse-move. `TerrainMesh.refresh()` already takes a dirty
rectangle for exactly this.

**Normals are computed by central difference against the global height array,
not by `computeVertexNormals()`.** Per-tile normal computation only sees the
faces inside that tile, so every vertex on a tile border would derive its normal
from half its true neighbourhood and the seams would show as hard creases under
raking light. Sampling the shared array means two tiles that meet compute
bit-identical normals for their shared vertices.

**The ocean floor is a separate plane.** The island mask drives the terrain's
border down to height 0, so without it the terrain's square edge is plainly
visible: inside it the translucent water composites over dark seabed, outside it
over bright sky. The plane continues the seabed to the horizon at the same depth
and colour.

**Dev console handle.** In development, `window.__world` exposes
`{ params, regenerate, erode, revert, heights, gui }` for tuning without
round-tripping through the panel:

```js
__world.params.erosion.erodeSpeed = 0.02
__world.gui.refreshDisplay()
__world.erode()
```

## Known rough edges

- Erosion deposits bilinearly into 4 cells while eroding through a radius-3
  brush. That asymmetry leaves faint cell-scale stippling on some slopes,
  visible when you zoom right in. Depositing through a small kernel would fix it
  at the cost of retuning.
- No shadows. Doing them well over terrain this size needs cascaded shadow maps.
- Changing map size or cell size rebuilds every tile, which briefly hitches at
  1024².

## Not built yet

Terrain sculpting brushes, prop and model decoration via instanced meshes,
biomes beyond the colour ramp, rivers and lakes as real water bodies, LOD, and
anything resembling gameplay. The tiled meshing and the Three-free `world/`
module are the two structural choices that keep those cheap to add.
