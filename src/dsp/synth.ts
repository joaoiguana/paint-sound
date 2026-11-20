// The two resynthesis engines. Pure functions: no DOM, runs in the worker (and in tests).
//
//  1. Additive (paint layer): one sine oscillator per canvas row, amplitude
//     taken from the painted value and linearly interpolated between frames.
//     Phase is a deterministic function of absolute time (phase = f·t + offset),
//     so ANY time segment can be rendered independently -> cheap partial re-renders.
//
//  2. ISTFT (sample layer): edited magnitudes + original phases -> inverse FFT
//     -> windowed overlap-add. Reusing the original phase is what keeps edits clean.

import { BINS, HOP, N, ROWS, ROW_GAIN, yToFreq } from './constants.ts'
import { FFT } from './fft.ts'

const fft = new FFT(N)

/** Periodic Hann window: with HOP = N/4, Σw² is constant (1.5). */
export const WINDOW = (() => {
  const w = new Float64Array(N)
  for (let n = 0; n < N; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N)
  return w
})()

export const frameCount = (length: number) => Math.floor(length / HOP) + 1

/** Short-time Fourier transform. Frame i is centred on sample i*HOP. */
export function stft(x: Float32Array) {
  const frames = frameCount(x.length)
  const mag = new Float32Array(frames * BINS)
  const phase = new Float32Array(frames * BINS)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let i = 0; i < frames; i++) {
    const start = i * HOP - N / 2
    for (let n = 0; n < N; n++) {
      const idx = start + n
      re[n] = idx >= 0 && idx < x.length ? x[idx] * WINDOW[n] : 0
      im[n] = 0
    }
    fft.forward(re, im)
    const o = i * BINS
    for (let k = 0; k < BINS; k++) {
      mag[o + k] = Math.hypot(re[k], im[k])
      phase[o + k] = Math.atan2(im[k], re[k])
    }
  }
  return { frames, mag, phase }
}

export interface SegmentInput {
  sr: number
  s0: number // first output sample (inclusive)
  s1: number // last output sample (exclusive)
  paintFrame0: number
  paintFrames: number
  paint: Float32Array // paintFrames × ROWS, starting at paintFrame0
  specFrame0: number
  specFrames: number
  mag: Float32Array | null // specFrames × BINS, starting at specFrame0
  phase: Float32Array | null
}

/** Render samples [s0, s1) from the spectrogram data covering that range. */
export function renderSegment(r: SegmentInput): Float32Array {
  const out = new Float32Array(r.s1 - r.s0)
  renderAdditive(out, r)
  if (r.mag && r.phase) renderIstft(out, r)
  softClip(out)
  return out
}

// --- additive ---------------------------------------------------------------

const SINE_SIZE = 4096
const SINE = (() => {
  const t = new Float32Array(SINE_SIZE + 1)
  for (let i = 0; i <= SINE_SIZE; i++) t[i] = Math.sin((2 * Math.PI * i) / SINE_SIZE)
  return t
})()

/** Stable pseudo-random start phase per row (avoids all rows peaking together). */
const rowOffset = (row: number) => {
  const x = Math.sin(row * 12.9898 + 4.1414) * 43758.5453
  return x - Math.floor(x)
}

function renderAdditive(out: Float32Array, r: SegmentInput) {
  const { sr, s0, s1, paint, paintFrame0, paintFrames } = r
  for (let row = 0; row < ROWS; row++) {
    const f = yToFreq(row)
    if (f >= sr * 0.48) break // rows ascend in frequency; stop below Nyquist
    const inc = f / sr // phase increment in cycles per sample
    const off = rowOffset(row)
    for (let j = 0; j < paintFrames; j++) {
      const a0 = paint[j * ROWS + row]
      const a1 = j + 1 < paintFrames ? paint[(j + 1) * ROWS + row] : 0
      if (a0 === 0 && a1 === 0) continue // silent: skip (the common case)
      const frameStart = (paintFrame0 + j) * HOP
      const nStart = Math.max(frameStart, s0)
      const nEnd = Math.min(frameStart + HOP, s1)
      if (nStart >= nEnd) continue
      // painted value v -> amplitude v² (feels more natural than linear)
      const g0 = a0 * a0 * ROW_GAIN
      const g1 = a1 * a1 * ROW_GAIN
      let ph = off + inc * nStart
      ph -= Math.floor(ph)
      for (let n = nStart; n < nEnd; n++) {
        const g = g0 + ((g1 - g0) * (n - frameStart)) / HOP
        const p = ph * SINE_SIZE
        const k = p | 0
        out[n - s0] += g * (SINE[k] + (SINE[k + 1] - SINE[k]) * (p - k))
        ph += inc
        if (ph >= 1) ph -= 1
      }
    }
  }
}

// --- inverse STFT -------------------------------------------------------------

function renderIstft(out: Float32Array, r: SegmentInput) {
  const { s0, s1, specFrame0, specFrames } = r
  const mag = r.mag!
  const phase = r.phase!
  const len = s1 - s0
  const acc = new Float64Array(len)
  const wsum = new Float64Array(len)
  const re = new Float64Array(N)
  const im = new Float64Array(N)

  for (let j = 0; j < specFrames; j++) {
    const start = (specFrame0 + j) * HOP - N / 2 - s0
    // window-power normaliser (handles the file edges correctly too)
    for (let n = 0; n < N; n++) {
      const idx = start + n
      if (idx >= 0 && idx < len) wsum[idx] += WINDOW[n] * WINDOW[n]
    }
    const o = j * BINS
    let any = false
    for (let k = 0; k < BINS; k++) {
      const m = mag[o + k]
      if (m > 0) any = true
      re[k] = m * Math.cos(phase[o + k])
      im[k] = m * Math.sin(phase[o + k])
    }
    if (!any) continue
    im[0] = 0
    im[N / 2] = 0
    for (let k = 1; k < N / 2; k++) {
      // Hermitian symmetry -> real output
      re[N - k] = re[k]
      im[N - k] = -im[k]
    }
    fft.inverse(re, im)
    for (let n = 0; n < N; n++) {
      const idx = start + n
      if (idx >= 0 && idx < len) acc[idx] += re[n] * WINDOW[n]
    }
  }
  for (let i = 0; i < len; i++) if (wsum[i] > 1e-9) out[i] += acc[i] / wsum[i]
}

/** Transparent below 0.9, gently saturates above, never exceeds 1. */
function softClip(x: Float32Array) {
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    const a = Math.abs(v)
    if (a > 0.9) x[i] = Math.sign(v) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1))
  }
}
