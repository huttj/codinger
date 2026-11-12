// On-disk state, all under ~/.codinger:
//   sessions.json        every session's metadata
//   events/<id>.jsonl    each session's event log, append-only
//   images/<sha>.<ext>   images pasted into replies (content-addressed)
//   lead/              the lead agent's working directory (LEAD_NOTES.md lives here)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Event, ImageRef, SessionMeta, Settings } from '../shared/types.ts'

const OLD_DATA = path.join(os.homedir(), '.codiner')
export const DATA = process.env.CODINGER_HOME ?? process.env.CODINER_HOME ?? homeData()
// Codinger was called Codiner until October 2026. Move ~/.codiner once, and leave a link
// there for the sessions and tasks that a restart keeps running, which still use the old path.
// Claude Code keeps the lead's conversation under its directory's name: move that too.
function homeData(): string {
  const data = path.join(os.homedir(), '.codinger')
  if (fs.existsSync(data) || !fs.existsSync(OLD_DATA) || fs.lstatSync(OLD_DATA).isSymbolicLink()) return data
  // Windows can't move a folder in use (a running task's log, a process's working
  // directory): stay in the old one until a start when it can.
  try { fs.renameSync(OLD_DATA, data) } catch { return OLD_DATA }
  // A junction needs no rights on Windows, where a symbolic link does.
  try { fs.symlinkSync(data, OLD_DATA, process.platform === 'win32' ? 'junction' : 'dir') } catch { /* no link */ }
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  const key = (dir: string) => path.join(projects, dir.replace(/[^A-Za-z0-9]/g, '-'))
  const from = key(path.join(OLD_DATA, 'lead')), to = key(path.join(data, 'lead'))
  try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to) } catch { /* the lead starts a new conversation */ }
  return data
}
const EVENTS = path.join(DATA, 'events')
export const IMAGES = path.join(DATA, 'images')
export const MEDIA = path.join(DATA, 'media')
export const LEAD_DIR = path.join(DATA, 'lead')
const PROMPTS = path.join(DATA, 'prompts')
// The lead agent was called the master until October 2026. Move its directory once.
const OLD_LEAD_DIR = path.join(DATA, 'master')
if (fs.existsSync(OLD_LEAD_DIR) && !fs.existsSync(LEAD_DIR)) fs.renameSync(OLD_LEAD_DIR, LEAD_DIR)
for (const d of [DATA, EVENTS, IMAGES, MEDIA, LEAD_DIR, PROMPTS]) fs.mkdirSync(d, { recursive: true })
export const LEAD_NOTES = path.join(LEAD_DIR, 'LEAD_NOTES.md')
// The lead's notes were NOTES.md until October 2026. Move them once (their history moves in index.ts).
export const OLD_LEAD_NOTES = path.join(LEAD_DIR, 'NOTES.md')
if (fs.existsSync(OLD_LEAD_NOTES) && !fs.existsSync(LEAD_NOTES)) fs.renameSync(OLD_LEAD_NOTES, LEAD_NOTES)

const SESSIONS = path.join(DATA, 'sessions.json')
const SETTINGS = path.join(DATA, 'settings.json')

export function loadSessions(): SessionMeta[] {
  let all: SessionMeta[]
  try { all = JSON.parse(fs.readFileSync(SESSIONS, 'utf8')) } catch { return [] }
  return all.map(renameMaster).map((m) => m.cwd.startsWith(OLD_DATA + path.sep) ? { ...m, cwd: DATA + m.cwd.slice(OLD_DATA.length) } : m)
}

// The old master session becomes the lead: new id, kind and directory. Claude Code
// keeps a conversation under the directory it ran in, so the lead starts a new one
// (its notes moved with the directory). Its event log keeps the old transcript.
export let leadRenamed = false
function renameMaster(m: SessionMeta): SessionMeta {
  if ((m.kind as string) !== 'master') return m
  leadRenamed = true
  const from = path.join(EVENTS, `${m.id}.jsonl`), to = path.join(EVENTS, 'lead.jsonl')
  if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to)
  return { ...m, id: 'lead', kind: 'lead', title: 'Lead', cwd: LEAD_DIR, claudeSessionId: randomUUID(), started: false, context: { ...m.context, used: 0 } }
}

let saveTimer: NodeJS.Timeout | null = null
export function saveSessions(all: () => SessionMeta[]) {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const tmp = SESSIONS + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(all(), null, 1))
    fs.renameSync(tmp, SESSIONS)
  }, 200)
}

export function loadSettings(): Settings {
  try {
    const { masterAutoSend, ...s } = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
    return { leadAutoSend: masterAutoSend ?? false, ...s }
  } catch { return { leadAutoSend: false } }
}
export function saveSettings(s: Settings) { fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 1)) }

// Context window per model. Claude Code only reports it in a turn's result, so
// remember what each model reported and use it from the start next time.
const WINDOWS = path.join(DATA, 'windows.json')
const windows: Record<string, number> = (() => { try { return JSON.parse(fs.readFileSync(WINDOWS, 'utf8')) } catch { return {} } })()
export function knownWindow(model: string | null | undefined): number {
  if (model && windows[model]) return windows[model]
  return model && /-[5-9]/.test(model) ? 1_000_000 : 200_000 // the 5.x models have 1M windows
}
export function learnWindow(model: string, w: number) {
  if (!model || !w || windows[model] === w) return
  windows[model] = w
  fs.writeFile(WINDOWS, JSON.stringify(windows, null, 1), () => {})
}

// What the default model ('') and each alias (opus, sonnet...) turned out to be, as
// Claude Code reported when a session started, so a new session can show it at once.
const MODELS = path.join(DATA, 'models.json')
const models: Record<string, string> = (() => { try { return JSON.parse(fs.readFileSync(MODELS, 'utf8')) } catch { return {} } })()
const isAlias = (model: string | null | undefined) => !model || !model.includes('-')
export function resolveModel(model: string | null | undefined): string | null {
  return isAlias(model) ? models[model ?? ''] ?? model ?? null : model!
}
export function aliasModels(): Record<string, string> { return { ...models } }
export function learnModel(asked: string | null | undefined, got: string) {
  if (!isAlias(asked) || !got || models[asked ?? ''] === got) return
  models[asked ?? ''] = got
  fs.writeFile(MODELS, JSON.stringify(models, null, 1), () => {})
}

const eventsFile = (id: string) => path.join(EVENTS, `${id}.jsonl`)

export function readEvents(id: string): Event[] {
  let raw = ''
  try { raw = fs.readFileSync(eventsFile(id), 'utf8') } catch { return [] }
  // Codinger was called Codiner until October 2026: its messages and its tools had the old name.
  raw = raw.replaceAll('"from":"codiner"', '"from":"codinger"').replaceAll('"mcp__codiner__', '"mcp__codinger__')
  const out: Event[] = []
  for (const line of raw.split('\n')) if (line.trim()) try { out.push(JSON.parse(line)) } catch { /* torn write */ }
  return out
}

export function appendEvent(id: string, e: Event) {
  fs.appendFileSync(eventsFile(id), JSON.stringify(e) + '\n')
}

export function writeEvents(id: string, events: Event[]) {
  const tmp = eventsFile(id) + '.tmp'
  fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e) + '\n').join(''))
  fs.renameSync(tmp, eventsFile(id))
}

export function deleteEvents(id: string) {
  fs.rmSync(eventsFile(id), { force: true })
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function saveImage(dataUrl: string): ImageRef {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(dataUrl)
  if (!m || !EXT[m[1]]) throw new Error('Unsupported image (use PNG, JPEG, GIF or WebP)')
  const buf = Buffer.from(m[2], 'base64')
  const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${EXT[m[1]]}`
  const file = path.join(IMAGES, name)
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf)
  return { url: `/api/images/${name}`, mediaType: m[1] }
}

export function imageFile(url: string): string | null {
  const name = /^\/api\/images\/([\w]+\.(png|jpg|gif|webp))$/.exec(url)?.[1]
  return name ? path.join(IMAGES, name) : null
}

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p
}

// A session's system prompt goes to claude as a file: on Windows the whole command
// line must fit in 32,767 characters, and the prompt alone can be bigger.
export function promptFile(id: string, text: string): string {
  const f = path.join(PROMPTS, `${id}.md`)
  fs.writeFileSync(f, text)
  return f
}
