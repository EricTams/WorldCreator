import * as THREE from 'three'
import { createDetailTexture } from './detailTexture'
import { createGroundTexture } from './groundTexture'
import { GROUND_TILE, GROUND_VARIANTS, GROUND_WIDTH } from '../assets/groundTiles'
import { WATER_DEEP, WATER_MID, WATER_SHALLOW, type RGB } from './colorRamp'

function linear(c: RGB): THREE.Color {
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace)
}

/**
 * Saturation restored after lighting and tone mapping.
 *
 * The source art is flat, unlit and vividly saturated — its grass is 89,193,53,
 * saturation 0.73. Run the same colour through a directional light at 2.6 plus
 * ACES, and it lands near 139,149,105 at saturation 0.30: ACES desaturates hard
 * once illumination pushes colour up its filmic curve, which is exactly what it
 * is designed to do for photographic content and exactly wrong for pixel art.
 *
 * Correcting in the ramp alone cannot work — you would have to author albedo
 * outside the gamut to land inside it. So this pulls saturation back *after*
 * tone mapping, where the loss happened.
 */
const SATURATION_PATCH = /* glsl */ `
{
  float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor.rgb = mix(vec3(lum), gl_FragColor.rgb, uSaturation);
}
`

export interface GroundSettings {
  enabled: boolean
  /** World units per repeat of the 16px biome tile. */
  scale: number
  /** How strongly the tile modulates the band colour, 0..1. */
  strength: number
  /** Fully textured within this distance, gone by `fadeFar`. */
  fadeNear: number
  fadeFar: number
  /** How much of the ground the textured alternate covers, 0..1. */
  density: number
  /** How strongly the alternate's grain shows where it is laid, 0..1. */
  baseStrength: number
  /**
   * World units either side of a territory border kept as flat fill, with no
   * textured patch laid over it.
   */
  borderSolid: number
  /** Draw the terrain as flat albedo, ignoring every light in the scene. */
  unshaded: boolean
  /** Draw the biome's actual tile texels, not a colour derived from them. */
  exact: boolean
}

export interface DetailSettings {
  enabled: boolean
  /** World units per repeat of the fine detail. */
  scale: number
  /** World units per repeat of the broad mottling. */
  macroScale: number
  normalStrength: number
  albedoStrength: number
}

export interface WaterSettings {
  enabled: boolean
  /**
   * World units of depth over which the bright coastal rim gives way to the
   * open sea's blue. Also how far the seabed shows through.
   */
  shoreBand: number
}

export interface TerrainMaterial {
  material: THREE.MeshStandardMaterial
  setDetail(d: DetailSettings): void
  setGround(g: GroundSettings): void
  /** The sea is drawn by this material; see the note above `WATER_PATCH`. */
  setWater(w: WaterSettings): void
  /** Point the terrain at the fog grid. Null or disabled draws everything. */
  setFog(texture: THREE.Texture | null, worldSize: number, enabled: boolean): void
  /** 1 leaves the tone-mapped result alone; >1 restores lost saturation. */
  setSaturation(v: number): void
  /** The waterline in world units. Below it, no territory owns the ground. */
  setSeaY(y: number): void
  /** Which tileset floors each point of the world. See `biomeTexture.ts`. */
  setBiomeMap(texture: THREE.Texture | null, worldSize: number): void
  setWireframe(on: boolean): void
  dispose(): void
}

/**
 * Shared GLSL: triplanar sampling of the detail map.
 *
 * Terrain has no sensible UV parameterisation — a flat XZ projection stretches
 * into vertical streaks on every cliff face, which is exactly where detail is
 * most visible. Triplanar projects from all three world axes and blends by the
 * surface normal, so slopes get the same texel density as flats and nothing
 * smears.
 */
const FRAGMENT_HEADER = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
/**
 * Water depth at this fragment, in world units, *before* the seabed was lifted
 * to the waterline — positive under the sea, negative on land. The lift throws
 * the real depth away, so the vertex shader has to hand it over separately.
 */
varying float vSeaDepth;

uniform float uWaterOn;
uniform vec3 uWaterShallow;
uniform vec3 uWaterMid;
uniform vec3 uWaterDeep;
uniform float uShoreBand;

uniform sampler2D uDetailMap;
uniform float uDetailScale;
uniform float uMacroScale;
uniform float uDetailNormal;
uniform float uDetailAlbedo;
uniform float uSaturation;

uniform sampler2D uGroundMap;
uniform float uGroundTiles;     // columns in the strip
uniform float uGroundTexel;     // 1 / strip width
uniform float uGroundScale;     // world units per tile repeat
uniform float uGroundStrength;
uniform float uGroundFadeNear;
uniform float uGroundFadeFar;
uniform float uGroundDensity;
uniform float uGroundVariants;
uniform float uUnshaded;
uniform float uGroundExact;
uniform float uGroundBaseStrength;

uniform sampler2D uFogMap;
uniform vec2 uFogOrigin;
uniform float uFogInvExtent;
uniform float uFogOverride;   // 1 = ignore fog entirely
uniform float uSeaY;          // world Y of the waterline

uniform sampler2D uBiomeMap;  // R = tileset index, G = world units from a border
uniform vec2 uBiomeOrigin;
uniform float uBiomeInvExtent;
uniform float uGroundBorderSolid;  // world units of flat ground either side

/**
 * The territory map at this fragment: tileset index, and distance from a border.
 *
 * A lookup rather than a varying, because a varying is interpolated and the
 * index is an index — see biomeTexture.ts. NEAREST filtering means the value
 * read is exactly the value written, so no fragment is ever handed the average
 * of two tileset names.
 */
vec2 biomeAt(vec2 world) {
  vec2 uv = (world - uBiomeOrigin) * uBiomeInvExtent;
  vec2 texel = texture2D(uBiomeMap, uv).rg;
  return vec2(floor(texel.r * 255.0 + 0.5), texel.g * 255.0);
}

/**
 * How much this fragment is allowed to be textured rather than flat.
 *
 * 0 on a border, rising to 1 once far enough inside a territory. The stored
 * distance is a difference of distances and so runs at about twice the
 * perpendicular distance to the border, which the halving here undoes so that
 * the threshold means what the GUI says it does.
 */
float biomeInterior(float gap) {
  float d = gap * 0.5;
  return smoothstep(uGroundBorderSolid * 0.35, uGroundBorderSolid, d);
}

vec3 triplanarWeights(vec3 n) {
  vec3 w = abs(n);
  // Sharpen so the blend band between planes is narrow; a soft blend reads as
  // a muddy smear along every 45-degree slope.
  w = pow(w, vec3(4.0));
  return w / max(w.x + w.y + w.z, 1e-5);
}

vec4 sampleDetail(vec3 pos, vec3 w, float scale) {
  vec2 uvX = pos.zy * scale;
  vec2 uvY = pos.xz * scale;
  vec2 uvZ = pos.xy * scale;

  vec4 sx = texture2D(uDetailMap, uvX);
  vec4 sy = texture2D(uDetailMap, uvY);
  vec4 sz = texture2D(uDetailMap, uvZ);

  vec2 px = sx.xy * 2.0 - 1.0;
  vec2 py = sy.xy * 2.0 - 1.0;
  vec2 pz = sz.xy * 2.0 - 1.0;

  // Each plane's tangent perturbation lifted back into world axes, then
  // summed by weight (UDN-style blend — cheap and stable at grazing angles).
  vec3 pert =
      vec3(0.0, px.y, px.x) * w.x
    + vec3(py.x, 0.0, py.y) * w.y
    + vec3(pz.x, pz.y, 0.0) * w.z;

  float h = sx.a * w.x + sy.a * w.y + sz.a * w.z;
  return vec4(pert, h);
}

/**
 * One variety tile of one biome, repeated across the world plane.
 *
 * The repeat is done here with fract() rather than by RepeatWrapping, because
 * the tiles share one strip texture — hardware wrapping would run straight into
 * the neighbouring biome's column. The half-texel inset stops a uv landing
 * exactly on a column boundary and picking up the tile next door.
 *
 * Returns luminance relative to the tile's own mean, so 1.0 is neutral and the
 * caller can multiply the terrain's band colour by it without shifting hue.
 */
float groundVariant(float rawColumn, vec2 world, float salt) {
  // Already integral, coming from a NEAREST fetch. Kept as a cheap guard on the
  // sampler's exactness rather than as the correction it used to be.
  float column = floor(rawColumn + 0.5);
  vec2 cell = floor(world / uGroundScale);
  vec2 uv = fract(world / uGroundScale);

  // Flip per cell so one 16px tile does not stamp a visible grid across two
  // kilometres of island.
  //
  // Flips specifically, not rotations: these tiles were chosen because their
  // left edge matches their right and their top matches their bottom, so a
  // mirror maps an edge onto its own twin and continuity survives. A transpose
  // would put a horizontal edge against a vertical one and open seams.
  float f = fract(sin(dot(cell, vec2(127.1, 311.7)) + salt) * 43758.5453);
  if (f > 0.5) uv.x = 1.0 - uv.x;
  if (fract(f * 17.0) > 0.5) uv.y = 1.0 - uv.y;

  float inset = uGroundTexel * 0.5;
  float u = (column + clamp(uv.x, 0.0, 1.0)) / uGroundTiles;
  u = clamp(u, column / uGroundTiles + inset, (column + 1.0) / uGroundTiles - inset);
  return texture2D(uGroundMap, vec2(u, clamp(uv.y, 0.02, 0.98))).a * 2.0;
}

/**
 * The tile's own texels, not a brightness derived from them.
 *
 * groundVariant returns alpha, which the packer rewrote to carry luminance
 * relative to the tile's mean — useful as a modulation, but it can only ever
 * tint whatever colour is already there. This returns rgb, so the terrain can
 * *be* the tileset instead of being lit like it.
 *
 * The texture is NearestFilter, mipmap-free and flagged sRGB, so a texel
 * sampled here and written out unshaded round-trips to the exact byte the
 * artist drew.
 */
vec3 groundTexelRgb(float rawColumn, vec2 world) {
  // The column used to arrive as a per-vertex attribute, which the rasteriser
  // interpolated — so a triangle straddling grass (0) and dirt (6) asked for
  // 1.7 and got sand, and along a whole border you saw the ice and cave columns
  // in territories that contain neither. Rounding, which is all this line did,
  // snapped the value to a whole column without stopping it travelling.
  //
  // It now comes from a NEAREST fetch out of the territory index map, so it is
  // exact by construction and there is nothing left to correct.
  float column = floor(rawColumn + 0.5);
  vec2 cell = floor(world / uGroundScale);
  vec2 uv = fract(world / uGroundScale);
  float f = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
  if (f > 0.5) uv.x = 1.0 - uv.x;
  if (fract(f * 17.0) > 0.5) uv.y = 1.0 - uv.y;
  float inset = uGroundTexel * 0.5;
  float u = (column + clamp(uv.x, 0.0, 1.0)) / uGroundTiles;
  u = clamp(u, column / uGroundTiles + inset, (column + 1.0) / uGroundTiles - inset);
  return texture2D(uGroundMap, vec2(u, clamp(uv.y, 0.02, 0.98))).rgb;
}

float groundHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

/** Smooth value noise on the world plane. */
float groundNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(groundHash(i),                groundHash(i + vec2(1.0, 0.0)), f.x),
             mix(groundHash(i + vec2(0.0, 1.0)), groundHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

/**
 * Each biome ships two ground surfaces and this lays one over the other.
 *
 * The pair comes straight from the sheet: a flat fill and, directly beneath it,
 * a textured alternate in the same palette. They are alternatives, not a base
 * and an ornament — so the alternate is laid in broad soft patches rather than
 * sprinkled per cell. That is the fix for flat-looking ground, and it works at
 * two scales at once: the patches break up the territory from the overview,
 * their grain breaks up the surface underfoot.
 *
 * The earlier version stamped a single 16px motif on scattered cells, which
 * left most of the ground bare flat colour and read as a repeating pattern
 * everywhere else.
 */
/**
 * Where the textured tile is laid, as broad soft patches on the world plane.
 *
 * Shared by both ground paths so they agree about *where* texture belongs and
 * differ only in what they do with it — one modulates the flat colour's
 * brightness by the tile's grain, the other replaces it with the tile's own
 * texels. When these were separate the exact path had no patches at all and
 * stamped the tileset over every square metre of the island.
 */
float groundBlot(vec2 world) {
  // Two octaves at unrelated frequencies: one alone gives blobs of a single
  // size, which the eye reads as a pattern rather than as terrain.
  //
  // The periods — roughly 30 and 8 world units — are deliberately shorter than
  // a screenful at the follow camera. An earlier version used 90 and 23, and a
  // single blob then covered the entire view: whether you saw any texture at
  // all depended on which side of the threshold that one blob fell, so most
  // camera positions showed none. Patch noise has to be finer than the frame.
  //
  // Not named "patch" — that is a reserved word in GLSL ES and the compiler
  // rejects it with a bare "illegal use of reserved word". (And no backticks in
  // this comment: the whole block is a JS template literal.)
  float blot = groundNoise(world * 0.033) * 0.65 + groundNoise(world * 0.125) * 0.35;

  // blot is not uniform on 0..1. Measured over the map it is near-normal with
  // mean 0.5 and standard deviation 0.158, so its 5th to 95th percentile spans
  // only 0.24..0.76. Thresholding at 1.0 - density therefore spent most of the
  // slider outside the distribution: everything below about 0.3 was bare and
  // everything above about 0.5 was solid, with the useful range squeezed
  // between. Mapping onto the measured span instead makes density mean what it
  // says — 0.5 covers about half the ground.
  float t = mix(0.76, 0.24, uGroundDensity);
  // The band stays narrower than the noise's own spread. Widen it much past
  // this and every point falls inside the transition, which is not blobs but a
  // uniform half-strength wash with no bare fill anywhere.
  return smoothstep(t - 0.09, t + 0.09, blot);
}

/** Brightness ratio: the flat fill modulated by the tile's grain, in patches. */
float groundDetail(float layer, vec2 world, float cover) {
  float grain = groundVariant(layer * uGroundVariants, world, 0.0);
  return mix(1.0, grain, cover * uGroundBaseStrength);
}
`

/**
 * Unexplored ground is not drawn.
 *
 * The discard comes first, before the triplanar detail sampling and the ground
 * tiles, so fogged terrain costs a texture fetch and a branch rather than the
 * whole material. Combined with skipping tiles that are wholly fogged on the
 * CPU, an unexplored island is nearly free to look at.
 *
 * A short ramp above the cutoff darkens the last few metres into the fog, so
 * the boundary reads as terrain falling into shadow rather than as a torn edge.
 */
const FOG_PATCH = /* glsl */ `
  vec2 fogUv = (vWorldPosition.xz - uFogOrigin) * uFogInvExtent;
  float fogSeen = max(texture2D(uFogMap, fogUv).r, uFogOverride);
  if (fogSeen < 0.18) discard;
  float fogLit = smoothstep(0.18, 0.55, fogSeen);
`

const ALBEDO_PATCH = /* glsl */ `
#ifdef TERRAIN_DETAIL
  vec3 twWeights = triplanarWeights(normalize(vWorldNormal));
  vec4 dFine  = sampleDetail(vWorldPosition, twWeights, uDetailScale);
  vec4 dMacro = sampleDetail(vWorldPosition, twWeights, uMacroScale);

  // Two scales: fine grain reads as surface material, the broad one breaks up
  // the flat colour bands that make untextured terrain look like plastic.
  float mottle = mix(dFine.w, dMacro.w, 0.55) * 2.0 - 1.0;
  diffuseColor.rgb *= 1.0 + mottle * uDetailAlbedo;
#endif

  // Everything below is a territory's floor being laid over this fragment, and
  // the seabed is not in a territory. Sampling the tileset underwater put the
  // Ashlands' basalt and the Frostmark's snow on the bottom of the sea, with a
  // border between them — and in "exact" mode, which replaces the albedo
  // outright, that was the whole picture rather than a tint on it. The vertex
  // colour underneath is already the neutral bed from colorRamp.ts, so the fix
  // is simply to leave it alone.
  //
  // The test is the carried depth, not the world height: submerged geometry has
  // been lifted to sit exactly *at* the waterline, so comparing against it can
  // no longer tell the seabed from the beach.
  bool submerged = vSeaDepth > 0.0;

  // Real ground texture from the tileset, blended between the two territories
  // that meet here.
  //
  // It fades out with distance rather than being mipmapped: a 16px tile
  // repeating every few metres turns to crawling static once it is smaller than
  // a pixel, and at strategy altitude flat readable colour is what you want
  // anyway. Near ground gets texture, the overview gets the biome's colour.
  vec2 territory = biomeAt(vWorldPosition.xz);
  float column = territory.x;

  // Texture belongs in the middle of a territory, not at its edge. Patches are
  // where the tileset is laid at all; the interior term pulls them off the
  // borders so that what meets across a border is flat colour against flat
  // colour — which is the only way the transition reads as a line rather than
  // as two grainy fields fraying into each other.
  float cover = groundBlot(vWorldPosition.xz) * biomeInterior(territory.y);

  if (!submerged) {
    float camDist = distance(cameraPosition, vWorldPosition);
    float near = smoothstep(uGroundFadeFar, uGroundFadeNear, camDist);
    float amount = uGroundStrength * near;
    if (amount > 0.001) {
      float ground = groundDetail(column, vWorldPosition.xz, cover);
      // A brightness ratio, so the elevation banding and the slope-driven rock
      // override keep their own colours and simply gain the tileset's texture.
      diffuseColor.rgb *= mix(1.0, ground, amount);
    }
  }

  // Exact: the ground *is* the tile. Replaces the albedo rather than modulating
  // it, so no ramp colour, no vertex colour and no grain survives — what reaches
  // the framebuffer is the texel the artist drew. Applied after the modulation
  // above so switching it off leaves that path untouched.
  // Exact: where a patch is laid, the ground *is* the tile — the texel the
  // artist drew, replacing the albedo rather than tinting it. Everywhere else it
  // stays the flat fill the vertex colour already holds, which is that same
  // sheet's own base colour, so the two are the one palette and a patch reads as
  // the ground having texture rather than as a different material.
  //
  // This used to replace the albedo unconditionally, over the whole island. The
  // patches are the point: flat fill is the ground, and the tileset is what
  // breaks it up.
  if (uGroundExact > 0.5 && !submerged) {
    vec3 texel = groundTexelRgb(column, vWorldPosition.xz);
    diffuseColor.rgb = mix(diffuseColor.rgb, texel, cover);
  }

  // Fade into the fog rather than ending at a hard line.
  diffuseColor.rgb *= mix(0.15, 1.0, fogLit);
`

/**
 * The sea, drawn by the terrain rather than floating above it.
 *
 * There used to be a translucent plane at the waterline. A plane and a coast
 * interpenetrate, and an interpenetration is the one edge MSAA cannot
 * antialias — coverage sampling only works on primitive silhouettes — so the
 * winner of the depth test flipped per pixel under the smallest camera nudge
 * and the whole shoreline crawled. Polygon offset, depth-write tricks and a
 * depth-driven alpha fade each moved the artefact around without removing it,
 * and the fade cost the coast its edge: what you got was a grey blur where the
 * land should meet the sea.
 *
 * So there is no plane. The vertex shader lifts the seabed up to the waterline,
 * which makes the sea a flat *part of the terrain surface*, and this paints it.
 * One primitive, one depth value per pixel, nothing left to fight over — the
 * flicker is gone by construction rather than by tuning.
 *
 * What that leaves is a colour boundary inside a single triangle, which is
 * exactly the kind of edge a shader can antialias properly: `fwidth` gives the
 * depth change per pixel, so the shoreline is one pixel wide whether you are
 * standing on the beach or looking at the island from orbit.
 */
const WATER_PATCH = /* glsl */ `
  {
    float aa = max(fwidth(vSeaDepth), 1e-4);
    float wet = smoothstep(-aa, aa, vSeaDepth) * uWaterOn;
    if (wet > 0.0) {
      float rim = smoothstep(0.0, uShoreBand, vSeaDepth);
      // The deep stop lands exactly on the sea's own floor, for two reasons.
      // It keeps the ramp spanning the whole sea whatever the sea level slider
      // does — and the island mask drives the map's border down to height zero,
      // so it is also what makes the border the one colour the open-ocean plane
      // outside it is painted. Reached any sooner and the terrain's square edge
      // shows up on the water as a change of blue.
      float far = smoothstep(uShoreBand, max(uShoreBand * 2.0, uSeaY), vSeaDepth);
      vec3 sea = mix(mix(uWaterShallow, uWaterMid, rim), uWaterDeep, far);
      // Unlit, and the same ramp everywhere: a specular plane sparkled as the
      // camera moved, which is the other half of what read as flashing water.
      sea *= mix(0.15, 1.0, fogLit);
      // Opaque right up to the edge. Letting the seabed show through the
      // shallows sounds like water and looks like fog: a translucent margin has
      // no edge of its own, so the coast dissolved into a pale smear instead of
      // meeting the land. The shallows read as shallow because of the rim
      // colour instead, which is how the source art does it too.
      outgoingLight = mix(outgoingLight, sea, wet);
    }
  }
`

const NORMAL_PATCH = /* glsl */ `
#ifdef TERRAIN_DETAIL
  {
    vec3 pert = dFine.xyz * uDetailNormal + dMacro.xyz * (uDetailNormal * 0.35);
    // At this point "normal" is in view space, so the world-space
    // perturbation has to be rotated into it before it can be added.
    normal = normalize(normal + mat3(viewMatrix) * pert);
  }
#endif
`

export function createTerrainMaterial(maxAnisotropy = 1): TerrainMaterial {
  const detailMap = createDetailTexture(256, 4, maxAnisotropy)
  const groundMap = createGroundTexture()

  const uniforms = {
    uDetailMap: { value: detailMap },
    uDetailScale: { value: 1 / 9 },
    uMacroScale: { value: 1 / 70 },
    uDetailNormal: { value: 0.55 },
    uDetailAlbedo: { value: 0.3 },
    uSaturation: { value: 1 },
    uGroundMap: { value: groundMap },
    uGroundTiles: { value: GROUND_WIDTH / GROUND_TILE },
    uGroundVariants: { value: GROUND_VARIANTS },
    uGroundTexel: { value: 1 / GROUND_WIDTH },
    uGroundScale: { value: 12 },
    uGroundStrength: { value: 0.85 },
    uGroundFadeNear: { value: 140 },
    uGroundFadeFar: { value: 460 },
    uGroundDensity: { value: 0.55 },
    uGroundBaseStrength: { value: 0.85 },
    uUnshaded: { value: 0 },
    uGroundExact: { value: 0 },
    uFogMap: { value: null as THREE.Texture | null },
    uFogOrigin: { value: new THREE.Vector2(-1024, -1024) },
    uFogInvExtent: { value: 1 / 2048 },
    uFogOverride: { value: 1 },
    uSeaY: { value: 0 },
    uBiomeMap: { value: null as THREE.Texture | null },
    uBiomeOrigin: { value: new THREE.Vector2(-1024, -1024) },
    uBiomeInvExtent: { value: 1 / 2048 },
    uGroundBorderSolid: { value: 26 },
    uWaterOn: { value: 1 },
    uWaterShallow: { value: linear(WATER_SHALLOW) },
    uWaterMid: { value: linear(WATER_MID) },
    uWaterDeep: { value: linear(WATER_DEEP) },
    uShoreBand: { value: 4 },
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
  })
  material.defines = { TERRAIN_DETAIL: '' }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)

    // The lift assumes the terrain's model matrix is a plain translation with
    // unit scale — it is: `terrainMesh.ts` writes absolute world coordinates
    // into the position attribute and never transforms the tiles or the group.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying float vSeaDepth;
attribute float aSeaDepth;
uniform float uSeaY;
uniform float uWaterOn;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
  // A flat sea has to be lit flat. Left alone, the seabed's relief kept its
  // normals after the lift and showed through as shading on a surface that is
  // no longer there — hills of light on water.
  if (uWaterOn > 0.5 && (modelMatrix * vec4(position, 1.0)).y < uSeaY) {
    objectNormal = vec3(0.0, 1.0, 0.0);
  }
  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  // Depth from the terrain's own height, handed over by the mesh, because the
  // coastal shelf has moved the geometry away from it — see terrainMesh.ts.
  // This is what decides where the water *is*.
  vSeaDepth = aSeaDepth;
  // Raise the seabed to the waterline. This is what makes the sea a surface of
  // the terrain instead of a plane cutting through it — see WATER_PATCH. It
  // reads the geometry rather than aSeaDepth, so what ends up flat is whatever
  // the shelf actually left below the waterline.
  if (uWaterOn > 0.5) {
    transformed.y += max(0.0, uSeaY - (modelMatrix * vec4(transformed, 1.0)).y);
  }
  vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      )

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_HEADER)
      // After color_fragment so the vertex colours are already folded in and
      // the detail modulates the final base colour.
      .replace('#include <color_fragment>', FOG_PATCH + '\n#include <color_fragment>\n' + ALBEDO_PATCH)
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n' + NORMAL_PATCH,
      )
      // After <opaque_fragment> so it acts on the lit, tone-mapped result —
      // which is where the saturation was lost — and before the atmospheric
      // fog blend, so distant haze is not re-saturated along with the ground.
      // Unshaded: hand the albedo straight to the output instead of the lit
      // result. The source art carries no lighting model at all — a tile is one
      // flat colour — so every bit of shading is a departure from it. This makes
      // the terrain *be* the tileset colour, which is the only way to see what
      // the palette actually looks like without the renderer's opinion on top.
      .replace(
        '#include <opaque_fragment>',
        '  outgoingLight = mix( outgoingLight, diffuseColor.rgb, uUnshaded );\n' +
          // After the unshaded override, so the sea covers the tileset rather
          // than the other way round.
          WATER_PATCH +
          '#include <opaque_fragment>\n' +
          SATURATION_PATCH,
      )
  }

  // The patched program must not be shared with an unpatched standard material.
  material.customProgramCacheKey = () => 'terrain-ground-patched-v19'

  function setGround(g: GroundSettings): void {
    uniforms.uGroundScale.value = Math.max(1, g.scale)
    uniforms.uGroundStrength.value = g.enabled ? g.strength : 0
    uniforms.uGroundFadeNear.value = g.fadeNear
    uniforms.uGroundFadeFar.value = Math.max(g.fadeNear + 1, g.fadeFar)
    uniforms.uGroundDensity.value = g.density
    uniforms.uGroundBaseStrength.value = g.baseStrength
    uniforms.uGroundBorderSolid.value = Math.max(0.01, g.borderSolid)
    // Exact implies unshaded: a lit tile is not the tile.
    uniforms.uGroundExact.value = g.exact ? 1 : 0
    uniforms.uUnshaded.value = g.unshaded || g.exact ? 1 : 0
    // And it implies no atmospheric fog. Three applies <fog_fragment> after
    // <opaque_fragment>, so it lands on top of the unshaded override and blends
    // the tile toward the sky colour — which is what turned a (89,193,53) grass
    // tile into pale mint on screen. Aerial perspective is a lighting effect and
    // this mode is the absence of lighting.
    if (material.fog === g.exact) {
      material.fog = !g.exact
      material.needsUpdate = true
    }
  }

  function setWater(w: WaterSettings): void {
    uniforms.uWaterOn.value = w.enabled ? 1 : 0
    uniforms.uShoreBand.value = Math.max(0.01, w.shoreBand)
  }

  function setFog(texture: THREE.Texture | null, worldSize: number, enabled: boolean): void {
    uniforms.uFogMap.value = texture
    uniforms.uFogOrigin.value.set(-worldSize / 2, -worldSize / 2)
    uniforms.uFogInvExtent.value = 1 / Math.max(1, worldSize)
    // No texture yet, or fog switched off, means draw everything.
    uniforms.uFogOverride.value = texture && enabled ? 0 : 1
  }

  function setSaturation(v: number): void {
    uniforms.uSaturation.value = Math.max(0, v)
  }

  function setSeaY(y: number): void {
    uniforms.uSeaY.value = y
  }

  function setBiomeMap(texture: THREE.Texture | null, worldSize: number): void {
    uniforms.uBiomeMap.value = texture
    uniforms.uBiomeOrigin.value.set(-worldSize / 2, -worldSize / 2)
    uniforms.uBiomeInvExtent.value = 1 / Math.max(1, worldSize)
  }

  function setDetail(d: DetailSettings): void {
    uniforms.uDetailScale.value = 1 / Math.max(0.01, d.scale)
    uniforms.uMacroScale.value = 1 / Math.max(0.01, d.macroScale)
    uniforms.uDetailNormal.value = d.enabled ? d.normalStrength : 0
    uniforms.uDetailAlbedo.value = d.enabled ? d.albedoStrength : 0
  }

  return {
    material,
    setDetail,
    setGround,
    setWater,
    setFog,
    setSaturation,
    setSeaY,
    setBiomeMap,
    setWireframe: (on: boolean) => {
      material.wireframe = on
    },
    dispose: () => {
      material.dispose()
      detailMap.dispose()
      groundMap.dispose()
    },
  }
}
