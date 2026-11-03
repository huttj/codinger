// Sessions that work together: a worker can start child sessions, see the other sessions,
// and send them messages. A message goes in at once, or when the receiver's turn ends.
// A parent and its children may always write to each other; other sessions too, unless the
// receiver narrowed its inbox with set_inbox. A parent can archive its children. A parent's message to its archived child waits for your yes or no:
// a yes takes the child out of the archive, so a parent can reuse a child that has the context. A child's parent hears
// when the child goes idle after work the parent sent it. A child's message to its parent waits for the child's next tool call: if
// its turn ends first, the parent gets one message that says so, and no separate idle note. Past MAX_RUN messages in a row from one sender, with no word from you in
// either session, a message waits for your OK.

import { randomUUID } from 'node:crypto'
import type { Mail, Part, PermissionMode, SessionMeta } from '../shared/types.ts'
import { MAX_RUN, excerpt } from '../shared/mail.ts'
import { cacheLeft, knownTtl } from '../shared/cache.ts'
import type { Session } from './session.ts'
import type { Tool } from './mcp.ts'

export const MAX_DEPTH = 2      // a top session, its children, and theirs
export const MAX_CHILDREN = 8   // children of one session that are not archived

type Ctx = {
  sessions: Map<string, Session>
  create(o: { cwd: string; title: string; model?: string | null; permissionMode: PermissionMode; parentId: string }): Session
  hidden(s: Session, parts: Part[]): { hidden?: string; tasks?: string[] }
  changed(): void
  push(n: { title: string; body: string; session: string }): Promise<string | null>
}
let ctx: Ctx

// Call it before a handed-on session can send its first event.
export function startMail(c: Ctx) {
  ctx = c
  // Messages the last server left waiting go once the server is up (sending needs
  // what index.ts sets up further down).
  setImmediate(() => {
    for (const s of c.sessions.values()) {
      for (const m of s.meta.mail ?? []) delete m.step
      flushMail(s)
    }
  })
}

export const MAIL_TOOLS = ['list_sessions', 'spawn_session', 'send_message', 'reply', 'set_inbox', 'read_session', 'stop_session', 'archive_session']
const isMailTool = (name: string) => MAIL_TOOLS.some((t) => name === `mcp__codinger__${t}`)

const busy = (m: SessionMeta) => m.status === 'working' || m.status === 'permission' || m.compacting
const metaOf = (id: string | null | undefined) => id ? ctx.sessions.get(id)?.meta : undefined
const workers = () => [...ctx.sessions.values()].map((s) => s.meta).filter((m) => m.kind === 'worker')
const childrenOf = (id: string) => workers().filter((m) => m.parentId === id)
// Codinger's own words, not a message that a session wrote.
const isNote = (m: Pick<Mail, 'idle' | 'decided'>) => !!(m.idle || m.decided)

// What b is to a.
function relation(a: SessionMeta, b: SessionMeta): 'parent' | 'child' | null {
  return b.parentId === a.id ? 'child' : a.parentId === b.id ? 'parent' : null
}

function depth(m: SessionMeta): number {
  let d = 0
  for (let p = metaOf(m.parentId); p && d < 10; p = metaOf(p.parentId)) d++
  return d
}

function isAncestor(id: string, m: SessionMeta): boolean {
  for (let p = metaOf(m.parentId), n = 0; p && n < 10; p = metaOf(p.parentId), n++) if (p.id === id) return true
  return false
}

function session(id: unknown): Session {
  const s = ctx.sessions.get(String(id ?? ''))
  if (!s || s.meta.kind !== 'worker') throw new Error(`No session "${id}". Call list_sessions.`)
  return s
}

// Why `to` does not take a message from `from`, if it does not. A reply always goes:
// the receiver wrote first.
function refusal(from: SessionMeta, to: SessionMeta, reply = false): string | null {
  if (to.id === from.id) return 'That is your own session.'
  if (to.archived) {
    if (relation(from, to) !== 'child') return `"${to.title}" is archived. Only its parent can send it a message, with the user's OK.`
    if (childrenOf(from.id).filter((c) => !c.archived).length >= MAX_CHILDREN) return `"${to.title}" is archived, and you have ${MAX_CHILDREN} children that are not archived, the most there can be. Ask the user to archive the ones that are done.`
    return null
  }
  if (reply || relation(from, to)) return null
  // The inbox is open unless the session narrowed it with set_inbox.
  const f = to.mailFilter
  if (!f || f.mode === 'any' || (f.mode === 'only' && f.ids?.includes(from.id))) return null
  return `"${to.title}" (${to.id}) closed its inbox: it takes messages only from ${f.mode === 'only' ? 'its parent, its children and the sessions it named' : 'its parent and its children'}.`
}

function post(to: Session, m: Omit<Mail, 'id' | 'ts'>): Mail {
  const mail: Mail = { ...m, id: `m${randomUUID().slice(0, 7)}`, ts: Date.now() }
  // A message to an archived session waits for your yes or no, in the sender's session too.
  if (to.meta.archived && !isNote(m)) {
    mail.held = mail.reopens = true
    void ctx.push({ title: m.title, body: `Asks to write to archived "${excerpt(to.meta.title, 40)}": ${excerpt(m.text, 90)}`, session: m.from })
  } else if (!isNote(m) && (to.meta.mailRun?.[m.from] ?? 0) >= MAX_RUN) mail.held = true
  if (!isNote(m) && metaOf(m.from)?.parentId === to.meta.id) mail.step = true
  to.meta.mail = [...to.meta.mail ?? [], mail]
  ctx.changed()
  flushMail(to)
  return mail
}

// What the sender hears of its message.
// A child's prompt cache: a message after it expires writes the whole context to the cache again.
function cacheOf(m: SessionMeta): string {
  const left = cacheLeft(m, Date.now(), knownTtl(workers()))
  return left == null ? 'empty' : left > 0 ? `warm for ${Math.ceil(left / 60_000)} more min` : 'expired'
}

function sent(to: Session, m: Mail): string {
  const t = `"${to.meta.title}"`
  return (
    m.reopens ? `Held for the user's OK as \`${m.id}\`: ${t} is archived. The user sees your message in your session and says yes or no. Do not send it again, and do not wait for the answer: go on with other work. After a yes, ${t} leaves the archive with its whole context and gets the message, and you hear from it as usual. After a no, you get a message that says so.`
    : m.held ? `Held for the user's OK as \`${m.id}\`: ${t} got ${MAX_RUN} messages in a row from you, and the user wrote in neither session since. Ask the user to press Send on it in ${t}.`
    : m.step ? `Sent to ${t} as \`${m.id}\`. It goes in at your next tool call, or when your turn ends: then it also tells ${t} that you are idle.`
    : to.meta.pendingCritical && to.meta.mail?.some((x) => x.id === m.id) ? `Waiting as \`${m.id}\`: ${t} has an item marked critical open for the user. Nothing goes in before the user's next message there; yours goes in with it. This is the only delivery there is until then.`
    : to.meta.mail?.some((x) => x.id === m.id) ? `Queued as \`${m.id}\`: ${t} is in the middle of a turn, and gets it when the turn ends.`
    : `Delivered to ${t} as \`${m.id}\`.`)
}

// Send the messages waiting for a session, in one turn, if it is between turns.
// An item marked critical holds them for the user's next message there (takeMail).
export function flushMail(s: Session) {
  if (busy(s.meta) || s.meta.archived || s.meta.pendingCritical) return
  const parts = takeMail(s)
  if (parts.length) s.send(parts, { from: 'mail', ...ctx.hidden(s, parts) })
}

// The messages ready to go in, taken off the session's list.
export function takeMail(s: Session): Part[] {
  const ready = (s.meta.mail ?? []).filter((m) => !m.held && !m.step)
  if (!ready.length) return []
  s.meta.mail = s.meta.mail!.filter((m) => m.held || m.step)
  const run = { ...s.meta.mailRun }
  for (const m of ready) if (!isNote(m)) run[m.from] = (run[m.from] ?? 0) + 1
  s.meta.mailRun = run
  if (ready.some((m) => !isNote(m) && m.from === s.meta.parentId)) s.meta.parentWaits = true
  const parts: Part[] = ready.map((m) => {
    const f = metaOf(m.from)
    const rel = f && relation(s.meta, f)
    return { kind: 'mail', text: m.text, id: m.id, from: m.from, title: f?.title ?? m.title, ...(rel ? { relation: rel } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.idle ? { idle: true } : {}), ...(m.decided ? { decided: true } : {}), ...(m.endTurn ? { endTurn: true } : {}) }
  })
  ctx.changed()
  return parts
}

// A child's messages to its parent that wait for its next step.
const stepping = (s: Session) => {
  const parent = s.meta.parentId ? ctx.sessions.get(s.meta.parentId) : undefined
  return { parent, waiting: parent?.meta.mail?.filter((m) => m.step && m.from === s.meta.id) ?? [] }
}

// The session called a tool: it goes on, so its messages to its parent go now. Loading a
// tool's schema is not a step.
export function stepped(s: Session, toolNames: string[]) {
  if (!toolNames.some((n) => !isMailTool(n) && n !== 'ToolSearch')) return
  const { parent, waiting } = stepping(s)
  if (!parent || !waiting.length) return
  for (const m of waiting) delete m.step
  ctx.changed()
  flushMail(parent)
}

// A turn ended and nothing started another: its parent hears it is idle, in its last message
// to the parent if there is one, else in a note if the parent sent it work.
export function turnEnded(s: Session) {
  const { parent, waiting } = stepping(s)
  if (parent && waiting.length) {
    for (const m of waiting) delete m.step
    if (!busy(s.meta)) {
      const last = waiting.at(-1)!
      last.endTurn = true
      if (s.meta.pendingAsks) last.text += '\n\n(It left questions for the user.)'
      s.meta.parentWaits = false
    }
    ctx.changed()
    flushMail(parent)
    return
  }
  if (!s.meta.parentWaits || busy(s.meta)) return
  s.meta.parentWaits = false
  if (parent && !parent.meta.archived) post(parent, { from: s.meta.id, title: s.meta.title, text: s.meta.pendingAsks ? 'It left questions for the user.' : '', idle: true })
  else ctx.changed()
}

// You wrote in a session: messages between it and any other start a new run.
export function userWrote(s: Session) {
  let n = s.meta.mailRun ? 1 : 0
  s.meta.mailRun = undefined
  for (const m of workers()) if (m.mailRun?.[s.meta.id]) { delete m.mailRun[s.meta.id]; n++ }
  if (n) ctx.changed()
}

// Your OK for a held message (it starts a new run from its sender), or its removal. A message
// to an archived session: a yes takes the session out of the archive. Its sender hears a no, and
// hears a yes only if you wrote a note: after a yes, it hears from the session as usual.
export function release(s: Session, id: string, send: boolean, note = '') {
  const m = s.meta.mail?.find((x) => x.id === id)
  if (!m) throw new Error('No such message')
  const asked = m.reopens
  if (send) {
    m.held = false
    delete m.reopens
    if (asked) s.meta.archived = false
    s.meta.mailRun = { ...s.meta.mailRun, [m.from]: 0 }
  } else s.meta.mail = s.meta.mail!.filter((x) => x !== m)
  ctx.changed()
  flushMail(s)
  const sender = ctx.sessions.get(m.from), words = note.trim()
  if (!asked || !sender || sender.meta.archived || (send && !words)) return
  const said = send ? `The user said yes to your message \`${m.id}\` to "${s.meta.title}".` : `The user said no to your message \`${m.id}\` to "${s.meta.title}": it did not go. Do not send it again unless the user asks.`
  post(sender, { from: s.meta.id, title: s.meta.title, text: words ? `${said} The user's note: ${words}` : said, decided: true })
}

export function mailTools(id: string): Tool[] {
  const me = () => session(id)
  return [
    {
      name: 'list_sessions',
      description: 'The other Codinger sessions (each a full Claude Code session with a name): id, title, directory, status, parent and children, what each is to you, and whether it takes messages from you (every session does, unless it closed its inbox with set_inbox). It also lists your archived children, and for each child its context use and its prompt cache: a message to a child whose cache expired writes its whole context to the cache again, at full price.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const m = me().meta
        return workers().filter((x) => !x.archived || x.parentId === m.id).map((x) => ({
          id: x.id, title: x.title, cwd: x.cwd, status: x.status,
          ...(x.archived ? { archived: true } : {}),
          ...(x.id === m.id ? { you: true } : { is: relation(m, x) ?? (x.parentId && x.parentId === m.parentId ? 'sibling' : 'other') }),
          ...(x.parentId === m.id ? { context: `${Math.round(x.context.used / 1000)}k of ${Math.round(x.context.window / 1000)}k tokens`, cache: cacheOf(x) } : {}),
          parent: x.parentId, children: childrenOf(x.id).filter((c) => !c.archived).map((c) => c.id),
          inbox: x.mailFilter?.mode === 'none' ? 'parent and children' : x.mailFilter?.mode === 'only' ? `parent, children and ${x.mailFilter.ids?.join(', ')}` : 'any',
          ...(x.id === m.id ? {} : { takes_messages_from_you: !refusal(m, x) }),
        }))
      },
    },
    {
      name: 'spawn_session',
      description: `Start a child session: a full Claude Code session with its own name, which the user can see and talk to in Codinger, and which you can message. Use it to delegate a large, separate piece of work (not for a quick search: use your own subagents for that). It gets your prompt as a message from you, and you hear when it ends its turn and is idle. Before you start one, look in list_sessions for a child of yours that already has the context for the work, archived or not, and send it a message instead; start a new one when that child's context is large or the work is unrelated. For children that work in the same git repository at the same time, make a git worktree for each one and start it there. At most ${MAX_CHILDREN} children; a child's child cannot start children.`,
      inputSchema: {
        type: 'object', required: ['title', 'prompt'],
        properties: {
          title: { type: 'string', description: 'Its name: 2 to 5 words' },
          prompt: { type: 'string', description: 'The work, with all the context it needs: it does not see your conversation' },
          cwd: { type: 'string', description: 'An existing directory, absolute or ~; yours by default' },
          model: { type: 'string', description: 'opus, sonnet, haiku or fable; omit for the default' },
        },
      },
      run: ({ title, prompt, cwd, model }) => {
        const m = me().meta
        if (depth(m) >= MAX_DEPTH) throw new Error('Your session is a child of a child, so it cannot start children. Do the work yourself, or ask your parent.')
        if (childrenOf(id).filter((c) => !c.archived).length >= MAX_CHILDREN) throw new Error(`You have ${MAX_CHILDREN} children that are not archived, the most there can be. Ask the user to archive the ones that are done.`)
        if (!String(prompt ?? '').trim()) throw new Error('Give a prompt')
        const s = ctx.create({ cwd: String(cwd ?? '') || m.cwd, title: String(title ?? ''), model: model ? String(model) : null, permissionMode: m.permissionMode, parentId: id })
        post(s, { from: id, title: m.title, text: String(prompt) })
        return `Started \`${s.meta.id}\` ("${s.meta.title}") in ${s.meta.cwd}, with your prompt. You will hear when it ends its turn and is idle.`
      },
    },
    {
      name: 'send_message',
      description: 'Send a message to another session. It goes in at once if the session is between turns, or when its turn ends. A session with an item marked critical for the user takes nothing before the user\'s next message there: yours goes in with it. Any session takes your messages, unless it closed its inbox with set_inbox (see list_sessions); your parent and your children always do. A message to your archived child waits for the user\'s OK: after a yes it takes the child out of the archive, and after a no you hear that it did not go. To answer a message you got, use reply.',
      inputSchema: { type: 'object', required: ['to', 'message'], properties: { to: { type: 'string', description: 'The session id' }, message: { type: 'string' } } },
      run: ({ to, message }) => {
        const m = me().meta, s = session(to)
        const why = refusal(m, s.meta)
        if (why) throw new Error(why)
        if (!String(message ?? '').trim()) throw new Error('Give a message')
        return sent(s, post(s, { from: id, title: m.title, text: String(message) }))
      },
    },
    {
      name: 'reply',
      description: "Answer a message from another session, by the message's id (the `m…` id in its header). The sender does not see your chat: what it should know goes in the reply. Both sessions show the reply.",
      inputSchema: { type: 'object', required: ['message_id', 'message'], properties: { message_id: { type: 'string' }, message: { type: 'string' } } },
      run: ({ message_id, message }) => {
        const mid = String(message_id ?? '').replace(/`/g, '')
        let orig: Extract<Part, { kind: 'mail' }> | undefined
        for (const e of me().getEvents()) if (e.t === 'user') for (const p of e.parts) if (p.kind === 'mail' && p.id === mid) orig = p
        if (!orig) throw new Error(`You got no message \`${mid}\`.`)
        if (isNote(orig)) throw new Error('That is a note from Codinger. Use send_message to write to the session.')
        const m = me().meta, s = session(orig.from)
        const why = refusal(m, s.meta, true)
        if (why) throw new Error(why)
        if (!String(message ?? '').trim()) throw new Error('Give a message')
        return sent(s, post(s, { from: id, title: m.title, text: String(message), replyTo: { id: mid, text: excerpt(orig.text) } }))
      },
    },
    {
      name: 'set_inbox',
      description: 'Choose which other sessions may send you messages. Your parent and your children always may. any (the default): every session. only: the sessions in ids. none: no others. Close it when you want quiet; open it again with any.',
      inputSchema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['none', 'only', 'any'] }, ids: { type: 'array', items: { type: 'string' } } } },
      run: ({ mode, ids }) => {
        const m = me().meta
        if (mode === 'any') m.mailFilter = undefined
        else if (mode === 'only') {
          const list = (Array.isArray(ids) ? ids : []).map(String)
          const unknown = list.filter((x) => !metaOf(x))
          if (unknown.length) throw new Error(`No sessions ${unknown.join(', ')}. Call list_sessions.`)
          if (!list.length) throw new Error('Give the ids')
          m.mailFilter = { mode: 'only', ids: list }
        } else m.mailFilter = { mode: 'none' }
        ctx.changed()
        return mode === 'any' ? 'Every session may now send you messages.' : mode === 'only' ? `Your parent, your children and ${(ids as string[]).join(', ')} may now send you messages.` : 'Only your parent and your children may now send you messages.'
      },
    },
    {
      name: 'read_session',
      description: "Read a condensed transcript of the last turns of one of your children (or their children). Costs context: keep max_chars small.",
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, turns: { type: 'number', description: 'Turns to go back (default 1)' }, max_chars: { type: 'number', description: 'Default 3000' } } },
      run: ({ id: target, turns, max_chars }) => {
        const s = session(target)
        if (!isAncestor(id, s.meta)) throw new Error('You can read only your own children and their children.')
        return s.digest(Math.min(Number(max_chars) || 3000, 20000), Number(turns) || 1)
      },
    },
    {
      name: 'stop_session',
      description: "Stop the turn one of your children (or their children) is in, like Esc in Claude Code, and optionally send it a message. Very rare: only to prevent damage, such as two sessions that change the same files.",
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, message: { type: 'string', description: 'What it should know: it goes in when the turn has stopped' } } },
      run: ({ id: target, message }) => {
        const s = session(target)
        if (!isAncestor(id, s.meta)) throw new Error('You can stop only your own children and their children.')
        const was = busy(s.meta)
        if (was) { s.interrupt(); s.notice(`"${me().meta.title}" stopped this turn.`, 'warn') }
        const done = was ? 'Stopped its turn.' : 'It was not in a turn.'
        if (!String(message ?? '').trim()) return done
        const why = refusal(me().meta, s.meta)
        return `${done} ${why ? `The message did not go: ${why}` : sent(s, post(s, { from: id, title: me().meta.title, text: String(message) }))}`
      },
    },
    {
      name: 'archive_session',
      description: "Archive one of your children (or their children), as the user does in the sidebar: its process ends, and it keeps its whole context. When a child's task is done, archive it, to keep the sidebar clean. If it left real questions for the user, leave it open. If it left only a routine question (for example \"may I restart?\"), ask the user that question in your own conversation, then archive the child. A message from you to your archived child can take it out of the archive again, if the user says yes.",
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: ({ id: target }) => {
        const s = session(target)
        if (!isAncestor(id, s.meta)) throw new Error('You can archive only your own children and their children.')
        if (s.meta.archived) return `"${s.meta.title}" is already archived.`
        if (busy(s.meta)) throw new Error(`"${s.meta.title}" is in a turn. Wait until it is idle, or stop it with stop_session first.`)
        s.meta.archived = true
        s.stop()
        ctx.changed()
        return `Archived "${s.meta.title}". A message from its parent takes it out of the archive again, if the user says yes.`
      },
    },
  ]
}
