import type { WorldParams } from './params'

/**
 * Message shapes shared by main.ts and the generation worker. Kept in its own
 * module so the main thread can import the types without importing the worker
 * body (which would pull the generator onto the main thread and defeat the
 * point of having a worker).
 */

export type Phase = 'generate' | 'erode'

export type WorkerRequest =
  | { type: 'generate'; jobId: number; params: WorldParams }
  | {
      type: 'erode'
      jobId: number
      params: WorldParams
      size: number
      /** Transferred. The main thread keeps its own pre-erosion copy. */
      heights: ArrayBuffer
    }

export type WorkerResponse =
  | { type: 'progress'; jobId: number; phase: Phase; frac: number }
  | {
      type: 'done'
      jobId: number
      phase: Phase
      size: number
      heights: ArrayBuffer
      ms: number
    }
  | { type: 'error'; jobId: number; message: string }
