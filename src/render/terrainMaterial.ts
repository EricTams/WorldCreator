import * as THREE from 'three'
import { createDetailTexture } from './detailTexture'

export interface DetailSettings {
  enabled: boolean
  /** World units per repeat of the fine detail. */
  scale: number
  /** World units per repeat of the broad mottling. */
  macroScale: number
  normalStrength: number
  albedoStrength: number
}

export interface TerrainMaterial {
  material: THREE.MeshStandardMaterial
  setDetail(d: DetailSettings): void
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

uniform sampler2D uDetailMap;
uniform float uDetailScale;
uniform float uMacroScale;
uniform float uDetailNormal;
uniform float uDetailAlbedo;

vec3 triplanarWeights(vec3 n) {
  vec3 w = abs(n);
  // Sharpen so the blend band between planes is narrow; a soft blend reads as
  // a muddy smear along every 45-degree slope.
  w = pow(w, vec3(4.0));
  return w / max(w.x + w.y + w.z, 1e-5);
}

// Returns xyz = world-space normal perturbation, w = height 0..1.
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

  const uniforms = {
    uDetailMap: { value: detailMap },
    uDetailScale: { value: 1 / 9 },
    uMacroScale: { value: 1 / 70 },
    uDetailNormal: { value: 0.55 },
    uDetailAlbedo: { value: 0.3 },
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
  })
  material.defines = { TERRAIN_DETAIL: '' }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWorldPosition;\nvarying vec3 vWorldNormal;',
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_HEADER)
      // After color_fragment so the vertex colours are already folded in and
      // the detail modulates the final base colour.
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + ALBEDO_PATCH)
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n' + NORMAL_PATCH,
      )
  }

  // The patched program must not be shared with an unpatched standard material.
  material.customProgramCacheKey = () => 'terrain-detail-v1'

  function setDetail(d: DetailSettings): void {
    uniforms.uDetailScale.value = 1 / Math.max(0.01, d.scale)
    uniforms.uMacroScale.value = 1 / Math.max(0.01, d.macroScale)
    uniforms.uDetailNormal.value = d.enabled ? d.normalStrength : 0
    uniforms.uDetailAlbedo.value = d.enabled ? d.albedoStrength : 0
  }

  return {
    material,
    setDetail,
    setWireframe: (on: boolean) => {
      material.wireframe = on
    },
    dispose: () => {
      material.dispose()
      detailMap.dispose()
    },
  }
}
