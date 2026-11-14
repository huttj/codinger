// Long-running commands an agent starts with the start_task tool: dev servers,
// watchers, long builds and test runs. Codinger runs each one in its own process
// group, apart from the claude process, so it has no time limit and keeps running
// when the session sleeps or Codinger restarts. Its output goes to
// ~/.codinger/tasks/<id>.log; a wrapper shell writes the exit code to <id>.exit.
//
// Each task is marked as Codinger's and the agent's, outside Codinger too: its
// command line in `ps` starts ": codinger-task <id> session <sid>", and it and
// everything it starts have CODINGER_TASK and CODINGER_SESSION in their environment.
//
// An ended task, and its log, goes after a week; the panel can remove one sooner.
//
// Stop sends SIGTERM to the task's process group (the exact pid Codinger started),
// then SIGKILL if it is still there after 5 seconds.
//
// On Windows the task runs in Git Bash when there is one, the same shell Claude
// Code's Bash tool uses. Its programs are not in the wrapper's Windows process
// tree, so Stop is Git Bash's own kill on the wrapper's process group (the
// wrapper writes its pid to <id>.pid), SIGTERM then SIGKILL, then `taskkill /T /F`.
// Without Git Bash the task runs in cmd.exe under a small node wrapper, and Stop
// is `taskkill /T /F` at once: without /F, taskkill stops no console program.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Task, TaskNotify } from '../shared/types.ts'
import { DATA } from './store.ts'
import { childEnv } from './auth.ts'

const DIR = path.join(DATA, 'tasks')
const INDEX = path.join(DIR, 'tasks.json')
fs.mkdirSync(DIR, { recursive: true })

export const logPath = (id: string) => path.join(DIR, `${id}.log`)
const exitPath = (id: string) => path.join(DIR, `${id}.exit`)
const pidPath = (id: string) => path.join(DIR, `${id}.pid`)
const files = (id: string) => [logPath(id), exitPath(id), pidPath(id)]

type Ctx = { changed: (tasks: Task[]) => void; ended: (t: Task) => void }
let ctx: Ctx
let tasks: Task[] = []
try { tasks = JSON.parse(fs.readFileSync(INDEX, 'utf8')) } catch { /* none yet */ }

const save = () => { fs.writeFileSync(INDEX + '.tmp', JSON.stringify(tasks, null, 1)); fs.renameSync(INDEX + '.tmp', INDEX); ctx?.changed(tasks) }
export const allTasks = () => tasks
export const taskOf = (id: string) => tasks.find((t) => t.id === id)

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

export function startTasks(c: Ctx) {
  ctx = c
  // Tasks that ended while Codinger was down are found on the first check. It runs after
  // index.ts has run to its end, because ctx.ended uses functions that index.ts defines below the call.
  setInterval(check, 2000).unref()
  setImmediate(check)
}

const WEEK = 7 * 24 * 3_600_000

function check() {
  let any = false
  const old = tasks.filter((t) => t.ended && t.ended < Date.now() - WEEK && t.told)
  for (const t of old) for (const f of files(t.id)) fs.rmSync(f, { force: true })
  if (old.length) { tasks = tasks.filter((t) => !old.includes(t)); any = true }
  for (const t of tasks) {
    if (t.ended) continue
    if (alive(t.pid)) {
      const p = progressOf(t.id)
      if (p?.pct !== t.progress?.pct || p?.label !== t.progress?.label) { t.progress = p; any = true }
      continue
    }
    delete t.progress
    const code = Number.parseInt(fs.readFileSync(exitPath(t.id), { encoding: 'utf8', flag: 'a+' }).trim(), 10)
    Object.assign(t, { ended: Date.now(), code: Number.isNaN(code) ? null : code })
    any = true
    ctx.ended(t)
  }
  if (any) save()
}

export function startTask(sid: string, o: { title: string; command: string; cwd: string; notify?: TaskNotify }): Task {
  const id = randomUUID().slice(0, 8)
  // Not 'a': Git Bash's programs can't write to a handle opened for appending, and the log is new.
  const fd = fs.openSync(logPath(id), 'w')
  fs.writeSync(fd, `# codinger task ${id} · session ${sid} · ${o.title} · ${new Date().toISOString()}\n# in ${o.cwd}\n$ ${o.command}\n\n`)
  // The inner shell runs the command, so an `exit` in it still leaves the wrapper to write the code.
  const sh = shell()
  const posix = (f: string) => `'${f.replaceAll('\\', '/')}'`
  const wrapper = `: codinger-task ${id} session ${sid}; ${sh ? `echo $$ > ${posix(pidPath(id))}; sh` : '/bin/sh'} -c "$CODINGER_TASK_COMMAND"; echo $? > ${posix(exitPath(id))}`
  const [cmd, args] = !WIN ? ['/bin/sh', ['-c', wrapper]] : sh ? [sh, ['-c', wrapper]] : [process.execPath, [CMD_WRAPPER, `codinger-task ${id} session ${sid}`, exitPath(id)]]
  const p = spawn(cmd, args, {
    cwd: o.cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    env: { ...childEnv(), CODINGER_TASK: id, CODINGER_SESSION: sid, CODINGER_TASK_COMMAND: o.command },
  })
  fs.closeSync(fd)
  if (!p.pid) throw new Error('The task did not start')
  p.unref()
  p.on('error', () => {})
  const t: Task = { id, sid, title: o.title, command: o.command, cwd: o.cwd, pid: p.pid, started: Date.now(), notify: o.notify ?? 'next' }
  tasks.push(t)
  save()
  return t
}

export function stopTask(id: string, by: 'user' | 'agent'): Task {
  const t = taskOf(id)
  if (!t) throw new Error(`No task ${id}`)
  if (t.ended) return t
  t.stopped = by
  save()
  // The whole group: the wrapper, the command and whatever it started.
  kill(t, false)
  setTimeout(() => { if (!t.ended && alive(t.pid)) kill(t, true) }, 5000).unref()
  return t
}

const WIN = process.platform === 'win32'

// Without Git Bash, the wrapper is cmd-task.ts.
const CMD_WRAPPER = path.join(import.meta.dirname, 'cmd-task.ts')

function kill(t: Task, force: boolean) {
  if (!WIN) { try { process.kill(-t.pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* gone */ } return }
  const spawnQuiet = (cmd: string, args: string[]) => spawn(cmd, args, { stdio: 'ignore', windowsHide: true }).on('error', () => {})
  let group = ''
  try { group = fs.readFileSync(pidPath(t.id), 'utf8').trim() } catch { /* a cmd.exe task */ }
  const sh = shell()
  if (sh && /^\d+$/.test(group)) spawnQuiet(sh, ['-c', `kill -${force ? 'KILL' : 'TERM'} -- -${group}`])
  if (force || !group) spawnQuiet('taskkill', ['/pid', String(t.pid), '/T', '/F'])
}

// Git Bash on Windows, if there is one (the place Claude Code looks first, then the usual ones).
let bash: string | null | undefined
function shell(): string | null {
  if (!WIN) return null
  if (bash !== undefined) return bash
  const e = process.env
  const places = [e.CLAUDE_CODE_GIT_BASH_PATH, ...[e.ProgramFiles, e['ProgramFiles(x86)'], e.LOCALAPPDATA && path.join(e.LOCALAPPDATA, 'Programs')]
    .filter(Boolean).map((d) => path.join(d!, 'Git', 'bin', 'bash.exe'))]
  return bash = places.find((f) => f && fs.existsSync(f)) ?? null
}

export function markTold(ids: string[]) {
  for (const t of tasks) if (ids.includes(t.id)) t.told = true
  save()
}

// Forget an ended task and its log.
export function removeTask(id: string) {
  const t = taskOf(id)
  if (!t || !t.ended) throw new Error('Only an ended task can be removed')
  tasks = tasks.filter((x) => x.id !== id)
  for (const f of files(id)) fs.rmSync(f, { force: true })
  save()
}

// ---- the log ------------------------------------------------------------------

// The log from byte `from` on, at most `max` bytes; with no `from`, its last `max` bytes.
// next: the byte to read from next time.
export function readLog(id: string, from?: number, max = 256 * 1024): { text: string; size: number; start: number; next: number } {
  let fd: number
  try { fd = fs.openSync(logPath(id), 'r') } catch { return { text: '', size: 0, start: 0, next: from ?? 0 } }
  try {
    const size = fs.fstatSync(fd).size
    const start = from == null ? Math.max(0, size - max) : Math.min(from, size)
    const len = Math.min(max, size - start)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    return { text: buf.toString('utf8'), size, start, next: start + len }
  } finally { fs.closeSync(fd) }
}

// Lines that contain `q` (case-insensitive), with their line numbers.
export function searchLog(id: string, q: string, limit = 500): { n: number; line: string }[] {
  const needle = q.toLowerCase()
  if (!needle) return []
  let text = ''
  try { text = fs.readFileSync(logPath(id), 'utf8') } catch { return [] }
  const out: { n: number; line: string }[] = []
  text.split('\n').map(lastDraw).forEach((line, i) => { if (out.length < limit && line.toLowerCase().includes(needle)) out.push({ n: i + 1, line: line.slice(0, 1000) }) })
  return out
}

// The last lines as a terminal shows them: a progress bar redraws its line with \r, so
// only what comes after the last \r stays. Long lines are cut.
export function tailLines(id: string, n = 8): string {
  return readLog(id, undefined, 16 * 1024).text.split('\n').map(lastDraw).filter((l, i, a) => l || i < a.length - 1).slice(-n)
    .map((l) => l.length > 300 ? l.slice(0, 300) + ' …' : l).join('\n')
}

// A percentage in the last few lines of the log, as progress bars (tqdm, curl, ...) write it,
// with the word before it as its label ("analysing:  89%|===" is 89, "analysing").
function progressOf(id: string): Task['progress'] {
  const lines = readLog(id, undefined, 4096).text.split('\n').map(lastDraw).filter((l) => l.trim()).slice(-3).reverse()
  for (const line of lines) {
    const m = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)].filter((x) => Number(x[1]) <= 100).at(-1)
    if (!m) continue
    const label = line.slice(0, m.index).replace(/[\s:|]+$/, '').split(/\s{2,}|\|/).at(-1)?.trim().slice(-30)
    return { pct: Math.floor(Number(m[1])), ...(label && /[a-z]/i.test(label) ? { label } : {}) }
  }
  return undefined
}

const lastDraw = (line: string) => line.split('\r').filter(Boolean).at(-1) ?? ''

const span = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ${Math.round(ms / 1000) % 60}s` : `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms / 60_000) % 60}m`

// What the agent is told when its task ends.
export function endText(t: Task): string {
  const how = t.stopped === 'user' ? 'was stopped by the user' : t.stopped === 'agent' ? 'was stopped by you' : t.code == null ? 'ended (exit code unknown)' : `ended with exit code ${t.code}`
  return `[Codinger] Your task \`${t.id}\` ("${t.title}") ${how}, after ${span((t.ended ?? Date.now()) - t.started)}. Log: ${logPath(t.id)}. Its last lines:\n~~~\n${tailLines(t.id)}\n~~~`
}

export function statusLine(t: Task): string {
  const state = !t.ended ? `running for ${span(Date.now() - t.started)}` : t.stopped ? `stopped by the ${t.stopped === 'user' ? 'user' : 'agent'}` : `ended, exit code ${t.code ?? 'unknown'}`
  return `- \`${t.id}\` "${t.title}": ${state}. Command: ${t.command.slice(0, 200)}. Log: ${logPath(t.id)}`
}
