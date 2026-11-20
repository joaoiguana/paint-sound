// Turns the model into pixels. Canvas is frames wide × ROWS tall; only dirty
// columns are redrawn, so painting stays cheap even on long files.
import { BINS, N } from '../dsp/constants.ts'
import type { SpectroModel } from './model.ts'

const lut = (stops: number[][]) => {
  const out = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1)
    const a = Math.floor(t)
    const b = Math.min(stops.length - 1, a + 1)
    const f = t - a
    for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[a][c] + (stops[b][c] - stops[a][c]) * f
  }
  return out
}

// sample layer: magma-like; paint layer: cyan ink
const SAMPLE_LUT = lut([
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129],
  [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191],
])
const PAINT_LUT = lut([[0, 90, 110], [0, 190, 210], [120, 240, 255], [235, 255, 255]])

const DB_RANGE = 80
const MAG_NORM = 1 / (N / 4) // a full-scale sine -> 0 dB

export function drawColumns(m: SpectroModel, img: ImageData, f0: number, f1: number) {
  const { rows, paint, mag, binLo, binHi } = m
  const px = img.data
  const w = img.width
  for (let f = f0; f <= f1; f++) {
    for (let r = 0; r < rows; r++) {
      let R = 8, G = 8, B = 14
      if (r % 60 === 0) { R = 34; G = 34; B = 48 } // faint line at every C

      if (mag) {
        let peak = 0
        const o = f * BINS
        for (let k = binLo[r]; k <= binHi[r]; k++) if (mag[o + k] > peak) peak = mag[o + k]
        const db = 20 * Math.log10(peak * MAG_NORM + 1e-12)
        const v = Math.min(1, Math.max(0, (db + DB_RANGE) / DB_RANGE))
        if (v > 0) {
          const i = (v * 255) | 0
          R = Math.max(R, SAMPLE_LUT[i * 3]); G = Math.max(G, SAMPLE_LUT[i * 3 + 1]); B = Math.max(B, SAMPLE_LUT[i * 3 + 2])
        }
      }

      const p = paint[f * rows + r]
      if (p > 0) {
        const i = (Math.min(1, p) * 255) | 0
        const a = Math.min(1, p * 1.6)
        R += (PAINT_LUT[i * 3] - R) * a
        G += (PAINT_LUT[i * 3 + 1] - G) * a
        B += (PAINT_LUT[i * 3 + 2] - B) * a
      }

      const idx = ((rows - 1 - r) * w + f) * 4
      px[idx] = R
      px[idx + 1] = G
      px[idx + 2] = B
      px[idx + 3] = 255
    }
  }
}
