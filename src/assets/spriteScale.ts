/**
 * How big a sprite is in world units — the one place that conversion lives.
 *
 * It sits beside the generated atlas rather than inside the renderer because
 * two very different things need it and only one of them can import three.js.
 * `render/cardLayer.ts` needs it to size a card; `world/sites.ts` needs it to
 * decide how much ground a town has to be given, because a clearing that does
 * not match the building standing in it is visible from the air.
 *
 * When those two disagreed, the ground was levelled to one size and the card
 * drawn at another. Keeping the conversion here means a headless tool — the
 * biome audit, the match harness — plans exactly the board the game renders.
 */

import { SPRITE_FRAMES } from './sprites'
import type { SpriteKey } from './sprites'

/** World units a 16-pixel-tall sprite occupies. */
export const DEFAULT_PIXEL_SCALE = 2.5

/** World-unit width of a sprite drawn at `pixelScale`. */
export function spriteWidthOf(key: SpriteKey, pixelScale = DEFAULT_PIXEL_SCALE): number {
  return SPRITE_FRAMES[key].w * (pixelScale / 16)
}
