import { useEffect, useRef, useState } from 'react'
import { useEscape } from '../escape.ts'
import type { ImageRef, PermissionMode, SessionMeta } from '../../../shared/types.ts'
import { api, currentMachine, globalId, localId, LOCAL, machineList, machineOf, select, setComposer, state } from '../store.ts'
import { DirPicker } from './DirPicker.tsx'
import { FlagPicker } from './FlagPicker.tsx'
import { McpPicker } from './McpDialog.tsx'
import { SessionPicker } from './SessionPicker.tsx'
import { focusField, RichInput } from './Inputs.tsx'
import { ChevronIcon } from './Icons.tsx'
import { FAMILIES, modelLabel, parseModel, VERSIONS } from '../../../shared/models.ts'

// machine: where it runs; the current session's by default.
// title and prompt: filled in already (a link from another app, url.ts).
export function NewSession({ cwd: initial, machine: start = currentMachine(), group, title: initialTitle = '', prompt: initialPrompt = '', onClose }: { cwd: string; machine?: string; group?: string; title?: string; prompt?: string; onClose(): void }) {
  useEscape(onClose)
  const [machine, setMachine] = useState(start)
  const [cwd, setCwd] = useState(initial)
  const [title, setTitle] = useState(initialTitle)
  // family: '' for the default, else an alias; version: '' for the version Claude Code picks, else a model ID.
  const [family, setFamily] = useState('')
  const [version, setVersion] = useState('')
  const model = version || family
  // What the default and each alias ran last time on that machine, to name its version.
  const [ran, setRan] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<PermissionMode>('auto')
  const [flags, setFlags] = useState<string[]>([])
  const [parentId, setParentId] = useState('')
  // The MCP servers it starts with; null: not changed, so the default of your settings.
  const [mcp, setMcp] = useState<string[] | null>(null)
  const mcpOff = state.machines[machine]?.settings.mcpStartOff !== false
  const [prompt, setPrompt] = useState(initialPrompt)
  const [images, setImages] = useState<ImageRef[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Whether the typed directory exists; if it doesn't, Create makes it first.
  const [missing, setMissing] = useState(false)
  const first = useRef<HTMLDivElement>(null)
  // Model, permissions, flags, MCP servers and parent: under "Advanced settings", above the first message, open or closed as you left it.
  const [advanced, setAdvanced] = useState(() => localStorage.getItem('codinger.newSession.advanced') === '1')
  const showAdvanced = (on: boolean) => { setAdvanced(on); localStorage.setItem('codinger.newSession.advanced', on ? '1' : '0') }
  // What is set there, when it is closed.
  const parent = state.sessions.find((s) => s.id === parentId)
  const summary = [
    model && modelLabel(model),
    mode !== 'auto' && { default: 'Ask before tools', acceptEdits: 'Auto-accept edits', plan: 'Plan only', bypassPermissions: 'Bypass permissions' }[mode as string],
    flags.length && `${flags.length} ${flags.length === 1 ? 'flag' : 'flags'}`,
    mcp && `${mcp.length} MCP ${mcp.length === 1 ? 'server' : 'servers'}`,
    parent && `sub-task of ${parent.title}`,
  ].filter(Boolean).join(' · ')

  useEffect(() => {
    if (!cwd.trim()) { setMissing(false); return }
    let live = true
    const t = setTimeout(() => {
      void api<{ kind: 'dir' | 'file' | 'missing' }>(`/api/fs/stat?path=${encodeURIComponent(cwd)}`, 'GET', undefined, machine)
        .then((r) => { if (live) setMissing(r.kind === 'missing') }).catch(() => {})
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [cwd, machine])

  useEffect(() => {
    let live = true
    void api<Record<string, string>>('/api/models', 'GET', undefined, machine).then((r) => { if (live) setRan(r) }).catch(() => {})
    return () => { live = false }
  }, [machine])
  // The version an alias ran last time, else the newest one known.
  const picks = (alias: string) => {
    const got = ran[alias]
    return got?.includes('-') ? parseModel(got).version : alias ? VERSIONS[alias]?.[0]?.version : null
  }

  const create = async () => {
    setBusy(true); setErr(null)
    try {
      const meta = await api<SessionMeta>('/api/sessions', 'POST', { cwd, title, model: model || null, permissionMode: mode, flags, parentId: parentId ? localId(parentId) : null, ...(mcp ? { mcp } : {}), group: machine === start ? group : undefined, mkdir: missing }, machine)
      const id = globalId(machine, meta.id)
      if (prompt.trim() || images.length) await api(`/api/sessions/${id}/send`, 'POST', { parts: [{ kind: 'text', text: prompt, images }] })
      else setComposer(id, { text: '' })
      select(id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      state.error = null
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-back top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal wide" onSubmit={(e) => { e.preventDefault(); void create() }}>
        <h2>New session</h2>
        {machineList().length > 1 && (
          <label>Machine
            <select value={machine} onChange={(e) => { setMachine(e.target.value); setCwd(''); setParentId(''); setMcp(null); setImages([]) }}>
              {machineList().map((m) => <option key={m.name} value={m.name}>{m.name === LOCAL ? `This machine${state.self ? ` (${state.self})` : ''}` : m.name}</option>)}
            </select>
          </label>
        )}
        {/* With a folder given (the + on a project), start in the first message: focus on the folder would open its menu. */}
        <div className="field">Directory
          <DirPicker value={cwd} onChange={setCwd} onPick={() => focusField(first.current?.querySelector<HTMLElement>('[contenteditable]'))} autoFocus={!initial} machine={machine} />
        </div>
        <label>Title <input value={title} placeholder="Defaults to the folder name" onChange={(e) => setTitle(e.target.value)} /></label>
        <button type="button" className="adv-toggle" aria-expanded={advanced} onClick={() => showAdvanced(!advanced)}>
          <span className="adv-label"><ChevronIcon size={12} className={advanced ? 'open' : undefined} />Advanced settings{!advanced && summary && <span className="muted"> · {summary}</span>}</span>
        </button>
        {advanced && <>
          <div className={family ? 'two three' : 'two'}>
            <label>Model
              <select value={family} onChange={(e) => { setFamily(e.target.value); setVersion('') }}>
                <option value="">Default{ran['']?.includes('-') ? ` (${modelLabel(ran[''])})` : ''}</option>
                {FAMILIES.map((f) => <option key={f} value={f}>{modelLabel(f)}</option>)}
              </select>
            </label>
            {family && <label>Version
              <select value={version} onChange={(e) => setVersion(e.target.value)}>
                <option value="">Latest{picks(family) ? ` (${picks(family)})` : ''}</option>
                {VERSIONS[family].map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
              </select>
            </label>}
            <label>Permissions
              <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
                <option value="auto">Auto mode</option><option value="default">Ask before tools</option><option value="acceptEdits">Auto-accept edits</option><option value="plan">Plan only</option><option value="bypassPermissions">Bypass permissions</option>
              </select>
            </label>
          </div>
          <div className="field">Claude Code flags
            <FlagPicker value={flags} onChange={setFlags} />
          </div>
          <div className="field">MCP servers
            <McpPicker cwd={cwd} machine={machine} value={mcp} onChange={setMcp} startOff={mcpOff} always={state.machines[machine]?.settings.mcpAlways} />
          </div>
          <div className="field">Sub-task of
            <SessionPicker sessions={state.sessions.filter((s) => s.kind === 'worker' && !s.archived && machineOf(s.id) === machine)} value={parentId} onChange={setParentId} placeholder="None. Type to search sessions" />
          </div>
        </>}
        <div className="field" ref={first}>First message (optional)
          <RichInput value={prompt} onChange={setPrompt} images={images} onImages={setImages} onSubmit={() => void create()} minRows={4} machine={machine} autoFocus={!!initial} uploadDir={cwd} />
        </div>
        {err && <div className="notice error">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !cwd.trim()}>{busy ? 'Starting…' : missing ? 'Create directory and start' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
