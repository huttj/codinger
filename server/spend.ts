// What a session has spent, for the agent itself: so it can measure a piece of
// work (read before, read after) and give the real cost next to its estimate.
// Read from the session's Claude Code transcript and its subagents' ones, so
// it has tokens as well as dollars; Codinger's own notes and keep-warm calls
// leave no transcript and are not in it.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { PROJECTS } from './meter.ts'
import { costOf } from '../shared/prices.ts'
import type { Usage } from '../shared/types.ts'

type Totals = { calls: number; sub: number; input: number; write: number; read: number; output: number; usd: number; models: Record<string, number> }

function files(dir: string, out: string[]) {
  let list: fs.Dirent[]
  try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of list) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
}

// The transcript, and its subagents' in <project>/<csid>/subagents/….
function transcripts(csid: string): string[] {
  let dirs: string[] = []
  try { dirs = fs.readdirSync(PROJECTS) } catch { return [] }
  for (const d of dirs) {
    const main = path.join(PROJECTS, d, `${csid}.jsonl`)
    if (!fs.existsSync(main)) continue
    const out = [main]
    files(path.join(PROJECTS, d, csid), out)
    return out
  }
  return []
}

export async function spendSince(csid: string, since = 0): Promise<Totals> {
  // A message's blocks come as separate lines with the usage so far: keep the last, largest one.
  const msgs = new Map<string, { u: any; model: string; sub: boolean }>()
  for (const f of transcripts(csid)) {
    const sub = f.includes(`${path.sep}subagents${path.sep}`)
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
        let m: any
        try { m = JSON.parse(line) } catch { continue }
        const msg = m.message
        if (m.type !== 'assistant' || !msg?.usage || !msg.id || msg.model === '<synthetic>') continue
        if (since && !(Date.parse(m.timestamp) >= since)) continue
        const prev = msgs.get(msg.id)
        if (!prev || (msg.usage.output_tokens ?? 0) >= (prev.u.output_tokens ?? 0)) msgs.set(msg.id, { u: msg.usage, model: msg.model, sub })
      }
    } catch {}
  }
  const t: Totals = { calls: 0, sub: 0, input: 0, write: 0, read: 0, output: 0, usd: 0, models: {} }
  for (const { u, model, sub } of msgs.values()) {
    const usd = costOf(u, model)
    t.calls++
    if (sub) t.sub++
    t.input += u.input_tokens ?? 0
    t.write += u.cache_creation_input_tokens ?? 0
    t.read += u.cache_read_input_tokens ?? 0
    t.output += u.output_tokens ?? 0
    t.usd += usd
    t.models[model] = (t.models[model] ?? 0) + usd
  }
  return t
}

// The time the session worked between since and until, in ms: the time of its
// turns, and of its subagents' turns. A turn runs from a prompt to the answer's
// end_turn (or to the last line before the next prompt, when it was stopped).
// The time between a turn's end and the next prompt is waiting: for the user,
// for a background task or for a message. It does not count.
const ENDS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])
const isPrompt = (m: any) => m.type === 'user' && !(Array.isArray(m.message?.content) && m.message.content.some((c: any) => c?.type === 'tool_result'))
export async function activeSince(csid: string, since: number, until: number): Promise<number> {
  const spans: [number, number][] = []
  for (const f of transcripts(csid)) {
    let open: number | null = null, last = 0
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line.includes('"timestamp"')) continue
        let m: any
        try { m = JSON.parse(line) } catch { continue }
        const t = Date.parse(m.timestamp)
        if (!(t > 0)) continue
        if (isPrompt(m)) { if (open != null) spans.push([open, last]); open = t }
        last = t
        if (open != null && m.type === 'assistant' && ENDS.has(m.message?.stop_reason)) { spans.push([open, t]); open = null }
      }
    } catch {}
    if (open != null) spans.push([open, last])
  }
  // The union of the spans, cut to since–until.
  let ms = 0, end = since
  for (const [a, b] of spans.map(([a, b]) => [Math.max(a, since), Math.min(b, until)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue
    ms += b - Math.max(a, end)
    end = b
  }
  return ms
}

const tok = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`
const mins = (ms: number) => ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 2 * 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`

export function spendText(t: Totals, opts: { since?: number; now: number; usage: Usage }): string {
  const { since, now, usage } = opts
  const r = usage.rate
  const share = [
    r?.fiveHour != null ? `about ${pct(t.usd * r.fiveHour)} of the 5-hour limit` : '',
    r?.sevenDay != null ? `about ${pct(t.usd * r.sevenDay)} of the weekly limit` : '',
  ].filter(Boolean)
  const level = [
    usage.fiveHour != null ? `5-hour ${pct(usage.fiveHour)}` : '',
    usage.sevenDay != null ? `weekly ${pct(usage.sevenDay)}` : '',
  ].filter(Boolean)
  const models = Object.entries(t.models).sort((a, b) => b[1] - a[1]).map(([m, d]) => `${m} $${d.toFixed(2)}`).join(', ')
  return [
    `now: ${now} (${new Date(now).toISOString()}). To measure a piece of work, call again with since set to this number.`,
    since ? `Since ${new Date(since).toISOString()} (${mins(now - since)} on the clock):` : 'Since this conversation started:',
    `- API calls: ${t.calls}${t.sub ? ` (${t.sub} by subagents)` : ''}`,
    `- Tokens: output ${tok(t.output)}, cache read ${tok(t.read)}, cache write ${tok(t.write)}, uncached input ${tok(t.input)}`,
    `- Cost at API prices: $${t.usd.toFixed(2)}${models ? ` (${models})` : ''}`,
    share.length ? `- Plan limits: ${share.join(', ')} (the meter's estimate)` : '- Plan limits: the meter has no estimate yet of how much of the limits a dollar uses.',
    level.length ? `- Limits used now, by all sessions: ${level.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}
