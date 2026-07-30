/** Types for `png.mjs`, which is plain JS so the asset packers can run without a build step. */

export interface RawImage {
  width: number
  height: number
  /** RGBA8, row-major, no padding. */
  data: Buffer
}

export function decodePng(buffer: Buffer, label?: string): RawImage
export function encodePng(image: RawImage): Buffer
