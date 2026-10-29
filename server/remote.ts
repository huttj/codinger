// Remote access, this machine's end. Two jobs, both through the hub at
// web.codinger.app (remote/, a Cloudflare Worker):
//
// - Serving: one outbound WebSocket to the hub, which sends through it
//   everything for web.codinger.app/m/<name>/. Each request is replayed on this
//   server at 127.0.0.1, and each browser WebSocket gets its own local one, so
//   the server sees what it sees from a local page. Nothing listens for
//   connections from outside. artifacts.codinger.app/m/<name>/… goes the same
//   way to the artifacts server (server/artifacts.ts).
// - Reaching your other machines: /api/remote/m/<other>/… on this server goes to
//   the hub's /m/<other>/… with this machine's token, so the local page needs no
//   sign-in of its own.
//
// "Connect this machine" asks the hub for a code; you approve it on
// web.codinger.app, signed in, and the machine gets its token. Remote access can be
// turned off and on again; Disconnect forgets the token.
//
// A channel's messages to the hub go in batches: the first at once, the rest
// within BATCH_MS of it in one frame (the hub pays for each frame it gets).

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable, type Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { machineName, PART_BYTES, PARTS_AHEAD, PING, PONG, REQ_HEADERS, RES_HEADERS, type HubMsg, type MachineMsg } from '../shared/remote.ts'
import type { RemoteStatus } from '../shared/types.ts'
import { DATA } from './store.ts'
import { iconOf } from './icons.ts'

const BATCH_MS = Number(process.env.CODINGER_REMOTE_BATCH_MS) || 1000
// A ping to the hub this often; no answer by the next one ends the socket, and it connects again.
const PING_MS = 30_000
// The hub's address: web.codinger.app, or the Worker's own workers.dev address where that
// domain does not resolve. Chosen in Settings (saved), else CODINGER_REMOTE_HUB.
const DEFAULT_HUB = (process.env.CODINGER_REMOTE_HUB ?? 'https://web.codinger.app').replace(/\/$/, '')
const FILE = path.join(DATA, 'remote.json')

type Saved = { on: boolean; name: string; token?: string; hub?: string; label?: string }
let saved: Saved = { on: false, name: machineName(os.hostname().replace(/\.local$/, '')) }
try { saved = { ...saved, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } } catch { /* not set up */ }
const hubUrl = () => saved.hub ?? DEFAULT_HUB
// Forget the token; keep the name and the hub's address.
const unlink = () => { saved = { on: false, name: saved.name, ...(saved.hub ? { hub: saved.hub } : {}) } }
const save = () => fs.writeFileSync(FILE, JSON.stringify(saved, null, 1), { mode: 0o600 })

let port = 0
let artPort = 0
let changed: (s: RemoteStatus) => void = () => {}
let hub: WebSocket | null = null
let connected = false
let linking: { code: string; url: string } | null = null
let retry: NodeJS.Timeout | null = null

// This machine's name on the hub: its page comes through at <hub>/m/<name>/.
export const remoteName = () => saved.name
export function remoteStatus(): RemoteStatus {
  return { hub: hubUrl(), name: saved.name, ...(saved.label ? { label: saved.label } : {}), on: saved.on, linked: !!saved.token, connected, ...(linking ? { linking } : {}) }
}
const tell = () => changed(remoteStatus())

// The hub and this machine's token, to publish there (server/share.ts); null before it is connected.
export const hubAuth = () => saved.token ? { hub: hubUrl(), token: saved.token } : null

export function startRemote(localPort: number, artifactsPort: number, onChange: (s: RemoteStatus) => void) {
  port = localPort
  artPort = artifactsPort
  changed = onChange
  if (saved.on && saved.token) connect()
}

// ---- the settings -------------------------------------------------------------

export async function remoteLink(name: string, hub?: string): Promise<RemoteStatus> {
  saved.name = machineName(name || saved.name)
  if (hub?.trim()) setHub(hub)
  save()
  // Say why it failed: a network or certificate problem shows only in the cause.
  const r = await fetch(`${hubUrl()}/_remote/link/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: saved.name }) })
    .catch((e: Error & { cause?: Error }) => { throw new Error(`Could not reach ${hubUrl()}: ${e.cause?.message ?? e.message}`) })
  if (!r.ok) throw new Error(`${hubUrl()} answered ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const { code, poll, url } = await r.json() as { code: string; poll: string; url: string }
  linking = { code, url }
  tell()
  // Wait for your approval on the web, for as long as the code lasts.
  const until = Date.now() + 10 * 60_000
  const wait = async () => {
    if (linking?.code !== code) return
    if (Date.now() > until) { linking = null; tell(); return }
    try {
      const p = await fetch(`${hubUrl()}/_remote/link/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, poll }) })
      const j = await p.json() as { token?: string; name?: string; waiting?: boolean }
      if (j.token) {
        Object.assign(saved, { token: j.token, name: j.name ?? saved.name, on: true })
        save()
        linking = null
        connect()
        tell()
        return
      }
      if (!p.ok) { linking = null; tell(); return }
    } catch { /* try again */ }
    setTimeout(wait, 2000).unref()
  }
  setTimeout(wait, 2000).unref()
  return remoteStatus()
}

// An address the hub answers at: "web.codinger.app" or a full URL. Empty: the default.
function setHub(hub: string) {
  const h = hub.trim().replace(/\/$/, '')
  if (!h) delete saved.hub
  else saved.hub = /^https?:\/\//.test(h) ? h : `https://${h}`
}

// Another address of the same hub: the token works there too, so no new approval.
export function remoteHub(hub: string) {
  setHub(hub)
  save()
  if (saved.on && saved.token) { disconnect(); connect() }
  tell()
}

export function remoteCancelLink() { linking = null; tell() }

export function remoteOn(on: boolean) {
  saved.on = on && !!saved.token
  save()
  if (saved.on) connect()
  else disconnect()
  tell()
}

// Forget this machine's token (approve it again to come back).
export function remoteForget() {
  disconnect()
  unlink()
  save()
  tell()
}

// ---- serving: the socket to the hub ------------------------------------------------

function connect() {
  if (hub || !saved.token) return
  if (retry) { clearTimeout(retry); retry = null }
  const local = `127.0.0.1:${port}`
  const ws = new WebSocket(`${hubUrl().replace(/^http/, 'ws')}/_remote/connect`, { headers: { authorization: `Bearer ${saved.token}` }, handshakeTimeout: PING_MS })
  hub = ws
  const chans = new Map<string, Chan>()
  // Answers going in parts; null until the hub says it takes them.
  let outs: Map<string, Out> | null = null
  const send = (m: MachineMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }
  // A socket can die with no close on either end (a dropped route): both still say connected,
  // and requests for this machine wait at the hub until they time out. The hub's runtime answers
  // PING only on a socket the hub still holds; a WebSocket ping got answers where it held none.
  let alive = true
  let beat: NodeJS.Timeout | null = null

  ws.on('open', () => {
    wait = 1000; connected = true; tell()
    beat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.send(PING) }, PING_MS)
    beat.unref()
  })
  ws.on('unexpected-response', (_req, res) => {
    // The hub does not know this token any more: forgotten on the web.
    if (res.statusCode === 403) { unlink(); save() }
  })
  ws.on('message', (raw) => {
    if (String(raw) === PONG) { alive = true; return }
    let m: HubMsg
    try { m = JSON.parse(String(raw)) } catch { return }
    // The hub says who this machine is there (a rename or a new display name, from anywhere).
    if (m.t === 'hello') { outs = m.parts ? outs ?? new Map() : null; saved.name = m.name; if (m.label) saved.label = m.label; else delete saved.label; save(); tell(); return }
    if (m.t === 'bye') {
      if (m.why === 'forgotten') { unlink(); save(); disconnect(); tell() }
      else { disconnect(); wait = 1000; connect() }
      return
    }
    if (m.t === 'req') request(local, m, send, outs)
    else if (m.t === 'ack') outs?.get(m.id)?.ack()
    else if (m.t === 'cancel') outs?.get(m.id)?.cancel()
    else if (m.t === 'open') chans.set(m.chan, new Chan(local, m, send, () => chans.delete(m.chan)))
    else if (m.t === 'msg') chans.get(m.chan)?.in(m.data)
    else if (m.t === 'close') { chans.get(m.chan)?.end(); chans.delete(m.chan) }
  })
  ws.on('close', (code) => {
    if (beat) clearInterval(beat)
    for (const c of chans.values()) c.end()
    chans.clear()
    for (const o of outs?.values() ?? []) o.cancel()
    // A socket let go of on purpose (off, renamed, replaced) changes nothing more.
    if (hub !== ws) return
    hub = null
    connected = false
    if (code === 4001) { unlink(); save() } // disconnected on the web
    tell()
    if (!saved.on || !saved.token || code === 1012) return
    if (code === 4002) wait = 200 // renamed: back at once, under the new name
    retry = setTimeout(connect, wait)
    retry.unref()
    wait = Math.min(wait * 2, 60_000)
  })
  ws.on('error', () => { /* the close handler tries again */ })
}
let wait = 1000

function disconnect() {
  if (retry) { clearTimeout(retry); retry = null }
  const ws = hub
  hub = null
  connected = false
  ws?.close(1000, 'Turned off')
}

// For a hub that takes no parts: one message, and base64 makes it a third bigger.
const MAX_BODY = 20 * 1024 * 1024

// An answer going to the hub in parts: an ack lets one more part go; a cancel stops it.
type Out = { ack(): void; cancel(): void }

// One HTTP request, replayed here. An answer over PART_BYTES goes in parts when the hub
// takes them (outs), so a file of any size gets through.
function request(local: string, m: Extract<HubMsg, { t: 'req' }>, send: (m: MachineMsg) => void, outs: Map<string, Out> | null) {
  const fail = (status: number, text: string) => send({ t: 'res', id: m.id, status, headers: { 'content-type': 'text/plain' }, body: Buffer.from(text).toString('base64') })
  // The artifacts server puts its own links under the path the browser sees.
  const r = http.request(m.art ? {
    host: '127.0.0.1', port: artPort, method: m.method, path: m.path,
    headers: { ...m.headers, host: `127.0.0.1:${artPort}`, 'x-codinger-base': `/m/${saved.name}` },
  } : {
    host: '127.0.0.1', port, method: m.method, path: m.path,
    headers: { ...m.headers, host: local, origin: `http://${local}`, 'x-codinger-remote': '1' },
  }, (res) => {
    const headers: Record<string, string> = {}
    for (const h of RES_HEADERS) { const v = res.headers[h]; if (v) headers[h] = String(v) }
    let parts: Buffer[] = [], size = 0, inParts = false, ahead = 0, done = false
    const flush = (end: boolean) => {
      send({ t: 'part', id: m.id, data: Buffer.concat(parts).toString('base64'), ...(end ? { end } : {}) })
      parts = []
      size = 0
      if (!end && ++ahead >= PARTS_AHEAD) res.pause()
    }
    res.on('data', (b: Buffer) => {
      if (done) return
      parts.push(b)
      size += b.length
      if (!inParts && outs && size > PART_BYTES) {
        inParts = true
        send({ t: 'res', id: m.id, status: res.statusCode ?? 502, headers, body: '', more: true })
        outs.set(m.id, { ack: () => { if (--ahead < PARTS_AHEAD) res.resume() }, cancel: () => { done = true; outs.delete(m.id); res.destroy() } })
      }
      if (inParts && size >= PART_BYTES) flush(false)
      // The hub closes the socket on a message over 32 MiB.
      if (!inParts && size > MAX_BODY) {
        done = true
        res.destroy()
        fail(413, `Too big to send through web.codinger.app (the limit is ${MAX_BODY / 1048576} MB). Open it on the machine.`)
      }
    })
    res.on('end', () => {
      if (done) return
      done = true
      if (inParts) { flush(true); outs?.delete(m.id); return }
      send({ t: 'res', id: m.id, status: res.statusCode ?? 502, headers, body: Buffer.concat(parts).toString('base64') })
    })
    res.on('error', () => {
      if (done) return
      done = true
      if (inParts) { send({ t: 'part', id: m.id, data: '', end: true, failed: true }); outs?.delete(m.id) }
      else fail(502, 'The answer broke off')
    })
  })
  r.on('error', (e) => fail(502, e.message))
  if (m.body) r.write(Buffer.from(m.body, 'base64'))
  r.end()
}

// One browser WebSocket, as a local one.
class Chan {
  private ws: WebSocket
  private chan: string
  private send: (m: MachineMsg) => void
  private early: string[] = []  // from the browser before the local socket opened
  private out: string[] = []
  private timer: NodeJS.Timeout | null = null
  private last = 0

  constructor(local: string, m: Extract<HubMsg, { t: 'open' }>, send: (m: MachineMsg) => void, gone: () => void) {
    this.chan = m.chan
    this.send = send
    this.ws = new WebSocket(`ws://${local}${m.path}`, m.protocols, { headers: { origin: `http://${local}`, 'x-codinger-remote': '1' } })
    this.ws.on('open', () => { for (const d of this.early) this.ws.send(d); this.early = [] })
    this.ws.on('message', (d) => this.queue(String(d)))
    this.ws.on('close', () => { this.flush(); send({ t: 'close', chan: m.chan }); gone() })
    this.ws.on('error', () => { /* close follows */ })
  }

  in(data: string) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
    else if (this.ws.readyState === WebSocket.CONNECTING) this.early.push(data)
  }

  end() { if (this.timer) clearTimeout(this.timer); this.ws.close() }

  // The first message after a quiet spell goes at once; the rest wait for the batch.
  private queue(d: string) {
    this.out.push(d)
    if (this.timer) return
    const since = Date.now() - this.last
    if (since >= BATCH_MS) return this.flush()
    this.timer = setTimeout(() => this.flush(), BATCH_MS - since)
  }

  private flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.out.length) return
    this.send({ t: 'msgs', chan: this.chan, data: this.out })
    this.out = []
    this.last = Date.now()
  }
}

// ---- reaching your other machines -----------------------------------------------

// /api/remote/machines[/<name>[/label|rename]], /api/remote/push/(key|subscribe|unsubscribe), and
// /api/remote/m/<name>/…: on to the hub, with this machine's token.
export async function remoteProxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (!saved.token) { res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'This machine is not connected to web.codinger.app' })); return }
  const own = url.pathname.startsWith('/api/remote/machines') || url.pathname.startsWith('/api/remote/push/')
  const target = own ? url.pathname.replace(/^\/api\/remote/, '/_remote') : url.pathname.replace(/^\/api\/remote/, '')
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise<Buffer>((resolve) => { const b: Buffer[] = []; req.on('data', (d) => b.push(d)); req.on('end', () => resolve(Buffer.concat(b))) })
  const r = await fetch(hubUrl() + target + url.search, {
    method: req.method,
    headers: { authorization: `Bearer ${saved.token}`, ...Object.fromEntries(REQ_HEADERS.flatMap((h) => req.headers[h] ? [[h, String(req.headers[h])]] : [])) },
    body: body && new Uint8Array(body),
  }).catch((e: Error) => e)
  if (r instanceof Error) { res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `Could not reach ${hubUrl()}: ${r.message}` })); return }
  const headers: Record<string, string> = {}
  for (const h of RES_HEADERS) { const v = r.headers.get(h); if (v) headers[h] = v }
  res.writeHead(r.status, headers)
  // A big file comes in parts: on as it comes.
  if (r.body) Readable.fromWeb(r.body as import('node:stream/web').ReadableStream).pipe(res)
  else res.end()
}

// A push notification to each browser that subscribed (remote/src/push.ts), if this machine is connected.
// Why no notification went, or null when one did. A hub from before October 2026 does not say how
// many browsers took it: then a push it took counts as sent.
export async function remoteNotify(n: { title: string; body: string; session: string; icon?: string }): Promise<string | null> {
  if (!saved.token || !saved.on) return 'this machine is not linked to the Codinger hub, or the link is off'
  n = { ...n, icon: n.icon ?? iconOf(n.session) }
  try {
    const r = await fetch(hubUrl() + '/_remote/push/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${saved.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(n),
    })
    if (!r.ok) return `the hub answered ${r.status}`
    const j = await r.json().catch(() => ({})) as { sent?: number; failed?: number }
    if (j.sent === 0) return j.failed ? `the push service refused it for all ${j.failed} browsers that have notifications on` : 'no browser or phone has notifications on for Codinger'
    return null
  } catch (e) { return `the hub did not answer (${e instanceof Error ? e.message : e})` }
}

// A WebSocket to /api/remote/m/<name>/…: one to the hub, joined to it.
const wss = new WebSocketServer({ noServer: true })
export function remoteUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  if (!saved.token) { socket.destroy(); return }
  const target = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/api\/remote/, '')
  const far = new WebSocket(`${hubUrl().replace(/^http/, 'ws')}${target}`, { headers: { authorization: `Bearer ${saved.token}` } })
  far.on('error', () => socket.destroy())
  far.on('open', () => wss.handleUpgrade(req, socket, head, (near) => {
    near.on('message', (d) => far.send(String(d)))
    far.on('message', (d) => near.send(String(d)))
    near.on('close', () => far.close())
    far.on('close', () => near.close())
  }))
}
