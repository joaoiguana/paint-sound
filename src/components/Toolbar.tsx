import { useRef, useState } from 'react'
import { SCALES, type ScaleName } from '../dsp/constants.ts'
import type { Engine, EngineState } from '../engine/engine.ts'
import { TOOLS, type Settings } from '../settings.ts'

interface Props {
  engine: Engine
  state: EngineState
  settings: Settings
  onChange: (s: Partial<Settings>) => void
}

export function Toolbar({ engine, state, settings, onChange }: Props) {
  const audioInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const [newSecs, setNewSecs] = useState(8)
  const pitched = settings.tool === 'brush' || settings.tool === 'harmonic'

  return (
    <header className="toolbar">
      <div className="group">
        <button className="primary" onClick={() => engine.toggle()} disabled={!state.ready} title="Space">
          {state.playing ? '■ Stop' : '▶ Play'}
        </button>
        <label className="check">
          <input type="checkbox" checked={state.loop} onChange={(e) => engine.setLoop(e.target.checked)} /> Loop
        </label>
      </div>

      <div className="group tools" role="radiogroup" aria-label="Tool">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={settings.tool === t.id}
            className={settings.tool === t.id ? 'active' : ''}
            disabled={t.id === 'restore' && !state.hasSample}
            title={`${t.hint} (${t.key.toUpperCase()})`}
            onClick={() => onChange({ tool: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="group">
        <label>
          Size
          <input type="range" min={2} max={80} value={settings.size} onChange={(e) => onChange({ size: +e.target.value })} />
        </label>
        <label>
          Strength
          <input type="range" min={0.05} max={1} step={0.05} value={settings.strength} onChange={(e) => onChange({ strength: +e.target.value })} />
        </label>
        {settings.tool === 'harmonic' && (
          <label>
            Harmonics {settings.harmonics}
            <input type="range" min={1} max={16} value={settings.harmonics} onChange={(e) => onChange({ harmonics: +e.target.value })} />
          </label>
        )}
        <label className={pitched ? '' : 'dim'} title="Snapped strokes land exactly on notes as pure tones">
          Snap
          <select value={settings.snap} onChange={(e) => onChange({ snap: e.target.value as ScaleName })}>
            {Object.keys(SCALES).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="group">
        <button onClick={() => engine.undo()} disabled={!state.canUndo} title="Ctrl+Z">Undo</button>
        <button onClick={() => engine.redo()} disabled={!state.canRedo} title="Ctrl+Shift+Z">Redo</button>
        <button onClick={() => engine.clearPaint()} title="Remove all painted strokes">Clear paint</button>
        {state.hasSample && <button onClick={() => engine.revertSample()} title="Undo all edits to the sample">Revert sample</button>}
      </div>

      <div className="group">
        <select value={newSecs} onChange={(e) => setNewSecs(+e.target.value)} aria-label="New canvas length">
          {[4, 8, 16, 30].map((s) => <option key={s} value={s}>{s}s</option>)}
        </select>
        <button onClick={() => engine.newBlank(newSecs)}>New</button>
        <button onClick={() => engine.newBlank(newSecs, true)}>Demo</button>
        <button onClick={() => audioInput.current?.click()} title="Or drop a file on the canvas">Load audio…</button>
        <button onClick={() => imageInput.current?.click()} title="Brightness becomes loudness, top = high pitch">Load image…</button>
        <button onClick={() => void engine.exportWav()}>Export WAV</button>
        <button onClick={() => engine.exportPng()}>Export PNG</button>
        <input ref={audioInput} type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void engine.loadFile(f); e.target.value = '' }} />
        <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void engine.loadImage(f); e.target.value = '' }} />
      </div>
    </header>
  )
}
