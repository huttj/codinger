// Codinger's server: owns the Claude Code processes, persists their transcripts,
// and serves the UI. Binds to 127.0.0.1 only and refuses cross-origin requests,
// since anything that can reach it can run Claude in your directories.
//
//   node server/index.ts          serve the built UI from dist/
//   node server/index.ts --dev    serve the UI through Vite, with hot reload

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { InboxItem, Part, PermissionMode, ServerMsg, SessionMeta, Settings, Usage } from '../shared/types.ts'
import { criticalUnanswered, inboxLabel, inboxParts, openItemsOf } from '../shared/inbox.ts'
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import { Session, pushBody, slashCommand, type Hooks, type Launch, type SlashCommand } from './session.ts'
import { Proc } from './proc.ts'
import { findHistory, importTranscript, lastCache, listDirs, listHistory } from './history.ts'
import { LEAD_PROMPT, WORKER_PROMPT, lookPrompt, workerNotesPrompt } from './prompts.ts'
import { LOOK_OPTIONS, LOOK_SLOTS, cleanLook, describeLook } from '../shared/looks.ts'
import { cleanAppearance } from '../shared/appearance.ts'
import * as meter from './meter.ts'
import * as costs from './costs.ts'
import * as usageLedger from './usage.ts'
import { notesDir, notesNow, notesPath, readNotes, resumeKeepWarm, startNotes } from './notes.ts'
import { notesFile } from '../shared/notes.ts'
import { flagProblem } from '../shared/flags.ts'
import { allTasks, endText, logPath, markTold, readLog, removeTask, searchLog, startTask, startTasks, statusLine, stopTask, taskOf } from './tasks.ts'
import type { Task, TaskNotify } from '../shared/types.ts'
import { configsFor, probe, serversFor } from './mcpservers.ts'
import { DEFAULT_CACHE_GUARD, cacheLeft, knownTtl } from '../shared/cache.ts'
import { AGENTS_FILE, agentsPrompt, readAgentsMd, writeAgentsMd } from './agentsmd.ts'
import { handleMcp, type Tool } from './mcp.ts'
import { spendSince, spendText } from './spend.ts'
import { backfillSubagentSpend } from './subspend.ts'
import { ESTIMATE_TOOLS, backfillActive, estimateTools, estimatesPrompt, estimatesReply } from './estimates.ts'
import { answered, askTools, forgetAsks, startAsks } from './asks.ts'
import { MAIL_TOOLS, flushMail, mailTools, release, startMail, stepped, takeMail, turnEnded, userWrote } from './mail.ts'
import { AUTOPILOT_MODES, amount, nudge, startAutopilot, usedOf, verdict } from './autopilot.ts'
import { blame, initFileHistory, moveHistory, noteEdit, record as recordVersion, versions } from './filehistory.ts'
import { claim, refresh, toolEnded, toolStarted, whoChanged } from './changes.ts'
import { CLAUDE, authState, cancelLogin, childEnv, initAuth, needed as authNeeded, startLogin, submitCode } from './auth.ts'
import { deviceType, findDevice } from './device.ts'
import { remoteCancelLink, remoteForget, remoteHub, remoteLink, remoteName, remoteOn, remoteNotify, remoteProxy, remoteStatus, remoteUpgrade, startRemote } from './remote.ts'
import { startUpdates, updateModeChanged, updateNow, updatePrompt, updateStatus } from './update.ts'
import {
  DATA, LEAD_DIR, LEAD_NOTES, OLD_LEAD_NOTES, appendEvent, deleteEvents, readEvents, expandHome, imageFile, knownWindow, leadRenamed, resolveModel, loadSessions, promptFile, loadSettings, saveImage, saveSessions, saveSettings,
} from './store.ts'
import { embedOf, mediaKind, mediaType } from '../shared/media.ts'
import { MEDIA_MAX, MEDIA_PART, keepMedia, mediaFile } from './media.ts'
import { allowed, committedAt, diffOf, findFiles, isSecret, isText, listDir, uncommitted } from './files.ts'
import { ARTIFACTS, artifactsChanged, artifactsPrompt, checkArtifact, forgetPublish, listArtifacts, noteTool, reportOf, setVisibility, showArtifact, startPublish, startHost, typeOf, watchArtifacts } from './artifacts.ts'
import { connectCallback, connectUrl, disconnect as prolificaDisconnect, prolificaState } from './prolifica.ts'
import { buildShare, publishShare, unpublishShare } from './share.ts'
import type { ShareOpts } from '../shared/share.ts'

const ROOT =path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 4545)
const DEV = process.argv.includes('--dev')
// Kept across restarts: a claude process that outlives a server (server/proc.ts) still reaches Codinger's tools.
const MCP_TOKEN = (() => {
  const f = path.join(DATA, 'mcp-token')
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t } catch { /* none yet */ }
  const t = randomUUID()
  fs.writeFileSync(f, t, { mode: 0o600 })
  return t
})()
const LEAD_ID = 'lead'
const MODES: PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']

// ---- state ----------------------------------------------------------------

const sessions = new Map<string, Session>()
let settings: Settings = loadSettings()
meter.poll()
setInterval(meter.poll, 60_000).unref()
costs.start()
usageLedger.start()
let usage: Usage = { ...meter.last(), rate: meter.rate() }
const sockets = new Set<WebSocket>()
// Slash commands differ by directory (project skills), so keep each session's
// list, and the last one seen for sessions that haven't started yet.
const COMMANDS_FILE = path.join(DATA, 'commands.json')
const commands = new Map<string, SlashCommand[]>()
// Closes the terminal window (or iTerm2 session) on the tty given as $1, a moment
// after the command's shell ends. Each app gets its own AppleScript, so a Mac
// without iTerm2 still compiles the Terminal one.
const CLOSER = `#!/bin/sh
rm -f "$0"
sleep 1
case "$TERM_PROGRAM" in
iTerm.app) osascript - "$1" <<'AS'
on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with x in sessions of t
          if tty of x is (item 1 of argv) then close x
        end repeat
      end repeat
    end repeat
  end tell
end run
AS
;;
Apple_Terminal) osascript - "$1" <<'AS'
on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is (item 1 of argv) then close w
      end repeat
    end repeat
  end tell
end run
AS
;;
esac
`
// Commands opened in Terminal from a <run> block, by token, until they report back.
const runs = new Map<string, { sid: string; log: string }>()

// Windows: a <run> command in a new PowerShell window in the session's directory.
// Windows PowerShell has no `script`, and its transcript misses what programs print,
// so when the command ends the script copies the window's text from where the
// command began. On success the window closes; on failure it stays at a prompt.
function runWindows(sid: string, cwd: string, cmd: string): string {
  const token = randomUUID().slice(0, 12)
  const file = path.join(os.tmpdir(), `codinger-${token}.ps1`)
  const log = path.join(os.tmpdir(), `codinger-${token}.log`)
  const q = (x: string) => `'${x.replace(/'/g, "''")}'`
  runs.set(token, { sid, log })
  // With a BOM, or Windows PowerShell reads the file in the ANSI code page.
  fs.writeFileSync(file, '﻿' + [
    'Remove-Item -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue',
    `Set-Location -LiteralPath ${q(cwd)}`,
    `Write-Host ('$ ' + ${q(cmd)})`,
    '$codingerFrom = $Host.UI.RawUI.CursorPosition.Y',
    '$global:LASTEXITCODE = 0; $Error.Clear(); $codingerOk = $false',
    'try {', cmd, '$codingerOk = $?', '} catch { Write-Host $_ -ForegroundColor Red }',
    '$codingerCode = if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $codingerOk -or $Error.Count) { 1 } else { 0 }',
    'try {',
    '  $ui = $Host.UI.RawUI; $to = $ui.CursorPosition.Y',
    '  $cells = $ui.GetBufferContents((New-Object System.Management.Automation.Host.Rectangle 0, ([Math]::Max($codingerFrom, $to - 200)), ($ui.BufferSize.Width - 1), $to))',
    '  $lines = for ($y = 0; $y -le $cells.GetUpperBound(0); $y++) { (-join (0..$cells.GetUpperBound(1) | ForEach-Object { $cells[$y, $_].Character })).TrimEnd() }',
    `  [IO.File]::WriteAllText(${q(log)}, ($lines -join "\`n"))`,
    '} catch { }',
    `try { Invoke-RestMethod -Method Post -TimeoutSec 5 -Uri "http://127.0.0.1:${PORT}/api/runs/${token}?code=$codingerCode" | Out-Null } catch { }`,
    'if ($codingerCode -eq 0) { Write-Host; Write-Host "Done. This window closes."; Start-Sleep 2; [Environment]::Exit(0) }',
    '',
  ].join('\r\n'))
  // `start` gives it a window of its own; -NoExit keeps that window after a failure.
  spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"start "Codinger" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${file}""`],
    { cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore', detached: true }).on('error', (e) => console.error('run', e.message)).unref()
  return token
}
let lastCommands: SlashCommand[] = (() => { try { return JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8')) } catch { return [] } })()

const metas = () => [...sessions.values()].map((s) => s.meta)

// The sessions that edited a file since its last commit (or, for a file git does not have, in the
// last 14 days), with those edits: the Changes view tells by them which session wrote which line
// (web/src/components/FileView.tsx). An archived session's events are read and not kept.
async function authorsOf(abs: string): Promise<{ id: string; title: string; edits: { old?: string; new: string; ts: number }[] }[]> {
  const since = (await committedAt(abs)) ?? Date.now() - 14 * 86400_000
  const real = new Map<string, string>()
  const realOf = (p: string) => { let r = real.get(p); if (r == null) { try { r = fs.realpathSync(p) } catch { r = p }; real.set(p, r) } return r }
  const want = realOf(abs)
  const out: Awaited<ReturnType<typeof authorsOf>> = []
  for (const s of sessions.values()) {
    if (s.meta.lastActivity < since) continue
    const edits: { old?: string; new: string; ts: number }[] = []
    for (const e of s.meta.archived ? readEvents(s.meta.id) : s.getEvents()) {
      if (e.t !== 'assistant' || e.ts < since) continue
      for (const b of e.blocks) {
        if (b.type !== 'tool_use' || !/^(Write|Edit|MultiEdit)$/.test(b.name) || typeof b.input?.file_path !== 'string') continue
        if (realOf(path.resolve(s.meta.cwd, b.input.file_path)) !== want) continue
        const one = (x: any) => typeof x?.new_string === 'string' && edits.push({ old: String(x.old_string ?? ''), new: x.new_string, ts: e.ts })
        if (b.name === 'Write') { if (typeof b.input.content === 'string') edits.push({ new: b.input.content, ts: e.ts }) }
        else if (b.name === 'Edit') one(b.input)
        else for (const x of Array.isArray(b.input.edits) ? b.input.edits : []) one(x)
      }
    }
    if (edits.length) out.push({ id: s.meta.id, title: s.meta.title, edits })
  }
  return out
}
function broadcast(msg: ServerMsg) {
  const s = JSON.stringify(msg)
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(s)
}
let metaTimer: NodeJS.Timeout | null = null
function metaChanged() {
  saveSessions(metas)
  if (metaTimer) return
  metaTimer = setTimeout(() => { metaTimer = null; broadcast({ type: 'sessions', sessions: metas() }) }, 40)
}

// A push notification when a worker's turn ends and it waits on you: it finished and you did not
// see it, it asks you something, or it needs a permission. A page that shows the session marks it
// seen at once, so the status must hold for a moment first.
const NOTIFY: Record<string, string> = { waiting: 'Finished', asking: 'Has questions for you', permission: 'Needs your permission' }
const lastStatus = new Map<string, string>()
function notifyOnChange(s: Session) {
  const m = s.meta
  const was = lastStatus.get(m.id)
  lastStatus.set(m.id, m.status)
  const status = m.status
  if (m.kind !== 'worker' || was !== 'working' || !NOTIFY[status]) return
  setTimeout(() => {
    if (m.status !== status) return
    remoteNotify({ title: m.title, body: pushBody(s.getEvents(), status) ?? NOTIFY[status], session: m.id })
  }, 2000).unref()
}

const hooks: Hooks = {
  meta: (s) => { notifyOnChange(s); metaChanged() },
  event: (s, event) => {
    broadcast({ type: 'event', sessionId: s.meta.id, event })
    metaChanged()
    if (event.t === 'assistant') stepped(s, event.blocks.flatMap((b) => b.type === 'tool_use' ? [b.name] : []))
    if (event.t === 'assistant') for (const b of event.blocks) if (b.type === 'tool_use') toolStarted(s.meta.cwd, b.id, b.name, event.ts)
    if (event.t === 'result') setImmediate(() => { autoSend(s); flushMail(s); taskTurn(s); autopilotTurn(s, event.isError); turnEnded(s) })
    // A tool call that finished may have changed a tracked file: record it with this message.
    if (event.t === 'tool_result') {
      const ev = s.getEvents()
      for (let i = ev.length - 1; i >= 0 && i > ev.length - 400; i--) {
        const a = ev[i]
        const b = a.t === 'assistant' ? a.blocks.find((x) => x.type === 'tool_use' && x.id === event.toolUseId) : undefined
        if (b?.type === 'tool_use') {
          noteEdit(b.name, b.input, { kind: 'session', sid: s.meta.id, title: s.meta.title, seq: a.seq })
          toolEnded(s.meta.cwd, b.id, b.name, b.input, s.meta.id, a.ts)
          if (!event.isError && noteTool(b.name, b.input, { sid: s.meta.id, seq: a.seq, ts: event.ts, tool: b.id })) artifactsChanged()
          break
        }
      }
    }
  },
  delta: (s, text, reset) => broadcast({ type: 'delta', sessionId: s.meta.id, text, reset }),
  authFailed: () => authNeeded(),
  truncate: (s, seq) => { broadcast({ type: 'truncate', sessionId: s.meta.id, seq }); metaChanged() },
  usage: (u) => { meter.limit(u); costs.limit(u); usage = { ...u, rate: meter.rate() }; broadcast({ type: 'usage', usage }) },
  commands: (s, list) => {
    commands.set(s.meta.id, list)
    if (s.meta.kind === 'worker') { lastCommands = list; fs.writeFile(COMMANDS_FILE, JSON.stringify(list), () => {}) }
  },
  mcpServers: (s) => s.meta.mcp ? configsFor(s.meta.cwd, s.meta.mcp.on) : null,
}

function launchFor(meta: SessionMeta): () => Launch {
  // Every session gets Codinger's set_look tool, pre-approved; workers keep their own MCP servers too.
  if (meta.kind === 'worker') return () => {
    const notes = settings.notes !== false
    // The worker writes its own notes: their folder (and its .gitignore) is there first.
    if (notes) notesDir(meta)
    return {
      args: [
        '--mcp-config', JSON.stringify({ mcpServers: { codinger: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp/${MCP_TOKEN}/look/${meta.id}` } } }),
        // Started with your MCP servers off: only Codinger's, until one is turned on (server/mcpservers.ts).
        ...(meta.mcp ? ['--strict-mcp-config'] : []),
        '--allowedTools', `mcp__codinger__set_look,mcp__codinger__set_title,mcp__codinger__claim_changes,mcp__codinger__start_task,mcp__codinger__stop_task,mcp__codinger__list_tasks,mcp__codinger__show_artifact,mcp__codinger__show_file,${MAIL_TOOLS.map((t) => `mcp__codinger__${t}`).join(',')}${settings.estimates !== false ? ESTIMATE_TOOLS.map((t) => `,mcp__codinger__${t}`).join('') : ''}${meta.mcp && settings.mcpClaude !== false ? ',mcp__codinger__use_mcp_server' : ''}`,
        // Artifacts live in one folder for every session (server/artifacts.ts).
        '--add-dir', ARTIFACTS,
      ],
      prompt: WORKER_PROMPT + (settings.estimates !== false ? estimatesPrompt() : '') + lookPrompt(meta.look) + titlePrompt(meta) + mcpPrompt(meta) + artifactsPrompt() + (notes ? workerNotesPrompt(notesFile(meta.id)) : '') + agentsPrompt(),
    }
  }
  return () => ({
    prompt: LEAD_PROMPT + lookPrompt(meta.look) + agentsPrompt(),
    args: [
      '--strict-mcp-config',
      '--mcp-config', JSON.stringify({ mcpServers: { codinger: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp/${MCP_TOKEN}` } } }),
      '--allowedTools', 'mcp__codinger',
      '--tools', 'Read,Write,Edit,Glob,Grep',
      '--autocompact', '200k',
    ],
  })
}

function adopt(meta: SessionMeta): Session {
  const s = new Session(meta, hooks, launchFor(meta))
  sessions.set(meta.id, s)
  return s
}

// The model a session will run before Claude Code says: what its alias (or the
// default) resolved to last time, else the model the newest session ran.
function expectModel(model: string | null | undefined): string | null {
  const known = resolveModel(model)
  if (known?.includes('-')) return known
  if (model) return model
  return [...sessions.values()].map((s) => s.meta).filter((m) => m.model?.includes('-')).sort((a, b) => b.createdAt - a.createdAt)[0]?.model ?? null
}

function newMeta(o: Partial<SessionMeta> & { cwd: string; title: string }): SessionMeta {
  const now = Date.now()
  const expected = expectModel(o.model)
  return {
    id: randomUUID().slice(0, 8), kind: 'worker', parentId: null, model: null, permissionMode: 'auto',
    claudeSessionId: randomUUID(), started: false, createdAt: now, lastActivity: now, status: 'new',
    running: false, unread: false, compacting: false, context: { used: 0, window: knownWindow(expected) }, pendingAsks: 0,
    lastText: '', error: null, archived: false, inbox: [], ...(expected ? { expectedModel: expected } : {}), ...o,
  }
}

for (const m of loadSessions()) {
  const meta = { ...newMeta(m), ...m }
  // The window used to default to 200k until a turn finished; trust what the model reports.
  if (meta.context.window === 200_000 || meta.context.used > meta.context.window) meta.context.window = Math.max(knownWindow(meta.model ?? meta.expectedModel), meta.context.used)
  // Sessions from before Codinger kept a cache record: the transcript has one.
  if (!meta.cache && meta.started) meta.cache = lastCache(meta.cwd, meta.claudeSessionId) ?? undefined
  adopt(meta)
}
if (!sessions.has(LEAD_ID)) {
  adopt(newMeta({ id: LEAD_ID, kind: 'lead', title: 'Lead', cwd: LEAD_DIR }))
  metaChanged()
}
if (leadRenamed) {
  get(LEAD_ID).notice('The master is now called the lead. It starts a new conversation and keeps its LEAD_NOTES.md.')
  saveSettings(settings)
  metaChanged()
}
// Costs saved before October 22, 2026 left out the subagents' calls: add them, once.
backfillSubagentSpend([...sessions.values()].map((s) => s.meta), metaChanged).catch((e) => console.error('subagent spend:', e))
// Auto mode became the default: move sessions still on the old defaults over, once.
if (!settings.autoModeMigrated) {
  for (const s of sessions.values()) if (s.meta.permissionMode === 'default' || (s.meta.kind === 'lead' && s.meta.permissionMode === 'acceptEdits')) s.meta.permissionMode = 'auto'
  settings = { ...settings, autoModeMigrated: true }
  saveSettings(settings)
  metaChanged()
}
// Busy sessions the last server handed on keep going; any other claude process it left is stopped.
Proc.sweep(new Set([...sessions.values()].map((s) => s.reattach()).filter((k): k is string => !!k)))
// The others that were mid-turn lost their turn: they go on, if you asked for that
// (once the server is up: sending needs what this file sets up further down).
setImmediate(() => { for (const s of sessions.values()) if (s.cut) resumeCut(s) })
function resumeCut(s: Session) {
  s.cut = false
  if (!settings.resumeCut) return
  if (holdReasons(s, true).length) { s.notice('The server stopped during Claude\'s turn. Its prompt cache has expired, so it goes on only when you send a message.'); return }
  s.notice('The server stopped during Claude\'s turn. Claude goes on.')
  s.send([{ kind: 'text', text: '[Codinger] The server stopped during your last turn, and the turn ended there. Go on from where you stopped.' }], { from: 'codinger', ...hiddenFor(s, []) })
}
startNotes({ sessions: () => sessions.values(), settings: () => settings, usage: () => usage, changed: metaChanged })
startTasks({ changed: (tasks) => broadcast({ type: 'tasks', tasks }), ended: taskEnded })
startMail({ sessions, create: createSession, hidden: hiddenFor, changed: metaChanged })
startAsks({
  session: (id) => { const s = sessions.get(id); return s && s.meta.kind === 'worker' ? { title: s.meta.title } : undefined },
  push: remoteNotify,
  notice: (id, text, level) => sessions.get(id)?.notice(text, level),
})
// Autopilot goes on in sessions the last server left between turns (a handed-on busy one
// gets there when its turn ends).
setTimeout(() => { for (const s of sessions.values()) autopilotTurn(s, false, true) }, 3000)

function get(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new HttpError(404, `No session ${id}`)
  return s
}

function createSession(o: { cwd: string; title?: string; model?: string | null; permissionMode?: PermissionMode; flags?: string[]; parentId?: string | null; group?: string | null; mkdir?: boolean; mcp?: string[] }): Session {
  const flags = Array.isArray(o.flags) ? o.flags.map((f) => String(f).trim()).filter(Boolean) : []
  for (const f of flags) { const p = flagProblem(f); if (p) throw new HttpError(400, p) }
  const cwd = path.resolve(expandHome(String(o.cwd ?? '').trim()))
  if (o.mkdir && !fs.existsSync(cwd)) {
    try { fs.mkdirSync(cwd, { recursive: true }) } catch (e) { throw new HttpError(400, `Can't create ${cwd}: ${(e as Error).message}`) }
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new HttpError(400, `Not a directory: ${cwd}`)
  const mode = MODES.includes(o.permissionMode as PermissionMode) ? o.permissionMode! : 'auto'
  const group = o.group ? String(o.group) : o.parentId ? sessions.get(o.parentId)?.meta.group : undefined
  const s = adopt(newMeta({
    cwd, title: o.title?.trim() || path.basename(cwd), model: o.model || null, permissionMode: mode,
    ...(flags.length ? { flags } : {}),
    parentId: o.parentId && sessions.has(o.parentId) ? o.parentId : null,
    // Its group: the one asked for, else its parent's.
    ...(group ? { group } : {}),
    // Only the MCP servers picked in the new session dialog. With no pick: none when you start
    // sessions with them off (that setting wins over the ones kept on for every new session),
    // else the ones kept on for every new session, or all of them if you never chose those.
    ...(Array.isArray(o.mcp) ? { mcp: { strict: true as const, on: [...new Set(o.mcp.map(String))] } }
      : settings.mcpStartOff !== false ? { mcp: { strict: true as const, on: [] } }
      : settings.mcpAlways ? { mcp: { strict: true as const, on: [...settings.mcpAlways] } } : {}),
  }))
  metaChanged()
  return s
}

// Pick up a session from Claude Code's own history, conversation included.
function resumeHistory(claudeId: string): Session {
  const existing = [...sessions.values()].find((s) => s.meta.claudeSessionId === claudeId)
  if (existing) { if (existing.meta.archived) { existing.meta.archived = false; metaChanged() } return existing }
  const found = findHistory(claudeId)
  if (!found) throw new HttpError(404, 'No such Claude Code session')
  const { file, item } = found
  if (!fs.existsSync(item.cwd)) throw new HttpError(400, `Its directory no longer exists: ${item.cwd}`)
  const { events, contextUsed, model } = importTranscript(file)
  const meta = newMeta({ cwd: item.cwd, title: item.title, claudeSessionId: claudeId, started: true, model, lastActivity: item.mtime })
  meta.context.used = contextUsed
  meta.context.window = Math.max(knownWindow(model), contextUsed)
  meta.cache = lastCache(item.cwd, claudeId) ?? undefined
  meta.status = 'idle'
  for (const e of events) appendEvent(meta.id, e)
  const s = adopt(meta)
  s.notice(`Picked up from Claude Code history (${plural(events.filter((e) => e.t === "user").length, "message")}). Your next message continues this conversation.`)
  if (Date.now() - item.mtime < 3 * 60_000) s.notice('This session was active in the last few minutes. If it is still open in a terminal, close it there first, or both will write to the same conversation.', 'warn')
  metaChanged()
  return s
}

// Context added to each message you send, out of the transcript: the lead gets
// the board; a worker gets the tasks that ended.
// What goes to Claude unseen with a message. A slash command takes none, so tasks
// that ended stay unheard until a message that can carry them.
function hiddenFor(s: Session, parts: Part[]): { hidden?: string; tasks?: string[] } {
  if (slashCommand(parts)) return {}
  if (s.meta.kind === 'lead') return { hidden: board() }
  const out: string[] = []
  // Tasks that ended since it last heard; the message keeps their ids, to show them.
  const ended = tasksEnded(s)
  out.push(...ended.map(endText))
  return out.length ? { hidden: out.join('\n\n'), ...(ended.length ? { tasks: ended.map((t) => t.id) } : {}) } : {}
}

// ---- autopilot (server/autopilot.ts) ----------------------------------------

// A turn ended (or the server started): tell Claude to go on, or end autopilot.
// It waits while a task or background work will start the next turn itself.
function autopilotTurn(s: Session, error: boolean, boot = false) {
  const ap = s.meta.autopilot
  if (!ap || ap.ended || busy(s) || s.meta.archived) return
  if (s.backgroundWork || allTasks().some((t) => t.sid === s.meta.id && !t.ended && t.notify !== 'next')) return
  // At a start, the turn before was judged by the last server.
  ap.used = usedOf(ap, s.meta, usage)
  const why = boot ? (ap.used >= ap.budget ? 'the budget is spent' : null) : verdict(ap, s.meta, s.getEvents(), usage, error)
  if (why) return endAutopilot(s, why)
  goOn(s)
}

function goOn(s: Session) {
  const ap = s.meta.autopilot!
  const n = nudge(ap)
  const p: Part[] = [{ kind: 'text', text: n.text }]
  const h = hiddenFor(s, p)
  s.send(p, { from: 'autopilot', ...h, hidden: [n.hidden, h.hidden].filter(Boolean).join('\n\n') })
  ap.turns++
  metaChanged()
}

function endAutopilot(s: Session, reason: string) {
  const ap = s.meta.autopilot
  if (!ap || ap.ended) return
  ap.used = usedOf(ap, s.meta, usage)
  ap.ended = { reason, at: Date.now() }
  s.notice(`Autopilot ended: ${reason}. It used ${amount(ap.unit, ap.used)} of ${amount(ap.unit, ap.budget)} in ${ap.turns} ${ap.turns === 1 ? 'turn' : 'turns'}.`)
  s.markUnread()
  metaChanged()
}

// ---- tasks (server/tasks.ts) ------------------------------------------------

// The session's tasks that ended and it has not heard of, now marked heard.
function tasksEnded(s: Session): Task[] {
  const t = allTasks().filter((x) => x.sid === s.meta.id && x.ended && !x.told)
  if (t.length) markTold(t.map((x) => x.id))
  return t
}

const busy = (s: Session) => s.meta.status === 'working' || s.meta.status === 'permission'

// A task ended. The session always hears of it with its next message; "turn" and
// "interrupt" make that happen now, unless a send would write an expired cache again.
function taskEnded(t: Task) {
  const s = sessions.get(t.sid)
  if (!s) return
  s.notice(`Task "${t.title}" ${t.stopped ? `was stopped by ${t.stopped === 'user' ? 'you' : 'Claude'}` : `ended${t.code != null ? ` with exit code ${t.code}` : ''}`}.`, t.code && !t.stopped ? 'warn' : 'info', { task: t.id })
  if (t.notify === 'next' || t.stopped === 'agent') return
  if (holdReasons(s, true).length) { s.notice(`Claude hears of it with your next message: its prompt cache has expired, so a message now would write it all again.`); return }
  if (busy(s) && t.notify === 'interrupt') s.interrupt()
  else if (busy(s)) return // taskTurn sends it when the turn ends
  sendTasks(s)
}

// A turn ended: tasks that asked for a turn of their own get it.
function taskTurn(s: Session) {
  if (busy(s) || !allTasks().some((x) => x.sid === s.meta.id && x.ended && !x.told && x.notify !== 'next')) return
  if (holdReasons(s, true).length) return
  sendTasks(s)
}

function sendTasks(s: Session) {
  const t = tasksEnded(s)
  if (t.length) s.send([{ kind: 'text', text: t.map(endText).join('\n\n') }], { from: 'codinger', ...hiddenFor(s, []), tasks: t.map((x) => x.id) })
}

function taskTools(id: string): Tool[] {
  const mine = (tid: unknown) => { const t = taskOf(String(tid ?? '')); if (!t || t.sid !== id) throw new Error(`You have no task "${tid}". Call list_tasks.`); return t }
  return [
    {
      name: 'start_task',
      description: 'Run a long or lasting shell command (a dev server, a watcher, a long build or test run) apart from this session, with no time limit. The user can watch its log and stop it in Codinger, and it keeps running if this session stops. Returns its id and log path; read the log with your usual tools.',
      inputSchema: {
        type: 'object', required: ['title', 'command'],
        properties: {
          title: { type: 'string', description: 'A short name for the user, like "Dev server" or "Full test run"' },
          command: { type: 'string', description: process.platform !== 'win32' ? 'The shell command (run with /bin/sh -c)' : 'The shell command (run in Git Bash with sh -c; in cmd.exe if Git Bash is not installed)' },
          cwd: { type: 'string', description: "The directory to run it in; your session's by default" },
          notify: { type: 'string', enum: ['next', 'turn', 'interrupt'], description: 'How you hear that it ended. next (default): with the next message to you. turn: in a turn of your own as soon as you are between turns; use it when you wait on the result. interrupt: stop your current turn; only when its end changes what you are doing.' },
        },
      },
      run: (args) => {
        const s = get(id)
        const command = String(args?.command ?? '').trim()
        if (!command) return 'Give a command.'
        const cwd = expandHome(String(args?.cwd ?? '') || s.meta.cwd)
        if (!fs.existsSync(cwd)) return `There is no directory ${cwd}.`
        const notify = (['next', 'turn', 'interrupt'] as const).includes(args?.notify) ? args.notify as TaskNotify : 'next'
        const t = startTask(id, { title: String(args?.title ?? '').trim().slice(0, 80) || command.slice(0, 40), command, cwd, notify })
        return `Started task \`${t.id}\` (pid ${t.pid}). Log: ${logPath(t.id)}. You will hear when it ends (${notify}).`
      },
    },
    {
      name: 'stop_task',
      description: process.platform !== 'win32' ? 'Stop one of your tasks: SIGTERM to its process group, then SIGKILL after 5 seconds.' : 'Stop one of your tasks: in Git Bash, SIGTERM to its process group, then SIGKILL after 5 seconds; in cmd.exe, taskkill /T /F on its process tree.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: (args) => { const t = mine(args?.id); if (t.ended) return `It already ended.`; stopTask(t.id, 'agent'); return `Stopping task \`${t.id}\`.` },
    },
    {
      name: 'list_tasks',
      description: 'Your tasks, running and ended, with their status and log paths.',
      inputSchema: { type: 'object', properties: {} },
      run: () => { const t = allTasks().filter((x) => x.sid === id); return t.length ? t.map(statusLine).join('\n') : 'You have no tasks.' },
    },
  ]
}

// What the lead sees at the end of each message you send it.
function board(): string {
  const lines = metas().filter((m) => m.kind === 'worker' && !m.archived).map((m) => {
    const ctx = Math.round((m.context.used / (m.context.window || 1)) * 100)
    return `- ${m.id} "${m.title}" ${m.cwd} status=${m.status} ctx=${ctx}%${m.pendingAsks ? ` open_questions=${m.pendingAsks}` : ''}${m.pendingCritical ? ` critical=${m.pendingCritical}` : ''}${m.parentId ? ` parent=${m.parentId}` : ''}${m.inbox.length ? ` drafts_waiting=${m.inbox.length}` : ''}`
  })
  return `<board>\n${lines.length ? lines.join('\n') : '(no worker sessions)'}\n</board>`
}

// ---- lead tools -----------------------------------------------------------

// The lead's drafts wait in the session's reply tray, beside yours, and go with
// your next message. They go on their own only when nothing there waits for
// you: auto-send is on, the worker is not mid-turn, every question and item
// Claude left has a reply, and you are not writing one. `now` is your yes, given
// to the lead, to send past all that. A big, expired cache always waits for you.
// approved: you said yes to the lead's drafts (Send drafts, in the lead view), so auto-send need not be on.
function holdReasons(s: Session, now = false, approved = false): string[] {
  const guard = settings.cacheGuard ?? DEFAULT_CACHE_GUARD
  const left = cacheLeft(s.meta, Date.now(), knownTtl(metas()))
  const why: string[] = []
  if (guard && left != null && left <= 0 && s.meta.context.used >= guard) why.push('its prompt cache has expired, so a send would write its whole context to the cache again; that is the user\'s call')
  // Not even send_now: nothing goes in before the user's next message there.
  if (s.meta.pendingCritical) why.push('Claude left an item marked critical for the user, so nothing goes in before the user\'s next message there')
  if (now) return why
  if (!settings.leadAutoSend && !approved) why.push('auto-send is off')
  if (s.meta.status === 'working' || s.meta.status === 'permission') why.push('it is mid-turn (the drafts go when the turn ends, if nothing else holds them)')
  const open = openItemsOf(s.getEvents()).filter((i) => !s.meta.inbox.some((d) => d.key === i.key))
  if (open.length) why.push(`Claude left questions or items the user has not replied to: ${open.map((i) => `${i.id} ("${i.label.slice(0, 60)}")`).join(', ')}`)
  if (s.meta.drafting) why.push('the user is writing a reply there')
  return why
}

function flushInbox(s: Session): void {
  const parts = inboxParts(s.meta.inbox)
  s.meta.inbox = []
  metaChanged()
  if (parts.length) s.send(parts, { from: 'lead', ...hiddenFor(s, parts) })
}

// A turn ended: drafts that waited only for it may go now.
function autoSend(s: Session): void {
  if (s.meta.kind === 'worker' && s.meta.inbox.length && !holdReasons(s).length) flushInbox(s)
}

type Draft = Omit<InboxItem, 'id' | 'from' | 'ts'>

function deliver(s: Session, drafts: Draft[], opts: { now?: boolean; urgent?: boolean } = {}): string {
  const id = s.meta.id
  // An item marked critical holds everything, urgent or not, for the user's next message.
  const critical = !!s.meta.pendingCritical
  // Urgent: stop the worker and send just this message. The rest wait as usual.
  if (opts.urgent && !critical) {
    const text = drafts.filter((d) => !d.kind || d.kind === 'text').map((d) => d.text.trim()).filter(Boolean).join('\n\n')
    if (!text) throw new Error('An urgent send needs a message')
    if (s.meta.status === 'working' || s.meta.status === 'permission') s.interrupt()
    const p: Part[] = [{ kind: 'text', text }]
    s.send(p, { from: 'lead', ...hiddenFor(s, p) })
    drafts = drafts.filter((d) => d.kind && d.kind !== 'text')
    if (!drafts.length) return `Stopped ${id}'s turn, if it was in one, and sent the message.`
  }
  // A newer draft for the same item replaces the older one.
  const keys = new Set(drafts.flatMap((d) => d.key ? [d.key] : []))
  s.meta.inbox = [...s.meta.inbox.filter((i) => !i.key || !keys.has(i.key)), ...drafts.map((d) => ({ ...d, id: randomUUID().slice(0, 8), from: 'lead', ts: Date.now() }))]
  metaChanged()
  const why = holdReasons(s, opts.now)
  if (!why.length) { flushInbox(s); return `${opts.urgent ? 'Sent the urgent message; then sent' : 'Sent'} the drafts to ${id}.` }
  const n = s.meta.inbox.length
  const ask = !opts.now && !critical && why.some((w) => w.startsWith('Claude left')) && !why[0].startsWith('its prompt cache')
  return `${critical && (opts.urgent || opts.now) ? `Not sent now: ${id} has an item marked critical open for the user. The only delivery there is with the user's next message. ` : ''}Held in ${id}'s reply tray (${n} draft${n === 1 ? '' : 's'} there now); they go with the user's next message there. Held because: ${why.join('; ')}.`
    + (ask ? ' If this should go now anyway, ask the user; with their yes, call again with send_now.' : '')
}

// The critter's look, chosen by the Claude in that session.
// Workers name their session after its task, and keep the name current, unless you named it.
// A name is a small thing of the session's own: Claude may always rename it, and
// when it renames one the user named, the user's name is kept to undo to.
function titlePrompt(meta: SessionMeta): string {
  const base = `\n\n## Your session's name\nName this session after its task with the set_title tool: 2 to 5 words, like "Login flow fix". Do it once the task is clear, and again only if the task changes a lot. Do not mention it unless the user asks.`
  if (!meta.titleByUser) return base + '\n'
  return base + ` The user named this session "${meta.title}"; you may still rename it when the task changes, and they can undo it.${meta.titleUndone ? ` They undid your rename to "${meta.titleUndone}", so do not propose that one again.` : ''}\n`
}

// A session that started with your MCP servers off is told their names, and may turn one on.
function mcpPrompt(meta: SessionMeta): string {
  if (!meta.mcp) return ''
  const names = serversFor(meta.cwd).map((s) => s.name)
  const may = settings.mcpClaude !== false
  return `\n\n## MCP servers\nThis session started with the user's MCP servers off, to keep its context small.`
    + (names.length ? ` These are available: ${names.join(', ')}.` : ' Codinger does not know their names yet: call use_mcp_server with no name.')
    + (meta.mcp.on.length ? ` Turned on: ${meta.mcp.on.join(', ')}.` : '')
    + ` When the task needs one, turn it on with the use_mcp_server tool${may ? '' : ', which asks the user first'}, then use its tools (they may come as deferred tools: load them with ToolSearch). Do not turn on a server the task does not need.\n`
}

function mcpTool(id: string): Tool {
  return {
    name: 'use_mcp_server',
    description: "Turn on one of the user's MCP servers (for example a claude.ai connector) in this session, when the task needs it. Its tools become available from your next step. With no name, it lists the servers.",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The server name, as listed' } } },
    run: async (args) => {
      const s = get(id), m = s.meta
      if (!m.mcp) return 'This session has all of the user\'s MCP servers on already.'
      const want = String(args?.name ?? '').trim().toLowerCase().replace(/^claude\.ai /, '')
      const find = () => serversFor(m.cwd).find((x) => x.name.toLowerCase().replace(/^claude\.ai /, '') === want)
      const server = want ? find() : undefined
      const list = serversFor(m.cwd).map((x) => `${x.name}${m.mcp!.on.includes(x.name) ? ' (on)' : ''}${x.status === 'needs-auth' ? ' (needs sign-in)' : ''}`).join(', ')
      // Codinger looks for servers only when the user presses Refresh: an unknown one may be new.
      const refresh = 'Codinger may not know about it yet: its MCP chip, at the top of this session, now asks the user to press Refresh. Ask them to, then try again.'
      if (!want && list) return `Servers: ${list}.`
      if (!server) {
        m.mcp.missing = want ? String(args.name) : 'a list of servers'
        metaChanged()
        return want ? `There is no server called "${args.name}" that Codinger knows (it knows: ${list || 'none'}). ${refresh}` : `Codinger knows no MCP servers yet. ${refresh}`
      }
      if (server.status === 'needs-auth') return `${server.name} needs the user to sign in first, in their claude.ai connector settings. Ask them to do that.`
      if (!m.mcp.on.includes(server.name)) m.mcp.on.push(server.name)
      s.setMcp(configsFor(m.cwd, m.mcp.on))
      metaChanged()
      return `Turned on ${server.name} (${server.tools} tools). Its tools are available from your next step.`
    },
  }
}

function titleTool(id: string): Tool {
  return {
    name: 'set_title',
    description: "Name your session in the Codinger sidebar after its task: 2 to 5 words. Call it when the task becomes clear, and again only if the task changes a lot.",
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    run: (args) => {
      const s = get(id)
      const t = String(args?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
      if (!t) return 'Give a title of 2 to 5 words.'
      if (t === s.meta.title) return `It is already "${t}".`
      const m = s.meta
      // Over a name the user gave, keep theirs to undo to.
      if (m.titleByUser && m.titleBefore == null) m.titleBefore = m.title
      m.title = t
      metaChanged()
      return m.titleBefore != null ? `Renamed to "${t}". The user had named it "${m.titleBefore}" and can undo this.` : `Renamed to "${t}".`
    },
  }
}

// Codinger names who made each uncommitted change from the times of tool calls (server/changes.ts);
// when a shell command ran while another session or the user changed the same file, the agent fixes it.
function claimTool(id: string): Tool {
  return {
    name: 'claim_changes',
    description: "Say which uncommitted changes in files are yours, when Codinger may name the wrong author for them in its Changes view: after a shell command that ran while another session or the user changed the same file, or for changes from before Codinger kept track. Call it before you ask for a review with a <review> tag. For each file, give the lines you changed in the file as it is now, or no lines when all its uncommitted changes are yours.",
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string', description: 'Relative to the session\'s directory, or absolute' }, lines: { type: 'string', description: 'Line ranges in the file as it is now, like "12-20, 31"; leave out for all' } }, required: ['path'] },
        },
      },
      required: ['files'],
    },
    run: async (args) => {
      const s = get(id)
      const files = Array.isArray(args?.files) ? args.files : []
      if (!files.length) return 'Give the files, each with a path and maybe lines.'
      const out: string[] = []
      for (const f of files) {
        const rel = String(f?.path ?? '').trim()
        if (!rel) continue
        let lines: [number, number][] | 'all' = 'all'
        if (f.lines != null && String(f.lines).trim()) {
          lines = [...String(f.lines).matchAll(/(\d+)\s*(?:-\s*(\d+))?/g)].map((m) => [Number(m[1]), Number(m[2] ?? m[1])] as [number, number])
          if (!lines.length) { out.push(`${rel}: give lines like "12-20, 31".`); continue }
        }
        const r = await claim(s.meta.cwd, path.resolve(s.meta.cwd, expandHome(rel)), s.meta.id, lines)
        out.push(typeof r === 'string' ? `${rel}: ${r}` : `${rel}: ${r} changed ${r === 1 ? 'line is' : 'lines are'} yours now.`)
      }
      return out.join('\n')
    },
  }
}

function lookTool(id: string): Tool {
  return {
    name: 'set_look',
    description: 'Choose how your critter looks in the Codinger sidebar: its colour and what it wears. Give only the slots you want to set; "none" clears one. Pick once; there is no need to call it again.',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(LOOK_SLOTS.map((s) => [s, { type: 'string', enum: [...LOOK_OPTIONS[s], 'none'] }])),
    },
    run: (args) => {
      const s = get(id)
      const { look, rejected } = cleanLook(args ?? {}, s.meta.look ?? {})
      s.meta.look = look
      metaChanged()
      return `Saved. You look like this: ${describeLook(look) || 'plain'}.${rejected.length ? ` Not known, so left out: ${rejected.join(', ')}.` : ''}`
    },
  }
}

// ---- artifacts (server/artifacts.ts) ----

// The second server that runs artifacts: its own port, so never Codinger's origin.
const UI_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]
// The hub's page (web.codinger.app, whichever address this machine reaches it at) frames artifacts too, from artifacts.codinger.app.
const artifactsPort = await startHost(Number(process.env.ARTIFACTS_PORT ?? PORT + 1), () => [...UI_ORIGINS, 'https://web.codinger.app', remoteStatus().hub])
const artifactsMsg = (): ServerMsg => ({ type: 'artifacts', artifacts: listArtifacts(), port: artifactsPort, prolifica: prolificaState() })
watchArtifacts(() => broadcast(artifactsMsg()))

function artifactTool(id: string): Tool {
  return {
    name: 'show_artifact',
    description: 'Show an artifact (a page in the artifacts folder) in the preview pane next to this session, and get the script errors of its load. Call it after you make or change one. Or give url to show a page that a dev server on this machine serves.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The artifact\'s folder name' }, url: { type: 'string', description: 'Instead: http://localhost:<port>/...' } } },
    run: async (args) => {
      const s = get(id)
      if (args?.url) {
        let u: URL
        try { u = new URL(String(args.url)) } catch { return 'Give a full address, like http://localhost:5173/.' }
        if (!/^https?:$/.test(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return 'Only pages on this machine (localhost) show in the pane.'
        broadcast({ type: 'preview', sessionId: id, target: { url: u.href }, at: Date.now() })
        return `Shown in the preview pane: ${u.href}`
      }
      const name = String(args?.name ?? '').trim()
      const bad = checkArtifact(name)
      if (bad) return bad
      // This call's place in the conversation, for its line there and the artifact's history.
      const ev = s.getEvents().findLast((e) => e.t === 'assistant' && e.blocks.some((b) => b.type === 'tool_use' && b.name.endsWith('show_artifact')))
      const call = ev?.t === 'assistant' ? ev.blocks.findLast((b) => b.type === 'tool_use' && b.name.endsWith('show_artifact')) : undefined
      const v = showArtifact(name, { sid: id, seq: ev?.seq ?? 0, ts: Date.now(), show: true, tool: call?.type === 'tool_use' ? call.id : undefined })
      artifactsChanged()
      broadcast({ type: 'preview', sessionId: id, target: { artifact: name }, at: Date.now() })
      return `Shown in the preview pane (http://127.0.0.1:${artifactsPort}/${name}/), version ${v}. To show this version in a message, write ![caption](artifact:${name}@${v}) on a line of its own. ${await reportOf(name)}`
    },
  }
}

// ---- what a session spent, for its own estimates (server/spend.ts) ----

function spendTool(id: string): Tool {
  return {
    name: 'read_spend',
    description: 'What this session has spent: API calls, tokens, dollars at API prices, and the share of the plan\'s usage limits. Call it before a piece of work and keep the "now" it returns; call it after with since set to that number, to report what the work took next to your estimate.',
    inputSchema: { type: 'object', properties: { since: { type: 'number', description: 'The "now" from an earlier call (ms since 1970). Leave out for the whole conversation.' } } },
    run: async (args) => {
      const s = get(id), now = Date.now()
      const since = Number(args?.since) || undefined
      if (!s.meta.claudeSessionId) return 'This session has made no API calls yet.'
      return spendText(await spendSince(s.meta.claudeSessionId, since), { since, now, usage })
    },
  }
}

// ---- files an agent shows the user (shared/media.ts) ----

function fileTool(id: string): Tool {
  return {
    name: 'show_file',
    description: 'Show the user a file or a web address in the conversation: an image (a screenshot), a video, audio, a PDF, a web page, or any other file to open or download. A file on this machine is copied when you call this, so it still shows after you change or delete it.',
    inputSchema: {
      type: 'object', required: ['path'],
      properties: {
        path: { type: 'string', description: 'A file path (absolute, or relative to your working directory) or an http(s) address' },
        caption: { type: 'string', description: 'A short line shown with it' },
      },
    },
    run: async (args) => {
      const s = get(id)
      const p = String(args?.path ?? '').trim()
      if (!p) return 'Give the path of a file, or an http(s) address.'
      if (/^[a-z][\w+.-]*:/i.test(p) && !/^[a-z]:[\\/]/i.test(p)) {
        let u: URL
        try { u = new URL(p) } catch { return 'That is not a full address.' }
        if (!/^https?:$/.test(u.protocol)) return 'Only http(s) addresses and files on this machine can be shown.'
        const kind = embedOf(u.href) ? 'video' : mediaKind(u.pathname)
        return `Shown to the user in the conversation: ${u.href} (${kind === 'file' ? 'as a link' : kind}).`
      }
      const file = path.resolve(s.meta.cwd, expandHome(p))
      let st: fs.Stats
      try { st = await fs.promises.stat(file) } catch { return `There is no file ${file}.` }
      if (!st.isFile()) return `${file} is not a file.`
      if (st.size > MEDIA_MAX) return `${file} is ${Math.round(st.size / 1048576)} MB: the limit is ${MEDIA_MAX / 1048576} MB. Make a smaller copy and show that.`
      const url = keepMedia(file, st)
      await mediaFile(url)
      const size = st.size < 1048576 ? `${Math.max(1, Math.round(st.size / 1024))} KB` : `${(st.size / 1048576).toFixed(1)} MB`
      return `Shown to the user in the conversation: ${file} (${mediaKind(file)}, ${size}).\nurl: ${url}`
    },
  }
}

const tools: Tool[] = [
  {
    name: 'list_sessions',
    description: "List the worker sessions: id, title, directory, status, context use, the questions and items Claude left open (with ids, for send_to_session's replies), your drafts waiting in each, whether the user is writing a reply there, and the tail of the last thing Claude said.",
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean' } } },
    run: ({ include_archived }) => metas().filter((m) => m.kind === 'worker' && (include_archived || !m.archived)).map((m) => ({
      id: m.id, title: m.title, cwd: m.cwd, parent: m.parentId, status: m.status,
      context: `${Math.round(m.context.used / 1000)}k of ${Math.round(m.context.window / 1000)}k`,
      open_items: openItemsOf(get(m.id).getEvents()).map((i) => ({ id: i.id, kind: i.kind, label: i.label.slice(0, 120), ...(i.kind === 'ask' && i.ask.options.length ? { choices: i.ask.options } : {}), ...(i.kind === 'consider' && i.critical ? { critical: true } : {}) })),
      your_drafts: m.inbox.map(inboxLabel), user_drafting: !!m.drafting, last_said: m.lastText.slice(-240),
    })),
  },
  {
    name: 'read_session',
    description: 'Read a condensed plain-text transcript of the last few turns of a session. Costs context: keep max_chars small.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string' }, turns: { type: 'number', description: 'User turns to go back (default 1)' }, max_chars: { type: 'number', description: 'Default 3000' } },
    },
    run: ({ id, turns, max_chars }) => get(id).digest(Math.min(Number(max_chars) || 3000, 20000), Number(turns) || 1),
  },
  {
    name: 'send_to_session',
    description: "Draft a reply to a worker session, written as if from the user: replies to its open questions and items (ids from list_sessions' open_items), a message, or both. The drafts go into the session's reply tray beside the user's own, where the user can edit them, and go with the user's next message there. They go on their own only when auto-send is on, the worker is between turns, every open question and item has a reply, and the user is not writing one. A message that is just a slash command (/compact, /model sonnet, /code-review, any skill) runs it, as if typed at the claude prompt.",
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string' },
        message: { type: 'string', description: 'Plain text, sent after the replies' },
        replies: {
          type: 'array',
          items: {
            type: 'object', required: ['item', 'action'],
            properties: {
              item: { type: 'string', description: 'The id of an open question or item, from open_items' },
              action: { type: 'string', enum: ['answer', 'done', 'dismiss'], description: 'answer: reply to it (a question or an item); done: the user did the task it asked for; dismiss: set it aside without a reply' },
              text: { type: 'string', description: 'The answer, or for done, a problem the user hit. For a draft: the edited text in full; leave it out to approve the draft as written' },
              choices: { type: 'array', items: { type: 'string' }, description: "For a question: the choices picked, word for word" },
            },
          },
        },
        send_now: { type: 'boolean', description: 'Send now, past open questions, a reply the user is writing, or auto-send being off. Only with the user\'s yes, asked in this conversation. Not past an item marked critical: nothing goes in before the user\'s next message there.' },
        urgent: { type: 'boolean', description: 'Stop the worker\'s turn and send `message` at once. Very rare: only to prevent harm the user would not want to wait on, such as a commit or a deletion about to go wrong.' },
      },
    },
    run: ({ id, message, replies, send_now, urgent }) => {
      const s = get(id)
      if (s.meta.kind !== 'worker') throw new Error('You can only message worker sessions')
      const open = openItemsOf(s.getEvents())
      const drafts: Draft[] = (Array.isArray(replies) ? replies : []).map((r: any) => {
        const it = open.find((i) => i.id === String(r.item) || i.key === String(r.item))
        if (!it) throw new Error(`No open question or item "${r.item}" in ${id}. Open now: ${open.map((i) => i.id).join(', ') || 'none'}`)
        const text = String(r.text ?? '')
        if (r.action === 'done') return { kind: 'done', key: it.key, label: it.label, text }
        if (r.action === 'dismiss') return { kind: 'dismiss', key: it.key, label: it.label, text: '' }
        // A draft: the lead's text is the edited draft; none approves it as written.
        if (it.kind === 'ask' && it.ask.draft != null) return { kind: 'answer', key: it.key, label: it.ask.question, text: text.trim() ? text : it.ask.draft, draft: !text.trim() || text.trim() === it.ask.draft.trim() ? 'same' : 'edited' }
        if (it.kind === 'ask') return { kind: 'answer', key: it.key, label: it.ask.question, text, choices: Array.isArray(r.choices) ? r.choices.map(String) : [] }
        return { kind: 'reply', key: it.key, label: it.label, text }
      })
      if (message != null && String(message).trim()) drafts.push({ kind: 'text', text: String(message) })
      if (!drafts.length) throw new Error('Give a message, replies, or both')
      return deliver(s, drafts, { now: !!send_now, urgent: !!urgent })
    },
  },
  {
    name: 'spawn_session',
    description: 'Start a new worker session in a directory. The first prompt is delivered like send_to_session.',
    inputSchema: {
      type: 'object', required: ['cwd', 'title'],
      properties: {
        cwd: { type: 'string', description: 'Absolute or ~ path to an existing directory' },
        title: { type: 'string' }, prompt: { type: 'string' },
        parent: { type: 'string', description: 'Id of the session this one is a sub-task of' },
        model: { type: 'string', description: 'opus, sonnet, haiku or fable; omit for the default' },
      },
    },
    run: ({ cwd, title, prompt, parent, model }) => {
      const s = createSession({ cwd, title, parentId: parent, model })
      return `Created ${s.meta.id}.` + (prompt ? ' ' + deliver(s, [{ kind: 'text', text: String(prompt) }]) : '')
    },
  },
  {
    name: 'find_past_sessions',
    description: "Search Claude Code's own session history (every conversation run with `claude` on this machine, in a terminal or here), newest first. Match on title, directory and prompts.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match; all must appear (case-insensitive). Omit for the most recent.' },
        limit: { type: 'number', description: 'Default 10' },
      },
    },
    run: ({ query, limit }) => {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const byClaude = new Map(metas().map((m) => [m.claudeSessionId, m.id]))
      return listHistory()
        .filter((h) => !h.continuedIn && !h.cwd.startsWith(DATA))
        .filter((h) => { const hay = `${h.title} ${h.cwd} ${h.firstPrompt} ${h.lastPrompt}`.toLowerCase(); return words.every((w) => hay.includes(w)) })
        .slice(0, Math.min(Number(limit) || 10, 50))
        .map((h) => ({
          claude_session_id: h.id, title: h.title, cwd: h.cwd, last_active: new Date(h.mtime).toISOString(),
          first_prompt: h.firstPrompt.slice(0, 160), last_prompt: h.lastPrompt.slice(0, 160), in_codinger_as: byClaude.get(h.id) ?? null,
        }))
    },
  },
  {
    name: 'resume_past_session',
    description: 'Bring a past Claude Code session into Codinger as a worker, with its conversation, so the user (or you, via send_to_session) can continue it. Returns its Codinger id.',
    inputSchema: { type: 'object', required: ['claude_session_id'], properties: { claude_session_id: { type: 'string' } } },
    run: ({ claude_session_id }) => {
      const s = resumeHistory(String(claude_session_id))
      return `Resumed as ${s.meta.id} ("${s.meta.title}", ${s.meta.cwd}). Nothing has been sent to it yet.`
    },
  },
  {
    name: 'interrupt_session',
    description: 'Stop the turn a worker is in the middle of (like pressing Esc in Claude Code). The session stays open.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: ({ id }) => { get(id).interrupt(); return 'Interrupted.' },
  },
  {
    name: 'close_session',
    description: 'Close a worker: end its process and move it to the archive. It can be reopened later with its history, so this is safe for finished work.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: ({ id }) => {
      const s = get(id)
      if (s.meta.kind !== 'worker') throw new Error('Only worker sessions can be closed')
      s.stop(); s.meta.archived = true; metaChanged()
      return `Closed ${id}.`
    },
  },
  {
    name: 'compact_session',
    description: "Compact a worker session's context (Claude Code's /compact), optionally with instructions on what to keep.",
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, instructions: { type: 'string' } } },
    run: ({ id, instructions }) => {
      const s = get(id)
      if (s.meta.status === 'working' || s.meta.status === 'permission') throw new Error('That session is mid-turn; try again when it is idle')
      s.command(instructions ? `/compact ${instructions}` : '/compact')
      return 'Compacting.'
    },
  },
]

// ---- http -----------------------------------------------------------------------

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`])
const localHost = (req: http.IncomingMessage) => LOCAL_HOSTS.has(req.headers.host ?? '')
const localOrigin = (req: http.IncomingMessage) => {
  const o = req.headers.origin
  if (!o) return true
  try { return LOCAL_HOSTS.has(new URL(o).host) } catch { return false }
}

async function json(req: http.IncomingMessage): Promise<any> {
  let s = ''
  for await (const c of req) { s += c; if (s.length > 40_000_000) throw new HttpError(413, 'Too large') }
  return s ? JSON.parse(s) : {}
}

// A command line as its words, as a shell splits it, with '…' and "…" quotes (no variables or escapes).
function splitArgs(line: string): string[] {
  const out: string[] = []
  let cur = '', quote = '', word = false
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = ''; else cur += ch }
    else if (ch === '"' || ch === "'") { quote = ch; word = true }
    else if (/\s/.test(ch)) { if (word || cur) out.push(cur); cur = ''; word = false }
    else cur += ch
  }
  if (word || cur) out.push(cur)
  return out
}

// Claude Code's /context for a new worker session in `cwd`, with a worker's own
// arguments (system prompt, Codinger's tools), so it counts what Codinger adds too.
// It makes no API call: Claude Code estimates the sizes itself. Kept 10 minutes.
const contexts = new Map<string, { at: number; text: string }>()
function startContext(cwd: string, fresh: boolean): Promise<string> {
  const hit = contexts.get(cwd)
  if (hit && !fresh && Date.now() - hit.at < 600_000) return Promise.resolve(hit.text)
  const meta = newMeta({ cwd, title: 'context' })
  const { args, prompt } = launchFor(meta)()
  const file = promptFile(meta.id, prompt)
  return new Promise((resolve, reject) => {
    execFile(CLAUDE, ['-p', '--output-format', 'json', '--no-session-persistence', '--append-system-prompt-file', file, ...args, '--', '/context'],
      { cwd, env: childEnv(), timeout: 120_000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
        fs.rm(file, { force: true }, () => {})
        let text = ''
        try { text = String(JSON.parse(out).result ?? '') } catch { /* reported below */ }
        if (!text) return reject(new Error(err?.message ?? 'Claude Code gave no answer'))
        contexts.set(cwd, { at: Date.now(), text })
        resolve(text)
      })
  })
}

// From a query (strings) or a body: messages and one line for each tool call, unless asked for more.
const shareOpts = (o: Record<string, unknown>): ShareOpts => ({
  tools: o.tools === 'full' ? 'full' : 'line',
  thinking: o.thinking === true || o.thinking === '1',
  redact: o.redact !== false && o.redact !== '0',
})

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const parts = url.pathname.split('/').slice(2) // after /api
  const method = req.method ?? 'GET'
  const [a, id, b, c, d] = parts
  // A request no route answers says which one it was, so its error is of use where it shows.
  const notFound = () => new HttpError(404, `Not found: ${method} ${url.pathname}`)

  // Remote access (server/remote.ts): set up on this machine only, not from the web.
  if (a === 'remote') {
    if (method === 'GET' && !id) return send(res, 200, remoteStatus())
    if (req.headers['x-codinger-remote']) throw new HttpError(403, 'Set up remote access on the machine itself')
    if (method === 'POST' && id === 'link') { const b = await json(req); return send(res, 200, await remoteLink(String(b.name ?? ''), b.hub ? String(b.hub) : undefined)) }
    if (method === 'POST' && id === 'cancel') { remoteCancelLink(); return send(res, 200, remoteStatus()) }
    if (method === 'POST' && id === 'on') { remoteOn(!!(await json(req)).on); return send(res, 200, remoteStatus()) }
    if (method === 'POST' && id === 'forget') { remoteForget(); return send(res, 200, remoteStatus()) }
    if (method === 'POST' && id === 'hub') { remoteHub(String((await json(req)).hub ?? '')); return send(res, 200, remoteStatus()) }
  }

  if (a === 'images' && method === 'GET') {
    const file = imageFile(url.pathname)
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'No such image')
    res.writeHead(200, { 'content-type': `image/${path.extname(file).slice(1).replace('jpg', 'jpeg')}`, 'cache-control': 'max-age=31536000, immutable' })
    fs.createReadStream(file).pipe(res)
    return
  }
  if (a === 'media' && method === 'GET') {
    // Kept by content, so never changes. A page or an SVG is sandboxed: it does not run as Codinger.
    const file = await mediaFile(url.pathname)
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'No such file')
    const kind = mediaKind(file)
    const size = fs.statSync(file).size
    const head = {
      'content-type': mediaType(file), 'x-content-type-options': 'nosniff', 'cache-control': 'max-age=31536000, immutable', 'accept-ranges': 'bytes',
      ...(kind === 'page' ? { 'content-security-policy': 'sandbox allow-scripts allow-popups' } : kind === 'image' || kind === 'file' ? { 'content-security-policy': 'sandbox' } : {}),
      ...(kind === 'file' && mediaType(file) === 'application/octet-stream' ? { 'content-disposition': 'attachment' } : {}),
    }
    return sendFile(req, res, file, size, head)
    return
  }
  if (a === 'tasks') {
    if (!id && method === 'GET') return send(res, 200, allTasks())
    if (id && b === 'log' && method === 'GET') { const f = url.searchParams.get('from'); return send(res, 200, readLog(id, f == null ? undefined : Number(f))) }
    if (id && b === 'search' && method === 'GET') return send(res, 200, searchLog(id, url.searchParams.get('q') ?? ''))
    if (id && b === 'stop' && method === 'POST') return send(res, 200, stopTask(id, 'user'))
    if (id && !b && method === 'DELETE') { removeTask(id); return send(res, 200, { ok: true }) }
  }
  if (a === 'images' && method === 'POST') return send(res, 200, saveImage(String((await json(req)).dataUrl ?? '')))
  if (a === 'artifacts') {
    if (!id && method === 'GET') return send(res, 200, artifactsMsg())
    if (id && b === 'publish' && method === 'POST') {
      const body = await json(req)
      const vis = ['public', 'unlisted', 'private'].includes(body.visibility) ? body.visibility : undefined
      // It runs on; the page follows it in the artifact's publishing.
      try { startPublish(id, { visibility: vis, note: typeof body.note === 'string' ? body.note : undefined, v: Number(body.v) || undefined, replace: body.replace === true }) }
      catch (e) { throw new HttpError(400, (e as Error).message) }
      return send(res, 200, { ok: true })
    }
    // The user closed the notice of a publish that ended.
    if (id && b === 'publishing' && method === 'DELETE') { forgetPublish(id); return send(res, 200, { ok: true }) }
    if (id && b === 'visibility' && method === 'POST') {
      const vis = (await json(req)).visibility
      if (!['public', 'unlisted', 'private'].includes(vis)) throw new HttpError(400, 'visibility: public, unlisted or private')
      try { return send(res, 200, await setVisibility(id, vis)) }
      catch (e) { throw new HttpError(400, (e as Error).message) }
      finally { artifactsChanged() }
    }
  }
  if (a === 'prolifica') {
    // The browser comes back here from approving Codinger on Prolifica.
    if (id === 'callback' && method === 'GET') {
      let err = ''
      try { await connectCallback(url) } catch (e) { err = (e as Error).message }
      artifactsChanged()
      const text = err ? `Codinger could not connect to Prolifica: ${err}` : 'Codinger is connected to Prolifica. You can close this tab.'
      res.writeHead(err ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><meta charset="utf-8"><title>Prolifica</title><body style="font:15px system-ui;padding:40px">${text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}${err ? '' : '<script>setTimeout(()=>close(),1500)</script>'}`)
      return
    }
    if (id === 'connect' && method === 'POST') return send(res, 200, { url: await connectUrl(`http://${req.headers.host}/api/prolifica/callback`) })
    if (!id && method === 'DELETE') { prolificaDisconnect(); artifactsChanged(); return send(res, 200, { ok: true }) }
  }
  if (a === 'restart' && method === 'POST') {
    send(res, 200, { ok: true })
    setTimeout(restart, 100)
    return
  }
  // The update from origin/main (server/update.ts): now, or by an agent in Codinger's own checkout.
  if (a === 'update' && method === 'POST' && id === 'now') return send(res, 200, await updateNow())
  if (a === 'update' && method === 'POST' && id === 'agent') {
    const s = createSession({ cwd: ROOT, title: 'Update Codinger' })
    deliver(s, [{ kind: 'text', text: updatePrompt() }])
    return send(res, 200, s.meta)
  }
  if (a === 'files') {
    const p = url.searchParams.get('path') ?? ''
    const known = trackedFiles().includes(p)
    if (!id && method === 'GET') return send(res, 200, trackedFiles().map((f) => ({
      path: f, builtIn: BUILT_IN().includes(f), exists: fs.existsSync(f), versions: versions(f).length, last: versions(f).at(-1)?.ts ?? null,
    })))
    if (id === 'blame' && method === 'GET') { if (!known) throw new HttpError(404, 'Not a tracked file'); return send(res, 200, blame(p)) }
    if (!id && method === 'PUT') {
      if (!known) throw new HttpError(404, 'Not a tracked file')
      const body = await json(req)
      if (typeof body.text !== 'string') throw new HttpError(400, 'text must be a string')
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body.text)
      recordVersion(p, { kind: 'settings' })
      return send(res, 200, blame(p))
    }
    if (id === 'track' && method === 'POST') {
      const f = path.resolve(expandHome(String((await json(req)).path ?? '').trim()))
      if (!f || f === '/') throw new HttpError(400, 'Give a file path')
      if (!trackedFiles().includes(f)) { settings = { ...settings, trackedFiles: [...(settings.trackedFiles ?? []), f] }; saveSettings(settings) }
      recordVersion(f, { kind: 'initial' })
      return send(res, 200, { path: f })
    }
    if (id === 'track' && method === 'DELETE') {
      settings = { ...settings, trackedFiles: (settings.trackedFiles ?? []).filter((f) => f !== p) }
      saveSettings(settings)
      return send(res, 200, { ok: true })
    }
    throw notFound()
  }
  if (a === 'agents-md' && method === 'GET') return send(res, 200, { path: AGENTS_FILE, text: readAgentsMd() })
  if (a === 'agents-md' && method === 'PUT') {
    const body = await json(req)
    if (typeof body.text !== 'string') throw new HttpError(400, 'text must be a string')
    writeAgentsMd(body.text)
    recordVersion(AGENTS_FILE, { kind: 'settings' })
    return send(res, 200, { path: AGENTS_FILE, text: body.text })
  }
  if (a === 'settings' && method === 'PUT') {
    const body = await json(req)
    settings = {
      ...settings,
      ...(typeof body.leadAutoSend === 'boolean' ? { leadAutoSend: body.leadAutoSend } : {}),
      ...(typeof body.selfRestart === 'boolean' ? { selfRestart: body.selfRestart } : {}),
      ...(typeof body.resumeCut === 'boolean' ? { resumeCut: body.resumeCut } : {}),
      ...(['ask', 'always', 'never'].includes(body.autoUpdate) ? { autoUpdate: body.autoUpdate } : {}),
      ...(body.appearance ? { appearance: cleanAppearance(body.appearance) } : {}),
      ...(Array.isArray(body.groupOrder) ? { groupOrder: body.groupOrder.map(String) } : {}),
      ...(Array.isArray(body.groups) ? { groups: body.groups.filter((g: any) => g && g.id).map((g: any) => ({ id: String(g.id), name: String(g.name ?? '').trim() || 'Group' })) } : {}),
      ...(Number.isFinite(body.cacheGuard) && body.cacheGuard >= 0 ? { cacheGuard: Math.round(body.cacheGuard) } : {}),
      ...(typeof body.notes === 'boolean' ? { notes: body.notes } : {}),
      ...(typeof body.estimates === 'boolean' ? { estimates: body.estimates } : {}),
      ...(Number.isFinite(body.keepWarmHours) && body.keepWarmHours >= 0 ? { keepWarmHours: Math.min(48, body.keepWarmHours) } : {}),
      ...(Number.isFinite(body.keepWarmMax) && body.keepWarmMax > 0 ? { keepWarmMax: Math.round(body.keepWarmMax) } : {}),
      ...(Number.isFinite(body.keepWarmUsage) && body.keepWarmUsage > 0 ? { keepWarmUsage: Math.min(100, body.keepWarmUsage) } : {}),
      ...(typeof body.mcpStartOff === 'boolean' ? { mcpStartOff: body.mcpStartOff } : {}),
      ...(typeof body.mcpClaude === 'boolean' ? { mcpClaude: body.mcpClaude } : {}),
      ...(Array.isArray(body.mcpAlways) ? { mcpAlways: body.mcpAlways.map(String) } : {}),
      ...(body.plan && Number.isFinite(body.plan.usd) && body.plan.usd >= 0 ? { plan: { tier: String(body.plan.tier ?? ''), usd: body.plan.usd, ...(body.plan.yearly ? { yearly: true } : {}) } } : {}),
      ...(body.reviewSeen ? { reviewSeen: { ...settings.reviewSeen, ...Object.fromEntries(['week', 'month'].filter((k) => typeof body.reviewSeen[k] === 'string').map((k) => [k, body.reviewSeen[k]])) } } : {}),
    }
    saveSettings(settings)
    broadcast({ type: 'settings', settings })
    if (body.autoUpdate) updateModeChanged()
    return send(res, 200, settings)
  }
  // What the usage meter has measured, to see how steady its estimate is.
  // What a new session in a folder starts with, by category.
  // Your MCP servers in a folder, found by a probe (server/mcpservers.ts).
  // Add a server with `claude mcp add` (the form in the MCP dialog); the page then looks for servers again.
  if (a === 'mcp' && id === 'add' && method === 'POST') {
    const body = await json(req)
    const cwd = path.resolve(expandHome(String(body.cwd ?? '~')))
    const name = String(body.name ?? '').trim(), target = String(body.target ?? '').trim()
    const transport = ['http', 'sse', 'stdio'].includes(body.transport) ? body.transport as string : 'http'
    const scope = ['local', 'project', 'user'].includes(body.scope) ? body.scope as string : 'local'
    if (!/^[\w.-]+$/.test(name)) throw new HttpError(400, 'Give the server a name of letters, digits, ".", "-" or "_"')
    if (!target) throw new HttpError(400, transport === 'stdio' ? 'Give the command that starts the server' : 'Give the URL of the server')
    const lines = (x: unknown) => Array.isArray(x) ? x.map((l) => String(l).trim()).filter(Boolean) : []
    const opts = transport === 'stdio' ? lines(body.env).flatMap((e) => ['-e', e]) : lines(body.headers).flatMap((h) => ['-H', h])
    const args = ['mcp', 'add', '-t', transport, '-s', scope, name, ...opts, '--', ...(transport === 'stdio' ? splitArgs(target) : [target])]
    await new Promise<void>((resolve, reject) => execFile(CLAUDE, args, { cwd, env: childEnv(), timeout: 30_000, windowsHide: true }, (err, _out, errOut) =>
      err ? reject(new HttpError(400, String(errOut).trim() || err.message)) : resolve()))
    return send(res, 200, { ok: true })
  }
  // Remove a server you added with Claude Code (not a claude.ai connector) with `claude mcp remove`.
  if (a === 'mcp' && id === 'remove' && method === 'POST') {
    const body = await json(req)
    const cwd = path.resolve(expandHome(String(body.cwd ?? '~')))
    const name = String(body.name ?? '').trim()
    if (!['local', 'project', 'user'].includes(body.scope)) throw new HttpError(400, 'Claude Code can remove only a server added in this folder, this project or all folders')
    if (!name) throw new HttpError(400, 'No server name')
    await new Promise<void>((resolve, reject) => execFile(CLAUDE, ['mcp', 'remove', '-s', body.scope, name], { cwd, env: childEnv(), timeout: 30_000, windowsHide: true }, (err, _out, errOut) =>
      err ? reject(new HttpError(400, String(errOut).trim() || err.message)) : resolve()))
    return send(res, 200, { ok: true })
  }
  if (a === 'mcp' && method === 'GET') return send(res, 200, serversFor(path.resolve(expandHome(url.searchParams.get('cwd') || '~'))).map(({ config: _, ...x }) => x))
  if (a === 'mcp' && method === 'POST') {
    const cwd = path.resolve(expandHome(String((await json(req)).cwd ?? '~')))
    let found
    try { found = await probe(cwd) } catch (e) { throw new HttpError(500, (e as Error).message) }
    // Sessions there stop asking, and get the configs of servers turned on before Codinger knew them.
    for (const x of sessions.values()) if (x.meta.cwd === cwd && x.meta.mcp) {
      delete x.meta.mcp.missing
      if (x.meta.mcp.on.length) x.setMcp(configsFor(cwd, x.meta.mcp.on))
    }
    metaChanged()
    return send(res, 200, found)
  }
  if (a === 'context' && method === 'GET') {
    const cwd = path.resolve(expandHome(url.searchParams.get('cwd') || '~'))
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new HttpError(400, `Not a directory: ${cwd}`)
    try { return send(res, 200, { cwd, text: await startContext(cwd, url.searchParams.get('fresh') === '1') }) } catch (e) { throw new HttpError(500, (e as Error).message) }
  }
  // Your plan, and day-by-day spend at API prices, for the cost view (shared/costs.ts).
  if (a === 'costs' && method === 'GET') return send(res, 200, await costs.reply())
  // Estimates in agent time and dollars, next to what the work took (server/estimates.ts).
  if (a === 'estimates' && method === 'GET') return send(res, 200, estimatesReply((sid) => sessions.get(sid)?.meta.title))
  // Tokens and spend by conversation and folder, from Codinger's copy of the transcripts (shared/usage.ts).
  if (a === 'usage' && method === 'GET') {
    const title = (id: string) => sessions.get(id)?.meta.title ?? null
    if (id === 'ledger') {
      let sums: Record<string, string> | undefined
      try { sums = JSON.parse(url.searchParams.get('sums') ?? 'null') ?? undefined } catch {}
      return send(res, 200, usageLedger.ledger(title, Number(url.searchParams.get('after')) || 0, sums))
    }
    if (id === 'sync') { await usageLedger.sync(); return send(res, 200, usageLedger.reply(title)) }
    return send(res, 200, usageLedger.reply(title))
  }
  if (a === 'meter' && method === 'GET') return send(res, 200, { rate: meter.rate(), five: meter.pairs('five'), seven: meter.pairs('seven') })
  if (a === 'history' && !id && method === 'GET') {
    const byClaude = new Map(metas().map((m) => [m.claudeSessionId, m.id]))
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const items = listHistory()
      .filter((h) => !h.continuedIn && !h.cwd.startsWith(DATA))
      .filter((h) => !q || `${h.title} ${h.cwd} ${h.firstPrompt} ${h.lastPrompt}`.toLowerCase().includes(q))
      .slice(0, 300)
      .map((h) => ({ ...h, codingerId: byClaude.get(h.id) ?? null }))
    return send(res, 200, items)
  }
  if (a === 'history' && id && b === 'resume' && method === 'POST') return send(res, 200, resumeHistory(id).meta)
  if (a === 'recent-dirs' && method === 'GET') {
    const seen = new Map<string, { path: string; ts: number; source: string }>()
    const add = (p: string, ts: number, source: string) => {
      if (p.startsWith(DATA)) return
      const cur = seen.get(p)
      if (!cur || cur.ts < ts) seen.set(p, { path: p, ts, source: cur && cur.source !== source ? 'both' : source })
    }
    for (const m of metas()) if (m.kind === 'worker') add(m.cwd, m.lastActivity, 'codinger')
    for (const h of listHistory()) add(h.cwd, h.mtime, 'claude')
    const dirs = [...seen.values()].filter((d) => fs.existsSync(d.path)).sort((x, y) => y.ts - x.ts).slice(0, 60)
    return send(res, 200, dirs)
  }
  if (a === 'fs' && id === 'dirs' && method === 'GET') {
    const p = expandHome(url.searchParams.get('path') || '~')
    try { return send(res, 200, listDirs(p, url.searchParams.get('hidden') === '1')) } catch { throw new HttpError(400, `Can't read ${p}`) }
  }
  if (a === 'fs' && id === 'stat' && method === 'GET') {
    const p = path.resolve(expandHome((url.searchParams.get('path') || '').trim() || '~'))
    let kind: 'dir' | 'file' | 'missing' = 'missing'
    try { kind = fs.statSync(p).isDirectory() ? 'dir' : 'file' } catch {}
    return send(res, 200, { path: p, kind })
  }
  if (a === 'fs' && id === 'exists' && method === 'POST') {
    // Paths named in a reply (absolute, ~/, or under the session's directory, maybe with :line): which are there.
    const body = await json(req)
    const cwd = expandHome(String(body.cwd ?? '~'))
    const out: Record<string, string | null> = {}
    for (const p of (Array.isArray(body.paths) ? body.paths : []).slice(0, 200).map(String)) {
      const abs = path.resolve(cwd, expandHome(p.replace(/(:\d+){1,2}$/, '')))
      out[p] = fs.existsSync(abs) ? abs : null
    }
    return send(res, 200, out)
  }
  if (a === 'fs' && id === 'upload' && method === 'POST') {
    // A file you attached to a message, put in the session's directory as it is (the raw
    // body); a name already there gets " (2)". The message then names the file (shared/files.ts).
    const dir = path.resolve(expandHome(url.searchParams.get('dir') ?? ''))
    const want = path.basename(url.searchParams.get('name') ?? '').replace(/[\x00-\x1f/\\:`]/g, '_').trim() || 'file'
    fs.mkdirSync(dir, { recursive: true })
    const ext = path.extname(want), stem = want.slice(0, want.length - ext.length) || want
    let name = want
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem} (${n})${ext}`
    const file = path.join(dir, name)
    const out = fs.createWriteStream(file, { flags: 'wx' })
    let size = 0
    try {
      for await (const c of req) {
        size += c.length
        if (size > 2_000_000_000) throw new HttpError(413, 'Files over 2 GB do not upload')
        if (!out.write(c)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => e ? j(e) : r()))
    } catch (e) { out.destroy(); fs.rmSync(file, { force: true }); throw e }
    return send(res, 200, { name, size })
  }
  if (a === 'fs' && id === 'reveal' && method === 'POST') {
    // A folder opens in Finder; a file is shown selected in its folder.
    const p = path.resolve(expandHome(String((await json(req)).path ?? '')))
    if (!fs.existsSync(p)) throw new HttpError(404, `There is no ${p}`)
    const dir = fs.statSync(p).isDirectory()
    if (process.platform === 'darwin') execFile('open', dir ? [p] : ['-R', p])
    else execFile('xdg-open', [dir ? p : path.dirname(p)])
    return send(res, 200, { ok: true })
  }
  if (a === 'fs' && id === 'pick' && method === 'POST') {
    if (process.platform !== 'darwin') throw new HttpError(400, 'The native folder picker is macOS-only')
    const start = (await json(req)).path
    const def = start && fs.existsSync(expandHome(start)) ? ` default location (POSIX file "${expandHome(start).replace(/["\\]/g, '')}")` : ''
    const picked = await new Promise<string | null>((resolve) => {
      execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "Choose a folder for the Claude session"${def})`], { timeout: 600_000 },
        (err, out) => resolve(err ? null : out.trim().replace(/\/$/, '') || null))
    })
    return send(res, 200, { path: picked })
  }
  if (a === 'runs' && id && method === 'POST') {
    // A command run from a <run> block ended (the Terminal script calls this).
    const run = runs.get(id)
    if (!run) throw new HttpError(404, 'No such run')
    runs.delete(id)
    let out = ''
    try { out = fs.readFileSync(run.log, 'utf8'); fs.rmSync(run.log, { force: true }) } catch { /* nothing recorded */ }
    // eslint-disable-next-line no-control-regex
    // Progress output redraws a line with \r: keep what each line ended as.
    const tail = out.replace(/\x1b\[[\d;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x04|\x08/g, '').replace(/^\^D/, '')
      .split('\n').map((l) => l.replace(/\r+$/, '').split('\r').pop()!).join('\n')
      .trimEnd().split('\n').slice(-20).join('\n').slice(-3000)
    broadcast({ type: 'run', sessionId: run.sid, token: id, code: Number(url.searchParams.get('code') ?? -1), tail })
    return send(res, 200, { ok: true })
  }
  if (a === 'login' && method === 'POST') {
    if (!id) startLogin()
    else if (id === 'code') { try { submitCode(String((await json(req)).code ?? '')) } catch (e) { throw new HttpError(400, (e as Error).message) } }
    else if (id === 'cancel') cancelLogin()
    else throw notFound()
    return send(res, 200, authState())
  }
  // Send the lead's drafts to every worker where nothing else holds them.
  if (a === 'lead' && id === 'send-drafts' && method === 'POST') {
    const sent: string[] = [], held: { id: string; title: string; why: string[] }[] = []
    for (const s of sessions.values()) {
      if (s.meta.kind !== 'worker' || s.meta.archived || !s.meta.inbox.length) continue
      const why = holdReasons(s, false, true)
      if (why.length) held.push({ id: s.meta.id, title: s.meta.title, why })
      else { flushInbox(s); sent.push(s.meta.id) }
    }
    return send(res, 200, { sent, held })
  }
  if (a === 'lead' && id === 'reset' && method === 'POST') {
    get(LEAD_ID).forget('Fresh start: the lead forgot this conversation. It keeps LEAD_NOTES.md.')
    return send(res, 200, { ok: true })
  }
  if (a !== 'sessions') throw notFound()

  if (!id && method === 'POST') return send(res, 200, createSession(await json(req)).meta)
  // The sidebar's order for a set of siblings, top first.
  if (id === 'order' && method === 'PUT') {
    const { ids } = await json(req)
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list')
    ids.forEach((x, i) => { const m = sessions.get(String(x))?.meta; if (m) m.order = i })
    metaChanged()
    return send(res, 200, { ok: true })
  }
  // Back to the default order: folders and sessions by latest activity.
  if (id === 'order' && method === 'DELETE') {
    for (const x of sessions.values()) delete x.meta.order
    settings = { ...settings, groupOrder: [] }
    saveSettings(settings)
    broadcast({ type: 'settings', settings })
    metaChanged()
    return send(res, 200, { ok: true })
  }
  const s = get(id)
  if (!b && method === 'PATCH') {
    const body = await json(req)
    if (typeof body.title === 'string' && body.title.trim()) {
      // Undo of Claude's rename: remember the name undone, so Claude doesn't offer it again.
      if (body.undo && s.meta.titleBefore != null) s.meta.titleUndone = s.meta.title
      s.meta.title = body.title.trim()
      s.meta.titleByUser = true
      s.meta.titleBefore = undefined
    }
    // Into another sidebar group (null: none), with the sessions it started that were in its old one.
    if ((typeof body.group === 'string' || body.group === null) && s.meta.kind === 'worker') {
      const from = s.meta.group, to = body.group || undefined
      const move = (m: SessionMeta) => {
        m.group = to
        for (const c of sessions.values()) if (c.meta.parentId === m.id && c.meta.group === from) move(c.meta)
      }
      move(s.meta)
    }
    if (typeof body.starred === 'boolean' && s.meta.kind === 'worker') s.meta.starred = body.starred || undefined
    if (typeof body.archived === 'boolean' && s.meta.kind === 'worker') { s.meta.archived = body.archived; if (body.archived) s.stop() }
    if (MODES.includes(body.permissionMode)) {
      s.setPermissionMode(body.permissionMode)
      if (!AUTOPILOT_MODES.includes(body.permissionMode)) endAutopilot(s, 'you changed the permission mode')
    }
    metaChanged()
    return send(res, 200, s.meta)
  }
  if (!b && method === 'DELETE') {
    if (s.meta.kind !== 'worker') throw new HttpError(400, 'The lead session cannot be deleted')
    s.stop()
    sessions.delete(id)
    forgetAsks(id)
    deleteEvents(id)
    metaChanged()
    return send(res, 200, { ok: true })
  }
  if (b === 'events' && method === 'GET') return send(res, 200, s.getEvents())
  // Its transcript, published read-only (server/share.ts): what would go, and taking it down.
  if (b === 'share' && method === 'GET') {
    const { paths, ...preview } = buildShare(s.meta, s.getEvents(), settings, shareOpts(Object.fromEntries(url.searchParams)))
    return send(res, 200, preview)
  }
  if (b === 'share' && method === 'DELETE') {
    if (s.meta.share) await unpublishShare(s.meta.share)
    delete s.meta.share
    metaChanged()
    return send(res, 200, s.meta)
  }
  if (b === 'commands' && method === 'GET') return send(res, 200, commands.get(id) ?? lastCommands)
  if (b === 'mcp' && method === 'GET') {
    return send(res, 200, { servers: serversFor(s.meta.cwd), on: s.meta.mcp?.on ?? null })
  }
  if (b === 'fs' && method === 'GET') {
    // A folder or a file for the Files pane (server/files.ts): a folder's entries, or a file's size.
    const abs = allowed(s.meta, s.getEvents(), url.searchParams.get('path') || '.')
    let st: fs.Stats | null = null
    try { st = abs ? fs.statSync(abs) : null } catch {}
    if (!abs || !st) throw new HttpError(404, 'No such file, or not one this session can show')
    if (st.isDirectory()) return send(res, 200, { path: abs, kind: 'dir', entries: await listDir(abs) })
    return send(res, 200, { path: abs, kind: 'file', size: st.size, mtime: st.mtimeMs })
  }
  if (b === 'find' && method === 'GET') return send(res, 200, await findFiles(path.resolve(s.meta.cwd), url.searchParams.get('q') ?? ''))
  if (b === 'uncommitted' && method === 'GET') return send(res, 200, { files: await uncommitted(s.meta.cwd) })
  if (b === 'diff' && method === 'GET') {
    const abs = allowed(s.meta, s.getEvents(), url.searchParams.get('path') || '')
    if (!abs || !fs.existsSync(abs)) throw new HttpError(404, 'No such file, or not one this session can show')
    const d = await diffOf(abs)
    if (d.status !== 'changed' && d.status !== 'new') return send(res, 200, d)
    await refresh(s.meta.cwd)
    let real = abs
    try { real = fs.realpathSync(abs) } catch {}
    const who = await whoChanged(real)
    // The sessions that changed it with a shell command only have no edits, but a name.
    const authors = await authorsOf(abs)
    for (const id of new Set([...Object.values(who?.add ?? {}), ...Object.values(who?.del ?? {})])) {
      const o = sessions.get(id)
      if (o && !authors.some((a) => a.id === id)) authors.push({ id, title: o.meta.title, edits: [] })
    }
    return send(res, 200, { ...d, authors, who })
  }
  if (b === 'file' && method === 'GET') {
    // A file in the session's directory (one you attached: name), or one the Files pane opens
    // (path: see server/files.ts), to show in the browser. Sandboxed, so a page among them does
    // not run as Codinger; run=1 lets a page run its scripts, still in the sandbox. The address
    // can end in the file's name (file/<name>), for the tab's title. Text of any kind comes as
    // text/plain, so a new tab shows it instead of saving it.
    const p = url.searchParams.get('path')
    const file = p != null ? allowed(s.meta, s.getEvents(), p) : path.resolve(s.meta.cwd, url.searchParams.get('name') ?? '')
    if (!file || (p == null && (!file.startsWith(path.resolve(s.meta.cwd) + path.sep) || isSecret(file))) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'No such file')
    const kind = mediaKind(file)
    const type = kind === 'file' ? (isText(file) ? 'text/plain; charset=utf-8' : typeOf(file)) : mediaType(file)
    const csp = kind === 'pdf' ? null : kind === 'page' && url.searchParams.get('run') === '1' ? 'sandbox allow-scripts allow-popups' : 'sandbox'
    return sendFile(req, res, file, fs.statSync(file).size, {
      'content-type': type.startsWith('text/') && !type.includes('charset') ? `${type}; charset=utf-8` : type,
      ...(csp ? { 'content-security-policy': csp } : {}), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'accept-ranges': 'bytes',
      ...(type === 'application/octet-stream' ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` } : {}),
    })
  }
  if (b === 'notes' && !c && method === 'GET') return send(res, 200, { path: notesPath(s.meta), text: readNotes(s.meta) })
  if (b === 'autopilot' && method === 'DELETE') { endAutopilot(s, 'you turned it off'); return send(res, 200, s.meta) }
  if (method !== 'POST') throw notFound()
  const body = await json(req)
  // A message you send to an archived session takes it out of the archive.
  const reopen = (s: Session) => { if (s.meta.archived) { s.meta.archived = false; metaChanged() } }
  switch (b) {
    case 'send': {
      let p: Part[] = Array.isArray(body.parts) ? body.parts : []
      // An item marked critical needs a comment with text, or Done, before anything goes (a page with old code may not check).
      const missing = criticalUnanswered(s.getEvents(), p)
      if (missing.length) throw new HttpError(409, `Comment on the critical item first: "${missing[0].label.slice(0, 80)}"`)
      // Messages from other sessions that waited on it go in with this one.
      if (s.meta.pendingCritical) p = [...p, ...takeMail(s)]
      // The lead's drafts that went with your reply.
      if (Array.isArray(body.inbox) && body.inbox.length) { s.meta.inbox = s.meta.inbox.filter((i) => !body.inbox.includes(i.id)); metaChanged() }
      reopen(s)
      // A message after an ask on the phone takes a note that names the ask.
      const h = hiddenFor(s, p), a = answered(s.meta.id)
      s.send(p, a ? { ...h, hidden: [a, h.hidden].filter(Boolean).join('\n\n') } : h)
      userWrote(s)
      return send(res, 200, { ok: true })
    }
    // Your OK for a message another session sent, held past the limit; or send: false to drop it.
    case 'mail':
      try { release(s, String(c), body.send !== false) } catch (e) { throw new HttpError(404, (e as Error).message) }
      return send(res, 200, { ok: true })
    case 'drafting':
      if (s.meta.drafting !== !!body.on) { s.meta.drafting = !!body.on; metaChanged() }
      return send(res, 200, { ok: true })
    case 'rewind': {
      // Delete from a message on; with parts, send them in its place (an edit).
      try { s.rewind(Number(body.seq)) } catch (e) { throw new HttpError(400, (e as Error).message) }
      const p: Part[] = Array.isArray(body.parts) ? body.parts : []
      if (p.length) { reopen(s); s.send(p, hiddenFor(s, p)) }
      return send(res, 200, { ok: true })
    }
    case 'run': {
      // A command Claude asked you to run, opened in a new Terminal window in the session's
      // directory. A .command file opens in the default terminal app and needs no Automation permission.
      const cmd = String(body.command ?? '').trim()
      if (!cmd) throw new HttpError(400, 'No command')
      if (process.platform === 'win32') return send(res, 200, { token: runWindows(s.meta.id, s.meta.cwd, cmd) })
      if (process.platform !== 'darwin') throw new HttpError(400, 'Run in Terminal is macOS and Windows only')
      // `script` keeps the terminal interactive and records what the command prints; when the
      // command ends, the script reports its exit code back, and the result goes to the item.
      const token = randomUUID().slice(0, 12)
      const file = path.join(os.tmpdir(), `codinger-${token}.command`)
      const log = path.join(os.tmpdir(), `codinger-${token}.log`)
      const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
      const closer = path.join(os.tmpdir(), `codinger-${token}-close.sh`)
      fs.writeFileSync(closer, CLOSER, { mode: 0o755 })
      runs.set(token, { sid: s.meta.id, log })
      fs.writeFileSync(file, [
        '#!/bin/sh', 'rm -f "$0"', `cd ${q(s.meta.cwd)} || exit 1`,
        `cat <<'CODINGER_CMD'`, `$ ${cmd}`, 'CODINGER_CMD',
        `script -q ${q(log)} /bin/sh -c ${q(cmd)}`, 'code=$?',
        `curl -s -m 5 -X POST "http://127.0.0.1:${PORT}/api/runs/${token}?code=$code" >/dev/null 2>&1`,
        // On success the window closes itself a moment after the shell ends (found by its tty);
        // on failure it stays, so you can read what went wrong.
        'if [ $code -eq 0 ]; then', '  echo; echo "Done. This window closes."',
        `  nohup sh ${q(closer)} "$(tty)" >/dev/null 2>&1 &`, `else rm -f ${q(closer)}`, 'fi',
        'exit $code', '',
      ].join('\n'), { mode: 0o755 })
      execFile('open', [file], (err) => { if (err) console.error('open', err.message) })
      return send(res, 200, { token })
    }
    case 'command':
      if (!/^\/[\w:.-]+/.test(body.cmd ?? '')) throw new HttpError(400, 'Not a slash command')
      s.command(body.cmd)
      return send(res, 200, { ok: true })
    case 'mcp': {
      // Turn one of your MCP servers on or off in a session that started with them off.
      const m = s.meta
      if (!m.mcp) throw new HttpError(400, 'This session started with all your MCP servers on')
      const name = String(body.name ?? '')
      m.mcp.on = body.on ? [...new Set([...m.mcp.on, name])] : m.mcp.on.filter((n) => n !== name)
      s.setMcp(configsFor(m.cwd, m.mcp.on))
      metaChanged()
      return send(res, 200, { on: m.mcp.on })
    }
    case 'notes': {
      // Write the notes now; keep-warm on again; or a new session that starts from them.
      if (c === 'keep-warm') { resumeKeepWarm(s.meta); return send(res, 200, { ok: true }) }
      if (c === 'continue') {
        if (!readNotes(s.meta)) throw new HttpError(400, 'This session has no notes yet')
        const n = createSession({ cwd: s.meta.cwd, title: `${s.meta.title} (continued)`, model: s.meta.model, permissionMode: s.meta.permissionMode, flags: s.meta.flags, parentId: s.meta.parentId, group: s.meta.group })
        return send(res, 200, { meta: n.meta, text: `Read \`${notesFile(s.meta.id)}\`: notes from an earlier session. Continue the work from there.` })
      }
      const err = notesNow(s, !!body.force)
      if (err) throw new HttpError(err === 'cold' ? 409 : 400, err === 'cold' ? 'The prompt cache has expired or is about to' : err)
      return send(res, 200, { ok: true })
    }
    case 'interrupt': endAutopilot(s, 'you stopped it'); s.interrupt(); return send(res, 200, { ok: true })
    case 'autopilot': {
      // Start, or start again with a new goal and budget. A session between turns goes on now.
      if (s.meta.kind !== 'worker') throw new HttpError(400, 'Only a worker session can run on autopilot')
      if (!String(body.goal ?? '').trim() && !s.getEvents().some((e) => e.t === 'user')) throw new HttpError(400, 'Give a goal: this session has no task yet')
      try { s.meta.autopilot = startAutopilot(s.meta, body, usage) } catch (e) { throw new HttpError(400, (e as Error).message) }
      metaChanged()
      if (!busy(s)) goOn(s)
      return send(res, 200, s.meta)
    }
    case 'share':
      s.meta.share = await publishShare(s.meta, s.getEvents(), settings, shareOpts(body))
      metaChanged()
      return send(res, 200, s.meta)
    case 'seen': s.markSeen(); return send(res, 200, { ok: true })
    case 'unread': s.markUnread(); return send(res, 200, { ok: true })
    case 'permission':
      s.answerPermission(String(body.requestId), body.decision, body.message)
      return send(res, 200, { ok: true })
    case 'inbox':
      if (d === 'dismiss') { s.meta.inbox = s.meta.inbox.filter((i) => i.id !== c); metaChanged(); return send(res, 200, { ok: true }) }
      // Your edit of one of the lead's drafts.
      if (d === 'edit') {
        const i = s.meta.inbox.find((x) => x.id === c)
        if (!i) throw new HttpError(404, 'No such draft')
        if (typeof body.text === 'string') i.text = body.text
        if (Array.isArray(body.choices)) i.choices = body.choices.map(String)
        metaChanged()
        return send(res, 200, { ok: true })
      }
  }
  throw notFound()
}

const server = http.createServer(async (req, res) => {
  try {
    if (!localHost(req) || !localOrigin(req)) throw new HttpError(403, 'Codinger only answers requests from its own page')
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname === `/mcp/${MCP_TOKEN}`) {
      const lead = [...sessions.values()].find((s) => s.meta.kind === 'lead')
      return await handleMcp(req, res, lead ? [...tools, lookTool(lead.meta.id)] : tools)
    }
    const look = url.pathname.startsWith(`/mcp/${MCP_TOKEN}/look/`) && url.pathname.split('/').pop()
    if (look && sessions.has(look)) return await handleMcp(req, res, [lookTool(look), titleTool(look), claimTool(look), mcpTool(look), artifactTool(look), fileTool(look), ...(settings.estimates !== false ? [spendTool(look), ...estimateTools(look, () => get(look).meta)] : []), ...taskTools(look), ...mailTools(look), ...askTools(look)])
    // The web UI asks this first; here it is a machine's own page.
    if (url.pathname === '/_remote/whoami') return send(res, 200, { web: false })
    if (url.pathname.startsWith('/api/remote/m/') || url.pathname.startsWith('/api/remote/machines') || /^\/api\/remote\/push\/(key|subscribe|unsubscribe)$/.test(url.pathname)) return await remoteProxy(req, res, url)
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    if (vite) return vite.middlewares(req, res)
    serveStatic(url.pathname, res, req.headers['x-codinger-remote'] ? `/m/${remoteName()}` : '')
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e) })
  }
})

const DIST = path.join(ROOT, 'dist')
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
// base: where the browser sees this machine's files, when the hub passes its page through
// (/m/<name>, vite.config.ts): the page's root paths go under it, and so do its scripts' loads.
function serveStatic(p: string, res: http.ServerResponse, base = '') {
  let file = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''))
  const missing = !file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()
  // A build since the page loaded removed its old files: a 404, not the page, which no import can use.
  if (missing && p.startsWith('/assets/')) { res.writeHead(404).end(); return }
  if (missing) file = path.join(DIST, 'index.html')
  if (!fs.existsSync(file)) { res.writeHead(500).end('Run `npm run build` first, or start with --dev.'); return }
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream'
  if (base && type === 'text/html') {
    const html = fs.readFileSync(file, 'utf8').replaceAll('"/assets/', `"${base}/assets/`).replace('<head>', `<head><script>window.__base=${JSON.stringify(base + '/')}</script>`)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(html)
    return
  }
  res.writeHead(200, { 'content-type': type })
  fs.createReadStream(file).pipe(res)
}

// ---- websocket --------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/api/remote/m/')) {
    if (!localHost(req) || !localOrigin(req)) { socket.destroy(); return }
    return remoteUpgrade(req, socket, head)
  }
  if (req.url !== '/ws') return // Vite's HMR socket has its own listener
  if (!localHost(req) || !localOrigin(req)) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
    ws.send(JSON.stringify({ type: 'hello', sessions: metas(), settings, usage, platform: process.platform, home: os.homedir(), auth: authState(), stale, staleAt, update: updateStatus(), remote: remoteStatus(), device: deviceType() } satisfies ServerMsg))
    ws.send(JSON.stringify({ type: 'tasks', tasks: allTasks() } satisfies ServerMsg))
    ws.send(JSON.stringify(artifactsMsg()))
  })
})

let vite: { middlewares: (req: http.IncomingMessage, res: http.ServerResponse) => void } | null = null
if (DEV) {
  const { createServer } = await import('vite')
  vite = await createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  })
}

// A missing or expired login starts a sign-in; once signed in, what failed goes again.
// Files whose history is kept: the notes every session reads, and any you add in Settings.
const BUILT_IN = () => [AGENTS_FILE, path.join(os.homedir(), '.claude', 'CLAUDE.md'), LEAD_NOTES]
moveHistory(OLD_LEAD_NOTES, LEAD_NOTES)
// A file, or the part that the request asks for: video and audio ask for parts (Safari plays
// nothing without them), and the Files pane asks for the first part of a long text file. An
// open-ended part is at most MEDIA_PART: through web.codinger.app, a whole answer is one WebSocket message.
function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, size: number, head: Record<string, string>) {
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (r && (r[1] || r[2])) {
    const start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]))
    const end = Math.min(r[1] && r[2] ? Number(r[2]) : size - 1, size - 1, start + MEDIA_PART - 1)
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...head, 'content-length': size })
  fs.createReadStream(file).pipe(res)
}

const trackedFiles = () => [...new Set([...BUILT_IN(), ...(settings.trackedFiles ?? [])])]
initFileHistory({
  files: trackedFiles,
  sessions: () => [...sessions.values()].map((s) => ({
    sid: s.meta.id, title: s.meta.title, csid: s.meta.claudeSessionId,
    seqOf: (toolUseId: string) => s.getEvents().find((e) => e.t === 'assistant' && e.blocks.some((b) => b.type === 'tool_use' && b.id === toolUseId))?.seq ?? null,
  })),
  changed: (p) => broadcast({ type: 'file', path: p }),
})

initAuth({
  change: (auth) => broadcast({ type: 'auth', auth }),
  signedIn: () => { for (const s of sessions.values()) s.retryAfterSignIn((p) => hiddenFor(s, p)) },
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codinger on http://localhost:${PORT}${DEV ? ' (dev)' : ''}`)
  startRemote(PORT, artifactsPort, (remote) => broadcast({ type: 'remote', remote }))
  startUpdates({ root: ROOT, mode: () => settings.autoUpdate ?? 'ask', busy: () => [...sessions.values()].some(busy), restart, onChange: (update) => broadcast({ type: 'update', update }) })
  findDevice((device) => broadcast({ type: 'device', device }))
  void backfillActive((sid) => sessions.get(sid)?.meta.claudeSessionId).catch(() => {})
})

// ---- restarting itself --------------------------------------------------------
// When the server's own code on disk is newer than this process, the page offers
// a restart: a new server starts detached (its log in ~/.codinger/server.log) as
// soon as this one has let go of the port. Busy sessions keep running (server/proc.ts).
const STARTED = Date.now()
function codeTime(): number {
  let t = 0
  for (const d of ['server', 'shared']) for (const f of fs.readdirSync(path.join(ROOT, d))) {
    if (f.endsWith('.ts')) t = Math.max(t, fs.statSync(path.join(ROOT, d, f)).mtimeMs)
  }
  return Math.max(t, fs.statSync(path.join(ROOT, 'package.json')).mtimeMs)
}
let stale = false
let staleAt = 0  // the time of the newest code: a newer change shows a hidden banner again
setInterval(() => {
  let t = staleAt
  try { t = codeTime() } catch { /* a file mid-save */ }
  const now = t > STARTED
  if (now !== stale || (now && t !== staleAt)) { stale = now; staleAt = now ? t : 0; broadcast({ type: 'stale', stale, staleAt }) }
}, 5000).unref()

function restart() {
  if (process.platform === 'win32') return restartWindows()
  const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
  const log = q(path.join(DATA, 'server.log'))
  // The built UI is rebuilt first when not serving it through Vite.
  const cmd = `sleep 1; ${DEV ? '' : `npx vite build >> ${log} 2>&1 && `}exec ${[process.execPath, ...process.argv.slice(1)].map(q).join(' ')} >> ${log} 2>&1`
  spawn('sh', ['-c', cmd], { cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore' }).unref()
  shutdown()
}

// No sh on Windows: a small node process waits for this one to go, then starts the new one.
function restartWindows() {
  const args = [path.join(DATA, 'server.log'), DEV, process.cwd(), process.execPath, ...process.argv.slice(1)]
  spawn(process.execPath, [path.join(ROOT, 'server', 'restart-windows.ts'), JSON.stringify(args)], { cwd: process.cwd(), env: process.env, detached: true, windowsHide: true, stdio: 'ignore' }).unref()
  shutdown()
}

function shutdown() {
  for (const s of sessions.values()) s.handoff()
  saveSessions(metas)
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

function plural(n: number, word: string) { return `${n} ${word}${n === 1 ? '' : 's'}` }
