import * as THREE from 'three'
import atlasUrl from '../assets/sprites.png'
import { ATLAS_HEIGHT, ATLAS_WIDTH, SPRITE_FRAMES } from '../assets/sprites'
import type { SpriteFrame, SpriteKey } from '../assets/sprites'

export type { SpriteKey }

/**
 * The bitmap the board is drawn from.
 *
 * Everything else here is generated at runtime — the terrain detail texture is
 * 4D simplex noise precisely so no binary has to ship. Hand-drawn pixel art is
 * the case that argument doesn't cover, so this is the exception: a 256x1024
 * atlas built from a curated slice of the source packs by tools/packSprites.mjs.
 * Art by Aleksandr Makarov — see assets/ART-CREDITS.md.
 *
 * The packer emits a second atlas, `assets/units.png`, holding the creature
 * walk cycles. Nothing loads it, because nothing animates creatures yet. When
 * something does, it needs more than a call to `loadSpriteAtlas(units)`: a
 * CardLayer binds one texture to one material, so a second atlas means either a
 * second CardLayer — two more draw calls, and correct, since creatures and
 * scenery do not need to sort against each other — or an atlas index on the
 * instance attribute and a sampler array in the shader. The first is a dozen
 * lines; the second is worth it only if creatures ever outnumber the trees.
 */
export interface SpriteAtlas {
  texture: THREE.Texture
  /** Resolves once the image has decoded. Frame rects are available before this. */
  ready: Promise<void>
  /**
   * Normalised (u0, v0, du, dv) for a sprite, ready to be applied as
   * `uv0 + quadUv * duv`. `dv` is negative: the atlas is authored top-down and
   * the texture is loaded unflipped, so walking *up* the quad walks *down* the
   * image.
   */
  uvRect(key: SpriteKey, frame?: number, row?: number): THREE.Vector4
  /** Source pixel dimensions, which set the card's aspect ratio. */
  pixelSize(key: SpriteKey): { w: number; h: number }
  dispose(): void
}

export function loadSpriteAtlas(maxAnisotropy = 1): SpriteAtlas {
  const loader = new THREE.TextureLoader()

  let resolve!: () => void
  let reject!: (e: unknown) => void
  const ready = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })

  const texture = loader.load(atlasUrl, () => resolve(), undefined, reject)

  // Pixel art, magnified: nearest, or every sprite turns to mush the moment you
  // ride up to it.
  texture.magFilter = THREE.NearestFilter
  // Minified, though, nearest is the wrong answer — a 16px pickup viewed from
  // the 'populous' preset two thousand units up aliases into crawling static.
  // Mipmaps plus anisotropy are what make the same atlas survive a zoom range
  // of two orders of magnitude. The packer's 4px gutters are what make
  // mipmapping safe across sprite boundaries.
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = Math.min(8, maxAnisotropy)
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  // The renderer outputs sRGB with ACES tone mapping; an unflagged atlas comes
  // out visibly washed out against the terrain.
  texture.colorSpace = THREE.SRGBColorSpace
  // Frame rects are authored in image space (origin top-left). Leaving the flip
  // on would mean negating every y in the generated frame map.
  texture.flipY = false

  // Typed as the interface rather than read off the literal: this atlas holds no
  // animation sheets since the creature art moved to units.png, so `'cols' in f`
  // narrows to never and every use of it becomes `unknown`. The frame/row
  // arguments stay, because the second atlas will need them.
  function pixelSize(key: SpriteKey): { w: number; h: number } {
    const f: SpriteFrame = SPRITE_FRAMES[key]
    return { w: f.w / (f.cols ?? 1), h: f.h / (f.rows ?? 1) }
  }

  function uvRect(key: SpriteKey, frame = 0, row = 0): THREE.Vector4 {
    const f: SpriteFrame = SPRITE_FRAMES[key]
    const cols = f.cols ?? 1
    const rows = f.rows ?? 1

    const w = f.w / cols
    const h = f.h / rows
    const x = f.x + (frame % cols) * w
    const y = f.y + (row % rows) * h

    // Quarter-texel inset. With NearestFilter a uv landing exactly on the rect
    // boundary can round outward and sample the neighbouring sprite; a quarter
    // texel is far too small to drop a pixel but enough to make that impossible.
    const i = 0.25
    return new THREE.Vector4(
      (x + i) / ATLAS_WIDTH,
      (y + h - i) / ATLAS_HEIGHT, // quad bottom == sprite bottom == larger image y
      (w - i * 2) / ATLAS_WIDTH,
      -(h - i * 2) / ATLAS_HEIGHT,
    )
  }

  return {
    texture,
    ready,
    uvRect,
    pixelSize,
    dispose: () => texture.dispose(),
  }
}
