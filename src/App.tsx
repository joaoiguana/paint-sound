import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import './App.css'
import { SpectrogramView } from './components/SpectrogramView.tsx'
import { Toolbar } from './components/Toolbar.tsx'
import { getEngine } from './engine/engine.ts'
import { DEFAULT_SETTINGS, TOOLS, type Settings } from './settings.ts'

const engine = getEngine()

export default function App() {
  const state = useSyncExternalStore(engine.subscribe, engine.getState)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const update = useCallback((s: Partial<Settings>) => setSettings((cur) => ({ ...cur, ...s })), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.code === 'Space') {
        e.preventDefault()
        engine.toggle()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) engine.redo()
        else engine.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        engine.redo()
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = TOOLS.find((t) => t.key === e.key.toLowerCase())
        if (t) update({ tool: t.id })
        if (e.key === '[') update({ size: Math.max(2, settings.size - 4) })
        if (e.key === ']') update({ size: Math.min(80, settings.size + 4) })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [update, settings.size])

  const tool = TOOLS.find((t) => t.id === settings.tool)!

  return (
    <div className="app">
      <Toolbar engine={engine} state={state} settings={settings} onChange={update} />
      <SpectrogramView engine={engine} state={state} settings={settings} />
      <footer className="status">
        <span className="title">{state.title}</span>
        <span>{state.seconds.toFixed(1)} s · {engine.model.sr} Hz</span>
        <span className="hint">{tool.label}: {tool.hint}</span>
        <span className="spacer" />
        {state.error && <span className="error">{state.error}</span>}
        {state.busy ? <span className="busy">{state.busy}</span> : state.rendering && <span className="busy">rendering…</span>}
        {!state.ready && <span className="busy">starting audio…</span>}
      </footer>
    </div>
  )
}
