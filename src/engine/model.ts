// The editable spectrogram. This is the "document": the canvas only *displays* it.
//
//  paint  frames × ROWS   painted oscillator amplitudes (0..1), resynthesised additively
//  mag    frames × BINS   STFT magnitudes of an imported sample (editable)
//  phase  frames × BINS   STFT phases of the sample (kept, so edits sound clean)
//  orig*  untouched copies, used by the Restore tool / Revert

import { BINS, HOP, N, ROWS, ROWS_PER_SEMITONE, freqToY, yToFreq } from '../dsp/constants.ts'
import { frameCount } from '../dsp/synth.ts'

export type Tool = 'brush' | 'harmonic' | 'erase' | 'smudge' | 'restore'

export interface Dab {
  tool: Tool
  cx: number // centre, in frames
  cy: number // centre, in rows (0 = lowest pitch)
  rx: number // radius in frames
  ry: number // radius in rows
  strength: number // 0..1
  harmonics: number
  pure: boolean // snapped: write exactly one row per note -> clean pitched tone
  dx: number // stroke movement since last dab (for smudge)
  dy: number
}

interface Tile {
  paint: Float32Array
  mag: Float32Array | null
  phase: Float32Array | null
}
type UndoEntry = Map<number, Tile>

const TILE = 32 // undo granularity in frames: only touched tiles are snapshotted
const MAX_UNDO = 40
const FLOW = 0.5

export class SpectroModel {
  readonly sr: number
  readonly length: number
  readonly frames: number
  readonly rows = ROWS
  readonly paint: Float32Array
  readonly mag: Float32Array | null
  readonly phase: Float32Array | null
  private readonly origMag: Float32Array | null
  private readonly origPhase: Float32Array | null

  /** For display: which FFT bins fall inside each canvas row. */
  readonly binLo: Int32Array
  readonly binHi: Int32Array
  /** For tools: each bin's row position and half-height (bins are wide in the bass). */
  private readonly binY: Float32Array
  private readonly binHalf: Float32Array

  private stroke: UndoEntry | null = null
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []

  constructor(sr: number, length: number, spec?: { mag: Float32Array; phase: Float32Array }) {
    this.sr = sr
    this.length = length
    this.frames = frameCount(length)
    this.paint = new Float32Array(this.frames * ROWS)
    this.mag = spec?.mag ?? null
    this.phase = spec?.phase ?? null
    this.origMag = spec ? spec.mag.slice() : null
    this.origPhase = spec ? spec.phase.slice() : null

    const df = sr / N
    this.binLo = new Int32Array(ROWS)
    this.binHi = new Int32Array(ROWS)
    for (let r = 0; r < ROWS; r++) {
      const lo = clamp(Math.round(yToFreq(r - 0.5) / df), 1, BINS - 1)
      const hi = clamp(Math.round(yToFreq(r + 0.5) / df) - 1, lo, BINS - 1)
      this.binLo[r] = lo
      this.binHi[r] = hi
    }
    this.binY = new Float32Array(BINS)
    this.binHalf = new Float32Array(BINS)
    for (let k = 1; k < BINS; k++) {
      this.binY[k] = freqToY(k * df)
      this.binHalf[k] = (freqToY((k + 0.5) * df) - freqToY(Math.max(0.5, k - 0.5) * df)) / 2
    }
    this.binY[0] = -1e9
  }

  get hasSample() {
    return this.mag !== null
  }
  get canUndo() {
    return this.undoStack.length > 0
  }
  get canRedo() {
    return this.redoStack.length > 0
  }
  get seconds() {
    return this.length / this.sr
  }

  // --- undo -----------------------------------------------------------------

  beginStroke() {
    this.stroke = new Map()
  }

  endStroke() {
    if (this.stroke && this.stroke.size) {
      this.undoStack.push(this.stroke)
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
      this.redoStack = []
    }
    this.stroke = null
  }

  undo() {
    return this.travel(this.undoStack, this.redoStack)
  }
  redo() {
    return this.travel(this.redoStack, this.undoStack)
  }

  private travel(from: UndoEntry[], to: UndoEntry[]): [number, number] | null {
    const entry = from.pop()
    if (!entry) return null
    const back: UndoEntry = new Map()
    let lo = Infinity
    let hi = -Infinity
    for (const [t, tile] of entry) {
      back.set(t, this.copyTile(t))
      this.writeTile(t, tile)
      lo = Math.min(lo, t * TILE)
      hi = Math.max(hi, Math.min(this.frames, (t + 1) * TILE) - 1)
    }
    to.push(back)
    return [lo, hi]
  }

  /** Snapshot the tiles covering frames [f0, f1] before they are modified. */
  private touch(f0: number, f1: number) {
    if (!this.stroke) return
    for (let t = Math.floor(f0 / TILE); t <= Math.floor(f1 / TILE); t++) {
      if (!this.stroke.has(t)) this.stroke.set(t, this.copyTile(t))
    }
  }

  private copyTile(t: number): Tile {
    const f0 = t * TILE
    const f1 = Math.min(this.frames, f0 + TILE)
    return {
      paint: this.paint.slice(f0 * ROWS, f1 * ROWS),
      mag: this.mag ? this.mag.slice(f0 * BINS, f1 * BINS) : null,
      phase: this.phase ? this.phase.slice(f0 * BINS, f1 * BINS) : null,
    }
  }

  private writeTile(t: number, tile: Tile) {
    const f0 = t * TILE
    this.paint.set(tile.paint, f0 * ROWS)
    if (this.mag && tile.mag) this.mag.set(tile.mag, f0 * BINS)
    if (this.phase && tile.phase) this.phase.set(tile.phase, f0 * BINS)
  }

  /** Whole-document edit as a single undo step. */
  private bulk(fn: () => void): [number, number] {
    const own = !this.stroke
    if (own) this.beginStroke()
    this.touch(0, this.frames - 1)
    fn()
    if (own) this.endStroke()
    return [0, this.frames - 1]
  }

  clearPaint() {
    return this.bulk(() => this.paint.fill(0))
  }

  revertSample() {
    return this.bulk(() => {
      if (this.mag && this.origMag) this.mag.set(this.origMag)
      if (this.phase && this.origPhase) this.phase.set(this.origPhase)
    })
  }

  setPaint(values: Float32Array) {
    return this.bulk(() => this.paint.set(values))
  }

  // --- tools ----------------------------------------------------------------

  dab(d: Dab): [number, number] | null {
    const rx = Math.max(0.75, d.rx)
    const ry = d.pure ? 0.6 : Math.max(0.6, d.ry)
    const f0 = Math.max(0, Math.ceil(d.cx - rx))
    const f1 = Math.min(this.frames - 1, Math.floor(d.cx + rx))
    if (f0 > f1) return null
    this.touch(f0, f1)
    const s = d.strength

    switch (d.tool) {
      case 'brush':
        this.paintAdd(f0, f1, d.cx, d.cy, rx, ry, s)
        break
      case 'harmonic':
        // fundamental + overtones at f·h, each quieter: one stroke = one rich tone
        for (let h = 1; h <= d.harmonics; h++) {
          const y = d.cy + 12 * Math.log2(h) * ROWS_PER_SEMITONE
          if (y > ROWS) break
          this.paintAdd(f0, f1, d.cx, d.pure ? Math.round(y) : y, rx, ry, s * h ** -0.8)
        }
        break
      case 'erase':
        this.eachCell(f0, f1, d.cx, d.cy, rx, ry, (i, w) => {
          this.paint[i] *= 1 - w * s * 0.6
        })
        this.eachBin(f0, f1, d.cx, d.cy, rx, ry, (i, w) => {
          this.mag![i] *= 1 - w * s * 0.6
        })
        break
      case 'restore':
        this.eachBin(f0, f1, d.cx, d.cy, rx, ry, (i, w) => {
          const a = w * s * 0.6
          this.mag![i] += (this.origMag![i] - this.mag![i]) * a
          if (a > 0.3) this.phase![i] = this.origPhase![i]
        })
        break
      case 'smudge':
        this.smudge(f0, f1, d, rx, ry)
        break
    }
    return [f0, f1]
  }

  /** Raise painted values toward `target` (repeated dabs converge, never overshoot). */
  private paintAdd(f0: number, f1: number, cx: number, cy: number, rx: number, ry: number, target: number) {
    this.eachCell(f0, f1, cx, cy, rx, ry, (i, w) => {
      const p = this.paint[i]
      if (p < target) this.paint[i] = p + (target - p) * w * FLOW
    })
  }

  /** Drag content along the stroke direction, on both layers. */
  private smudge(f0: number, f1: number, d: Dab, rx: number, ry: number) {
    const amount = d.strength * 0.85
    const idx: number[] = []
    const val: number[] = []
    this.eachCell(f0, f1, d.cx, d.cy, rx, ry, (i, w, f, r) => {
      const sf = Math.round(f - d.dx)
      const sr = Math.round(r - d.dy)
      if (sf < 0 || sf >= this.frames || sr < 0 || sr >= ROWS) return
      const cur = this.paint[i]
      idx.push(i)
      val.push(cur + (this.paint[sf * ROWS + sr] - cur) * w * amount)
    })
    for (let j = 0; j < idx.length; j++) this.paint[idx[j]] = val[j]

    if (!this.mag || !this.phase) return
    const mag = this.mag
    const phase = this.phase
    const df = this.sr / N
    const pIdx: number[] = []
    const pVal: number[] = []
    idx.length = 0
    val.length = 0
    this.eachBin(f0, f1, d.cx, d.cy, rx, ry, (i, w, f, k) => {
      const sf = Math.round(f - d.dx)
      const sk = Math.round(yToFreq(this.binY[k] - d.dy) / df)
      if (sf < 0 || sf >= this.frames || sk < 1 || sk >= BINS) return
      const src = sf * BINS + sk
      const a = w * amount
      idx.push(i)
      val.push(mag[i] + (mag[src] - mag[i]) * a)
      if (a > 0.5) {
        // moving content m frames later in time advances its phase by 2π·k·m·HOP/N
        pIdx.push(i)
        pVal.push(phase[src] + (2 * Math.PI * k * (f - sf) * HOP) / N)
      }
    })
    for (let j = 0; j < idx.length; j++) mag[idx[j]] = val[j]
    for (let j = 0; j < pIdx.length; j++) phase[pIdx[j]] = pVal[j]
  }

  /** Visit paint cells under an elliptical brush with a smooth (1-d²)² falloff. */
  private eachCell(
    f0: number, f1: number, cx: number, cy: number, rx: number, ry: number,
    fn: (i: number, w: number, f: number, r: number) => void,
  ) {
    const r0 = Math.max(0, Math.ceil(cy - ry))
    const r1 = Math.min(ROWS - 1, Math.floor(cy + ry))
    for (let f = f0; f <= f1; f++) {
      const ax = (f - cx) / rx
      const ax2 = ax * ax
      if (ax2 >= 1) continue
      for (let r = r0; r <= r1; r++) {
        const ay = (r - cy) / ry
        const d2 = ax2 + ay * ay
        if (d2 >= 1) continue
        const q = 1 - d2
        fn(f * ROWS + r, q * q, f, r)
      }
    }
  }

  /** Visit sample-layer FFT bins under the brush (in musical row space). */
  private eachBin(
    f0: number, f1: number, cx: number, cy: number, rx: number, ry: number,
    fn: (i: number, w: number, f: number, k: number) => void,
  ) {
    if (!this.mag) return
    const df = this.sr / N
    const k0 = Math.max(1, Math.floor(yToFreq(cy - ry - 3) / df))
    const k1 = Math.min(BINS - 1, Math.ceil(yToFreq(cy + ry + 3) / df))
    for (let f = f0; f <= f1; f++) {
      const ax = (f - cx) / rx
      const ax2 = ax * ax
      if (ax2 >= 1) continue
      for (let k = k0; k <= k1; k++) {
        const ay = Math.max(0, Math.abs(this.binY[k] - cy) - this.binHalf[k]) / ry
        const d2 = ax2 + ay * ay
        if (d2 >= 1) continue
        const q = 1 - d2
        fn(f * BINS + k, q * q, f, k)
      }
    }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
