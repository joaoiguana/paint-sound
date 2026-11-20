// A starter sketch painted through the same tool API the mouse uses,
// so you hear something the moment you press play.
import { HOP, midiToY } from '../dsp/constants.ts'
import type { Dab, SpectroModel } from './model.ts'

export function paintDemo(m: SpectroModel) {
  const fps = m.sr / HOP
  const stroke = (t0: number, t1: number, y0: number, y1: number, d: Partial<Dab>, decay = 0.5) => {
    const steps = Math.ceil((t1 - t0) * fps * 2)
    for (let s = 0; s <= steps; s++) {
      const u = s / steps
      m.dab({
        tool: 'harmonic', cx: (t0 + (t1 - t0) * u) * fps, cy: y0 + (y1 - y0) * u,
        rx: 1.5, ry: 0.6, strength: 0.9, harmonics: 8, pure: true, dx: 0, dy: 0,
        ...d,
        ...(d.strength !== undefined ? {} : { strength: 0.9 * (1 - decay * u) }),
      })
    }
  }
  const sec = m.seconds

  // chord pad: C – Am – F – G, built from harmonic-brush strokes
  const chords = [[48, 52, 55], [45, 48, 52], [41, 45, 48], [43, 47, 50]]
  const len = sec / chords.length
  chords.forEach((notes, i) =>
    notes.forEach((n) => stroke(i * len + 0.02, (i + 0.92) * len, midiToY(n), midiToY(n), { harmonics: 6 }, 0.6)),
  )

  // melody: plain pure sines an octave up
  const melody = [72, 76, 79, 76, 72, 76, 81, 79, 77, 81, 84, 81, 79, 74, 71, 74]
  const step = sec / melody.length
  melody.forEach((n, i) =>
    stroke(i * step, i * step + step * 0.7, midiToY(n), midiToY(n), { tool: 'brush' }, 0.8),
  )

  // a breathy noise swoosh at the end: thick, un-snapped brush = band of noise
  stroke(sec * 0.78, sec * 0.98, midiToY(84), midiToY(108), { tool: 'brush', pure: false, ry: 7, strength: 0.35 })
}
