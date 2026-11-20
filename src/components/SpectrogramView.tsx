import { useEffect, useRef } from 'react'
import { HOP, SCALES, midiToY, noteName, snapY, yToFreq, yToMidi } from '../dsp/constants.ts'
import { drawColumns } from '../engine/display.ts'
import type { Engine, EngineState } from '../engine/engine.ts'
import type { Settings } from '../settings.ts'

interface Props {
  engine: Engine
  state: EngineState
  settings: Settings
}

interface Point {
  fx: number // frames
  fy: number // rows
  px: number // css pixels (for even dab spacing)
  py: number
}

const OCTAVE_LABELS = Array.from({ length: 10 }, (_, i) => i + 1) // C1 … C10

export function SpectrogramView({ engine, state, settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const rulerHeadRef = useRef<HTMLDivElement>(null)
  const readoutRef = useRef<HTMLSpanElement>(null)
  const last = useRef<Point | null>(null)
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // (Re)build the canvas whenever a new document is loaded, then redraw dirty columns only.
  useEffect(() => {
    const canvas = canvasRef.current!
    const m = engine.model
    canvas.width = m.frames
    canvas.height = m.rows
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(m.frames, m.rows)
    drawColumns(m, img, 0, m.frames - 1)
    ctx.putImageData(img, 0, 0)
    engine.setCanvas(canvas)
    return engine.onDisplay((f0, f1) => {
      drawColumns(m, img, f0, f1)
      ctx.putImageData(img, 0, 0, f0, 0, f1 - f0 + 1, m.rows)
    })
  }, [engine, state.modelVersion])

  // Playhead: updated straight on the DOM, no React re-render per audio tick.
  useEffect(() => {
    const move = (pos: number) => {
      const pct = `${(pos / engine.model.length) * 100}%`
      if (playheadRef.current) playheadRef.current.style.left = pct
      if (rulerHeadRef.current) rulerHeadRef.current.style.left = pct
    }
    move(engine.position)
    return engine.onPosition(move)
  }, [engine, state.modelVersion])

  const toPoint = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const m = engine.model
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    return { px, py, fx: (px / rect.width) * m.frames - 0.5, fy: m.rows - 0.5 - (py / rect.height) * m.rows }
  }

  const dabAt = (p: Point, prev: Point) => {
    const s = settingsRef.current
    const rect = canvasRef.current!.getBoundingClientRect()
    const m = engine.model
    const scale = SCALES[s.snap]
    const pitched = s.tool === 'brush' || s.tool === 'harmonic'
    const pure = pitched && scale !== null
    engine.dab({
      tool: s.tool,
      cx: p.fx,
      cy: pure ? snapY(p.fy, scale) : p.fy,
      rx: ((s.size / 2) * m.frames) / rect.width,
      ry: ((s.size / 2) * m.rows) / rect.height,
      strength: s.strength,
      harmonics: s.harmonics,
      pure,
      dx: p.fx - prev.fx,
      dy: p.fy - prev.fy,
    })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toPoint(e)
    engine.beginStroke()
    dabAt(p, p)
    last.current = p
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toPoint(e)
    const m = engine.model
    const midi = yToMidi(p.fy)
    if (readoutRef.current) {
      const t = Math.max(0, ((p.fx + 0.5) * HOP) / m.sr)
      readoutRef.current.textContent = `${t.toFixed(2)} s · ${yToFreq(p.fy).toFixed(1)} Hz · ${noteName(midi)}`
    }
    const prev = last.current
    if (!prev) return
    // interpolate dabs so fast strokes stay continuous
    const dist = Math.hypot(p.px - prev.px, p.py - prev.py)
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, settingsRef.current.size * 0.2)))
    let q0 = prev
    for (let i = 1; i <= steps; i++) {
      const u = i / steps
      const q: Point = {
        px: prev.px + (p.px - prev.px) * u,
        py: prev.py + (p.py - prev.py) * u,
        fx: prev.fx + (p.fx - prev.fx) * u,
        fy: prev.fy + (p.fy - prev.fy) * u,
      }
      dabAt(q, q0)
      q0 = q
    }
    last.current = p
  }

  const endStroke = () => {
    if (!last.current) return
    last.current = null
    engine.endStroke()
  }

  const seekFromRuler = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1 && e.type !== 'pointerdown') return
    const rect = e.currentTarget.getBoundingClientRect()
    engine.seek(((e.clientX - rect.left) / rect.width) * engine.model.length)
  }

  const secs = state.seconds
  const tickEvery = secs > 30 ? 5 : secs > 12 ? 2 : 1
  const ticks = Array.from({ length: Math.floor(secs / tickEvery) + 1 }, (_, i) => i * tickEvery)
  const rows = engine.model.rows

  return (
    <div
      className="stage"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const f = e.dataTransfer.files[0]
        if (f) void engine.loadFile(f)
      }}
    >
      <div className="corner">
        <span ref={readoutRef} className="readout" />
      </div>
      <div className="ruler" onPointerDown={seekFromRuler} onPointerMove={seekFromRuler} title="Click / drag to seek">
        {ticks.map((t) => (
          <span key={t} className="tick" style={{ left: `${(t / secs) * 100}%` }}>
            {t}s
          </span>
        ))}
        <div ref={rulerHeadRef} className="ruler-head" />
      </div>
      <div className="axis">
        {OCTAVE_LABELS.map((o) => {
          const y = midiToY(12 * (o + 1))
          if (y >= rows) return null
          return (
            <span key={o} style={{ top: `${((rows - 0.5 - y) / rows) * 100}%` }}>
              C{o}
            </span>
          )
        })}
      </div>
      <div className={`canvas-box tool-${settings.tool}`}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={() => readoutRef.current && (readoutRef.current.textContent = '')}
        />
        <div ref={playheadRef} className="playhead" />
      </div>
    </div>
  )
}
