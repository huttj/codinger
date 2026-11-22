// The usage ledger (shared/usage.ts): tokens and spend at API prices, by
// conversation and by folder, for cost audits. It reads Codinger's copy of the
// transcripts (server/archive.ts) and keeps its totals in usage.json; without
// that file it builds them again from the whole copy.
//
// A message's lines come one content block at a time, each with the usage so
// far, so only what grew counts (as in server/meter.ts). The same message can
// be in more than one transcript (a fork copies the conversation), so message
// ids are remembered for 45 days.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA } from './store.ts'
import { ARCHIVE, archive, archiveInfo, files, readLines } from './archive.ts'
import { isPrompt } from './meter.ts'
import { costOf } from '../shared/prices.ts'
import { dayKey } from '../shared/costs.ts'
import { hubAuth, remoteStatus } from './remote.ts'
import { addTok, differ, digest, noTok, type Ledger, type Tok, type UsageConv, type UsageReply } from '../shared/usage.ts'

const FILE = path.join(DATA, 'usage.json')
const HOME = os.homedir()
const SEEN = 45 * 86_400_000
// Folders that are not a project: Claude Code's own files, and scratch space.
const IGNORE = [...new Set([path.join(HOME, '.claude'), '/tmp', '/private/tmp', '/private/var', '/var/folders', os.tmpdir()])]

type Conv = {
  codinger: string | null; title: string; prompt: string; home: string
  first: number; last: number; prompts: number; tok: Tok; models: Record<string, number>
  spend: Record<string, Record<string, number>>
  at?: number                              // when a call last changed it: the sync sends what changed
}
type Saved = {
  v: 1
  offsets: Record<string, number>          // archive file → bytes read
  targets: Record<string, string[]>        // archive file → the projects its calls work on now
  aliases?: Record<string, string>         // a worktree an agent made, or a folder that moved (gone now, maybe) → its project
  seen: Record<string, number[]>           // message id → [time, input, w5, w1h, read, out, usd]
  convs: Record<string, Conv>              // Claude Code session id → totals
  worked: Record<string, Record<string, Tok>>
  ran: Record<string, Record<string, Tok>>
  stamps?: Record<string, number>          // day → when a call last changed its totals
  surfaces?: { days: Record<string, Record<string, number>>; names: Record<string, string>; last?: { window: string; top: Record<string, number> }; windowStart?: string; resetsAt?: string }
}
const blank = (): Saved => ({ v: 1, offsets: {}, targets: {}, seen: {}, convs: {}, worked: {}, ran: {} })
let saved = blank()
try { const x = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (x.v === 1) saved = x } catch {}

let timer: NodeJS.Timeout | null = null
function save(now = false) {
  if (timer) { clearTimeout(timer); timer = null }
  const write = () => {
    const tmp = FILE + '.tmp'
    fs.writeFile(tmp, JSON.stringify(saved), (e) => { if (!e) fs.rename(tmp, FILE, () => {}) })
  }
  if (now) write()
  else timer = setTimeout(() => { timer = null; write() }, 5_000)
}

// ---- projects ---------------------------------------------------------------

const projects = new Map<string, string | null>()
const inside = (p: string, d: string) => p === d || p.startsWith(d + path.sep)

// The project a path belongs to: its git repository (a worktree's main one),
// else the first two folders under home (one for a hidden folder), or null
// for a folder in IGNORE.
export function projectOf(p: string, cwd?: string): string | null {
  if (!p) return null
  if (p === '~' || p.startsWith('~/')) p = path.join(HOME, p.slice(1))
  if (!path.isAbsolute(p)) { if (!cwd) return null; p = path.resolve(cwd, p) }
  p = path.normalize(p)
  if (projects.has(p)) return projects.get(p)!
  try { p = fs.realpathSync(p) } catch {}
  let out: string | null = null
  const wt = Object.keys(saved.aliases ?? {}).find((d) => inside(p, d))
  // An alias can point at a folder that moved too.
  if (wt) { out = saved.aliases![wt]; for (let n = 0, to; n < 5 && (to = Object.keys(saved.aliases!).find((d) => inside(out!, d))); n++) out = saved.aliases![to] }
  else if (!IGNORE.some((d) => inside(p, d))) {
    let dir = p
    try { if (!fs.statSync(p).isDirectory()) dir = path.dirname(p) } catch { if (path.extname(p)) dir = path.dirname(p) }
    for (let d = dir; ; d = path.dirname(d)) {
      let st: fs.Stats | null = null
      try { st = fs.statSync(path.join(d, '.git')) } catch {}
      if (st?.isDirectory()) { out = d; break }
      if (st?.isFile()) {
        const g = /gitdir:\s*(.+)/.exec(fs.readFileSync(path.join(d, '.git'), 'utf8'))?.[1].trim()
        const i = g ? path.resolve(d, g).indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`) : -1
        out = i > 0 ? path.resolve(d, g!).slice(0, i) : d
        break
      }
      if (d === HOME || d === path.dirname(d)) break
    }
    if (!out) {
      const parts = inside(dir, HOME) ? path.relative(HOME, dir).split(path.sep).filter(Boolean) : dir.split(path.sep).filter(Boolean)
      // A hidden folder under home (~/.codinger) is one project.
      const n = inside(dir, HOME) && parts[0]?.startsWith('.') ? 1 : 2
      out = inside(dir, HOME) ? path.join(HOME, ...parts.slice(0, n)) : path.sep + parts.slice(0, n).join(path.sep)
    }
  }
  projects.set(p, out)
  return out
}

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2')
// The projects a tool call reads or changes.
function toolProjects(input: any, cwd: string | undefined): string[] {
  const paths: string[] = []
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof input?.[k] === 'string') paths.push(input[k])
  if (typeof input?.command === 'string') {
    for (const m of input.command.matchAll(/(?:^|[\s;&|(])(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) paths.push(unquote(m[1]))
    for (const m of input.command.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g)) paths.push(unquote(m[1]))
  }
  return paths.filter((p) => !p.includes('$')).map((p) => projectOf(p, cwd)).filter((p): p is string => !!p && p !== path.sep)
}

// A transcript's folder in ~/.claude/projects is named after the folder the
// conversation ran in. If that folder is gone and the name fits a folder next
// to it, the folder moved there (Codinger moves transcripts when a folder is
// renamed): its files count for the new place.
const checked = new Set<string>()
const encode = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-')
function moved(rel: string, cwd: string) {
  const key = rel.split(path.sep)[0] + '\0' + cwd
  if (checked.has(key)) return
  checked.add(key)
  const name = rel.split(path.sep)[0]
  if (encode(cwd) === name || fs.existsSync(cwd) || saved.aliases?.[cwd]) return
  let list: string[] = []
  try { list = fs.readdirSync(path.dirname(cwd)) } catch { return }
  const to = list.map((e) => path.join(path.dirname(cwd), e)).find((d) => encode(d) === name)
  if (to) { (saved.aliases ??= {})[cwd] = projectOf(to) ?? to; projects.clear() }
}

// `git worktree add <path>` in a command: remember the worktree's repository,
// so its files count for the repository after the worktree is gone.
function worktrees(command: string, cwd: string | undefined) {
  let cur = cwd
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const w = part.trim().split(/\s+/).map(unquote)
    if (w[0] === 'cd' && w[1]) { cur = w[1].startsWith('~') ? path.join(HOME, w[1].slice(1)) : cur ? path.resolve(cur, w[1]) : w[1]; continue }
    if (w[0] !== 'git') continue
    let i = 1, dir = cur
    if (w[i] === '-C' && w[i + 1]) { dir = cur ? path.resolve(cur, w[i + 1]) : w[i + 1]; i += 2 }
    if (w[i] !== 'worktree' || w[i + 1] !== 'add') continue
    let at: string | undefined
    for (let j = i + 2; j < w.length; j++) {
      if (/^-[bB]$|^--orphan$|^--reason$/.test(w[j])) { j++; continue }
      if (w[j].startsWith('-')) continue
      at = w[j]; break
    }
    if (!at || at.includes('$') || !dir) continue
    const repo = projectOf(dir), wt = path.normalize(at.startsWith('~') ? path.join(HOME, at.slice(1)) : path.resolve(dir, at))
    if (!repo || inside(wt, repo) || IGNORE.some((d) => inside(wt, d))) continue
    ;(saved.aliases ??= {})[wt] = repo
    projects.clear()
  }
}

// ---- counting -----------------------------------------------------------------

function conv(id: string, cwd: string | undefined, t: number): Conv {
  let c = saved.convs[id]
  if (!c) c = saved.convs[id] = { codinger: null, title: '', prompt: '', home: '', first: t, last: t, prompts: 0, tok: noTok(), models: {}, spend: {} }
  if (!c.home && cwd) c.home = projectOf(cwd) ?? cwd
  return c
}

function count(c: Conv, t: number, model: string, tok: Tok, where: string[]) {
  const day = dayKey(t), home = c.home || '?'
  c.at = (saved.stamps ??= {})[day] = Date.now()
  c.first = Math.min(c.first, t); c.last = Math.max(c.last, t)
  addTok(c.tok, tok)
  c.models[model] = (c.models[model] ?? 0) + tok.usd
  addTok(((saved.ran[day] ??= {})[home] ??= noTok()), tok)
  const to = where.length ? where : [home], share = 1 / to.length
  for (const p of to) {
    const part: Tok = { calls: tok.calls * share, input: tok.input * share, w5: tok.w5 * share, w1h: tok.w1h * share, read: tok.read * share, out: tok.out * share, usd: tok.usd * share }
    addTok(((saved.worked[day] ??= {})[p] ??= noTok()), part)
    const d = (c.spend[day] ??= {})
    d[p] = (d[p] ?? 0) + part.usd
  }
}

function tokens(u: any): number[] {
  const cc = u.cache_creation ?? {}
  const w1h = cc.ephemeral_1h_input_tokens ?? 0
  const w5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h)
  return [u.input_tokens ?? 0, w5, w1h, u.cache_read_input_tokens ?? 0, u.output_tokens ?? 0]
}

// One batch of whole lines from one archive file.
function lines(rel: string, sub: boolean, batch: string[]) {
  const items: any[] = []
  for (const line of batch) {
    if (line.includes('"tool_result"')) continue
    if (!/"type":"(assistant|user|custom-title)"/.test(line)) continue
    try { items.push(JSON.parse(line)) } catch {}
  }
  // Each message's tools first: its blocks come as separate lines, and the
  // first line already has most of its usage.
  const tools = new Map<string, string[]>()
  for (const m of items) {
    if (m.type !== 'assistant' || !m.message?.id || !Array.isArray(m.message.content)) continue
    for (const b of m.message.content) {
      if (b?.type !== 'tool_use') continue
      if (typeof b.input?.command === 'string' && b.input.command.includes('worktree add')) worktrees(b.input.command, m.cwd)
      const ps = toolProjects(b.input, m.cwd)
      if (ps.length) tools.set(m.message.id, [...new Set([...(tools.get(m.message.id) ?? []), ...ps])])
    }
  }
  for (const m of items) if (typeof m.cwd === 'string') moved(rel, m.cwd)
  for (const m of items) {
    const id = m.sessionId ?? path.basename(rel, '.jsonl')
    const t = Date.parse(m.timestamp) || Date.now()
    if (m.type === 'custom-title') {
      const c = conv(id, m.cwd, t), k = /^codinger-([0-9a-z]+)$/.exec(m.customTitle ?? '')
      if (k) c.codinger = k[1]
      else if (m.customTitle) c.title = m.customTitle
      continue
    }
    if (m.type === 'user') {
      if (sub || !isPrompt(m)) continue
      const c = conv(id, m.cwd, t)
      c.prompts++
      if (!c.prompt) {
        const x = m.message.content
        c.prompt = (typeof x === 'string' ? x : x.find((b: any) => b.type === 'text')?.text ?? '').trim().slice(0, 120)
      }
      // A new prompt works in the conversation's own folder until a tool goes elsewhere.
      delete saved.targets[rel]
      continue
    }
    const msg = m.message
    if (!msg?.usage || !msg.id || msg.model === '<synthetic>') continue
    const ps = tools.get(msg.id)
    if (ps) saved.targets[rel] = ps
    const now = tokens(msg.usage), usd = costOf(msg.usage, msg.model)
    const prev = saved.seen[msg.id]
    if (prev && prev[6] >= usd) continue
    saved.seen[msg.id] = [t, ...now, usd]
    const d = prev ? now.map((n, i) => Math.max(0, n - prev[i + 1])) : now
    const c = conv(id, m.cwd, t)
    count(c, t, msg.model, { calls: prev ? 0 : 1, input: d[0], w5: d[1], w1h: d[2], read: d[3], out: d[4], usd: usd - (prev?.[6] ?? 0) }, saved.targets[rel] ?? [])
  }
}

let scanning = false, at: number | null = null

// Copy the new transcript lines to the archive, then count them.
export async function pass() {
  if (scanning) return
  scanning = true
  try {
    await archive()
    for (const f of await files(ARCHIVE, 6)) {
      const rel = path.relative(ARCHIVE, f)
      let from = saved.offsets[rel] ?? 0
      const size = (await fs.promises.stat(f).catch(() => null))?.size ?? 0
      if (size === from) continue
      if (size < from) from = 0
      const sub = rel.includes(`${path.sep}subagents${path.sep}`)
      try { saved.offsets[rel] = await readLines(f, from, (b) => lines(rel, sub, b)) } catch {}
    }
    const old = Date.now() - SEEN
    for (const id in saved.seen) if (saved.seen[id][0] < old) delete saved.seen[id]
    save(true)
  } finally {
    scanning = false
    at = Date.now()
  }
}

// A call that leaves no transcript (server/notes.ts): it counts for the conversation's own folder.
export function offTranscript(claudeId: string, cwd: string, u: any, model: string) {
  const t = Date.now(), usd = costOf(u, model), [input, w5, w1h, rd, out] = tokens(u)
  if (!usd) return
  count(conv(claudeId, cwd, t), t, model, { calls: 1, input, w5, w1h, read: rd, out, usd }, [])
  save()
}

// This machine's ledger, with each Codinger session's Claude Code sessions
// together. title: a Codinger session's title, from its id.
// after: only the days and conversations a call changed from that time on
// (the upTo of the last reply), for the sync. theirs: the reader's checksums
// of its copy; a month that differs from ours goes whole, so a copy that
// missed a part (or got one twice) is set right.
export function ledger(title: (codingerId: string) => string | null, after = 0, theirs?: Record<string, string>): Ledger {
  if (!scanning && (!at || Date.now() - at > 2 * 60_000)) void pass()
  const upTo = Date.now(), sums = digest(saved.ran)
  const repaired = after && theirs ? differ(sums, theirs) : []
  const fix = new Set(repaired)
  const changed = (d: string) => (saved.stamps?.[d] ?? 0) >= after || fix.has(d.slice(0, 7))
  // A Codinger session goes whole, with all its Claude Code sessions, if any of them changed.
  const keys = new Set(Object.entries(saved.convs).filter(([, c]) => (c.at ?? 0) >= after || Object.keys(c.spend).some((d) => fix.has(d.slice(0, 7)))).map(([id, c]) => c.codinger ?? id))
  const days = (x: Record<string, Record<string, Tok>>) => after ? Object.fromEntries(Object.entries(x).filter(([d]) => changed(d))) : x
  const by = new Map<string, UsageConv>()
  for (const [id, c] of Object.entries(saved.convs)) {
    if (after && !keys.has(c.codinger ?? id)) continue
    const key = c.codinger ?? id
    let o = by.get(key)
    if (!o) {
      o = { id: key, codinger: c.codinger, claude: [], title: '', home: c.home, first: c.first, last: c.last, prompts: 0, tok: noTok(), models: {}, spend: {} }
      by.set(key, o)
    }
    o.claude.push(id)
    o.title ||= (c.codinger && title(c.codinger)) || c.title || c.prompt
    o.first = Math.min(o.first, c.first); o.last = Math.max(o.last, c.last)
    o.prompts += c.prompts
    addTok(o.tok, c.tok)
    for (const m in c.models) o.models[m] = (o.models[m] ?? 0) + c.models[m]
    for (const d in c.spend) for (const p in c.spend[d]) { const x = (o.spend[d] ??= {}); x[p] = (x[p] ?? 0) + c.spend[d][p] }
  }
  const r = remoteStatus()
  return { v: 1, machine: r.name, ...(r.label ? { label: r.label } : {}), at, upTo, after, sums, ...(repaired.length ? { repaired } : {}), since: Object.keys(saved.ran).sort()[0] ?? null, worked: days(saved.worked), ran: days(saved.ran), convs: [...by.values()] }
}

// The last copy of each other machine's ledger.
export const others = () => [...synced.values()].filter((l) => l.machine !== remoteStatus().name)

export function reply(title: (codingerId: string) => string | null): UsageReply {
  const own = ledger(title)
  const others = [...synced.values()].filter((l) => l.machine !== own.machine)
  const sf = saved.surfaces
  return { ...own, archive: archiveInfo(), scanning, others, surfaces: { days: sf?.days ?? {}, names: sf?.names ?? {}, windowStart: sf?.windowStart, resetsAt: sf?.resetsAt } }
}

// The weekly limit by product, from claude.ai's report (server/costs.ts reads
// it about once an hour). Each report gives the share of the week each product
// used so far in this window; what grew since the last report counts for the
// day of this one. A new window (after the weekly reset) counts from zero.
export function surfaces(j: any) {
  const used = j?.seven_day?.utilization, rows = j?.seven_day_breakdown?.rows, start = Date.parse(j?.seven_day_breakdown?.window_started_at)
  if (typeof used !== 'number' || !Array.isArray(rows) || !start) return
  // The start comes a little different in each report (18:59:59.9, then 19:00:00.2): to the minute.
  const win = new Date(Math.round(start / 60_000) * 60_000).toISOString()
  const sf = (saved.surfaces ??= { days: {}, names: {} })
  if (sf.last?.window !== win) sf.last = { window: win, top: {} }
  const day = dayKey(Date.now())
  for (const r of rows) {
    if (typeof r?.key !== 'string' || typeof r.percent !== 'number') continue
    sf.names[r.key] = String(r.display_name ?? r.key)
    // Both numbers are whole percents, so a share can step back: count only what passes the highest so far.
    const share = used / 100 * r.percent / 100, top = sf.last.top[r.key] ?? 0
    if (share > top) {
      const d = (sf.days[day] ??= {})
      d[r.key] = (d[r.key] ?? 0) + share - top
      sf.last.top[r.key] = share
    }
  }
  sf.windowStart = win
  const resets = Date.parse(j.seven_day?.resets_at)
  if (resets) sf.resetsAt = new Date(Math.round(resets / 60_000) * 60_000).toISOString()
  save()
}

// ---- sync ---------------------------------------------------------------------
//
// Your other machines' ledgers, through the hub at web.codinger.app (server/remote.ts):
// each one's /api/usage/ledger, read every half hour and kept in ledgers/<machine>.json.
// After the first read, only what changed since the last one comes: whole days
// and whole conversations, which take the place of the ones in the copy. A
// machine that is off or gone keeps its last copy, so its history stays.

const LEDGERS = path.join(DATA, 'ledgers')
const synced = new Map<string, Ledger>()
try { for (const f of fs.readdirSync(LEDGERS)) if (f.endsWith('.json')) { const l = JSON.parse(fs.readFileSync(path.join(LEDGERS, f), 'utf8')); if (l.v === 1) synced.set(l.machine, l) } } catch {}

export async function sync() {
  const auth = hubAuth()
  if (!auth) return
  const get = (p: string) => fetch(auth.hub + p, { headers: { authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(60_000) })
  let list: { name: string; label?: string; connected: boolean }[]
  try { list = await (await get('/_remote/machines')).json() } catch { return }
  const self = remoteStatus().name
  for (const m of list) {
    if (m.name === self || !m.connected) continue
    try {
      const prev = synced.get(m.name)
      // What we have of its ledger: a part of what changed since, and the months our copy has wrong.
      const r = await get(`/m/${m.name}/api/usage/ledger?after=${prev?.upTo ?? 0}` + (prev ? `&sums=${encodeURIComponent(JSON.stringify(digest(prev.ran)))}` : ''))
      if (!r.ok || !/json/.test(r.headers.get('content-type') ?? '')) continue
      let l = await r.json() as Ledger
      if (l?.v !== 1 || !l.ran || !Array.isArray(l.convs)) continue
      if (prev && l.after) {
        const convs = new Map(prev.convs.map((c) => [c.id, c]))
        for (const c of l.convs) convs.set(c.id, c)
        l = { ...l, worked: { ...prev.worked, ...l.worked }, ran: { ...prev.ran, ...l.ran }, convs: [...convs.values()], since: [prev.since, l.since].filter((x): x is string => !!x).sort()[0] ?? null }
      }
      // Check the copy against the sender's checksums; if a month still differs, read it all next time.
      const wrong = l.sums ? differ(digest(l.ran), l.sums) : []
      l.check = { at: Date.now(), ok: !wrong.length, ...(l.repaired?.length ? { repaired: l.repaired } : {}) }
      if (wrong.length) l.upTo = 0
      delete l.after; delete l.repaired
      l.machine = m.name
      if (m.label) l.label = m.label
      synced.set(m.name, l)
      await fs.promises.mkdir(LEDGERS, { recursive: true })
      await fs.promises.writeFile(path.join(LEDGERS, `${m.name}.json`), JSON.stringify(l))
    } catch {}
  }
}

export function start() {
  setTimeout(() => void pass(), 20_000).unref()
  setInterval(() => void pass(), 10 * 60_000).unref()
  setTimeout(() => void sync(), 60_000).unref()
  setInterval(() => void sync(), 30 * 60_000).unref()
}
