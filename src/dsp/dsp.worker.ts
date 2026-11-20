// DSP worker: heavy lifting off the UI thread. Stateless: each request carries
// exactly the spectrogram slice it needs, so there is no shared state to sync.
import type { WorkerReply, WorkerRequest } from './protocol.ts'
import { renderSegment, stft } from './synth.ts'

const reply = (msg: WorkerReply, transfer: Transferable[]) => self.postMessage(msg, { transfer })

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'analyze') {
    const { frames, mag, phase } = stft(msg.samples)
    reply({ type: 'analyzed', id: msg.id, frames, mag, phase }, [mag.buffer, phase.buffer])
  } else if (msg.type === 'render') {
    const data = renderSegment(msg)
    reply({ type: 'rendered', id: msg.id, gen: msg.gen, s0: msg.s0, data }, [data.buffer])
  }
}
