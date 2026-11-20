// Shared DSP constants and the time/frequency <-> canvas mapping.
//
// Time:      one canvas column = one STFT frame = HOP samples.
//            Frame i is centred on sample i * HOP.
// Frequency: the canvas is laid out on a *musical* (log) axis.
//            Row y corresponds to MIDI note MIDI_LOW + y / ROWS_PER_SEMITONE,
//            so every 5th row is exactly an equal-tempered note.

export const N = 2048 // FFT size (window length)
export const HOP = 512 // hop size: 75% overlap with a Hann window
export const BINS = N / 2 + 1 // number of non-redundant FFT bins

export const ROWS_PER_SEMITONE = 5
export const MIDI_LOW = 24 // C1 ≈ 32.7 Hz
export const SEMITONES = 108 // 9 octaves -> up to C10 ≈ 16.7 kHz
export const ROWS = SEMITONES * ROWS_PER_SEMITONE // 540 oscillator rows / canvas pixels

export const ROW_GAIN = 0.15 // amplitude of one fully painted oscillator row
export const MAX_SECONDS = 60

export const yToMidi = (y: number) => MIDI_LOW + y / ROWS_PER_SEMITONE
export const midiToY = (m: number) => (m - MIDI_LOW) * ROWS_PER_SEMITONE
export const midiToFreq = (m: number) => 440 * 2 ** ((m - 69) / 12)
export const freqToMidi = (f: number) => 69 + 12 * Math.log2(f / 440)
export const yToFreq = (y: number) => midiToFreq(yToMidi(y))
export const freqToY = (f: number) => midiToY(freqToMidi(f))

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export function noteName(midi: number): string {
  const m = Math.round(midi)
  const cents = Math.round((midi - m) * 100)
  const base = `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`
  return cents === 0 ? base : `${base} ${cents > 0 ? '+' : ''}${cents}¢`
}

export const SCALES = {
  off: null,
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
} as const
export type ScaleName = keyof typeof SCALES

/** Snap a canvas row position to the nearest note of a scale (C-rooted). */
export function snapY(y: number, scale: readonly number[]): number {
  const midi = yToMidi(y)
  let best = Math.round(midi)
  let bestDist = Infinity
  for (let m = Math.round(midi) - 6; m <= Math.round(midi) + 6; m++) {
    if (!scale.includes(((m % 12) + 12) % 12)) continue
    const d = Math.abs(m - midi)
    if (d < bestDist) {
      bestDist = d
      best = m
    }
  }
  return midiToY(best)
}
