# WorldCreator

Procedural terrain generation in the browser. TypeScript + Three.js + Vite, deployed to GitHub Pages.

**Live: https://erictams.github.io/WorldCreator/**

A seeded noise pipeline builds a finite island, hydraulic erosion carves drainage
networks into it, and everything is exposed as live controls. This is the
foundation for a game in the Populous / Magic Carpet mould — a bounded,
deformable landscape you can view from strategy altitude or from the deck.

## Controls

| Key | Action |
|-----|--------|
| **W A S D** | Move the avatar **north / west / south / east** |
| **Space / Shift** | Ascend / descend (fly mode only) |
| Mouse drag | Orbit · scroll to zoom |

Movement is in **fixed world directions, not relative to the camera** — W is
always north however you've orbited the view. That keeps the map's geography
stable in your head: a place stays north-east of another place whichever way
you happen to be looking, which is how the strategy games this is aiming at
behave. North is `-Z`, east is `+X`, and the corner compass shows where north
has gone after you orbit.

The avatar carries a marker pole so you can find it from strategy altitude; it
hides itself automatically once the camera is close enough to see the body.

It rides a carpet at a hover height of **4 body heights**. That's deliberately
expressed in multiples of the avatar's own height rather than world units, so
rescaling the avatar carries the ride height with it in proportion instead of
silently leaving it at the wrong altitude. The carpet conforms to the ground
slope when it's near the ground and levels off as it lifts clear — a carpet
hovering well above a hillside while still tilted to match it looks tethered to
terrain it isn't touching.

### Scale and speed

The island is **2 km across** (256 cells × 8 units, reading 1 unit as 1 m) and
top speed is **17 m/s**, so crossing it takes **two minutes**. The status bar
shows that figure live, since the whole world scale was derived from it rather
than picked.

The scale follows from the traversal target, not the other way round. At the
earlier 512-unit size, two minutes meant 4.3 m/s — under one body-length per
second for a 5 m avatar, which is a crawl no matter how close the camera sits.
Speed *perception* comes from how fast the ground crosses the frame, and the
follow distance is what supplies it — the visible ground is roughly the orbit
distance across, so top speed crosses a frame in a couple of seconds. But
optical flow can't rescue a hundred-body-length island; the world itself had
to grow.

Relief is `heightScale` over world width: 101 / 2048 is just under 5%, a ~100 m
high point on a 2 km island. Sea level is normalised and scales with it, so
changing the height never moves the coastline.

### Following the avatar

The app opens in a close third-person view. The camera does **not** orbit the
avatar directly — it orbits a damped pivot that chases it. Locked rigidly, the
avatar sits nailed to the centre of the screen and movement reads as the world
sliding past a tripod; with a little lag the avatar pulls ahead when it starts
moving and settles back when it stops, which is what reads as motion.

`follow lag` is the catch-up time constant, and `max trail` caps how far the
pivot may ever fall behind. The cap matters: an exponential chase alone settles
at `speed × lag` behind, which at a sprint walks the avatar off the edge of the
frame. Measured with the defaults, the avatar stays within ±0.29 of frame centre
in all four directions.

Lateral movement is the binding case when tuning: heading north mostly adds
depth, but strafing turns trail directly into screen offset.

### Camera auto-recentre

After **2.5 s without rotating**, the camera eases back to a resting
orientation: north up, pitched 45° below horizontal. The compass ring lights up
while this is happening, so the view moving on its own reads as a feature rather
than a bug.

Only *rotation* restarts the countdown. Zooming changes the orbit radius and
panning changes the pivot — neither touches the orbit angles, so neither
interrupts the settle. Holding a drag also suppresses it, so the camera never
rotates out from under a pan in progress.

Delay, resting pitch, settle speed, and an on/off switch are under *Camera*.

With `restore distance` on, the settle also eases the orbit distance back — but
**only in the follow framing**. Applying it to every view drags the camera out
of the whole-map overview and into the hillside two seconds after load, which is
exactly what an early version did. The overview presets deliberately clear the
resting distance, so pulling back to look at the whole map is never undone.

Worth knowing: the resting pitch is global, so it wins over the view presets a
couple of seconds after you click one. The presets are all north-up already so
there's no jarring swing, but *Magic Carpet view* starts at 12° and will drift
up to 45°. If you want a preset's pitch to stick, either turn auto-recentre off
or set the resting pitch to match.

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
  game/      avatar and input
  ui/        the lil-gui control panel and compass
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
| 7 | **Detail amplification** | Subdivide and synthesise fine structure — see below. |

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

## Tuning the relief

Relief is really the **ratio of `heightScale` to the map's world width**
(`mapSize × cellSize`), not `heightScale` on its own. The defaults give
`42 / (256 × 2)` ≈ **8%** — clearly hilly, but you can cross a valley without
scaling a wall.

The original defaults were `60 / (256 × 1)` ≈ 23%, which looks dramatic from
orbit and is miserable to actually move through. If you want the drama back,
raise **height scale** or lower **cell size** under *Look*; `redistribution`
and ridge `strength` under *Shape* and *Ridged mountains* control how spiky
rather than how tall.

## Detail amplification

Erosion runs at the simulation grid; amplification then subdivides the result
and synthesises the fine structure the simulation never had.

The point is cost. Erosion at 2048² would take tens of seconds, and its features
— drainage networks, valley floors, sediment fans — are large-scale anyway, so
almost all of that time buys nothing you can see. Measured, from a 256²
simulation grid:

| Levels | Render grid | Triangles | Erode | Amplify | Frame rate |
|---|---|---|---|---|---|
| 0 | 256² | 131k | 0.20 s | — | 120 fps |
| 2 (default) | 1024² | 2.1M | 0.20 s | **0.04 s** | 120 fps |
| 3 | 2048² | 8.4M | 0.20 s | **0.13 s** | 120 fps |

**The trade is real and worth stating: the channels stay at simulation
resolution.** What you gain is surface structure, not finer rivers. If you want
finer drainage, raise `map size` — that's what it's for.

Three things that matter in the implementation:

- **Bicubic, not bilinear.** Bilinear upsampling is only C0, so every original
  cell boundary keeps a derivative discontinuity that lights up as a visible
  crease once the surface is shaded. Catmull-Rom is C1 and leaves none.
- **One octave per level, not one broadband pass at the end.** Detail is added
  after each doubling, at that level's scale, so the levels together *are* the
  fractal. Adding it all at final resolution looks visibly wrong by comparison.
- **Slope weighting is what stops it looking like noise smeared over
  everything.** Erosion works hard to produce flat sediment plains, valley
  floors and beaches; roughening those undoes it. Steep faces take the detail,
  flats keep only `detail on flats` of it.

`ridged` ("rockiness") blends between rounded swells and sharp creases. Past
about 0.3 at high frequency it starts to look like fur rather than rock.

## Surface detail

Close-up quality comes from the material, not from geometry. The terrain mesh is
unchanged; a detail layer in the shader does the work, at no triangle cost
(~9.5 ms worst frame at ground level, and the texture builds once in ~39 ms).

**Triplanar projection.** A heightfield has no sensible UV parameterisation — a
flat XZ projection stretches into vertical streaks on every cliff face, which is
exactly where detail is most visible. Triplanar samples from all three world
axes and blends by the surface normal, so slopes get the same texel density as
flats. The blend weights are raised to the 4th power; a soft blend reads as a
muddy smear along every 45° slope.

**The detail texture is generated, not shipped** — no binary in the repo,
nothing to 404 on Pages. It tiles seamlessly because it samples *4D* simplex
noise around a torus: walking u and v once around two circles returns exactly to
the start, so the 2D slice wraps in both axes. Sampling a 2D field over a square
and hoping leaves a visible join, and blending the edges to hide it softens
exactly the fine detail the texture exists to provide.

**Two scales.** Fine grain (~9 m) reads as surface material; broad mottling
(~70 m) breaks up the flat colour bands that make untextured terrain look like
plastic. One scale alone reads as uniform fizz.

Implemented by patching `MeshStandardMaterial` through `onBeforeCompile` rather
than writing a `ShaderMaterial`, which keeps PBR lighting, fog and tone mapping
for free. Note the injected normal perturbation is built in world space but
`normal` at that point in the fragment shader is in **view** space, so it gets
rotated by `viewMatrix` before being added.

## A note on LOD

LOD removes detail at distance; it does not add any up close. Switching on a
perfect LOD system would leave the near view identical, because near tiles are
already drawn at full resolution. Its real role is to make a *higher source
resolution* affordable — so it's worth doing after detail texturing and
geometric amplification, not before.

For reference, the sketch when it's needed: stride-based per-tile LOD (a tile at
level *k* samples every 2ᵏ-th vertex from the same global array), distance
selection with hysteresis so tiles don't thrash at boundaries, neighbouring
tiles constrained to differ by at most one level, and cracks closed by welding
the finer tile's odd edge vertices onto the midpoint of their neighbours —
preferable to skirts, which are visibly wrong at exactly the grazing ground-level
angles this is meant to improve. `TerrainMesh.refresh()` already takes a dirty
rectangle, so only tiles whose level changed need rebuilding.

**Still not necessary, by a wider margin than expected.** 8.4M triangles holds
120 fps. Two things carry it: tile size scales with the grid so the draw call
count stays near 16×16 whatever the resolution, and per-tile frustum culling
means most of the map never reaches the GPU at ground level. The binding
constraint at 2048² is vertex-buffer memory (~185 MB), not fill or draw calls —
so the first real symptom on weaker hardware will be allocation failure rather
than a slow frame rate. That, not frame time, is the thing to watch for.

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

**The depth range is kept tight, and the water is polygon-offset.** At the
shoreline the water plane and the terrain surface are exactly coplanar — that is
what a shoreline *is* — so the depth comparison there is a coin flip per pixel
per frame, which shows up as flickering along the whole beach as the camera
moves. Depth precision is dominated by the near plane, and an early
`near = extent/4000` left roughly 4 cm of depth resolution at normal viewing
distance, which the beach band sits well inside. The near plane now keeps the
ratio near 1:10000 rather than 1:120000. Precision alone never fully resolves
coplanar surfaces though, so the water also carries a small negative
`polygonOffset` to make it win the tie consistently — and "water laps over the
last centimetre of beach" is the right answer visually as well as the stable one.

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
anything resembling gameplay. The avatar is a stand-in, not a character
controller — no collision volume, no slope limit, no acceleration. It samples
the heightmap and sits on it, which is enough to answer "does this landscape
feel good to move through". The tiled meshing and the Three-free `world/`
module are the two structural choices that keep those cheap to add.
