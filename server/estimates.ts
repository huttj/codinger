// Estimates in agent time and dollars, and what the work really took. An agent
// need not estimate; when it does, it saves the estimate before the work and
// calls save_actual after it, and Codinger measures the time and spend between
// the two from the transcript (server/spend.ts). The time is the time of the
// session's turns (active), not the time on the clock: the waits between turns,
// for the user or a task, do not count. Each pair goes to
// estimates.jsonl, and the prompt quotes the ratios found so far, so the next
// estimate starts from them. Settings.estimates turns it all off.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA } from './store.ts'
import { activeSince, spendSince } from './spend.ts'
import type { Tool } from './mcp.ts'
import type { SessionMeta } from '../shared/types.ts'
import type { EstimatesFound, EstimatesReply } from '../shared/estimates.ts'

const FILE = path.join(DATA, 'estimates.jsonl')
export const ESTIMATE_TOOLS = ['read_spend', 'save_estimate', 'save_actual']

type Estimate = { id: string; t: number; sid: string; cwd: string; model?: string; ctx: number; task: string; minutes: number; usd?: number; humanHours?: number }
// minutes: the time on the clock from save_estimate to save_actual; active: the time of the turns in it.
// Pairs saved before active was measured get it from backfillActive.
type Actual = { id: string; t: number; minutes: number; active?: number; usd: number; calls: number; output: number; read: number; note?: string }
const took = (a: Actual) => a.active ?? a.minutes

function load() {
  const est = new Map<string, Estimate>(), act = new Map<string, Actual>()
  try {
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      if (!line) continue
      try { const { k, ...x } = JSON.parse(line); if (k === 'estimate') est.set(x.id, x); else if (k === 'actual') act.set(x.id, x) } catch {}
    }
  } catch {}
  return { est, act }
}
const append = (x: object) => { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(FILE, JSON.stringify(x) + '\n') }

const median = (xs: number[]) => { if (!xs.length) return undefined; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d
const ratio = (x: number) => x >= 10 ? `${Math.round(x)}×` : `${round(x, x < 1 ? 2 : 1)}×`

// The medians over every saved pair.
function found(): EstimatesFound {
  const { est, act } = load()
  const pairs = [...act.values()].flatMap((a) => { const e = est.get(a.id); return e ? [{ e, a }] : [] })
  return {
    n: pairs.length,
    time: median(pairs.filter((p) => p.e.minutes > 0).map((p) => took(p.a) / p.e.minutes)),
    cost: median(pairs.filter((p) => p.e.usd).map((p) => p.a.usd / p.e.usd!)),
    perHour: median(pairs.filter((p) => p.e.humanHours).map((p) => took(p.a) / p.e.humanHours!)),
    usdPerHour: median(pairs.filter((p) => p.e.humanHours).map((p) => p.a.usd / p.e.humanHours!)),
  }
}

// Every estimate, newest first, with its actual once there is one.
export function estimatesReply(title: (sid: string) => string | undefined): EstimatesReply {
  const { est, act } = load()
  const rows = [...est.values()].sort((a, b) => b.t - a.t).map((e) => {
    const a = act.get(e.id)
    return {
      id: e.id, t: e.t, sid: e.sid, title: title(e.sid), task: e.task, minutes: e.minutes, usd: e.usd, humanHours: e.humanHours,
      ...(a ? { actual: { t: a.t, minutes: took(a), wall: a.minutes, usd: a.usd, calls: a.calls, note: a.note } } : {}),
    }
  })
  return { rows, found: found() }
}

export function estimatesPrompt(): string {
  const f = found()
  const seen = f.n >= 3
    ? `From the ${f.n} estimates saved so far (medians): the work took ${f.time != null ? `${ratio(f.time)} the estimated time` : 'no time measure yet'}${f.cost != null ? ` and ${ratio(f.cost)} the estimated cost` : ''}${f.perHour != null ? `; 1 human hour was about ${round(f.perHour, 1)} minutes and $${round(f.usdPerHour!)}` : ''}. Correct your estimates by these.`
    : `One early data point (Opus 5.5, October 2026): work that a gut feeling put at 13 human hours took 11 minutes and $4.50, so 1 gut hour was about 1 minute and $0.35.`
  return `
## Time and cost estimates
You do not have to give estimates. If you give one, give it in agent time on the clock, not in a
person's hours ("2–3 hours", "half a day"): you work much faster than a person. Give the cost
too when it matters: dollars at API prices, tokens, or the share of the plan's usage limits. If
a figure in human hours helps the user, give it second, and label it.
${seen} Most of the cost is cache reads: each call reads the whole context again, so the cost
grows with the size of your context, not only with the size of the work.
When you give an estimate, save it with save_estimate before you start the work. When the work
is done, call save_actual: Codinger measures the time and cost between the two calls and
compares them with your estimate. The time counts only your turns: the time when you wait for
the user or for a background task between turns does not count. Tell the user both. read_spend
shows what this session has spent so far.
`
}

export function estimateTools(id: string, meta: () => SessionMeta): Tool[] {
  return [
    {
      name: 'save_estimate',
      description: 'Save an estimate you gave the user, just before you start the work. Codinger measures the work from now until you call save_actual.',
      inputSchema: {
        type: 'object', required: ['task', 'minutes'],
        properties: {
          task: { type: 'string', description: 'The work, in a few words' },
          minutes: { type: 'number', description: 'Your estimate in agent minutes on the clock' },
          usd: { type: 'number', description: 'Your estimate in dollars at API prices, if you gave one' },
          human_hours: { type: 'number', description: 'Your estimate in human hours, if you gave one' },
        },
      },
      run: (args) => {
        const m = meta(), task = String(args?.task ?? '').trim().slice(0, 200), minutes = Number(args?.minutes)
        if (!task || !(minutes > 0)) return 'Give the task and your estimate in minutes.'
        const e: Estimate = {
          id: randomUUID().slice(0, 8), t: Date.now(), sid: id, cwd: m.cwd, model: m.model ?? undefined, ctx: m.context.used, task, minutes,
          ...(Number(args?.usd) > 0 ? { usd: Number(args.usd) } : {}), ...(Number(args?.human_hours) > 0 ? { humanHours: Number(args.human_hours) } : {}),
        }
        append({ k: 'estimate', ...e })
        return `Saved estimate \`${e.id}\`. When the work is done, call save_actual.`
      },
    },
    {
      name: 'save_actual',
      description: 'The work you estimated is done: Codinger measures the time of your turns and the spend since save_estimate (the waits between turns do not count), saves them next to the estimate, and returns both.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The estimate\'s id; your last open one if left out' },
          note: { type: 'string', description: 'What made it differ, if you know (for example: the scope grew)' },
        },
      },
      run: async (args) => {
        const m = meta(), { est, act } = load()
        const e = args?.id ? est.get(String(args.id)) : [...est.values()].findLast((x) => x.sid === id && !act.has(x.id))
        if (!e || e.sid !== id) return args?.id ? `This session has no estimate "${args.id}".` : 'This session has no open estimate. Call save_estimate before the work.'
        if (!m.claudeSessionId) return 'This session has made no API calls yet.'
        const now = Date.now(), t = await spendSince(m.claudeSessionId, e.t)
        if (!t.calls) return 'Codinger found no API calls since the estimate yet, so it saved nothing. Call save_actual again when the work is done.'
        const active = await activeSince(m.claudeSessionId, e.t, now)
        const a: Actual = { id: e.id, t: now, minutes: round((now - e.t) / 60_000, 1), active: round(active / 60_000, 1), usd: round(t.usd), calls: t.calls, output: t.output, read: t.read, ...(args?.note ? { note: String(args.note).slice(0, 300) } : {}) }
        append({ k: 'actual', ...a })
        const f = found()
        return [
          `"${e.task}": estimated ${e.minutes} min${e.usd ? `, $${e.usd}` : ''}${e.humanHours ? ` (${e.humanHours} human h)` : ''}.`,
          `Actual: ${a.active} min of work (${a.minutes} min on the clock), $${a.usd.toFixed(2)}, ${a.calls} API calls, ${Math.round(a.output / 1000)}k output tokens, ${(a.read / 1e6).toFixed(2)}M cache read.`,
          `That is ${ratio(took(a) / e.minutes)} the estimated time${e.usd ? ` and ${ratio(a.usd / e.usd)} the estimated cost` : ''}.`,
          f.n >= 2 && f.time != null ? `Over all ${f.n} saved estimates, the median is ${ratio(f.time)} the estimated time${f.cost != null ? ` and ${ratio(f.cost)} the cost` : ''}.` : '',
        ].filter(Boolean).join('\n')
      },
    },
  ]
}

// Once, at start: the active time of the pairs saved before Codinger measured it.
// csid gives a session's Claude Code session id; a pair whose transcript is gone keeps its clock time.
export async function backfillActive(csid: (sid: string) => string | null | undefined) {
  const { est, act } = load()
  for (const a of act.values()) {
    const e = est.get(a.id), c = e && a.active == null ? csid(e.sid) : null
    if (!e || !c) continue
    const ms = await activeSince(c, e.t, a.t)
    if (ms > 0) append({ k: 'actual', ...a, active: round(ms / 60_000, 1) })
  }
}
