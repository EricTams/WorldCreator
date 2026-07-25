/**
 * Seeded pseudo-random number generation.
 *
 * Inlined rather than pulling in `alea` — it's fifteen lines and keeps the
 * world module dependency-free apart from the noise function itself.
 */

/** FNV-1a. Turns a human-typed seed string into a 32-bit integer. */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Mulberry32. Fast, small, and good enough for terrain. Returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Build a generator from a seed string plus a stream name, so that independent
 * parts of the pipeline (base noise, warp field, ridges, erosion droplets) each
 * get their own uncorrelated sequence from the same user-visible seed. Without
 * the stream name they would all share a sequence and visibly rhyme.
 */
export function makeRng(seed: string, stream = ''): () => number {
  return mulberry32(hashString(`${seed}/${stream}`))
}

/** A short, pronounceable random seed for the "randomize" button. */
export function randomSeed(): string {
  const syllables = [
    'ka', 'ro', 'mi', 'tha', 'vel', 'sun', 'dor', 'ish', 'ael', 'nor',
    'qua', 'zen', 'lir', 'oth', 'bry', 'fen', 'gal', 'hax', 'wyn', 'umb',
  ]
  let out = ''
  for (let i = 0; i < 3; i++) {
    out += syllables[Math.floor(Math.random() * syllables.length)]
  }
  return out
}
