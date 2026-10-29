// The browser's whole state, in one mutable object with a version counter.
// Components re-render on any change; at this scale that's plenty.

import { useSyncExternalStore } from 'react'
import type { Anchor, ArtifactAnchor, AuthState, Event, ImageRef, InboxItem, Part, RemoteStatus, ServerMsg, SessionMeta, Settings, Task, Usage } from '../../shared/types.ts'
import type { RemoteMachine } from '../../shared/remote.ts'
import type { UpdateStatus } from '../../shared/update.ts'
import { inboxParts } from '../../shared/inbox.ts'
import { itemsOf } from '../../shared/blocks.ts'
import { applyAppearance, holdingAppearance } from './appearance.ts'
import type { Artifact, PreviewTarget, ProlificaState } from '../../shared/artifacts.ts'
import type { LineComment, Verdict } from '../../shared/review.ts'

// reaction: an emoji alone, shown at the left of its passage, not as a card;
// whole: on a whole paragraph or list item (the reaction button), so not highlighted.
export type NoteDraft = { id: string; kind: 'note'; anchor: Anchor; quote: string; text: string; images: ImageRef[]; createdAt: number; itemKey?: string; reaction?: boolean; whole?: boolean }
// original: for a <draft>, the text as Claude wrote it; approved: it goes back as it is (edits go back anyway).
export type AnswerDraft = { id: string; kind: 'answer'; askKey: string; question: string; choices: string[]; text: string; images: ImageRef[]; createdAt: number; original?: string; approved?: boolean }
// A question or item set aside without a reply ("<msg>:<id>").
export type DismissDraft = { id: string; kind: 'dismiss'; key: string; label: string; createdAt: number }
// An item you did ("<msg>:<id>"); text: a problem you hit doing it.
export type DoneDraft = { id: string; kind: 'done'; key: string; label: string; text: string; result?: string; createdAt: number }
// A command opened in Terminal from a <run> block (by token), and how it ended.
export type Run = { sid: string; card: string; command: string; item?: { key: string; label: string }; code?: number; tail?: string }
// Your verdict on a file the agent changed in one turn (group), and a comment on lines of a file (shared/review.ts).
// verdict: none on a note on a whole review (path '') before you decide.
export type VerdictDraft = { id: string; kind: 'verdict'; group: string; path: string; rel: string; verdict?: Verdict; text?: string; createdAt: number }
export type LineDraft = { id: string; kind: 'line'; createdAt: number } & LineComment
// A comment on an artifact in the preview pane (ArtifactNotes.tsx); reaction: an emoji alone.
export type ArtDraft = { id: string; kind: 'artifact'; anchor: ArtifactAnchor; quote: string; text: string; images: ImageRef[]; createdAt: number; reaction?: boolean }
export type Draft = NoteDraft | ArtDraft | AnswerDraft | DismissDraft | DoneDraft | VerdictDraft | LineDraft
export type Composer = { text: string; images: ImageRef[] }

// One Codinger server: this page's own (LOCAL), or another machine through
// web.codinger.app (server/remote.ts). On web.codinger.app every machine is remote.
export type Machine = {
  name: string
  connected: boolean
  loaded: boolean          // its hello came
  sessions: SessionMeta[]  // ids made global (globalId)
  settings: Settings
  usage: Usage
  tasks: Task[]
  platform: string
  home: string
  auth: AuthState
  stale: boolean
  staleAt?: number         // the time of its newest code on disk
  update?: UpdateStatus    // its update from origin/main (server/update.ts)
  remote?: RemoteStatus    // its own remote access
  device?: 'laptop' | 'desktop'
}

// The tabs of the panel beside a session: what its agent showed, its files, its questions and items.
export type PanelTab = 'preview' | 'files' | 'items'
// The panel of one session: its tab (null: closed), the tab it opens on again, whether it
// takes the conversation's place too, and whether Files shows its list beside a file (false: hidden).
// (Its width and the list's are in SessionView.tsx and FileBrowser.tsx.)
export type Panel = { tab: PanelTab | null; last?: PanelTab; wide: boolean; list?: boolean }

type State = {
  // These belong to a machine: the current one (the selected session's), or for
  // sessions, all of them. Set on the state, they go to that machine.
  connected: boolean
  sessions: SessionMeta[]
  settings: Settings
  usage: Usage
  events: Record<string, Event[]>
  streaming: Record<string, string>
  selected: string
  drafts: Record<string, Draft[]>
  composer: Record<string, Composer>
  focus: string | null       // a draft id whose textarea should take focus
  showArchived: boolean
  error: string | null
  platform: string
  home: string
  auth: AuthState
  lightbox: string | null     // an image shown full size
  showSteps: boolean          // keep Claude's in-between messages out of the activity rows
  touchPick: boolean          // on a touch screen with the keyboard up, a held finger picks message text (Transcript.tsx)
  money: 'usd' | 'pct' | 'week'   // costs in dollars, or as a share of the 5-hour or weekly limit (web/src/cache.ts)
  runs: Record<string, Run>
  tasks: Task[]   // long-running commands agents started (server/tasks.ts)
  fileTick: Record<string, number>   // bumped when a tracked file gets a new version
  stale: boolean                     // the server's code on disk is newer than the server
  staleAt?: number
  update?: UpdateStatus              // an update from origin/main that waits, runs or stopped
  restarting: string | null         // the machine that restarts (Restart in the banner), until its hello comes
  loaded: boolean                    // the server's hello came: sessions and settings are real
  page: 'artifacts' | null           // a page in place of the selected session
  artifact: string | null            // the artifact chosen on the Artifacts page
  artifactV?: number                 // and the version of it on view there (none: the latest)
  settingsPage: string | null        // Settings is open, on this page
  panels: Record<string, Panel>      // by session: the panel beside it (SidePanel.tsx)
  fileOpen: Record<string, { path: string; line?: number; changes?: boolean; group?: string; at: number }>   // by session: the file or folder its Files tab shows, and the group for review it was opened from
  artifacts: Artifact[]
  artifactsPort: number              // where the server that runs artifacts listens
  prolifica: ProlificaState
  preview: Record<string, { target: PreviewTarget; at: number }>   // what each session's preview pane shows
  machines: Record<string, Machine>
  web: boolean                       // this page is web.codinger.app
  email: string | null               // signed in there as
  self: string                       // this machine's name on web.codinger.app, once connected
  sideTab: 'local' | 'remote'        // the sidebar's tab, on a machine's own page
  sideOpen: boolean                  // on a phone the sidebar covers the page: is it showing
  sideHidden: boolean                // on a wide screen you hid the sidebar (a click on its splitter, main.tsx)
  collapsed: string[]                // machines whose sessions you hid in the sidebar, and groups (group:<machine>:<id>)
  sideAll: boolean                   // the sidebar shows every session as a row, not only those that need you
  archiveQuery: string               // the archived view shows only the sessions whose folder has this text
  archiveByFolder: boolean           // the archived view puts sessions under their folders, not under your groups
  machineOrder: string[]             // other machines, in the order you dragged them to
  // A published transcript, shown read-only (web/src/share.tsx): where its files come from, and
  // whether its tool calls have their input and output or one line each. Null in Codinger itself.
  share: { file(url: string): string; tools: 'line' | 'full' } | null
}

const saved = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d } catch { return d } }

// On a phone the panel covers the conversation, so they all start closed there.
const phone = matchMedia('(max-width: 720px)').matches
// The panel of a session you have not changed it in.
const panelNew: Panel = { tab: phone ? null : 'items', wide: false }
let panels: Record<string, Panel> = saved('codinger.panels', {})
if (phone) panels = Object.fromEntries(Object.entries(panels).map(([k, p]) => [k, { ...p, tab: null }]))

export const state = {
  events: {},
  streaming: {},
  selected: saved('codinger.selected', 'lead'),
  drafts: saved('codinger.drafts', {}),
  composer: saved('codinger.composer', {}),
  focus: null,
  showArchived: false,
  sideOpen: false,
  error: null,
  lightbox: null,
  showSteps: saved('codinger.showSteps', false),
  touchPick: saved('codinger.touchPick', true),
  // 'both' was a choice until October 2026.
  money: (['usd', 'pct', 'week'] as const).find((x) => x === saved('codinger.money', 'pct')) ?? 'pct',
  runs: {},
  fileTick: {},
  restarting: null,
  page: null,
  artifact: localStorage.getItem('codinger.artifact'),
  settingsPage: null,
  panels,
  fileOpen: {},
  artifacts: [],
  artifactsPort: 0,
  prolifica: null,
  preview: saved('codinger.preview', {}),
  machines: {},
  web: false,
  email: null,
  self: '',
  sideTab: saved('codinger.sideTab', 'local'),
  collapsed: saved('codinger.collapsed', []),
  sideAll: saved('codinger.sideAll', false),
  archiveQuery: '',
  archiveByFolder: saved('codinger.archiveByFolder', false),
  sideHidden: saved('codinger.sideHidden', false),
  machineOrder: saved('codinger.machineOrder', []),
  share: null,
} as Partial<State> as State

// ---- machines -------------------------------------------------------------------

export const LOCAL = ''
// A remote session's id is "<machine>~<its id there>".
const SEP = '~'
export const machineOf = (id: string) => id.includes(SEP) ? id.slice(0, id.indexOf(SEP)) : LOCAL
export const localId = (id: string) => id.includes(SEP) ? id.slice(id.indexOf(SEP) + 1) : id
export const globalId = (machine: string, id: string) => machine ? `${machine}${SEP}${id}` : id
// A session id that a server sent (in a message, a task, a tool call): on the current machine.
export const here = (id: string) => globalId(currentMachine(), id)

const blank = (name: string): Machine => ({ name, connected: false, loaded: false, sessions: [], settings: { leadAutoSend: false }, usage: {}, tasks: [], platform: '', home: '', auth: { state: 'ok' }, stale: false })

// The machines in sidebar order: this page's own first, then the others where you
// dragged them, then any new ones by name.
export function machineList() {
  const rank = (n: string) => n === LOCAL ? -1 : (state.machineOrder.indexOf(n) + 1 || Infinity)
  return Object.values(state.machines).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
}

// What to show when the selected session is gone: the latest active one, anywhere.
// The lead is not shown (Codinger's own lead agent is hidden for now).
const fallback = () => state.sessions.filter((s) => s.kind === 'worker' && !s.archived).sort((a, b) => b.lastActivity - a.lastActivity)[0]?.id ?? ''

// The machine of the selected session; what Settings, usage and tasks show.
export function currentMachine(): string {
  const m = machineOf(state.selected)
  return state.machines[m] ? m : machineList()[0]?.name ?? LOCAL
}
const cur = () => state.machines[currentMachine()] ?? blank(LOCAL)

// Where a machine's server is, from this page.
export const baseOf = (machine: string) => !machine ? '' : state.web ? `/m/${machine}` : `/api/remote/m/${machine}`
export const urlOf = (path: string, machine = currentMachine()) => baseOf(machine) + path
// An image or file the server keeps (/api/images/…), from the current session's machine.
export const media = (url: string, machine = currentMachine()) =>
  state.share && /^\/api\/(images|media)\//.test(url) ? state.share.file(url) : url.startsWith('/api/') ? urlOf(url, machine) : url

Object.defineProperties(state, {
  sessions: {
    get: () => machineList().flatMap((m) => m.sessions),
    set: (list: SessionMeta[]) => { for (const m of Object.values(state.machines)) m.sessions = list.filter((s) => machineOf(s.id) === m.name) },
  },
  connected: { get: () => cur().connected },
  loaded: { get: () => cur().loaded },
  settings: { get: () => cur().settings, set: (v: Settings) => { cur().settings = v } },
  usage: { get: () => cur().usage },
  tasks: { get: () => cur().tasks },
  platform: { get: () => cur().platform },
  home: { get: () => cur().home },
  auth: { get: () => cur().auth },
  stale: { get: () => cur().stale },
  staleAt: { get: () => cur().staleAt },
  update: { get: () => cur().update },
})

// The machine whose appearance this page wears: its own, or on the web the first one.
const looksFrom = () => state.web ? machineList()[0]?.name : LOCAL
// Where the artifacts server is, from this page: on the web, artifacts.codinger.app for the
// machine they come from (remote/src/index.ts); null on the hub's other address, which has none.
export function artifactsBase(port: number): string | null {
  if (!state.web) return `http://127.0.0.1:${port}`
  const m = looksFrom()
  return m && location.hostname.startsWith('web.') ? `${location.origin.replace('//web.', '//artifacts.')}/m/${m}` : null
}

export const panelOf = (sid: string): Panel => state.panels[sid] ?? panelNew
// Changes a session's panel (then call changed()). A tab it opens on is the one it opens on again.
export function setPanel(sid: string, p: Partial<Panel>) {
  const next = { ...panelOf(sid), ...p }
  if (next.tab) next.last = next.tab
  state.panels = { ...state.panels, [sid]: next }
}

let version = 0
const listeners = new Set<() => void>()
let persistTimer = 0
// Changes the server makes (quietly), not you: the address changes in place for them (url.ts).
export let quiet = 0
export function quietly(fn: () => void) { quiet++; try { fn() } finally { quiet-- } }
export const onChanged = (l: () => void) => { listeners.add(l) }
export function changed() {
  version++
  for (const l of listeners) l()
  reportDrafting()
  clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    localStorage.setItem('codinger.drafts', JSON.stringify(state.drafts))
    localStorage.setItem('codinger.composer', JSON.stringify(state.composer))
    localStorage.setItem('codinger.selected', JSON.stringify(state.selected))
    localStorage.setItem('codinger.showSteps', JSON.stringify(state.showSteps))
    localStorage.setItem('codinger.touchPick', JSON.stringify(state.touchPick))
    localStorage.setItem('codinger.preview', JSON.stringify(state.preview))
    localStorage.setItem('codinger.sideTab', JSON.stringify(state.sideTab))
    localStorage.setItem('codinger.collapsed', JSON.stringify(state.collapsed))
    localStorage.setItem('codinger.sideAll', JSON.stringify(state.sideAll))
    localStorage.setItem('codinger.archiveByFolder', JSON.stringify(state.archiveByFolder))
    localStorage.setItem('codinger.sideHidden', JSON.stringify(state.sideHidden))
    localStorage.setItem('codinger.machineOrder', JSON.stringify(state.machineOrder))
    if (state.artifact) localStorage.setItem('codinger.artifact', state.artifact)
    localStorage.setItem('codinger.panels', JSON.stringify(state.panels))
  }, 300)
}
// Tell the server which sessions you are writing a reply in, so the lead's
// drafts wait for yours instead of going ahead of them.
const drafting = new Map<string, boolean>()
let draftingTimer: number | undefined
function reportDrafting() {
  if (draftingTimer) return
  draftingTimer = window.setTimeout(() => {
    draftingTimer = undefined
    if (!state.loaded) return
    for (const m of state.sessions) {
      if (m.kind !== 'worker') continue
      const c = composerOf(m.id)
      const on = draftsOf(m.id).some(hasContent) || !!c.text.trim() || c.images.length > 0
      if (on === (drafting.get(m.id) ?? !!m.drafting)) continue
      drafting.set(m.id, on)
      void api(`/api/sessions/${m.id}/drafting`, 'POST', { on }).catch(() => drafting.delete(m.id))
    }
  }, 600)
}

export function useStore(): State {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => version)
  return state
}

// ---- server ---------------------------------------------------------------------

// A call to a Codinger server: a session's own machine for /api/sessions/<id>/…,
// else `machine`, else the current one.
export async function api<T = any>(path: string, method = 'POST', body?: unknown, machine?: string): Promise<T> {
  // Until /_remote/whoami answers, this page does not know if it is web.codinger.app, where a
  // call to its own server goes to the hub; the panels that load at once ask before that.
  if (whoami) await whoami
  const sid = /^\/api\/sessions\/([^/?]+)/.exec(path)?.[1]
  if (sid?.includes(SEP)) { machine = machineOf(sid); path = path.replace(sid, localId(sid)) }
  machine ??= currentMachine()
  // On web.codinger.app every server is a machine's: until the list of machines comes there is
  // none to ask, and the hub would answer with its page.
  if (state.web && !machine) throw new Error(`${method} ${path}: no machine yet`)
  const r = await fetch(urlOf(path, machine), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // A page, not an answer: the request went to a server that does not have this route.
  if (r.ok && r.headers.get('content-type')?.startsWith('text/html')) showError(`${method} ${path}: the server sent a page, not an answer`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) showError(j.error ?? `${r.status} ${r.statusText}`)
  return j
}

// An error shows for a while, then goes (a click closes it sooner).
export function showError(msg: string): never {
  state.error = msg
  setTimeout(() => { if (state.error === msg) { state.error = null; changed() } }, 8000)
  changed()
  throw new Error(msg)
}

// A file you attach to a message goes into dir, the session's directory, under its own
// name (or "name (2)"); returns the name it got.
export async function uploadFile(file: File, dir: string, machine?: string): Promise<string> {
  const r = await fetch(urlOf(`/api/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, machine ?? currentMachine()), { method: 'POST', body: file })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) showError(j.error ?? `${file.name} did not upload: ${r.status} ${r.statusText}`)
  return j.name
}

// Whether this page is web.codinger.app (and who you are there), once start() asks.
let whoami: Promise<{ web?: boolean; email?: string | null }> | null = null

// Start: on web.codinger.app, sign in and find your machines; on a machine, its own server
// (and, once it is connected to web.codinger.app, the other machines).
export async function start() {
  whoami = fetch('/_remote/whoami').then((r) => r.json()).catch(() => ({ web: false }))
    .then((who) => { state.web = !!who.web; return who })
  const who = await whoami
  if (who.web) {
    if (!who.email) { location.href = '/_remote/login'; return }
    state.email = who.email
  } else {
    state.machines[LOCAL] = blank(LOCAL)
    connect(LOCAL)
  }
  void refreshMachines()
  setInterval(() => void refreshMachines(), 30_000)
}

const sockets = new Map<string, WebSocket>()
function connect(machine: string) {
  if (sockets.has(machine)) return
  const base = baseOf(machine)
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}/ws`)
  sockets.set(machine, ws)
  ws.onmessage = (m) => quietly(() => onServer(JSON.parse(m.data), machine))
  ws.onopen = () => {
    const m = state.machines[machine]
    if (m) m.connected = true
    // Anything that happened while we were away: reload what we had open.
    for (const id of Object.keys(state.events)) if (machineOf(id) === machine) void loadEvents(id, true)
    changed()
  }
  ws.onclose = () => {
    sockets.delete(machine)
    const m = state.machines[machine]
    if (m) m.connected = false
    changed()
    // A machine that is gone from the list stays gone (refreshMachines).
    if (m) setTimeout(() => { if (state.machines[machine]) connect(machine) }, machine ? 3000 : 1000)
  }
}

// The other machines on web.codinger.app: connect to the new ones, let go of the gone ones.
let known: RemoteMachine[] = []
export async function refreshMachines() {
  if (!state.web && !state.machines[LOCAL]?.remote?.linked) known = []
  else {
    const r = await fetch(state.web ? '/_remote/machines' : '/api/remote/machines').catch(() => null)
    if (r?.status === 401 && state.web) { location.href = '/_remote/login'; return }
    if (!r?.ok) return
    known = await r.json()
  }
  const live = new Set(known.filter((m) => m.connected && m.name !== state.self).map((m) => m.name))
  for (const name of Object.keys(state.machines)) {
    if (name === LOCAL || live.has(name)) continue
    delete state.machines[name]
    sockets.get(name)?.close()
  }
  for (const name of live) { state.machines[name] ??= blank(name); connect(name) }
  changed()
}
// Machines you connected that are not on line now.
export const offline = () => known.filter((m) => !m.connected && m.name !== state.self).map((m) => m.name)
// Every machine you connected, this one too, with its display name.
export const knownMachines = () => known
// What the sidebar calls a machine: its display name, else its name.
export const labelOf = (name: string) => known.find((m) => m.name === name)?.label ?? name

function onServer(m: ServerMsg, machine: string) {
  const M = state.machines[machine]
  if (!M) return
  const g = (id: string) => globalId(machine, id)
  const own = (list: SessionMeta[]) => machine ? list.map((s) => ({ ...s, id: g(s.id), parentId: s.parentId && g(s.parentId) })) : list
  const looks = looksFrom() === machine
  switch (m.type) {
    case 'hello':
      Object.assign(M, { sessions: own(m.sessions), settings: m.settings, usage: m.usage, loaded: true, platform: m.platform, home: m.home, auth: m.auth ?? { state: 'ok' }, stale: !!m.stale, staleAt: m.staleAt, update: m.update, remote: m.remote, device: m.device })
      if (looks) applyAppearance(m.settings.appearance)
      if (state.restarting === machine) state.restarting = null
      if (!machine) onRemote(m.remote)
      // A selected session that is gone, or a lead: the latest one instead. No session (after a close) stays so.
      if (state.selected && !state.sessions.some((s) => s.id === state.selected && s.kind === 'worker')) state.selected = fallback()
      if (!state.selected) state.sideOpen = true  // nothing to show: on a phone, the sessions
      break
    case 'sessions': M.sessions = own(m.sessions); break
    case 'settings':
      if (looks && holdingAppearance()) { M.settings = { ...m.settings, appearance: M.settings.appearance }; break }
      M.settings = m.settings
      if (looks) applyAppearance(m.settings.appearance)
      break
    case 'usage': M.usage = m.usage; break
    case 'tasks': M.tasks = m.tasks; break
    // Artifacts run on this page's own machine (on the web, the first one).
    case 'artifacts': if (looks) { state.artifacts = m.artifacts; state.artifactsPort = m.port; state.prolifica = m.prolifica }; break
    case 'preview': state.preview = { ...state.preview, [g(m.sessionId)]: { target: m.target, at: m.at } }; break
    case 'auth': M.auth = m.auth; break
    case 'stale': M.stale = m.stale; M.staleAt = m.staleAt; break
    case 'update': M.update = m.update; break
    case 'device': M.device = m.device; break
    case 'remote': M.remote = m.remote; if (!machine) onRemote(m.remote); break
    case 'file': state.fileTick = { ...state.fileTick, [m.path]: (state.fileTick[m.path] ?? 0) + 1 }; break
    case 'run': {
      const run = state.runs[m.token]
      if (!run) break
      Object.assign(run, { code: m.code, tail: m.tail })
      // The command an item asked for ended: the item is done, with how it went.
      if (run.item && !draftsOf(run.sid).some((d) => d.kind === 'dismiss' && d.key === run.item!.key)) {
        markDone(run.sid, run.item.key, run.item.label)
        const result = `$ ${run.command}\nexit code ${m.code}${m.tail ? `\n${m.tail}` : ''}`
        state.drafts[run.sid] = draftsOf(run.sid).map((d) => d.kind === 'done' && d.key === run.item!.key ? { ...d, result } : d)
      }
      break
    }
    case 'event': {
      const sid = g(m.sessionId)
      const list = state.events[sid]
      if (list && (!list.length || list[list.length - 1].seq < m.event.seq)) state.events[sid] = [...list, m.event]
      // Seen only in a window that has the focus: in another tab, app or screen, the turn stays
      // unread, so a push notification comes (server/index.ts, notifyOnChange).
      if (sid === state.selected && document.visibilityState === 'visible' && document.hasFocus() && m.event.t === 'result') void api(`/api/sessions/${sid}/seen`).catch(() => {})
      break
    }
    case 'delta': {
      const sid = g(m.sessionId)
      state.streaming[sid] = m.reset ? '' : (state.streaming[sid] ?? '') + m.text
      break
    }
    case 'truncate': {
      const sid = g(m.sessionId)
      const list = state.events[sid]
      if (list) state.events[sid] = list.filter((e) => e.seq < m.seq)
      state.streaming[sid] = ''
      // Comments and answers on messages that are gone go with them.
      const gone = (msg: string) => Number(msg.split(/[.:]/)[0]) >= m.seq
      // Comments on artifacts stay: they are on no message.
      state.drafts[sid] = draftsOf(sid).filter((d) => d.kind === 'artifact' || !gone(d.kind === 'note' ? d.anchor.msg : d.kind === 'answer' ? d.askKey : d.kind === 'verdict' || d.kind === 'line' ? d.group ?? '' : d.key))
      break
    }
  }
  changed()
}

// This machine's own remote access changed: who it is there, and whom it can reach.
function onRemote(r: RemoteStatus | undefined) {
  state.self = r?.connected ? r.name : ''
  void refreshMachines()
}

const loading = new Set<string>()
export async function loadEvents(id: string, force = false) {
  if ((!force && state.events[id]) || loading.has(id)) return
  loading.add(id)
  try {
    const ev = await api<Event[]>(`/api/sessions/${id}/events`, 'GET')
    // Merge with anything the socket delivered while we were fetching.
    const live = (state.events[id] ?? []).filter((e) => e.seq > (ev.at(-1)?.seq ?? 0))
    state.events[id] = [...ev, ...live]
    changed()
  } finally { loading.delete(id) }
}

// hideSide: on a phone, a session you pick covers the sidebar; a close or a fallback leaves it as it is.
export function select(id: string, hideSide = true) {
  state.selected = id
  state.page = null
  if (hideSide) state.sideOpen = false
  changed()
  opened(id)
}
// A session that shows now: its events, and it is seen.
export function opened(id: string) {
  if (!id) return
  void loadEvents(id)
  const s = state.sessions.find((x) => x.id === id)
  if (s?.unread) void api(`/api/sessions/${id}/seen`).catch(() => {})
}
// Back in this window: the session it shows is seen now.
window.addEventListener('focus', () => {
  if (state.sessions.find((x) => x.id === state.selected)?.unread) void api(`/api/sessions/${state.selected}/seen`).catch(() => {})
})

// Open a session at one of its events (a message, or the tool call in an activity row).
export function revealEvent(sid: string, seq: number) {
  select(sid)
  const find = (n: number) => {
    const el = document.querySelector<HTMLElement>(`[data-sid="${sid}"][data-msg^="${seq}."]`)
      ?? [...document.querySelectorAll<HTMLElement>('.activity[data-seqs]')].find((a) => a.dataset.seqs!.split(',').includes(String(seq)))
    if (!el) { if (n < 30) setTimeout(() => find(n + 1), 150); return }
    if (el.classList.contains('activity') && !el.classList.contains('open')) el.querySelector<HTMLElement>('.activity-line')?.click()
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
  }
  setTimeout(() => find(0), 50)
}

// No session shows: the blank view. On a phone the sessions show in its place.
export function deselect() {
  state.selected = ''
  state.page = null
  state.sideOpen = true
  changed()
}

// The sidebar shows the archived sessions, or the active ones. An open session that is not in
// that list no longer shows: the blank view instead.
export function showArchive(on: boolean) {
  state.showArchived = on
  state.archiveQuery = ''
  const s = state.sessions.find((x) => x.id === state.selected)
  if (s && !!s.archived !== on) state.selected = ''
  changed()
}

// Closing archives the session (its process ends; Reopen brings it back). If it was open, no session shows.
export async function closeSession(id: string) {
  await api(`/api/sessions/${id}`, 'PATCH', { archived: true })
  if (state.selected === id) deselect()
}

// ---- drafts -------------------------------------------------------------------------

export const draftsOf = (sid: string) => state.drafts[sid] ?? []
export const composerOf = (sid: string): Composer => state.composer[sid] ?? { text: '', images: [] }

export function addDraft(sid: string, d: Draft) {
  state.drafts[sid] = [...draftsOf(sid), d]
  state.focus = d.id
  changed()
}
export function updateDraft(sid: string, id: string, patch: Partial<NoteDraft> | Partial<ArtDraft> | Partial<AnswerDraft>) {
  state.drafts[sid] = draftsOf(sid).map((d) => d.id === id ? { ...d, ...patch } as Draft : d)
  // A written reply to a set-aside item takes the dismissal back (a reaction does not).
  const d = draftsOf(sid).find((x) => x.id === id)
  if (d?.kind === 'note' && d.itemKey && !d.reaction && hasContent(d)) reviveItem(sid, d.itemKey)
  changed()
}
export function removeDraft(sid: string, id: string) {
  state.drafts[sid] = draftsOf(sid).filter((d) => d.id !== id)
  changed()
}
export function setComposer(sid: string, c: Partial<Composer>) {
  state.composer[sid] = { ...composerOf(sid), ...c }
  changed()
}

const order = (msg: string) => msg.split(/[.:]/).map(Number)
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0 }

export function hasContent(d: Draft): boolean {
  if (d.kind === 'dismiss' || d.kind === 'done' || d.kind === 'verdict') return true
  if (d.kind === 'line') return !!d.text.trim()
  // A draft goes back when edited, or approved as it is.
  if (d.kind === 'answer' && d.original != null) return !!d.text.trim() && (d.text.trim() !== d.original.trim() || !!d.approved)
  return !!(d.text.trim() || d.images.length || (d.kind === 'answer' && d.choices.length))
}

// The questions and items directly inside an item to consider.
function nestedIn(sid: string, key: string): { key: string; label: string }[] {
  const at = key.indexOf(':'), msg = key.slice(0, at), id = key.slice(at + 1)
  const [seq, i] = msg.split('.').map(Number)
  const e = state.events[sid]?.find((x) => x.t === 'assistant' && x.seq === seq)
  const b = e?.t === 'assistant' ? e.blocks[i] : undefined
  return b?.type === 'text' ? itemsOf(b.text).filter((it) => it.parent === id).map((it) => ({ key: `${msg}:${it.id}`, label: it.label })) : []
}

export function dismissItem(sid: string, key: string, label: string) {
  if (draftsOf(sid).some((d) => d.kind === 'dismiss' && d.key === key)) return
  // An untouched reply card for it goes too.
  const keep = draftsOf(sid).filter((d) => !(d.kind === 'note' && d.itemKey === key && !hasContent(d)) && !(d.kind === 'answer' && d.askKey === key && !hasContent(d)))
  state.drafts[sid] = [...keep, { id: uid(), kind: 'dismiss', key, label, createdAt: Date.now() }]
  // So do the questions inside it, which it hides.
  for (const n of nestedIn(sid, key)) dismissItem(sid, n.key, n.label)
  changed()
}
export function undismissItem(sid: string, key: string) {
  const nested = new Set(nestedIn(sid, key).map((n) => n.key))
  state.drafts[sid] = draftsOf(sid).filter((d) => !((d.kind === 'dismiss' || d.kind === 'done') && d.key === key))
  for (const n of nested) undismissItem(sid, n)
  changed()
}

// The item to consider that a question sits directly in, if any.
function parentOf(sid: string, key: string): string | null {
  const at = key.indexOf(':'), msg = key.slice(0, at), id = key.slice(at + 1)
  const [seq, i] = msg.split('.').map(Number)
  const e = state.events[sid]?.find((x) => x.t === 'assistant' && x.seq === seq)
  const b = e?.t === 'assistant' ? e.blocks[i] : undefined
  const up = b?.type === 'text' ? itemsOf(b.text).find((it) => it.id === id)?.parent : undefined
  return up ? `${msg}:${up}` : null
}

// Using a set-aside item takes back its dismissal, and those of the items around it.
export function reviveItem(sid: string, key: string) {
  for (let k: string | null = key; k; k = parentOf(sid, k)) {
    if (draftsOf(sid).some((d) => d.kind === 'dismiss' && d.key === k)) undismissItem(sid, k)
  }
}

export function markDone(sid: string, key: string, label: string) {
  if (draftsOf(sid).some((d) => d.kind === 'done' && d.key === key)) return
  const keep = draftsOf(sid).filter((d) => !(d.kind === 'dismiss' && d.key === key) && !(d.kind === 'note' && d.itemKey === key && !hasContent(d)))
  state.drafts[sid] = [...keep, { id: uid(), kind: 'done', key, label, text: '', createdAt: Date.now() }]
  changed()
}
export function setDoneText(sid: string, key: string, text: string) {
  state.drafts[sid] = draftsOf(sid).map((d) => d.kind === 'done' && d.key === key ? { ...d, text } : d)
  changed()
}

// Everything queued for a session, in reading order: notes and answers in the
// order their passages appear, then whatever is in the composer.
// The lead's drafts (shared/inbox.ts) go with yours: its replies in reading
// order among your own, its message after yours.
export const inboxOf = (sid: string): InboxItem[] => state.sessions.find((s) => s.id === sid)?.inbox ?? []

export function queuedParts(sid: string, alsoDismiss: { key: string; label: string }[] = []): Part[] {
  const mine = draftsOf(sid)
  // Your own reply to an item wins over the lead's.
  const yours = new Set(mine.flatMap((d) => d.kind === 'note' && d.itemKey && hasContent(d) ? [d.itemKey] : d.kind === 'answer' && hasContent(d) ? [d.askKey] : d.kind === 'dismiss' || d.kind === 'done' ? [d.key] : []))
  const lead = inboxOf(sid).filter((i) => !i.key || !yours.has(i.key))
  const leadKeys = new Set(lead.flatMap((i) => i.key ? [i.key] : []))
  const dismissed = [
    ...mine.flatMap((d) => d.kind === 'dismiss' ? [{ key: d.key, label: d.label }] : []),
    ...lead.flatMap((i) => i.kind === 'dismiss' && i.key ? [{ key: i.key, label: i.label ?? '' }] : []),
    ...alsoDismiss.filter((i) => !leadKeys.has(i.key)),
  ]
  const done = [
    ...mine.flatMap((d) => d.kind === 'done' ? [{ key: d.key, label: d.label, ...(d.text.trim() ? { text: d.text.trim() } : {}), ...(d.result ? { result: d.result } : {}) }] : []),
    ...lead.flatMap((i) => i.kind === 'done' && i.key ? [{ key: i.key, label: i.label ?? '', ...(i.text.trim() ? { text: i.text.trim() } : {}) }] : []),
  ]
  const keyed: { p: Part; k: number[]; t: number }[] = mine.filter((d): d is NoteDraft | AnswerDraft => (d.kind === 'note' || d.kind === 'answer') && hasContent(d)).map((d) => d.kind === 'note'
    ? { p: { kind: 'note', text: d.text, quote: d.quote, anchor: d.anchor, images: d.images, ...(d.itemKey ? { itemKey: d.itemKey } : {}), ...(d.whole ? { whole: true } : {}) }, k: [...order(d.anchor.msg), d.anchor.pieces.at(-1)?.block ?? 0], t: d.createdAt }
    : { p: { kind: 'answer', text: d.text, askKey: d.askKey, question: d.question, choices: d.choices, images: d.images, ...(d.original != null ? { draft: d.text.trim() === d.original.trim() ? 'same' as const : 'edited' as const } : {}) }, k: [...order(d.askKey.split(':')[0]), 9999], t: d.createdAt })
  for (const i of lead) if ((i.kind === 'answer' || i.kind === 'reply') && i.key) keyed.push({ p: inboxParts([i])[0], k: [...order(i.key.split(':')[0]), 9999], t: i.ts })
  keyed.sort((a, b) => cmp(a.k, b.k) || a.t - b.t)
  const parts: Part[] = keyed.map((x) => x.p)
  // Comments on artifacts, in the order you wrote them.
  for (const d of mine) if (d.kind === 'artifact' && hasContent(d)) parts.push({ kind: 'artifact', text: d.text, quote: d.quote, anchor: d.anchor, images: d.images })
  const files = mine.flatMap((d) => d.kind === 'verdict' ? [{ group: d.group, path: d.path, rel: d.rel, verdict: d.verdict, ...(d.text?.trim() ? { text: d.text.trim() } : {}) }] : [])
  const comments = mine.flatMap((d): LineComment[] => {
    if (d.kind !== 'line' || !d.text.trim()) return []
    const { id: _, kind: __, createdAt: ___, ...c } = d
    return [c]
  })
  if (files.length || comments.length) parts.push({ kind: 'review', text: '', files, comments })
  if (done.length) parts.push({ kind: 'done', text: '', items: done })
  if (dismissed.length) parts.push({ kind: 'dismiss', text: '', items: dismissed })
  const c = composerOf(sid)
  if (c.text.trim() || c.images.length) parts.push({ kind: 'text', text: c.text, images: c.images })
  parts.push(...inboxParts(lead.filter((i) => !i.kind || i.kind === 'text')))
  return parts
}

export async function sendQueued(sid: string, alsoDismiss: { key: string; label: string }[] = []) {
  const parts = queuedParts(sid, alsoDismiss)
  if (!parts.length) return
  await api(`/api/sessions/${sid}/send`, 'POST', { parts, inbox: inboxOf(sid).map((i) => i.id) })
  state.drafts[sid] = []
  state.composer[sid] = { text: '', images: [] }
  changed()
}

// Delete one of your messages and everything after it; with parts, send them
// in its place (an edit).
export async function rewind(sid: string, seq: number, parts?: Part[]) {
  await api(`/api/sessions/${sid}/rewind`, 'POST', { seq, ...(parts ? { parts } : {}) })
}

export const uid = () => Math.random().toString(36).slice(2, 10)
