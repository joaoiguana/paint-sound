// Messages between the main thread and the DSP worker.
import type { SegmentInput } from './synth.ts'

export type WorkerRequest =
  | { type: 'analyze'; id: number; samples: Float32Array }
  | ({ type: 'render'; id: number; gen: number } & SegmentInput)

export type WorkerReply =
  | { type: 'analyzed'; id: number; frames: number; mag: Float32Array; phase: Float32Array }
  | { type: 'rendered'; id: number; gen: number; s0: number; data: Float32Array }
