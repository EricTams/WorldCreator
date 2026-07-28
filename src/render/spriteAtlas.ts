import * as THREE from 'three'
import spritesUrl from '../assets/sprites.png'
import unitsUrl from '../assets/units.png'
import { ATLAS_HEIGHT, ATLAS_WIDTH, SPRITE_FRAMES } from '../assets/sprites'
import type { SpriteFrame, SpriteKey } from '../assets/sprites'
import {
  ATLAS_HEIGHT as UNIT_ATLAS_HEIGHT,
  ATLAS_WIDTH as UNIT_ATLAS_WIDTH,
  SPRITE_FRAMES as UNIT_FRAMES,
} from '../assets/units'
import type { SpriteKey as UnitKey } from '../assets/units'

export type { SpriteKey, UnitKey }

/**
 * The bitmaps the board is drawn from.
 *
 * Everything else here is generated at runtime — the terrain detail texture is
 * 4D simplex noise precisely so no binary has to ship. Hand-drawn pixel art is
 * the case that argument doesn't cover, so these are the exception: two atlases
 * built from a curated slice of the source packs by tools/packSprites.mjs.
 * Art by Aleksandr Makarov — see assets/ART-CREDITS.md.
 *
 * There are two of them because the creature sheets are half the pixels and
 * were, until the units were wired up, none of the game. They stay separate now
 * for a different reason: one material binds one texture, so scenery and
 * creatures are two draw calls whatever happens. That is the correct split
 * anyway — the board's cards are placed once and culled by fog, while creatures
 * move and animate every frame, so they want completely different layers.
 */
export interface Atlas<K extends string> {
  texture: THREE.Texture
  /** Resolves once the image has decoded. Frame rects are available before this. */
  ready: Promise<void>
  /**
   * Normalised (u0, v0, du, dv) for a sprite, ready to be applied as
   * `uv0 + quadUv * duv`. `dv` is negative: the atlas is authored top-down and
   * the texture is loaded unflipped, so walking *up* the quad walks *down* the
   * image.
   *
   * Writes into `out` when given one. Animated cards resolve a rect per instance
   * per frame, and allocating a Vector4 for each was the layer's only per-frame
   * garbage.
   */
  uvRect(key: K, frame?: number, row?: number, out?: THREE.Vector4): THREE.Vector4
  /** Source pixel dimensions, which set the card's aspect ratio. */
  pixelSize(key: K): { w: number; h: number }
  dispose(): void
}

export type SpriteAtlas = Atlas<SpriteKey>
export type UnitAtlas = Atlas<UnitKey>

function makeAtlas<K extends string>(
  url: string,
  frames: Record<string, SpriteFrame>,
  atlasWidth: number,
  atlasHeight: number,
  maxAnisotropy: number,
): Atlas<K> {
  const loader = new THREE.TextureLoader()

  let resolve!: () => void
  let reject!: (e: unknown) => void
  const ready = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })

  const texture = loader.load(url, () => resolve(), undefined, reject)

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

  function pixelSize(key: K): { w: number; h: number } {
    const f = frames[key]
    return { w: f.w / (f.cols ?? 1), h: f.h / (f.rows ?? 1) }
  }

  const scratch = new THREE.Vector4()

  function uvRect(key: K, frame = 0, row = 0, out?: THREE.Vector4): THREE.Vector4 {
    const f = frames[key]
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
    return (out ?? scratch).set(
      (x + i) / atlasWidth,
      (y + h - i) / atlasHeight, // quad bottom == sprite bottom == larger image y
      (w - i * 2) / atlasWidth,
      -(h - i * 2) / atlasHeight,
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

export function loadSpriteAtlas(maxAnisotropy = 1): SpriteAtlas {
  return makeAtlas<SpriteKey>(spritesUrl, SPRITE_FRAMES, ATLAS_WIDTH, ATLAS_HEIGHT, maxAnisotropy)
}

/**
 * The creature atlas: 54 sheets of 4 frames x 5 rows.
 *
 * Rows are Idle / Walk / Attack / Damage / Death — see `UNIT_ANIM` in
 * `game/factions.ts`, which is where that ordering is written down rather than
 * spread through the callers. A few sheets carry a sixth "special" row that
 * nothing indexes.
 */
export function loadUnitAtlas(maxAnisotropy = 1): UnitAtlas {
  return makeAtlas<UnitKey>(
    unitsUrl,
    UNIT_FRAMES,
    UNIT_ATLAS_WIDTH,
    UNIT_ATLAS_HEIGHT,
    maxAnisotropy,
  )
}
