/// <reference lib="webworker" />
import { erode } from './erosion'
import { generateHeightmap } from './generate'
import { Heightmap } from './heightmap'
import { makeRng } from './prng'
import type { WorkerRequest, WorkerResponse } from './protocol'

/**
 * Generation worker. Keeps both the noise pipeline and the multi-second
 * erosion loop off the main thread, so the camera stays interactive while a
 * map is being built.
 *
 * Heightmap buffers are transferred in both directions rather than copied.
 */

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? [])
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data

  try {
    if (req.type === 'generate') {
      const started = performance.now()
      const hm = generateHeightmap(req.params)
      post(
        {
          type: 'done',
          jobId: req.jobId,
          phase: 'generate',
          size: hm.size,
          heights: hm.data.buffer as ArrayBuffer,
          ms: performance.now() - started,
        },
        [hm.data.buffer as ArrayBuffer],
      )
      return
    }

    if (req.type === 'erode') {
      const hm = new Heightmap(req.size, new Float32Array(req.heights))
      const rng = makeRng(req.params.seed, 'erosion')
      const result = erode(hm, req.params.erosion, req.params.shape.seaLevel, rng, (frac) => {
        post({ type: 'progress', jobId: req.jobId, phase: 'erode', frac })
      })
      post(
        {
          type: 'done',
          jobId: req.jobId,
          phase: 'erode',
          size: hm.size,
          heights: hm.data.buffer as ArrayBuffer,
          ms: result.ms,
        },
        [hm.data.buffer as ArrayBuffer],
      )
      return
    }
  } catch (err) {
    post({
      type: 'error',
      jobId: (req as { jobId: number }).jobId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
