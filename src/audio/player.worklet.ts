// AudioWorklet: runs on the real-time audio thread.
// It is deliberately dumb: it plays a mono buffer that the main thread keeps
// patching as the worker re-renders edited regions, so you hear edits while playing.

declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

type Msg =
  | { type: 'load'; data: Float32Array }
  | { type: 'patch'; offset: number; data: Float32Array }
  | { type: 'play'; from: number }
  | { type: 'stop' }
  | { type: 'seek'; pos: number }
  | { type: 'loop'; loop: boolean }

const FADE_STEP = 1 / 256 // ~5 ms fade in/out to avoid clicks

class PlayerProcessor extends AudioWorkletProcessor {
  private buf: Float32Array = new Float32Array(0)
  private pos = 0
  private playing = false
  private loop = false
  private gain = 0
  private target = 0
  private tick = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<Msg>) => this.onMessage(e.data)
  }

  private onMessage(m: Msg) {
    switch (m.type) {
      case 'load':
        this.buf = m.data
        if (this.pos >= this.buf.length) this.pos = 0
        break
      case 'patch': {
        const room = this.buf.length - m.offset
        if (room > 0) this.buf.set(room < m.data.length ? m.data.subarray(0, room) : m.data, m.offset)
        break
      }
      case 'play':
        this.pos = Math.min(m.from, this.buf.length)
        this.playing = true
        this.target = 1
        break
      case 'stop':
        this.target = 0
        break
      case 'seek':
        this.pos = Math.max(0, Math.min(m.pos, this.buf.length))
        break
      case 'loop':
        this.loop = m.loop
        break
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const left = out[0]
    if (!left) return true
    for (let i = 0; i < left.length; i++) {
      if (!this.playing) {
        left[i] = 0
        continue
      }
      this.gain =
        this.gain < this.target
          ? Math.min(this.target, this.gain + FADE_STEP)
          : Math.max(this.target, this.gain - FADE_STEP)
      if (this.pos >= this.buf.length) {
        if (this.loop && this.buf.length) this.pos = 0
        else {
          this.playing = false
          this.gain = 0
          this.port.postMessage({ type: 'ended' })
          left[i] = 0
          continue
        }
      }
      left[i] = this.buf[this.pos++] * this.gain
      if (this.target === 0 && this.gain === 0) {
        this.playing = false
        this.port.postMessage({ type: 'pos', pos: this.pos })
      }
    }
    for (let c = 1; c < out.length; c++) out[c].set(left)
    if (this.playing && ++this.tick % 6 === 0) this.port.postMessage({ type: 'pos', pos: this.pos })
    return true
  }
}

registerProcessor('paint-sound-player', PlayerProcessor)
