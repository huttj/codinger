// Questions and notices for the user while the user is away from Codinger. A session sends a
// push to the user's phone now (notify_user, ask_user) or at a time each day (schedule_ask).
// The push goes through the hub (web.codinger.app), and a tap on it opens the session on the
// phone. The user answers there, in the session, as in any message.
//
// An ask stays open until the user's next message in that session. That message takes a
// hidden note with the open asks and what the agent said to do with the answer (`then`), so
// the agent knows which question the message answers, even many hours later.
//
// The schedule runs on this machine: a scheduled ask goes only while Codinger runs and the
// hub link is on. One that is more than an hour late (the Mac slept) waits for the next day.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA } from './store.ts'
import type { Tool } from './mcp.ts'

const FILE = path.join(DATA, 'asks.json')
const LATE = 60 * 60_000
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

type Schedule = { id: string; sid: string; question: string; time: string; days?: string[]; then?: string; last?: string; created: number }
type Open = { sid: string; question: string; then?: string; ts: number }
type State = { schedules: Schedule[]; open: Open[] }

type Ctx = {
  session(id: string): { title: string } | undefined
  // Why no push went, or null when one did.
  push(n: { title: string; body: string; session: string }): Promise<string | null>
  notice(sid: string, text: string, level?: 'info' | 'warn' | 'error'): void
}
let ctx: Ctx

function load(): State {
  try { return { schedules: [], open: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } } catch { return { schedules: [], open: [] } }
}
function update(f: (s: State) => void) {
  const s = load()
  f(s)
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(s, null, 1))
  fs.renameSync(FILE + '.tmp', FILE)
}

const pad = (n: number) => String(n).padStart(2, '0')
const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const clock = (ts: number) => new Date(ts).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const noPush = (why: string) => new Error(`No push went: ${why}. Ask the user to link this machine to the hub and to turn on notifications in Codinger's Settings, in the app on the phone's home screen.`)

async function ask(sid: string, question: string, then?: string) {
  const title = ctx.session(sid)?.title ?? 'Codinger'
  const why = await ctx.push({ title, body: question, session: sid })
  if (why) throw noPush(why)
  update((s) => { s.open = [...s.open.filter((o) => o.sid !== sid || Date.now() - o.ts < 7 * 86400_000), { sid, question, ts: Date.now(), ...(then ? { then } : {}) }] })
  ctx.notice(sid, `Asked you on your phone: "${question}"`)
}

function due(s: Schedule, now: Date): boolean {
  const [h, m] = s.time.split(':').map(Number)
  const at = new Date(now); at.setHours(h, m, 0, 0)
  if (s.last === dateOf(now) || now < at || now.getTime() - at.getTime() > LATE) return false
  return !s.days?.length || s.days.includes(DAYS[now.getDay()])
}

function tick() {
  const now = new Date()
  for (const s of load().schedules) {
    if (!due(s, now) || !ctx.session(s.sid)) continue
    update((x) => { const y = x.schedules.find((z) => z.id === s.id); if (y) y.last = dateOf(now) })
    ask(s.sid, s.question, s.then).catch((e) => ctx.notice(s.sid, `The scheduled ask "${s.question}" did not go: ${e.message}`, 'warn'))
  }
}

export function startAsks(c: Ctx) {
  ctx = c
  setInterval(tick, 20_000).unref()
}

// The user wrote in a session: the note that goes with the message, if asks were open there.
export function answered(sid: string): string | undefined {
  const open = load().open.filter((o) => o.sid === sid)
  if (!open.length) return
  update((s) => { s.open = s.open.filter((o) => o.sid !== sid) })
  return `[Codinger: you asked the user on their phone ${open.map((o) => `"${o.question}" (${clock(o.ts)})${o.then ? `, and said to do this with the answer: ${o.then.replace(/[.\s]+$/, '')}` : ''}`).join('; ')}. This message may be the answer.]`
}

export function forgetAsks(sid: string) {
  update((s) => { s.schedules = s.schedules.filter((x) => x.sid !== sid); s.open = s.open.filter((x) => x.sid !== sid) })
}

const describe = (s: Schedule) => `\`${s.id}\` at ${s.time}${s.days?.length ? ` on ${s.days.join(', ')}` : ' every day'}: "${s.question}"${s.then ? `; then: ${s.then}` : ''}${s.last ? `; last asked ${s.last}` : ''}`

export function askTools(id: string): Tool[] {
  const then = { type: 'string', description: 'What to do with the answer, for example "append it as one line **8 pm check-in:** <answer> to today\'s journal note". It comes back to you with the answer, so it can be precise.' }
  return [
    {
      name: 'notify_user',
      description: "Send a push notification to the user's phone now. A tap on it opens this session. Use it only for news the user wants while away, or when the user asked for it.",
      inputSchema: { type: 'object', required: ['body'], properties: { body: { type: 'string', description: 'One or two short sentences, at most 180 characters, that say what happened or what you need. No markdown: a phone shows it as plain text.' }, title: { type: 'string', description: "This session's name if you leave it out" } } },
      run: async ({ body, title }) => {
        const b = String(body ?? '').trim()
        if (!b) throw new Error('Give a body')
        const why = await ctx.push({ title: String(title ?? '').trim() || (ctx.session(id)?.title ?? 'Codinger'), body: b, session: id })
        if (why) throw noPush(why)
        return 'Sent.'
      },
    },
    {
      name: 'ask_user',
      description: "Ask the user a question by a push notification to their phone now. A tap opens this session, and the user answers there; the answer comes to you as the user's next message, with a note that names this question. Use it when the user is away and you need an answer, or when the user asked for it.",
      inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string', description: 'One short question, at most 180 characters, that makes sense alone. No markdown: a phone shows it as plain text.' }, then } },
      run: async ({ question, then }) => {
        const q = String(question ?? '').trim()
        if (!q) throw new Error('Give a question')
        await ask(id, q, String(then ?? '').trim() || undefined)
        return 'Asked. The answer comes as the user\'s next message in this session.'
      },
    },
    {
      name: 'schedule_ask',
      description: "Ask the user a question by a push notification at a time each day (this Mac's time zone), until you cancel it, for example a daily check-in. Each answer comes to you as the user's next message, with a note that names the question and your `then`. It goes only while Codinger runs.",
      inputSchema: {
        type: 'object', required: ['question', 'time'],
        properties: {
          question: { type: 'string', description: 'One short question, at most 180 characters, that makes sense alone. No markdown: a phone shows it as plain text.' },
          time: { type: 'string', description: 'HH:MM, 24-hour, local time, for example 20:00' },
          days: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'The days to ask; every day if you leave it out' },
          then,
        },
      },
      run: ({ question, time, days, then }) => {
        const q = String(question ?? '').trim()
        if (!q) throw new Error('Give a question')
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim())
        if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('time must be HH:MM, 24-hour')
        const d = Array.isArray(days) ? days.map((x) => String(x).toLowerCase().slice(0, 3)).filter((x) => DAYS.includes(x)) : []
        const t = String(then ?? '').trim()
        const s: Schedule = { id: `a${randomUUID().slice(0, 7)}`, sid: id, question: q, time: `${pad(+m[1])}:${m[2]}`, ...(d.length ? { days: d } : {}), ...(t ? { then: t } : {}), created: Date.now() }
        // Set after today's time: it starts tomorrow.
        const now = new Date(), at = new Date(now); at.setHours(+m[1], +m[2], 0, 0)
        if (at <= now) s.last = dateOf(now)
        update((x) => { x.schedules.push(s) })
        return `Scheduled ${describe(s)}.`
      },
    },
    {
      name: 'list_asks',
      description: 'Your scheduled asks, and the asks the user has not answered yet.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const st = load()
        const sch = st.schedules.filter((s) => s.sid === id), open = st.open.filter((o) => o.sid === id)
        return [sch.length ? `Scheduled:\n${sch.map((s) => `- ${describe(s)}`).join('\n')}` : 'No scheduled asks.',
          open.length ? `Not answered yet:\n${open.map((o) => `- ${clock(o.ts)}: "${o.question}"`).join('\n')}` : ''].filter(Boolean).join('\n\n')
      },
    },
    {
      name: 'cancel_ask',
      description: 'Cancel one of your scheduled asks, by its id from list_asks.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: ({ id: k }) => {
        const key = String(k ?? '').replace(/`/g, '')
        if (!load().schedules.some((s) => s.id === key && s.sid === id)) throw new Error(`You have no scheduled ask "${key}". Call list_asks.`)
        update((x) => { x.schedules = x.schedules.filter((s) => s.id !== key) })
        return `Cancelled \`${key}\`.`
      },
    },
  ]
}

// ---- Settings ---------------------------------------------------------------

// Every session's asks, for the Asks page in Settings.
export function asksReply(title: (sid: string) => string | undefined) {
  const st = load()
  return {
    schedules: st.schedules.map((s) => ({ ...s, title: title(s.sid) })),
    open: st.open.map((o) => ({ ...o, title: title(o.sid) })),
  }
}

// The user cancelled a scheduled ask in Settings. The session's transcript says so; its agent sees it in list_asks.
export function cancelAsk(id: string): boolean {
  const s = load().schedules.find((x) => x.id === id)
  if (!s) return false
  update((x) => { x.schedules = x.schedules.filter((y) => y.id !== id) })
  ctx.notice(s.sid, `You cancelled the scheduled ask "${s.question}" in Settings.`)
  return true
}
