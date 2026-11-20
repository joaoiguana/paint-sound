import type { ScaleName } from './dsp/constants.ts'
import type { Tool } from './engine/model.ts'

export interface Settings {
  tool: Tool
  size: number // brush diameter, css px
  strength: number
  harmonics: number
  snap: ScaleName
}

export const DEFAULT_SETTINGS: Settings = {
  tool: 'harmonic',
  size: 12,
  strength: 0.8,
  harmonics: 8,
  snap: 'pentatonic',
}

export const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'brush', label: 'Brush', key: 'b', hint: 'Paint sine tones (snapped) or noise bands (snap off, big brush)' },
  { id: 'harmonic', label: 'Harmonic', key: 'h', hint: 'Paint a note with its overtones: one stroke = one rich tone' },
  { id: 'erase', label: 'Erase', key: 'e', hint: 'Remove energy from paint and from the loaded sample' },
  { id: 'smudge', label: 'Smudge', key: 's', hint: 'Drag sound around: smear a pad in time, bend pitch' },
  { id: 'restore', label: 'Restore', key: 'r', hint: 'Paint the original sample back in' },
]
