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

// The title and first message you typed and didn't send, kept as you type: closing the dialog
// (Esc, Cancel, a click outside, a reload) loses nothing, and the next new session starts with it.
const DRAFT = 'codinger.newSession.draft'
type Draft = { title: string; prompt: string }
function readDraft(): Draft | null {
  try { const d = JSON.parse(localStorage.getItem(DRAFT) ?? 'null') as Draft | null; return d && (d.prompt || d.title) ? d : null } catch { return null }
}
function writeDraft(d: Draft | null) {
  try { if (d && (d.prompt.trim() || d.title.trim())) localStorage.setItem(DRAFT, JSON.stringify(d)); else localStorage.removeItem(DRAFT) } catch { /* no storage: nothing kept */ }
}

// machine: where it runs; the current session's by default.
// title and prompt: filled in already (a link from another app, url.ts).
export function NewSession({ cwd: initial, machine: start = currentMachine(), group, title: initialTitle = '', prompt: initialPrompt = '', onClose }: { cwd: string; machine?: string; group?: string; title?: string; prompt?: string; onClose(): void }) {
  // With something typed, Esc asks first (what you typed is kept either way).
  useEscape(() => { if (!typed || confirm('Close this new session? What you typed is kept for next time.')) onClose() })
  const [machine, setMachine] = useState(start)
  const [cwd, setCwd] = useState(initial)
  // A link's own title and message (url.ts) come first, and don't touch the kept draft.
  const linked = !!(initialTitle || initialPrompt)
  const [restored] = useState(() => linked ? null : readDraft())
  const [title, setTitle] = useState(restored?.title ?? initialTitle)
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<PermissionMode>('auto')
  const [flags, setFlags] = useState<string[]>([])
  const [parentId, setParentId] = useState('')
  // The MCP servers it starts with; null: not changed, so the default of your settings.
  const [mcp, setMcp] = useState<string[] | null>(null)
  const mcpOff = state.machines[machine]?.settings.mcpStartOff !== false
  const [prompt, setPrompt] = useState(restored?.prompt ?? initialPrompt)
  const [images, setImages] = useState<ImageRef[]>([])
  const sent = useRef(false)
  useEffect(() => { if (!linked && !sent.current) writeDraft({ title, prompt }) }, [title, prompt, linked])
  // With something typed, a click outside doesn't close it: only Esc or Cancel do (and the draft stays).
  const typed = !!(prompt.trim() || title.trim() || images.length)
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
    model && model[0].toUpperCase() + model.slice(1),
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

  const create = async () => {
    setBusy(true); setErr(null)
    try {
      const meta = await api<SessionMeta>('/api/sessions', 'POST', { cwd, title, model: model || null, permissionMode: mode, flags, parentId: parentId ? localId(parentId) : null, ...(mcp ? { mcp } : {}), group: machine === start ? group : undefined, mkdir: missing }, machine)
      const id = globalId(machine, meta.id)
      if (prompt.trim() || images.length) await api(`/api/sessions/${id}/send`, 'POST', { parts: [{ kind: 'text', text: prompt, images }] })
      else setComposer(id, { text: '' })
      sent.current = true
      if (!linked) writeDraft(null)
      select(id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      state.error = null
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-back top" onMouseDown={(e) => { if (e.target === e.currentTarget && !typed) onClose() }}>
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
          <div className="two">
            <label>Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Default</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option><option value="fable">Fable</option>
              </select>
            </label>
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
        <div className="field" ref={first}><span>First message (optional){restored && (prompt || title) && <> · <span className="muted">your unsent draft</span> <button type="button" className="link" onClick={() => { setPrompt(''); setTitle('') }}>Clear</button></>}</span>
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
