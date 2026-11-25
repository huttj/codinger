// One Claude Code conversation, driven through `claude -p` in stream-JSON mode.
// That is the same headless protocol the Agent SDK speaks, run on your own
// Claude Code login: no API key involved (we strip it from the environment).
//
// The process is started lazily on the first send and kept alive between
// turns. A server restart leaves a busy process running for the next server
// (server/proc.ts); an idle one ends, and the next send resumes it with --resume.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { formatAnswer, formatArtifactNote, formatNote } from '../shared/asks.ts'
import { formatDismissed, formatDone, formatPending, itemsOf, raiseItems } from '../shared/blocks.ts'
import { fromUser } from '../shared/inbox.ts'
import { formatReview } from '../shared/review.ts'
import { formatMail } from '../shared/mail.ts'
import { flagArgs } from '../shared/flags.ts'
import { mediaTypeOf, splitImages, withoutImages } from '../shared/images.ts'
import { splitPastes } from '../shared/pastes.ts'
import type { Block, Event, Part, PermissionMode, SessionMeta, Status, Usage } from '../shared/types.ts'
import { AUTH_ERROR, CLAUDE, childEnv } from './auth.ts'
import { entryBefore } from './history.ts'
import { Proc } from './proc.ts'
import { keepMediaIn } from './media.ts'
import { addSpend, costOf } from '../shared/prices.ts'
import { appendEvent, imageFile, knownWindow, learnModel, learnWindow, promptFile, readEvents, writeEvents } from './store.ts'

export type Hooks = {
  meta(s: Session): void
  event(s: Session, e: Event): void
  delta(s: Session, text: string, reset: boolean): void
  truncate(s: Session, seq: number): void
  authFailed(s: Session): void
  usage(u: Usage): void
  commands(s: Session, list: SlashCommand[]): void
  mcpServers(s: Session): Record<string, unknown> | null   // MCP servers to add once the process starts
}

export type SlashCommand = { name: string; description: string; argumentHint: string }

export type Launch = { args: string[]; prompt: string }

// A session's display name in Claude Code: "codinger-" and its Codinger id.
export const claudeName = (id: string) => `codinger-${id}`

const MAX_RESULT = 8000
// How long a finished session keeps its claude process before it sleeps.
// CODINGER_SLEEP_MS overrides it (for tests).
const IDLE_SLEEP_MS = Number(process.env.CODINGER_SLEEP_MS ?? process.env.CODINER_SLEEP_MS) || 5 * 60_000

// A message that is only a slash command goes in as one, as if typed at the claude prompt;
// nothing hidden goes with it.
export function slashCommand(parts: Part[]): string {
  const only = parts.length === 1 && parts[0].kind === 'text' && !parts[0].images?.length ? parts[0].text.trim() : ''
  return /^\/[\w:.-]+/.test(only) ? only : ''
}

export class Session {
  meta: SessionMeta
  private events: Event[] | null = null
  private proc: Proc | null = null
  private outstanding = 0        // turns sent but not yet finished
  private background = 0         // background tasks (shells, agents) the process is running
  private sleepTimer: NodeJS.Timeout | null = null
  private stopping = false       // we asked the process to end (sleep, close, delete)
  private interrupted = false
  private authRetry: number | null = null  // a message that failed for want of a login, to send again
  private terminalOnly = new Set(['doctor', 'color', 'focus', 'reload-plugins', 'heapdump'])
  private pending = new Map<string, { input: any; suggestions: any[] }>()
  // The prompt cache's clock starts when an API call starts, which the stream doesn't
  // say. callFrom: the last moment Claude Code got input or gave output, so the next
  // call starts after it; callStart: that moment, for the call now replying.
  private callFrom = 0
  private callStart = 0
  private costSeen = new Map<string, number>()  // message id → dollars counted, as its lines come in
  private seqFrom = 1  // the first number for an empty transcript
  private hooks: Hooks
  private launch: () => Launch
  // The last server stopped mid-turn without handing the process on (a crash, a forced stop).
  cut = false

  constructor(meta: SessionMeta, hooks: Hooks, launch: () => Launch) {
    this.meta = meta
    this.hooks = hooks
    this.launch = launch
    // Whatever was in flight when the server last stopped is gone now, unless reattach() finds it.
    this.cut = meta.status === 'working' || meta.status === 'permission'
    meta.running = false
    meta.compacting = false
    if (meta.status === 'working' || meta.status === 'permission') meta.status = 'idle'
    // A status saved by an older version can disagree with what it rests on (a lead reset once left 'asking' with no asks).
    if (meta.status === 'asking' && !meta.pendingAsks) meta.status = meta.unread ? 'waiting' : 'idle'
    if (meta.status === 'waiting' && !meta.unread) meta.status = 'idle'
  }

  // Claude Code runs background work (shells, agents) that starts a turn when it ends.
  get backgroundWork() { return this.background > 0 }

  getEvents(): Event[] {
    if (!this.events) this.events = readEvents(this.meta.id)
    return this.events
  }

  private nextSeq(): number {
    const ev = this.getEvents()
    return ev.length ? ev[ev.length - 1].seq + 1 : this.seqFrom
  }

  private record<T extends Event['t']>(t: T, body: Omit<Extract<Event, { t: T }>, 'seq' | 'ts' | 't'>): Event {
    const e = { seq: this.nextSeq(), ts: Date.now(), t, ...body } as unknown as Event
    this.getEvents().push(e)
    appendEvent(this.meta.id, e)
    this.meta.lastActivity = e.ts
    this.hooks.event(this, e)
    return e
  }

  notice(text: string, level: 'info' | 'warn' | 'error' = 'info', extra: { task?: string } = {}) {
    this.record('notice', { text, level, ...extra })
  }

  private refresh() {
    const m = this.meta
    let s: Status
    if (this.pending.size) s = 'permission'
    else if (this.outstanding > 0 || m.compacting) s = 'working'
    else if (m.error) s = 'error'
    else if (m.pendingAsks) s = 'asking'
    else if (m.unread) s = 'waiting'
    else s = m.started || this.getEvents().length ? 'idle' : 'new'
    m.status = s
    m.running = !!this.proc
    this.scheduleSleep()
    this.hooks.meta(this)
  }

  // A finished session ends its process after a while; the next message resumes it.
  // Never while a turn, a permission prompt, a compaction or background work is live.
  private canSleep() {
    const m = this.meta
    return !!this.proc && ['idle', 'waiting', 'asking'].includes(m.status) && !m.compacting && !this.background
  }

  private scheduleSleep() {
    if (!this.canSleep()) {
      if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null }
      return
    }
    if (this.sleepTimer) return
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null
      if (this.canSleep()) this.stop()
    }, IDLE_SLEEP_MS)
  }

  // ---- process ----------------------------------------------------------

  private ensureProc() {
    // A process that is on its way out (asleep, closed) takes no more input; start a new one.
    if (this.proc && !this.stopping) return
    this.stopping = false
    const { args, prompt } = this.launch()
    const m = this.meta
    const full = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      // Its name among Claude Code sessions (what agents message it by) carries its Codinger id.
      '--name', claudeName(m.id),
      '--permission-mode', m.permissionMode,
      ...(m.model ? ['--model', m.model] : []),
      ...flagArgs(m.flags, os.homedir()),
      ...(m.resumeAt ? ['--resume', m.claudeSessionId, '--resume-session-at', m.resumeAt, '--fork-session']
        : m.started ? ['--resume', m.claudeSessionId] : ['--session-id', m.claudeSessionId]),
      '--append-system-prompt-file', promptFile(m.id, prompt),
      ...args,
    ]
    if (!fs.existsSync(m.cwd)) throw new Error(`Directory not found: ${m.cwd}`)
    const p = Proc.spawn(CLAUDE, full, { cwd: m.cwd, env: childEnv() })
    this.proc = p
    this.listen(p)
    // Ask for the command list (with descriptions) the way the Agent SDK does.
    p.write(JSON.stringify({ type: 'control_request', request_id: `init-${m.id}`, request: { subtype: 'initialize' } }) + '\n')
    // A session that started with your MCP servers off gets back the ones turned on since.
    const mcp = this.hooks.mcpServers(this)
    if (mcp && Object.keys(mcp).length) p.write(JSON.stringify({ type: 'control_request', request_id: `mcp-${randomUUID()}`, request: { subtype: 'mcp_set_servers', servers: mcp } }) + '\n')
    this.refresh()
  }

  private listen(p: Proc) {
    const m = this.meta
    p.start((line) => {
      if (this.proc !== p || !line.trim()) return // let go of by a rewind
      let msg: any
      try { msg = JSON.parse(line) } catch { return }
      try { this.handle(msg) } catch (e) { console.error(`[${m.id}] handling`, msg?.type, e) }
    }, (code, signal) => {
      if (this.proc !== p) return
      this.proc = null
      const wasBusy = this.outstanding > 0
      // claude exits with code 143 on SIGTERM, so a stop we asked for is judged by the flag.
      const expected = this.stopping
      this.stopping = false
      this.outstanding = 0
      this.background = 0
      for (const id of this.pending.keys()) this.record('permission_resolved', { requestId: id, resolution: 'cancelled' })
      this.pending.clear()
      this.meta.compacting = false
      if (expected) {
        // Asleep or closed: nothing to report.
      } else if (code && signal !== 'SIGTERM') {
        const tail = p.stderrTail().trim().split('\n').slice(-6).join('\n')
        this.meta.error = `claude exited with code ${code}${tail ? `: ${tail}` : ''}`
        this.notice(this.meta.error, 'error')
      } else if (wasBusy) {
        this.notice('The Claude process stopped mid-turn.', 'warn')
      }
      this.hooks.delta(this, '', true)
      this.refresh()
    })
  }

  // The server is stopping: a busy process keeps running for the next server; an idle one ends.
  handoff() {
    const p = this.proc
    if (!p || this.stopping) return
    if (!this.outstanding && !this.pending.size && !this.background && !this.meta.compacting) return this.stop()
    p.handoff(this.meta.id, {
      outstanding: this.outstanding, background: this.background, interrupted: this.interrupted,
      compacting: this.meta.compacting, pending: [...this.pending], callFrom: this.callFrom, callStart: this.callStart,
    })
    this.proc = null
  }

  // A new server: pick up the process the last one handed on, if it still runs.
  // Returns its key, or null.
  reattach(): string | null {
    const r = Proc.adopt(this.meta.id)
    if (!r) return null
    this.cut = false
    const st = r.state as { outstanding: number; background: number; interrupted: boolean; compacting: boolean; pending: [string, { input: any; suggestions: any[] }][]; callFrom: number; callStart: number }
    this.proc = r.proc
    this.outstanding = st.outstanding
    this.background = st.background
    this.interrupted = st.interrupted
    this.pending = new Map(st.pending)
    this.callFrom = st.callFrom
    this.callStart = st.callStart
    this.meta.compacting = st.compacting
    this.listen(r.proc)
    this.refresh()
    return r.proc.key
  }

  private write(obj: unknown) {
    this.ensureProc()
    this.proc!.write(JSON.stringify(obj) + '\n')
  }

  // A one-off call on this conversation that leaves it as it is (server/notes.ts):
  // the same model, system prompt and tools as the session's own process, so it
  // reads the same prompt cache; forked, and not saved. The prompt goes on stdin.
  forkCommand() {
    const m = this.meta
    const { args, prompt } = this.launch()
    return {
      cmd: CLAUDE,
      args: [
        '-p', '--output-format', 'json', '--permission-mode', m.permissionMode,
        ...(m.model ? ['--model', m.model] : []),
        // Its flags too: the same tools, so the same prompt cache.
        ...flagArgs(m.flags, os.homedir()),
        '--resume', m.claudeSessionId, '--fork-session', '--no-session-persistence', '--max-turns', '1',
        '--append-system-prompt-file', promptFile(m.id, prompt),
        ...args,
      ],
      cwd: m.cwd,
      env: childEnv(),
    }
  }

  // The MCP servers this session has on besides Codinger's, in a running process at once;
  // a process started later gets them from the mcpServers hook.
  setMcp(servers: Record<string, unknown>) {
    if (!this.proc || this.stopping) return
    this.write({ type: 'control_request', request_id: `mcp-${randomUUID()}`, request: { subtype: 'mcp_set_servers', servers } })
  }

  stop() {
    if (!this.proc) return
    this.stopping = true
    this.proc.kill()
  }

  // End the process and forget it at once: whatever it still prints is ignored.
  private detach() {
    const p = this.proc
    this.proc = null
    p?.kill()
    this.stopping = false
    this.outstanding = 0
    this.background = 0
    this.interrupted = false
    this.pending.clear()
    this.meta.compacting = false
    this.hooks.delta(this, '', true)
  }

  // ---- input ------------------------------------------------------------

  // `hidden` is appended to what Claude sees but left out of the transcript
  // (the lead's board snapshot). `tasks`: the tasks whose end it tells of.
  send(parts: Part[], opts: { from?: string; hidden?: string; tasks?: string[] } = {}) {
    const { from, hidden, tasks } = opts
    const only = slashCommand(parts)
    if (only) return this.command(only, from)
    const content: any[] = []
    // Adjacent text blocks reach Claude run together, so parts share one block, a blank line apart.
    const addText = (text: string) => {
      const prev = content.at(-1)
      if (prev?.type === 'text') prev.text += `\n\n${text}`
      else content.push({ type: 'text', text })
    }
    const addImage = (url: string, mediaType: string) => {
      const file = imageFile(url)
      if (!file || !fs.existsSync(file)) return
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: fs.readFileSync(file).toString('base64') } })
    }
    for (const p of parts) {
      // A long paste goes to Claude as the text it was (a very long one is a file, shared/pastes.ts);
      // images pasted into the text go where they sit in it.
      for (const c of splitPastes(partText(p))) {
        if ('paste' in c) { if (c.paste.trim()) addText(c.paste); continue }
        for (const r of splitImages(c.text)) {
          if ('url' in r) addImage(r.url, mediaTypeOf(r.url))
          else if (r.text.trim()) addText(r.text.trim())
        }
      }
      for (const img of p.images ?? []) addImage(img.url, img.mediaType)
    }
    if (!content.length) throw new Error('Nothing to send')
    if (hidden) addText(hidden)
    const uuid = randomUUID()
    this.callFrom = Date.now()
    this.write({ type: 'user', uuid, message: { role: 'user', content } })
    this.outstanding++
    this.meta.unread = false
    this.meta.pendingAsks = 0
    this.meta.pendingCritical = 0
    this.meta.pendingReviews = 0
    this.meta.error = null
    this.record('user', { parts, uuid, csid: this.meta.claudeSessionId, ...(from ? { from } : {}), ...(tasks?.length ? { tasks } : {}) })
    this.refresh()
  }

  // Slash commands (/compact, /context, ...) go in as plain user text.
  command(cmd: string, from?: string) {
    const uuid = randomUUID()
    this.callFrom = Date.now()
    this.write({ type: 'user', uuid, message: { role: 'user', content: cmd } })
    this.outstanding++
    this.meta.unread = false
    this.meta.error = null
    if (cmd.startsWith('/compact')) this.meta.compacting = true
    this.record('user', { parts: [{ kind: 'text', text: cmd }], uuid, csid: this.meta.claudeSessionId, ...(from ? { from } : {}) })
    this.refresh()
  }

  // Forget one of your messages and everything after it, in the transcript and
  // in Claude's context. Claude resumes from the entry before it, in a forked
  // copy of its transcript (the original stays in Claude Code's history).
  // Files Claude changed since then stay as they are.
  rewind(seq: number) {
    const ev = this.getEvents()
    const i = ev.findIndex((e) => e.seq === seq)
    const e = ev[i]
    if (e?.t !== 'user') throw new Error('That is not one of your messages')
    const m = this.meta
    const text = e.parts.map(partText).filter((t) => t.trim()).join('\n\n').trim()
    const nth = ev.slice(0, i).filter((x) => x.t === 'user' && x.parts.map(partText).filter((t) => t.trim()).join('\n\n').trim() === text).length
    // A message sent just before a fork or a /clear is filed under the old id; look in both.
    let csid = '', at: string | null | undefined
    for (const id of new Set([e.csid, m.claudeSessionId].filter((x): x is string => !!x))) {
      at = entryBefore(id, { uuid: e.uuid, text, nth })
      if (at !== undefined) { csid = id; break }
    }
    if (at === undefined) {
      // Claude never got it (or its transcript is gone): only the transcript here needs cutting.
      if (m.started && ev.slice(0, i).some((x) => x.t === 'user')) throw new Error('Claude Code\'s transcript has no record of that message, so its context cannot be cut there')
      at = null
    }
    this.detach()
    if (at) Object.assign(m, { claudeSessionId: csid, started: true, resumeAt: at })
    else Object.assign(m, { claudeSessionId: randomUUID(), started: false, resumeAt: null })
    ev.splice(i)
    writeEvents(m.id, ev)
    m.error = null
    m.unread = false
    Object.assign(m, this.openAsks())
    const last = ev.findLast((x) => x.t === 'assistant' && x.blocks.some((b) => b.type === 'text'))
    m.lastText = last?.t === 'assistant' ? overview(last.blocks.flatMap((b) => b.type === 'text' ? [b.text] : []).join('\n')) : ''
    this.hooks.truncate(this, seq)
    this.refresh()
  }

  // Start over: a new conversation, and this transcript goes with the old one.
  // Its numbers keep counting up, so nothing still kept by number points into the new one.
  forget(note: string) {
    this.detach()
    const m = this.meta
    this.seqFrom = this.nextSeq()
    this.events = []
    writeEvents(m.id, [])
    Object.assign(m, { claudeSessionId: randomUUID(), started: false, resumeAt: null, context: { used: 0, window: m.context.window }, error: null, unread: false, pendingAsks: 0, pendingCritical: 0, pendingReviews: 0, lastText: '' })
    this.hooks.truncate(this, 0)
    this.notice(note)
    this.refresh()
  }

  // The login was missing or expired.
  private authError() {
    const last = this.getEvents().findLast((e) => e.t === 'user')
    if (last) this.authRetry = last.seq
    this.hooks.authFailed(this)
  }

  // Signed in again: the message that failed goes again, in its own place.
  retryAfterSignIn(extra: (parts: Part[]) => { hidden?: string; tasks?: string[] }) {
    const seq = this.authRetry
    this.authRetry = null
    if (seq == null) return
    const ev = this.getEvents()
    const e = ev.find((x) => x.seq === seq)
    if (e?.t !== 'user' || ev.some((x) => x.t === 'user' && x.seq > seq)) return
    try { this.rewind(seq) } catch { this.detach() }
    const opts = extra(e.parts)
    this.send(e.parts, { ...opts, ...(e.from ? { from: e.from } : {}), ...(e.tasks || opts.tasks ? { tasks: [...e.tasks ?? [], ...opts.tasks ?? []] } : {}) })
  }

  interrupt() {
    if (!this.proc) return
    this.interrupted = true
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
  }

  setPermissionMode(mode: PermissionMode) {
    this.meta.permissionMode = mode
    if (this.proc) this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode } })
    this.refresh()
  }

  answerPermission(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string) {
    const req = this.pending.get(requestId)
    if (!req) throw new Error('That permission request is no longer pending')
    this.pending.delete(requestId)
    const response = decision === 'deny'
      ? { behavior: 'deny', message: `The user denied this.${message?.trim() ? ` Their reason: ${message.trim()}` : ''}` }
      : { behavior: 'allow', updatedInput: req.input, ...(decision === 'always' ? { updatedPermissions: req.suggestions } : {}) }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    this.record('permission_resolved', { requestId, resolution: decision })
    this.refresh()
  }

  markSeen() {
    if (!this.meta.unread) return
    this.meta.unread = false
    this.refresh()
  }

  markUnread() {
    if (this.meta.unread) return
    this.meta.unread = true
    this.refresh()
  }

  // ---- output -----------------------------------------------------------

  private handle(msg: any) {
    const m = this.meta
    // Claude starts a turn by itself when background work finishes.
    if (!this.outstanding && (msg.type === 'stream_event' || msg.type === 'assistant')) { this.outstanding = 1; this.refresh() }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          m.started = true
          // /clear starts a new conversation under a new id, and so does a fork after a rewind; resume that one next time.
          if (msg.session_id) { m.claudeSessionId = msg.session_id; m.resumeAt = null }
          if (Array.isArray(msg.terminal_slash_commands)) this.terminalOnly = new Set(msg.terminal_slash_commands)
          if (msg.model && msg.model !== m.model) { learnModel(m.model, msg.model); m.model = msg.model; m.context.window = knownWindow(m.model) }
          if (msg.apiKeySource && msg.apiKeySource !== 'none') this.notice(`Claude is authenticating with ${msg.apiKeySource}, which may bill per token.`, 'warn')
          this.refresh()
        } else if (msg.subtype === 'background_tasks_changed') {
          this.background = Array.isArray(msg.tasks) ? msg.tasks.length : 0
          this.refresh()
        } else if (msg.subtype === 'status') {
          m.compacting = msg.status === 'compacting'
          this.refresh()
        } else if (msg.subtype === 'compact_boundary') {
          const c = msg.compact_metadata ?? {}
          if (c.post_tokens != null) m.context.used = c.post_tokens
          this.notice(`Context compacted${c.pre_tokens ? `: ${k(c.pre_tokens)} → ${k(c.post_tokens ?? 0)}` : ''} (${c.trigger ?? 'manual'})`)
          this.refresh()
        }
        return
      case 'stream_event': {
        if (msg.parent_tool_use_id) return
        const ev = msg.event
        if (ev?.type === 'message_start') this.callStart = this.callFrom || Date.now()
        if (ev?.type === 'content_block_start' || ev?.type === 'message_start') this.hooks.delta(this, '', true)
        else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.hooks.delta(this, ev.delta.text, false)
        return
      }
      case 'assistant': {
        const a = msg.message ?? {}
        const synthetic = a.model === '<synthetic>'
        if (!synthetic && a.usage) {
          // A message's blocks come as separate lines with the usage so far: count only what grew.
          // Subagents' calls count too: they are this session's spend.
          const id = a.id ?? msg.uuid, usd = costOf(a.usage, a.model ?? m.model), prev = this.costSeen.get(id) ?? 0
          if (usd > prev) { this.costSeen.set(id, usd); addSpend(m, usd - prev) }
        }
        if (msg.parent_tool_use_id) return // a subagent's own turns: too noisy for the transcript, and not this context
        const blocks: Block[] = []
        for (const b of a.content ?? []) {
          // Images of local files in the text point at kept copies (server/media.ts).
          // <raise item="…"/>: an earlier item again, as it was.
          if (b.type === 'text') blocks.push({ type: 'text', text: raiseItems(keepMediaIn(b.text, m.cwd), (msg) => this.textOf(msg)) })
          else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking })
          else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
        }
        if (synthetic && blocks.some((b) => b.type === 'text' && AUTH_ERROR.test(b.text))) this.authError()
        if (!synthetic && a.usage) {
          const u = a.usage
          // The first call of a conversation: how big a new session starts.
          if (!m.context.used && !m.base) {
            const read = u.cache_read_input_tokens ?? 0
            m.base = { total: (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0), read }
          }
          m.context.used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
          // What it wrote to the cache says the TTL; a call that only read keeps the last one.
          const cc = u.cache_creation ?? {}
          const ttl = cc.ephemeral_1h_input_tokens > 0 ? 3_600_000 : cc.ephemeral_5m_input_tokens > 0 ? 300_000 : m.cache?.ttl ?? 300_000
          m.cache = { at: this.callStart || Date.now(), ttl }
        }
        this.callFrom = Date.now()
        this.hooks.delta(this, '', true)
        if (!blocks.length) return
        const plain = overview(blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n'))
        if (plain) m.lastText = plain
        this.record('assistant', { msgId: a.id ?? msg.uuid, blocks, ...(synthetic ? { synthetic } : {}) })
        return
      }
      case 'user': {
        if (msg.parent_tool_use_id) return
        const c = msg.message?.content
        if (typeof c === 'string') {
          const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(c)?.[1]?.trim()
          if (out) this.notice(out)
          return
        }
        for (const b of c ?? []) {
          if (b.type !== 'tool_result') continue
          this.callFrom = Date.now()
          const text = typeof b.content === 'string' ? b.content
            : (b.content ?? []).map((x: any) => x.type === 'text' ? x.text : `[${x.type}]`).join('\n')
          this.record('tool_result', { toolUseId: b.tool_use_id, text: text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '\n… (truncated)' : text, isError: !!b.is_error })
        }
        return
      }
      case 'result': {
        // Messages sent mid-turn are often taken into the running turn, which then ends with one
        // result for all of them: a result means nothing is left in flight. A queued message that
        // starts a turn of its own is caught when its output arrives (top of handle).
        this.outstanding = 0
        m.compacting = false
        const mu = msg.modelUsage ?? {}
        for (const [model, u] of Object.entries(mu)) if ((u as any)?.contextWindow) learnWindow(model, (u as any).contextWindow)
        const win = (mu[m.model ?? ''] ?? Object.values(mu)[0] as any)?.contextWindow
        if (win) m.context.window = win
        if (msg.is_error && this.interrupted) {
          msg.is_error = false
          this.notice('Interrupted.')
        } else if (msg.is_error) {
          m.error = String(msg.result ?? msg.subtype ?? 'error').slice(0, 500)
          if (AUTH_ERROR.test(m.error) && this.authRetry == null) this.authError()
        }
        if (!this.outstanding) this.interrupted = false
        if (msg.num_turns > 0 || msg.is_error) {
          this.record('result', { durationMs: msg.duration_ms ?? 0, isError: !!msg.is_error, ...(msg.is_error ? { text: m.error! } : {}) })
          m.unread = true
          Object.assign(m, this.openAsks())
        }
        this.hooks.delta(this, '', true)
        this.refresh()
        return
      }
      case 'control_response': {
        const r = msg.response
        const failed = String(r?.request_id ?? '').startsWith('mcp-') ? Object.entries(r.response?.errors ?? {}) : []
        if (failed.length) this.notice(`Could not turn on ${failed.map(([n, e]) => `${n} (${e})`).join(', ')}`, 'warn')
        if (r?.request_id === `init-${m.id}` && Array.isArray(r.response?.commands)) {
          this.hooks.commands(this, r.response.commands
            .filter((c: any) => c?.name && !this.terminalOnly.has(c.name) && !c.name.startsWith('__'))
            .map((c: any) => ({ name: c.name, description: String(c.description ?? ''), argumentHint: String(c.argumentHint ?? '') })))
        }
        return
      }
      case 'conversation_reset': {
        m.context.used = 0
        m.pendingAsks = 0
        m.pendingCritical = 0
        m.pendingReviews = 0
        this.notice('Conversation cleared. Claude starts fresh from here.')
        this.refresh()
        return
      }
      case 'control_request': {
        const r = msg.request ?? {}
        if (r.subtype === 'can_use_tool') {
          const suggestions = (r.permission_suggestions ?? []).filter((s: any) => s.type === 'addRules')
          this.pending.set(msg.request_id, { input: r.input, suggestions })
          this.record('permission', {
            requestId: msg.request_id, toolName: r.display_name ?? r.tool_name, input: r.input,
            description: r.description ?? r.decision_reason, canAlways: suggestions.length > 0,
            ...(r.tool_use_id ? { toolUseId: r.tool_use_id } : {}),
          })
          this.refresh()
        } else {
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Codinger does not handle ${r.subtype}` } })
        }
        return
      }
      case 'control_cancel_request': {
        if (this.pending.delete(msg.request_id)) {
          this.record('permission_resolved', { requestId: msg.request_id, resolution: 'cancelled' })
          this.refresh()
        }
        return
      }
      case 'rate_limit_event': {
        const i = msg.rate_limit_info ?? {}
        const w = i.unifiedWindows ?? {}
        this.hooks.usage({ fiveHour: w.five_hour?.utilization, sevenDay: w.seven_day?.utilization, resetsAt: i.resetsAt, status: i.status, ...(i.isUsingOverage ? { overage: true } : {}) })
        return
      }
    }
  }

  // The text of a block of Claude's, by "<seq>.<block>" (the first part of an item's key).
  private textOf(msg: string): string | undefined {
    const [seq, i] = msg.split('.').map(Number)
    const e = this.getEvents().find((x) => x.t === 'assistant' && x.seq === seq)
    const b = e?.t === 'assistant' ? e.blocks[i] : undefined
    return b?.type === 'text' ? b.text : undefined
  }

  // Questions and items to consider in Claude's text since the user last spoke.
  private openAsks(): { pendingAsks: number; pendingCritical: number; pendingReviews: number } {
    const ev = this.getEvents()
    let n = 0, critical = 0, reviews = 0
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      if (fromUser(e)) break
      if (e.t === 'assistant') for (const b of e.blocks) if (b.type === 'text') for (const it of itemsOf(b.text)) { n++; if (it.kind === 'consider' && it.critical) critical++; if (it.kind === 'review') reviews++ }
    }
    return { pendingAsks: n, pendingCritical: critical, pendingReviews: reviews }
  }

  // A plain-text rendering of the recent transcript, for the lead agent.
  digest(maxChars: number, turns: number): string {
    const ev = this.getEvents()
    let start = ev.length
    let seen = 0
    while (start > 0 && seen < turns) { start--; if (ev[start].t === 'user') seen++ }
    const lines: string[] = []
    for (const e of ev.slice(start)) {
      if (e.t === 'user') lines.push(`USER${e.from ? ` (via ${e.from})` : ''}: ${e.parts.map((p) => p.kind === 'note' ? formatNote(p.quote, p.text) : p.kind === 'answer' ? `[answer ${p.askKey}] ${p.choices?.join('; ') ?? ''} ${p.text}` : p.kind === 'dismiss' ? formatDismissed(p.items) : p.kind === 'pending' ? formatPending(p.items) : p.kind === 'done' ? formatDone(p.items) : partText(p)).join('\n')}`)
      else if (e.t === 'assistant') for (const b of e.blocks) {
        if (b.type === 'text') lines.push(`CLAUDE: ${b.text}`)
        else if (b.type === 'tool_use') lines.push(`  [${b.name}] ${toolSummary(b.name, b.input)}`)
      }
      else if (e.t === 'permission') lines.push(`  [waiting for permission: ${e.toolName}]`)
      else if (e.t === 'notice' && e.level !== 'info') lines.push(`  [${e.level}: ${e.text}]`)
    }
    const s = withoutImages(lines.join('\n'))
    return s.length > maxChars ? '…' + s.slice(-maxChars) : s
  }
}

// The text Claude receives for one part of a message.
function partText(p: Part): string {
  return p.kind === 'note' ? formatNote(p.quote, p.text)
    : p.kind === 'artifact' ? formatArtifactNote(p.anchor, p.quote, p.text)
    : p.kind === 'answer' ? formatAnswer(p.askKey.split(':').pop()!, p.question, p.choices, p.text, p.draft)
    : p.kind === 'dismiss' ? formatDismissed(p.items)
    : p.kind === 'pending' ? formatPending(p.items)
    : p.kind === 'done' ? formatDone(p.items)
    : p.kind === 'review' ? formatReview(p.files, p.comments)
    : p.kind === 'mail' ? formatMail(p)
    : p.text
}

// The tail of what Claude said, for overviews: questions as their text, without the markup.
function overview(text: string): string {
  return text
    .replace(/^```ask\b[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (_, body: string) => `Q: ${body.split('\n')[0]}`)
    .replace(/^\s*<ask\b[^>]*>\s*\n?([^\n]*)[\s\S]*?<\/ask>\s*$/gm, (_, q: string) => `Q: ${q}`)
    .replace(/^\s*<\/?(answer|details|consider|run|review)\b[^>]*>\s*$/gm, '')
    .trim().slice(-400)
}

// The body of a push when a turn ends: the questions it left, the tool that waits for a
// permission, or the answer it gave. A phone shows about 180 characters of it, with no markdown.
export function pushBody(events: Event[], status: string): string | null {
  const from = events.findLastIndex((e) => e.t === 'user')
  const turn = events.slice(from + 1)
  if (status === 'permission') {
    const p = turn.findLast((e) => e.t === 'permission')
    if (p?.t !== 'permission') return null
    const what = toolSummary(p.toolName, p.input) || p.description || ''
    return clip(`Needs your permission: ${p.toolName}${what ? ` ${what}` : ''}`)
  }
  const texts = turn.flatMap((e) => e.t === 'assistant' ? [e.blocks.flatMap((b) => b.type === 'text' ? [b.text] : []).join('\n')] : []).filter(Boolean)
  if (status === 'asking') {
    const all = texts.join('\n')
    const items = [
      ...[...all.matchAll(/<consider\b[^>]*\btitle="([^"]*)"[^>]*\bcritical\b[^>]*>/g)].map((m) => m[1]),
      ...[...all.matchAll(/<ask\b[^>]*>\s*\n?([^\n]*)/g)].map((m) => m[1]),
    ].map(plain).filter(Boolean)
    if (!items.length) return null
    return clip(items.length === 1 ? items[0] : `${items.length} questions: ${items.join(' · ')}`)
  }
  const last = texts.findLast((t) => /<answer\b/.test(t)) ?? texts.at(-1)
  if (!last) return null
  const answer = /<answer\b[^>]*>([\s\S]*?)<\/answer>/.exec(last)?.[1]
  // With no <answer>, the first paragraph of the last message.
  return clip(plain(answer ?? last.replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, '').trim().split(/\n\s*\n/)[0] ?? '')) || null
}

const plain = (t: string) => t
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/<\/?[a-z][^>]*>/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s*(#+|[-*+]|\d+\.)\s+/gm, '')
  .replace(/\*\*|__|`/g, '')
  .replace(/\s+/g, ' ').trim()

const clip = (t: string, n = 180) => t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '')}…`

export function toolSummary(name: string, input: any): string {
  if (!input) return ''
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt
  return typeof v === 'string' ? v.split('\n')[0].slice(0, 160) : JSON.stringify(input).slice(0, 160)
}

const k = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
