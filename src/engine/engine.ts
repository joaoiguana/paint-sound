// Orchestrates: model (main thread) -> worker (DSP) -> worklet (playback).
//
//   brush dab ──► model.dab() ──► markDirty(frames)
//                                   ├─► display listeners (redraw columns, next rAF)
//                                   └─► render queue ──► worker renders just that
//                                        time range ──► patch audio + worklet buffer
//
import workletUrl from '../audio/player.worklet.ts?worker&url'
import { BINS, HOP, MAX_SECONDS, N, ROWS } from '../dsp/constants.ts'
import type { WorkerReply, WorkerRequest } from '../dsp/protocol.ts'
import { paintDemo } from './demo.ts'
import { SpectroModel, type Dab } from './model.ts'
import { download, encodeWav } from './wav.ts'

export interface EngineState {
  ready: boolean
  playing: boolean
  loop: boolean
  rendering: boolean
  busy: string | null
  error: string | null
  modelVersion: number
  seconds: number
  hasSample: boolean
  canUndo: boolean
  canRedo: boolean
  title: string
}

type Range = [number, number]
const CHUNK_SECONDS = 1.5 // big re-renders are split so playback updates progressively

export class Engine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' })
  model: SpectroModel
  /** The rendered output, mirrored inside the worklet. */
  private audio: Float32Array
  private node: AudioWorkletNode | null = null
  private readonly worker = new Worker(new URL('../dsp/dsp.worker.ts', import.meta.url), { type: 'module' })
  private gen = 0 // bumps on new document; stale worker results are dropped
  private nextId = 1
  private dirty: Range | null = null
  private inflight = false
  private displayDirty: Range | null = null
  private rafPending = false
  private flushWaiters: (() => void)[] = []
  private analyzeWaiters = new Map<number, (r: { mag: Float32Array; phase: Float32Array }) => void>()
  position = 0 // playhead in samples
  private canvas: HTMLCanvasElement | null = null

  private state: EngineState
  private listeners = new Set<() => void>()
  private displayListeners = new Set<(f0: number, f1: number) => void>()
  private positionListeners = new Set<(pos: number) => void>()

  constructor() {
    const sr = this.ctx.sampleRate
    this.model = new SpectroModel(sr, 8 * sr)
    this.audio = new Float32Array(this.model.length)
    this.state = this.snapshot({ ready: false, playing: false, loop: true, rendering: false, busy: null, error: null, modelVersion: 0, title: 'Demo sketch' })
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onWorker(e.data)
    this.worker.onerror = (e) => this.set({ error: `Worker error: ${e.message}` })
    paintDemo(this.model)
    this.markDirty(0, this.model.frames - 1)
    this.init().catch((err) => this.set({ error: `Audio init failed: ${err}` }))
  }

  private async init() {
    await this.ctx.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(this.ctx, 'paint-sound-player', { outputChannelCount: [2] })
    node.connect(this.ctx.destination)
    node.port.onmessage = (e) => {
      const m = e.data as { type: string; pos?: number }
      if (m.type === 'pos') this.setPosition(m.pos!)
      if (m.type === 'ended') {
        this.set({ playing: false })
        this.setPosition(0)
      }
    }
    this.node = node
    node.port.postMessage({ type: 'loop', loop: this.state.loop })
    node.port.postMessage({ type: 'load', data: this.audio.slice() })
    this.set({ ready: true })
  }

  // --- React-facing store ---------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getState = () => this.state
  onDisplay(fn: (f0: number, f1: number) => void) {
    this.displayListeners.add(fn)
    return () => void this.displayListeners.delete(fn)
  }
  onPosition(fn: (pos: number) => void) {
    this.positionListeners.add(fn)
    return () => void this.positionListeners.delete(fn)
  }

  private snapshot(base: Partial<EngineState>): EngineState {
    const m = this.model
    return {
      ...(this.state ?? {}),
      ...base,
      seconds: m.seconds,
      hasSample: m.hasSample,
      canUndo: m.canUndo,
      canRedo: m.canRedo,
    } as EngineState
  }
  private set(patch: Partial<EngineState>) {
    this.state = this.snapshot(patch)
    this.listeners.forEach((l) => l())
  }
  private setPosition(pos: number) {
    this.position = pos
    this.positionListeners.forEach((l) => l(pos))
  }

  // --- editing --------------------------------------------------------------

  beginStroke() {
    this.model.beginStroke()
  }
  dab(d: Dab) {
    const r = this.model.dab(d)
    if (r) this.markDirty(r[0], r[1])
  }
  endStroke() {
    this.model.endStroke()
    this.set({})
  }
  undo() {
    this.apply(this.model.undo())
  }
  redo() {
    this.apply(this.model.redo())
  }
  clearPaint() {
    this.apply(this.model.clearPaint())
  }
  revertSample() {
    this.apply(this.model.revertSample())
  }
  private apply(r: Range | null) {
    if (r) this.markDirty(r[0], r[1])
    this.set({})
  }

  private markDirty(f0: number, f1: number) {
    this.dirty = union(this.dirty, [f0, f1])
    this.displayDirty = union(this.displayDirty, [f0, f1])
    if (!this.rafPending) {
      this.rafPending = true
      requestAnimationFrame(() => {
        this.rafPending = false
        const d = this.displayDirty
        this.displayDirty = null
        if (d) this.displayListeners.forEach((l) => l(d[0], d[1]))
      })
    }
    this.kick()
  }

  // --- render scheduling ----------------------------------------------------

  /** Send the next dirty chunk to the worker (one request in flight at a time). */
  private kick(): void {
    if (this.inflight) return
    if (!this.dirty) {
      if (this.state.rendering) this.set({ rendering: false })
      this.flushWaiters.splice(0).forEach((w) => w())
      return
    }
    const m = this.model
    const fa = this.dirty[0]
    let fb = this.dirty[1]
    const chunk = Math.ceil((CHUNK_SECONDS * m.sr) / HOP)
    if (fb - fa > chunk) {
      this.dirty = [fa + chunk + 1, fb]
      fb = fa + chunk
    } else this.dirty = null

    // Which output samples can a change in frames [fa, fb] affect?
    //  - paint: amplitudes are interpolated between neighbouring frames (±HOP)
    //  - sample layer: each frame's window spans ±N/2 samples
    const s0 = Math.max(0, fa * HOP - N / 2 - HOP)
    const s1 = Math.min(m.length, fb * HOP + N / 2 + HOP)
    if (s1 <= s0) return this.kick()
    // ...and which frames are needed to recompute those samples?
    const p0 = Math.floor(s0 / HOP)
    const p1 = Math.min(m.frames - 1, Math.floor((s1 - 1) / HOP) + 1)
    const i0 = Math.max(0, Math.floor((s0 - N / 2) / HOP) + 1)
    const i1 = Math.min(m.frames - 1, Math.ceil((s1 + N / 2) / HOP) - 1)

    const req: WorkerRequest = {
      type: 'render', id: this.nextId++, gen: this.gen, sr: m.sr, s0, s1,
      paintFrame0: p0, paintFrames: p1 - p0 + 1, paint: m.paint.slice(p0 * ROWS, (p1 + 1) * ROWS),
      specFrame0: i0, specFrames: i1 - i0 + 1,
      mag: m.mag ? m.mag.slice(i0 * BINS, (i1 + 1) * BINS) : null,
      phase: m.phase ? m.phase.slice(i0 * BINS, (i1 + 1) * BINS) : null,
    }
    const transfer = [req.paint.buffer, req.mag?.buffer, req.phase?.buffer].filter(Boolean) as ArrayBuffer[]
    this.inflight = true
    if (!this.state.rendering) this.set({ rendering: true })
    this.worker.postMessage(req, transfer)
  }

  private onWorker(msg: WorkerReply) {
    if (msg.type === 'analyzed') {
      this.analyzeWaiters.get(msg.id)?.(msg)
      this.analyzeWaiters.delete(msg.id)
      return
    }
    this.inflight = false
    if (msg.gen === this.gen) {
      this.audio.set(msg.data, msg.s0)
      this.node?.port.postMessage({ type: 'patch', offset: msg.s0, data: msg.data }, [msg.data.buffer])
    }
    this.kick()
  }

  /** Resolves once every pending edit has been rendered to audio. */
  flush() {
    return new Promise<void>((resolve) => {
      if (!this.inflight && !this.dirty) resolve()
      else this.flushWaiters.push(resolve)
    })
  }

  // --- transport ------------------------------------------------------------

  async play() {
    await this.ctx.resume()
    const from = this.position >= this.model.length - 1 ? 0 : this.position
    this.node?.port.postMessage({ type: 'play', from })
    this.set({ playing: true })
  }
  stop() {
    this.node?.port.postMessage({ type: 'stop' })
    this.set({ playing: false })
  }
  toggle() {
    if (this.state.playing) this.stop()
    else void this.play()
  }
  seek(sample: number) {
    const pos = Math.max(0, Math.min(this.model.length, Math.round(sample)))
    this.node?.port.postMessage({ type: 'seek', pos })
    this.setPosition(pos)
  }
  setLoop(loop: boolean) {
    this.node?.port.postMessage({ type: 'loop', loop })
    this.set({ loop })
  }

  // --- documents ------------------------------------------------------------

  private replaceModel(model: SpectroModel, audio: Float32Array, title: string) {
    this.stop()
    this.gen++
    this.model = model
    this.audio = audio
    this.dirty = null
    this.displayDirty = null
    this.node?.port.postMessage({ type: 'load', data: audio.slice() })
    this.setPosition(0)
    this.set({ modelVersion: this.state.modelVersion + 1, title, error: null })
  }

  newBlank(seconds: number, demo = false) {
    const sr = this.ctx.sampleRate
    const model = new SpectroModel(sr, Math.round(seconds * sr))
    this.replaceModel(model, new Float32Array(model.length), demo ? 'Demo sketch' : 'Untitled')
    if (demo) {
      paintDemo(model)
      this.markDirty(0, model.frames - 1)
    }
  }

  async loadFile(file: File) {
    if (file.type.startsWith('image/')) return this.loadImage(file)
    try {
      this.set({ busy: `Decoding ${file.name}…`, error: null })
      const decoded = await this.ctx.decodeAudioData(await file.arrayBuffer())
      const sr = this.ctx.sampleRate // decodeAudioData resamples to the context rate
      const len = Math.min(decoded.length, MAX_SECONDS * sr)
      const mono = new Float32Array(len)
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        const ch = decoded.getChannelData(c)
        for (let i = 0; i < len; i++) mono[i] += ch[i] / decoded.numberOfChannels
      }
      this.set({ busy: 'Analysing spectrum (STFT)…' })
      const id = this.nextId++
      const spec = await new Promise<{ mag: Float32Array; phase: Float32Array }>((resolve) => {
        this.analyzeWaiters.set(id, resolve)
        const copy = mono.slice()
        this.worker.postMessage({ type: 'analyze', id, samples: copy } satisfies WorkerRequest, [copy.buffer])
      })
      // Unedited audio is the original itself: ISTFT(STFT(x)) ≈ x, so only edits get re-rendered.
      this.replaceModel(new SpectroModel(sr, len, spec), mono, file.name)
      if (decoded.length > len) this.set({ error: `Trimmed to the first ${MAX_SECONDS}s.` })
    } catch (err) {
      this.set({ error: `Could not load ${file.name}: ${err}` })
    } finally {
      this.set({ busy: null })
    }
  }

  /** Paint an image into the paint layer: brightness = loudness, top = high pitch. */
  async loadImage(file: File) {
    try {
      const bmp = await createImageBitmap(file)
      const m = this.model
      const c = new OffscreenCanvas(m.frames, m.rows)
      const g = c.getContext('2d')!
      g.drawImage(bmp, 0, 0, m.frames, m.rows)
      const px = g.getImageData(0, 0, m.frames, m.rows).data
      const values = new Float32Array(m.frames * m.rows)
      for (let f = 0; f < m.frames; f++) {
        for (let r = 0; r < m.rows; r++) {
          const i = ((m.rows - 1 - r) * m.frames + f) * 4
          const lum = ((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255) * (px[i + 3] / 255)
          values[f * m.rows + r] = lum < 0.12 ? 0 : ((lum - 0.12) / 0.88) ** 1.5
        }
      }
      this.apply(m.setPaint(values))
    } catch (err) {
      this.set({ error: `Could not load image: ${err}` })
    }
  }

  async exportWav() {
    this.set({ busy: 'Rendering…' })
    await this.flush()
    download(encodeWav(this.audio, this.model.sr), `${baseName(this.state.title)}.wav`)
    this.set({ busy: null })
  }

  setCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  exportPng() {
    this.canvas?.toBlob((b) => b && download(b, `${baseName(this.state.title)}.png`))
  }
}

const union = (a: Range | null, b: Range): Range => (a ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : b)
const baseName = (s: string) => s.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-') || 'paint-sound'

let instance: Engine | null = null
export const getEngine = () => (instance ??= new Engine())
