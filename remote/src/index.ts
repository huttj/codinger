// The hub for remote access: one Worker and one Durable Object for the owner,
// at web.codinger.app.
//
// - The Codinger UI itself (the built dist/, Workers static assets).
// - Sign-in by an email link, to the addresses in ALLOWED_EMAILS only.
// - Connecting a machine: its Codinger asks for a code, you approve it here
//   (signed in), and the machine gets a token.
// - /m/<machine>/… goes through that machine's one outbound WebSocket
//   (shared/remote.ts): each request, and each WebSocket as a channel. A signed-in
//   browser or another machine (with its token) can use it.
// - Transcripts your machines publish (server/share.ts), kept in R2 and readable by
//   anyone with the link at /s/<id>.
// - A machine's artifacts at artifacts.codinger.app/m/<machine>/…, a host of their own,
//   so their scripts never run as web.codinger.app.

import { DurableObject } from 'cloudflare:workers'
import { EmailMessage } from 'cloudflare:email'
import { PING, PONG, REQ_HEADERS, RES_HEADERS, type HubMsg, type MachineMsg, type RemoteMachine } from '../../shared/remote.ts'
import { mediaKind, mediaType } from '../../shared/media.ts'
import { newVapid, sendPush, type Subscription, type Vapid } from './push.ts'

type Env = {
  HUB: DurableObjectNamespace<Hub>
  EMAIL: SendEmail
  SHARES: R2Bucket
  ASSETS: Fetcher
  ALLOWED_EMAILS: string   // comma-separated
  MAIL_FROM: string
}

const TIMEOUT_MS = 60_000
const COOKIE = 'codinger_session'
const ART_COOKIE = 'codinger_artifacts'
const TICKET_MS = 60_000
const SESSION_DAYS = 30
const LOGIN_MS = 15 * 60_000
const LINK_MS = 10 * 60_000

type Login = { email: string; exp: number; next?: string }
type Session = { email: string; exp: number }
// On artifacts.codinger.app: good for as long as the sign-in on web.codinger.app it came from (of: its hash).
type ArtSession = { of: string }
type Ticket = { of: string; exp: number }
type Link = { name: string; poll: string; exp: number; token?: string }
type Machine = { name: string; created: number; tokenHash: string; label?: string }
// A published transcript: in R2 at s/<id>/share.json, with the files it shows at s/<id>/f/<name>.
type ShareRec = { id: string; title: string; machine: string; created: number; updated: number; files: string[] }
const SHARE_PATH = /^\/_remote\/shares\/([A-Za-z0-9]{16})(?:\/f\/([0-9a-f]{24}\.[a-z0-9]{1,8}))?$/
const SHARE_FILE = /^[0-9a-f]{24}\.[a-z0-9]{1,8}$/
// Where a ticket may send the browser on artifacts.codinger.app.
const ART_PATH = /^\/m\/[a-z0-9-]{1,40}\/[^/\\]/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // A published transcript is public: no sign-in, so no need for the hub's state.
    const url = new URL(req.url)
    if (url.pathname.startsWith('/s/')) return await readShare(req, env, url).catch((e) => json({ error: e instanceof Error ? e.message : String(e) }, 500))
    // One owner, so one hub. Static files never get here (wrangler.jsonc: run_worker_first).
    return env.HUB.get(env.HUB.idFromName('owner')).fetch(req)
  },
} satisfies ExportedHandler<Env>

export class Hub extends DurableObject<Env> {
  private pending = new Map<string, (m: Extract<MachineMsg, { t: 'res' }>) => void>()
  // Answers coming in parts (shared/remote.ts), by request id.
  private streams = new Map<string, Stream>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // A machine's heartbeat, answered without waking the hub.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const p = url.pathname
    try {
      if (url.hostname.startsWith('artifacts.')) return await this.artifacts(req, url)
      if (p.startsWith('/m/')) return await this.tunnel(req, url)
      switch (`${req.method} ${p}`) {
        case 'GET /_remote/whoami': {
          const s = await this.session(req)
          return json(s ? { web: true, email: s.email } : { web: true, email: null }, s ? 200 : 401)
        }
        case 'GET /_remote/login': return loginPage(url.searchParams.get('next') ?? '')
        case 'POST /_remote/login': return await this.login(req, url)
        case 'GET /_remote/verify': return verifyPage(url.searchParams.get('t') ?? '')
        case 'POST /_remote/verify': return await this.verify(req)
        case 'POST /_remote/logout': return await this.logout(req)
        case 'POST /_remote/link/start': return await this.linkStart(req, url)
        case 'POST /_remote/link/poll': return await this.linkPoll(req)
        case 'GET /_remote/link': return await this.linkPage(req, url)
        case 'POST /_remote/link': return await this.linkApprove(req, url)
        case 'GET /_remote/machines': {
          if (!await this.allowed(req)) return json({ error: 'Not signed in' }, 401)
          return json(await this.machines())
        }
        case 'GET /_remote/connect': return await this.attach(req)
        case 'GET /_remote/artifacts': return await this.artTicket(req, url)
        // Push notifications: a browser on this site subscribes itself; a page on a machine's own
        // address subscribes through that machine (with its token). Only a machine sends.
        case 'GET /_remote/push/key': {
          if (!await this.allowed(req)) return json({ error: 'Not signed in' }, 401)
          return json({ key: (await this.vapid()).pub })
        }
        case 'POST /_remote/push/subscribe':
        case 'POST /_remote/push/unsubscribe': {
          if (!await this.machineOf(req) && (!await this.session(req) || !sameOrigin(req, url))) return json({ error: 'Not signed in' }, 401)
          const body = await req.json<{ sub?: Subscription; endpoint?: string }>()
          const endpoint = body.sub?.endpoint ?? body.endpoint
          if (!endpoint?.startsWith('https://')) return json({ error: 'No subscription' }, 400)
          const k = `push:sub:${await hash(endpoint)}`
          if (p.endsWith('/unsubscribe')) await this.ctx.storage.delete(k)
          else if (body.sub?.keys?.p256dh && body.sub.keys.auth) await this.ctx.storage.put(k, { endpoint, keys: { p256dh: body.sub.keys.p256dh, auth: body.sub.keys.auth } } satisfies Subscription)
          else return json({ error: 'No subscription' }, 400)
          return json({ ok: true })
        }
        case 'POST /_remote/push/send': {
          const m = await this.machineOf(req)
          if (!m) return json({ error: 'Not allowed' }, 403)
          const body = await req.json<{ title?: string; body?: string; session?: string; icon?: string }>()
          // icon: the session's critter, a small PNG data URL (Chrome shows it; an iPhone shows the app's icon).
          const icon = typeof body.icon === 'string' && body.icon.startsWith('data:image/png;base64,') && body.icon.length <= 2600 ? body.icon : undefined
          const payload = JSON.stringify({ title: String(body.title ?? 'Codinger').slice(0, 200), body: String(body.body ?? '').slice(0, 500), machine: m.name, session: String(body.session ?? ''), ...(icon ? { icon } : {}) })
          // sent: the browsers that took it. 0 when no browser has notifications on.
          return json({ ok: true, ...await this.push(payload) })
        }
      }
      // A machine's display name, or its name: from the web, or from one of your machines.
      const change = /^\/_remote\/machines\/([a-z0-9-]{1,40})\/(label|rename)$/.exec(p)
      if (change && req.method === 'POST') {
        if (!await this.machineOf(req) && (!await this.session(req) || !sameOrigin(req, url))) return json({ error: 'Not signed in' }, 401)
        const body = await req.json<{ label?: string; name?: string }>()
        return change[2] === 'label' ? await this.label(change[1], String(body.label ?? '')) : await this.rename(change[1], String(body.name ?? ''))
      }
      // Publishing a transcript: from one of your machines only.
      const share = SHARE_PATH.exec(p)
      if (share) {
        const m = await this.machineOf(req)
        if (!m) return json({ error: 'Not allowed' }, 403)
        return await this.share(req, m, share[1], share[2])
      }
      const forget = /^\/_remote\/machines\/([a-z0-9-]{1,40})$/.exec(p)
      // Removing a machine: from the web, or from one of your machines (Settings → Remote access).
      if (forget && req.method === 'DELETE') {
        if (!await this.machineOf(req) && (!await this.session(req) || !sameOrigin(req, url))) return json({ error: 'Not signed in' }, 401)
        await this.forget(forget[1])
        return json({ ok: true })
      }
      return new Response('Not found', { status: 404 })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  }

  // ---- sign-in -----------------------------------------------------------------

  private allowedEmail(email: string) {
    return this.env.ALLOWED_EMAILS.split(',').map((s) => s.trim().toLowerCase()).includes(email)
  }

  // Ask for a link. The answer is the same for any address, so it tells nobody which ones are on the list.
  private async login(req: Request, url: URL): Promise<Response> {
    const form = await req.formData()
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const next = String(form.get('next') ?? '')
    if (this.allowedEmail(email)) {
      // At most 5 links an hour to one address.
      const key = `sent:${email}`
      const sent = ((await this.ctx.storage.get<number[]>(key)) ?? []).filter((t) => t > Date.now() - 3_600_000)
      if (sent.length < 5) {
        const t = token()
        await this.ctx.storage.put(`login:${await hash(t)}`, { email, exp: Date.now() + LOGIN_MS, ...(next.startsWith('/_remote/link?') ? { next } : {}) } satisfies Login)
        await this.ctx.storage.put(key, [...sent, Date.now()])
        await this.mail(email, 'Sign in to Codinger', `Open this link to sign in to Codinger on web.codinger.app:\n\n${url.origin}/_remote/verify?t=${t}\n\nIt works once, for 15 minutes. If you did not ask for it, do nothing.`)
      }
    }
    return page('Check your email', '<p>If the address is on the list, a link to sign in is on the way. It works for 15 minutes.</p>')
  }

  // A POST from the page the link opens, so a mail scanner that opens links does not use it up.
  private async verify(req: Request): Promise<Response> {
    const form = await req.formData()
    const key = `login:${await hash(String(form.get('t') ?? ''))}`
    const login = await this.ctx.storage.get<Login>(key)
    await this.ctx.storage.delete(key)
    if (!login || login.exp < Date.now()) return page('Link expired', '<p>This link is used or too old. <a href="/_remote/login">Ask for a new one</a>.</p>', 400)
    const s = token()
    await this.ctx.storage.put(`session:${await hash(s)}`, { email: login.email, exp: Date.now() + SESSION_DAYS * 86_400_000 } satisfies Session)
    return new Response(null, { status: 303, headers: { location: login.next ?? '/', 'set-cookie': `${COOKIE}=${s}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}` } })
  }

  private async logout(req: Request): Promise<Response> {
    const s = cookie(req, COOKIE)
    if (s) await this.ctx.storage.delete(`session:${await hash(s)}`)
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } })
  }

  private async session(req: Request): Promise<Session | null> {
    return (await this.signedIn(req))?.v ?? null
  }

  // The sign-in and its cookie. A page on another codinger.app host (an artifact) can set a cookie
  // of the same name for all of codinger.app; it comes first, so each one is tried.
  private async signedIn(req: Request): Promise<{ v: Session; s: string } | null> {
    for (const s of cookies(req, COOKIE)) {
      const v = await this.ctx.storage.get<Session>(`session:${await hash(s)}`)
      if (v && v.exp > Date.now() && this.allowedEmail(v.email)) return { v, s }
    }
    return null
  }

  // A machine, by the token in its Authorization header.
  private async machineOf(req: Request): Promise<Machine | null> {
    const t = req.headers.get('authorization')?.replace(/^Bearer /, '')
    if (!t) return null
    const name = await this.ctx.storage.get<string>(`token:${await hash(t)}`)
    return name ? (await this.ctx.storage.get<Machine>(`machine:${name}`)) ?? null : null
  }

  // The hub's VAPID key pair, made the first time a browser asks for it.
  private async vapid(): Promise<Vapid> {
    const v = await this.ctx.storage.get<Vapid>('push:vapid')
    if (v) return v
    const n = await newVapid()
    await this.ctx.storage.put('push:vapid', n)
    return n
  }

  // To each browser that subscribed. A subscription the push service no longer knows goes.
  private async push(payload: string): Promise<{ sent: number; failed: number }> {
    const vapid = await this.vapid()
    const subs = await this.ctx.storage.list<Subscription>({ prefix: 'push:sub:' })
    let sent = 0, failed = 0
    await Promise.all([...subs].map(async ([k, sub]) => {
      const status = await sendPush(sub, payload, vapid, `mailto:${this.env.MAIL_FROM}`).catch(() => 0)
      if (status >= 200 && status < 300) sent++
      else failed++
      if (status === 404 || status === 410) await this.ctx.storage.delete(k)
    }))
    return { sent, failed }
  }

  // Signed in, or one of your machines.
  private async allowed(req: Request) { return !!(await this.session(req)) || !!(await this.machineOf(req)) }

  private async mail(to: string, subject: string, text: string) {
    const from = this.env.MAIL_FROM
    const raw = [
      `From: Codinger <${from}>`, `To: <${to}>`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1]}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', text,
    ].join('\r\n')
    await this.env.EMAIL.send(new EmailMessage(from, to, raw))
  }

  // ---- connecting a machine --------------------------------------------------------

  // The machine asks; it shows you the link with the code, and polls with its secret.
  private async linkStart(req: Request, url: URL): Promise<Response> {
    const { name } = await req.json<{ name?: string }>()
    if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) return json({ error: 'Bad name' }, 400)
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')
    const poll = token()
    await this.ctx.storage.put(`link:${code}`, { name, poll: await hash(poll), exp: Date.now() + LINK_MS } satisfies Link)
    return json({ code, poll, url: `${url.origin}/_remote/link?code=${code}` })
  }

  private async linkPoll(req: Request): Promise<Response> {
    const { code, poll } = await req.json<{ code?: string; poll?: string }>()
    const key = `link:${code}`
    const link = await this.ctx.storage.get<Link>(key)
    if (!link || link.poll !== await hash(String(poll)) || link.exp < Date.now()) return json({ error: 'No such request, or it expired' }, 404)
    if (!link.token) return json({ waiting: true })
    await this.ctx.storage.delete(key)
    return json({ token: link.token, name: link.name })
  }

  private async linkPage(req: Request, url: URL): Promise<Response> {
    if (!await this.session(req)) return new Response(null, { status: 303, headers: { location: `/_remote/login?next=${encodeURIComponent(url.pathname + url.search)}` } })
    const code = url.searchParams.get('code') ?? ''
    const link = await this.ctx.storage.get<Link>(`link:${code}`)
    if (!link || link.exp < Date.now() || link.token) return page('Not found', '<p>This request is used or too old. Start again in Codinger.</p>', 404)
    const again = await this.ctx.storage.get<Machine>(`machine:${link.name}`)
    return page('Connect a machine', `<p>Connect <b>${esc(link.name)}</b> to your Codinger? Check that Codinger on that machine shows this code:</p><div class="code">${esc(code)}</div>
${again ? `<p>A machine with this name is connected already. It will be disconnected.</p>` : ''}
<form method="post"><input type="hidden" name="code" value="${esc(code)}"><button>Connect ${esc(link.name)}</button></form>`)
  }

  private async linkApprove(req: Request, url: URL): Promise<Response> {
    if (!await this.session(req) || !sameOrigin(req, url)) return page('Not signed in', '<p><a href="/_remote/login">Sign in</a> first.</p>', 401)
    const code = String((await req.formData()).get('code') ?? '')
    const key = `link:${code}`
    const link = await this.ctx.storage.get<Link>(key)
    if (!link || link.exp < Date.now() || link.token) return page('Not found', '<p>This request is used or too old. Start again in Codinger.</p>', 404)
    await this.forget(link.name)
    const t = token()
    const tokenHash = await hash(t)
    await this.ctx.storage.put(`machine:${link.name}`, { name: link.name, created: Date.now(), tokenHash } satisfies Machine)
    await this.ctx.storage.put(`token:${tokenHash}`, link.name)
    await this.ctx.storage.put(key, { ...link, token: t } satisfies Link)
    return page('Connected', `<p><b>${esc(link.name)}</b> is connected. You can close this page.</p><p><a href="/">Open Codinger</a></p>`)
  }

  private async forget(name: string) {
    const m = await this.ctx.storage.get<Machine>(`machine:${name}`)
    if (m) await this.ctx.storage.delete([`machine:${name}`, `token:${m.tokenHash}`])
    for (const ws of this.ctx.getWebSockets(`m:${name}`)) { send(ws, { t: 'bye', why: 'forgotten' }); ws.close(4001, 'Disconnected from web.codinger.app') }
    this.dropMachine(name)
  }

  private async machines(): Promise<RemoteMachine[]> {
    const known = await this.ctx.storage.list<Machine>({ prefix: 'machine:' })
    return [...known.values()].map((m) => ({ name: m.name, ...(m.label ? { label: m.label } : {}), connected: !!this.socket(m.name) })).sort((a, b) => a.name.localeCompare(b.name))
  }

  private async label(name: string, label: string): Promise<Response> {
    const m = await this.ctx.storage.get<Machine>(`machine:${name}`)
    if (!m) return json({ error: `No machine ${name}` }, 404)
    const l = label.trim().slice(0, 60)
    const next: Machine = { ...m }
    if (l && l !== name) next.label = l
    else delete next.label
    await this.ctx.storage.put(`machine:${name}`, next)
    const ws = this.socket(name)
    if (ws) send(ws, { t: 'hello', name, parts: true, ...(next.label ? { label: next.label } : {}) })
    return json({ name, label: next.label ?? null })
  }

  // A new name moves the machine: its token stays, and it connects again under the new name.
  private async rename(name: string, to: string): Promise<Response> {
    if (!/^[a-z0-9-]{1,40}$/.test(to)) return json({ error: 'A name has lower-case letters, digits and dashes only' }, 400)
    const m = await this.ctx.storage.get<Machine>(`machine:${name}`)
    if (!m) return json({ error: `No machine ${name}` }, 404)
    if (to === name) return json({ name })
    if (await this.ctx.storage.get(`machine:${to}`)) return json({ error: `There is a machine ${to} already` }, 409)
    await this.ctx.storage.put(`machine:${to}`, { ...m, name: to })
    await this.ctx.storage.put(`token:${m.tokenHash}`, to)
    await this.ctx.storage.delete(`machine:${name}`)
    // The machine connects again itself when it hears this; the close is only a backup.
    for (const ws of this.ctx.getWebSockets(`m:${name}`)) { send(ws, { t: 'bye', why: 'renamed' }); ws.close(4002, 'Renamed') }
    this.dropMachine(name)
    return json({ name: to })
  }

  // The machine's own socket, kept open.
  private async attach(req: Request): Promise<Response> {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    const m = await this.machineOf(req)
    if (!m) return new Response('Not allowed', { status: 403 })
    // A machine that connects again takes the place of its old socket.
    for (const old of this.ctx.getWebSockets(`m:${m.name}`)) { this.dropMachine(m.name); old.close(1012, 'Connected again') }
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, ['m', `m:${m.name}`])
    server.serializeAttachment({ at: Date.now() })
    send(server, { t: 'hello', name: m.name, parts: true, ...(m.label ? { label: m.label } : {}) })
    return new Response(null, { status: 101, webSocket: client })
  }

  // The newest open one: a socket closed here can stay listed until the other end answers, so
  // the first listed can be a dead one, and the machine gets none of its requests.
  private socket(name: string): WebSocket | undefined {
    const at = (ws: WebSocket) => (ws.deserializeAttachment() as { at?: number } | null)?.at ?? 0
    return this.ctx.getWebSockets(`m:${name}`).filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN).sort((a, b) => at(b) - at(a))[0]
  }

  // ---- published transcripts ------------------------------------------------------

  // GET: the files the hub has (to send only the new ones). PUT a file, then the transcript,
  // which drops the files it no longer shows. DELETE: all of it.
  private async share(req: Request, m: Machine, id: string, file?: string): Promise<Response> {
    const key = `share:${id}`
    const rec = await this.ctx.storage.get<ShareRec>(key)
    const bucket = this.env.SHARES
    if (file) {
      if (req.method !== 'PUT' || !req.body) return json({ error: 'Not found' }, 404)
      await bucket.put(`s/${id}/f/${file}`, req.body, { httpMetadata: { contentType: mediaType(file) } })
      return json({ ok: true })
    }
    if (req.method === 'GET') return rec ? json({ files: rec.files }) : json({ error: 'No such transcript' }, 404)
    if (req.method === 'PUT') {
      const text = await req.text()
      const s = JSON.parse(text) as { v?: number; title?: unknown; events?: unknown; files?: unknown }
      if (s.v !== 1 || !Array.isArray(s.events) || !Array.isArray(s.files)) return json({ error: 'Not a transcript' }, 400)
      const files = s.files.filter((f): f is string => typeof f === 'string' && SHARE_FILE.test(f))
      const title = String(s.title ?? '').slice(0, 200)
      await bucket.put(`s/${id}/share.json`, text, { httpMetadata: { contentType: 'application/json' }, customMetadata: { title } })
      const keep = new Set(files.map((f) => `s/${id}/f/${f}`))
      const gone = (await listAll(bucket, `s/${id}/f/`)).filter((k) => !keep.has(k))
      if (gone.length) await bucket.delete(gone)
      const now = Date.now()
      await this.ctx.storage.put(key, { id, title, machine: m.name, created: rec?.created ?? now, updated: now, files } satisfies ShareRec)
      return json({ ok: true })
    }
    if (req.method === 'DELETE') {
      const all = await listAll(bucket, `s/${id}/`)
      for (let i = 0; i < all.length; i += 1000) await bucket.delete(all.slice(i, i + 1000))
      await this.ctx.storage.delete(key)
      return json({ ok: true })
    }
    return json({ error: 'Not found' }, 404)
  }

  // ---- /m/<machine>/… through the machine ------------------------------------------

  private async tunnel(req: Request, url: URL): Promise<Response> {
    const [, , name, ...rest] = url.pathname.split('/')
    // A browser needs its session and this site as the origin; a machine, its token.
    const from = await this.machineOf(req)
    if (!from && (!await this.session(req) || !sameOrigin(req, url))) return json({ error: 'Not signed in' }, 401)
    const machine = this.socket(name)
    if (!machine) return json({ error: `${name} is not connected` }, 502)
    const path = '/' + rest.join('/') + url.search
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.channel(req, name, path, machine)
    return this.request(req, name, path, machine)
  }

  // art: for the machine's artifacts server, whose redirects come through too.
  private async request(req: Request, name: string, path: string, machine: WebSocket, art = false): Promise<Response> {
    const id = crypto.randomUUID()
    const headers: Record<string, string> = {}
    for (const h of REQ_HEADERS) { const v = req.headers.get(h); if (v) headers[h] = v }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : toBase64(new Uint8Array(await req.arrayBuffer()))
    const res = await new Promise<Extract<MachineMsg, { t: 'res' }> | null>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null) }, TIMEOUT_MS)
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
      send(machine, { t: 'req', id, method: req.method, path, headers, ...(body ? { body } : {}), ...(art ? { art } : {}) })
    })
    if (!res) return json({ error: 'The machine did not answer in time' }, 504)
    const out = new Headers()
    for (const h of art ? [...RES_HEADERS, 'location'] : RES_HEADERS) if (res.headers[h]) out.set(h, res.headers[h])
    if (res.more) return new Response(this.stream(id, name, machine), { status: res.status, headers: out })
    return new Response(req.method === 'HEAD' ? null : fromBase64(res.body), { status: res.status, headers: out })
  }

  // A big answer, passed on part by part: each part written (the browser read the last) lets
  // the machine send one more, so only a few are ever held here.
  private stream(id: string, name: string, machine: WebSocket): ReadableStream<Uint8Array> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const s: Stream = { machine: name, writer, idle: null }
    this.streams.set(id, s)
    // The browser went away: the machine stops.
    writer.closed.catch(() => { if (this.streams.delete(id)) send(machine, { t: 'cancel', id }) })
    this.idle(id, s)
    return readable
  }

  // No part for TIMEOUT_MS: the machine is stuck, so the browser gets an error.
  private idle(id: string, s: Stream) {
    clearTimeout(s.idle)
    s.idle = setTimeout(() => this.endStream(id, 'The machine stopped sending'), TIMEOUT_MS)
  }

  private endStream(id: string, why?: string) {
    const s = this.streams.get(id)
    if (!s) return
    this.streams.delete(id)
    clearTimeout(s.idle)
    if (why) s.writer.abort(why).catch(() => {})
  }

  private part(machine: WebSocket, m: Extract<MachineMsg, { t: 'part' }>) {
    const s = this.streams.get(m.id)
    if (!s) return
    if (m.failed) return this.endStream(m.id, 'The machine stopped sending')
    if (m.end) this.endStream(m.id)
    else this.idle(m.id, s)
    s.writer.write(fromBase64(m.data)).then(() => m.end ? s.writer.close() : send(machine, { t: 'ack', id: m.id })).catch(() => {})
  }

  // ---- artifacts.codinger.app/m/<machine>/… -------------------------------------------
  //
  // A machine's artifacts server, through its socket. The host has a cookie of its own, as
  // web.codinger.app's must never reach an artifact. A browser without it goes to
  // web.codinger.app/_remote/artifacts, which (signed in) sends it back with a ticket for
  // one. Both cookies are SameSite=Lax, so a frame on another site gets neither.

  private async artifacts(req: Request, url: URL): Promise<Response> {
    const p = url.pathname
    if (req.method === 'GET' && p === '/_remote/enter') return await this.artEnter(url)
    const m = /^\/m\/([a-z0-9-]{1,40})(\/.*)$/.exec(p)
    if (!m) return new Response('Not found', { status: 404 })
    if (!await this.artSession(req)) {
      if (req.method !== 'GET') return json({ error: 'Not signed in' }, 401)
      return new Response(null, { status: 302, headers: { location: `${url.origin.replace('//artifacts.', '//web.')}/_remote/artifacts?to=${encodeURIComponent(p + url.search)}` } })
    }
    // web.codinger.app frames these, so a same-site request is fine here; a write still needs this origin.
    const o = req.headers.get('origin')
    if (o ? o !== url.origin : req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Not allowed' }, 403)
    if (req.headers.get('upgrade')) return new Response('No WebSockets here', { status: 400 })
    const machine = this.socket(m[1])
    if (!machine) return page('Not connected', `<p><b>${esc(m[1])}</b> is not connected, so its artifacts cannot show.</p>`, 502)
    return this.request(req, m[1], m[2] + url.search, machine, true)
  }

  // On web.codinger.app: a ticket for a cookie on artifacts.codinger.app, then back to the artifact.
  private async artTicket(req: Request, url: URL): Promise<Response> {
    const to = url.searchParams.get('to') ?? ''
    if (!url.hostname.startsWith('web.') || !ART_PATH.test(to)) return new Response('Not found', { status: 404 })
    const s = (await this.signedIn(req))?.s
    if (!s) return page('Not signed in', '<p>Sign in on <a href="/" target="_top">web.codinger.app</a> to see this artifact.</p>', 401)
    const t = token()
    await this.ctx.storage.put(`ticket:${await hash(t)}`, { of: await hash(s), exp: Date.now() + TICKET_MS } satisfies Ticket)
    return new Response(null, { status: 302, headers: { location: `${url.origin.replace('//web.', '//artifacts.')}/_remote/enter?t=${t}&to=${encodeURIComponent(to)}` } })
  }

  private async artEnter(url: URL): Promise<Response> {
    const key = `ticket:${await hash(url.searchParams.get('t') ?? '')}`
    const ticket = await this.ctx.storage.get<Ticket>(key)
    await this.ctx.storage.delete(key)
    const to = url.searchParams.get('to') ?? ''
    if (!ticket || ticket.exp < Date.now() || !ART_PATH.test(to)) return page('Link expired', '<p>Open the artifact again in Codinger.</p>', 400)
    const s = token()
    await this.ctx.storage.put(`art:${await hash(s)}`, { of: ticket.of } satisfies ArtSession)
    return new Response(null, { status: 302, headers: { location: to, 'set-cookie': `${ART_COOKIE}=${s}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}` } })
  }

  private async artSession(req: Request): Promise<Session | null> {
    for (const s of cookies(req, ART_COOKIE)) {
      const key = `art:${await hash(s)}`
      const a = await this.ctx.storage.get<ArtSession>(key)
      if (!a) continue
      const v = await this.ctx.storage.get<Session>(`session:${a.of}`)
      if (v && v.exp > Date.now() && this.allowedEmail(v.email)) return v
      await this.ctx.storage.delete(key)
    }
    return null
  }

  private channel(req: Request, name: string, path: string, machine: WebSocket): Response {
    const chan = crypto.randomUUID()
    const protocols = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, ['b', `b:${name}`, `c:${chan}`])
    send(machine, { t: 'open', chan, path, protocols })
    return new Response(null, { status: 101, webSocket: client, headers: protocols[0] ? { 'sec-websocket-protocol': protocols[0] } : {} })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws)
    const data = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    if (tags[0] === 'm') {
      let m: MachineMsg
      try { m = JSON.parse(data) } catch { return }
      if (m.t === 'res') { this.pending.get(m.id)?.(m); this.pending.delete(m.id) }
      else if (m.t === 'part') this.part(ws, m)
      else if (m.t === 'msgs') for (const b of this.ctx.getWebSockets(`c:${m.chan}`)) for (const d of m.data) b.send(d)
      else if (m.t === 'close') for (const b of this.ctx.getWebSockets(`c:${m.chan}`)) b.close(1000, 'Closed')
      return
    }
    // A browser: on to its machine.
    const name = tags.find((t) => t.startsWith('b:'))!.slice(2)
    const chan = tags.find((t) => t.startsWith('c:'))!.slice(2)
    const machine = this.socket(name)
    if (machine) send(machine, { t: 'msg', chan, data })
    else ws.close(1011, 'The machine went away')
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(1000, 'Closed') } catch { /* closed */ }
    const tags = this.ctx.getTags(ws)
    // An old socket of a machine that connected again: its browsers are on the new one.
    if (tags[0] === 'm') return this.socket(tags[1].slice(2)) ? undefined : this.dropMachine(tags[1].slice(2))
    const name = tags.find((t) => t.startsWith('b:'))!.slice(2)
    const chan = tags.find((t) => t.startsWith('c:'))!.slice(2)
    const machine = this.socket(name)
    if (machine) send(machine, { t: 'close', chan })
  }

  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws) }

  // A machine went: so do the browsers on it.
  private dropMachine(name: string) {
    for (const [id, s] of this.streams) if (s.machine === name) this.endStream(id, 'The machine went away')
    for (const b of this.ctx.getWebSockets(`b:${name}`)) try { b.close(1011, 'The machine went away') } catch { /* closed */ }
  }
}

// ---- reading a published transcript --------------------------------------------

// /s/<id>: the page (web/share.html) with the transcript's title; /s/<id>/share.json: the
// transcript; /s/<id>/f/<name>: a file it shows. The files are kept by content, so they never
// change; a page or an SVG among them is sandboxed, so it never runs as this site.
async function readShare(req: Request, env: Env, url: URL): Promise<Response> {
  const m = /^\/s\/([A-Za-z0-9]{16})(?:\/(share\.json)|\/f\/([0-9a-f]{24}\.[a-z0-9]{1,8}))?\/?$/.exec(url.pathname)
  if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return page('Not found', '<p>There is no transcript here.</p>', 404)
  const [, id, data, file] = m
  if (file) {
    const obj = await env.SHARES.get(`s/${id}/f/${file}`, req.headers.has('range') ? { range: req.headers } : {})
    if (!obj) return new Response('Not found', { status: 404 })
    const kind = mediaKind(file)
    const headers = new Headers({
      'content-type': mediaType(file), 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable', 'accept-ranges': 'bytes', etag: obj.httpEtag,
      ...(kind === 'page' ? { 'content-security-policy': 'sandbox allow-scripts allow-popups' } : kind === 'image' || kind === 'file' ? { 'content-security-policy': 'sandbox' } : {}),
      ...(kind === 'file' && mediaType(file) === 'application/octet-stream' ? { 'content-disposition': 'attachment' } : {}),
    })
    const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined
    if (!r || !req.headers.has('range')) return new Response(req.method === 'HEAD' ? null : obj.body, { headers: (headers.set('content-length', String(obj.size)), headers) })
    const offset = r.suffix != null ? obj.size - r.suffix : r.offset ?? 0
    const length = r.suffix != null ? r.suffix : r.length ?? obj.size - offset
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`)
    headers.set('content-length', String(length))
    return new Response(req.method === 'HEAD' ? null : obj.body, { status: 206, headers })
  }
  if (data) {
    const obj = await env.SHARES.get(`s/${id}/share.json`)
    if (!obj) return json({ error: 'No such transcript' }, 404)
    return new Response(obj.body, { headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' } })
  }
  const head = await env.SHARES.head(`s/${id}/share.json`)
  if (!head) return page('Not found', '<p>There is no transcript here. Its owner may have taken it down.</p>', 404)
  const title = head.customMetadata?.title || 'A transcript'
  const shell = await env.ASSETS.fetch(new Request(new URL('/share.html', url)))
  const meta = `<meta property="og:title" content="${esc(title)}"><meta property="og:type" content="article"><meta property="og:site_name" content="Codinger"><meta name="robots" content="noindex">`
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(`${title} · Codinger`) } })
    .on('head', { element(e) { e.append(meta, { html: true }) } })
    .transform(new Response(shell.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } }))
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const l = await bucket.list({ prefix, cursor })
    out.push(...l.objects.map((o) => o.key))
    cursor = l.truncated ? l.cursor : undefined
  } while (cursor)
  return out
}

// ---- helpers -----------------------------------------------------------------

type Stream = { machine: string; writer: WritableStreamDefaultWriter<Uint8Array>; idle: ReturnType<typeof setTimeout> | null }

const send = (ws: WebSocket, m: HubMsg) => { try { ws.send(JSON.stringify(m)) } catch { /* gone */ } }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const cookies = (req: Request, name: string) => (req.headers.get('cookie') ?? '').split(/;\s*/).filter((c) => c.startsWith(`${name}=`)).map((c) => c.slice(name.length + 1))
const cookie = (req: Request, name: string) => cookies(req, name)[0]
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const token = () => toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!)
async function hash(s: string) { return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))) }
// A request a page on this site made: a browser sends Origin on a WebSocket and on any POST, PUT, PATCH or DELETE.
// A GET from another codinger.app host (an artifact's <img>, say) has no Origin but carries the
// sign-in cookie, as the cookie is SameSite=Lax; Sec-Fetch-Site says where it came from.
function sameOrigin(req: Request, url: URL) {
  const o = req.headers.get('origin')
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  return o ? o === url.origin : req.method === 'GET' || req.method === 'HEAD'
}

function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// The critter, as on codinger.app.
const CRITTER = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 -1 16 14' width='34' height='30' shape-rendering='crispEdges'><rect x='3' y='3' width='10' height='1' fill='#2b98c6'/><rect x='2' y='4' width='12' height='5' fill='#2b98c6'/><rect x='3' y='9' width='10' height='1' fill='#2b98c6'/><rect x='0' y='6' width='2' height='2' fill='#2b98c6'/><rect x='14' y='6' width='2' height='2' fill='#2b98c6'/><rect x='5' y='4' width='1' height='2' fill='#222'/><rect x='10' y='4' width='1' height='2' fill='#222'/><rect x='4' y='10' width='2' height='2' fill='#2b98c6'/><rect x='10' y='10' width='2' height='2' fill='#2b98c6'/></svg>`
const ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 -1 16 14' shape-rendering='crispEdges'><rect x='3' y='3' width='10' height='1' fill='%232b98c6'/><rect x='2' y='4' width='12' height='5' fill='%232b98c6'/><rect x='3' y='9' width='10' height='1' fill='%232b98c6'/><rect x='0' y='6' width='2' height='2' fill='%232b98c6'/><rect x='14' y='6' width='2' height='2' fill='%232b98c6'/><rect x='5' y='4' width='1' height='2' fill='%23222'/><rect x='10' y='4' width='1' height='2' fill='%23222'/><rect x='4' y='10' width='2' height='2' fill='%232b98c6'/><rect x='10' y='10' width='2' height='2' fill='%232b98c6'/></svg>"

// A page of the hub's own (sign-in, connecting a machine), in codinger.app's colors.
function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Codinger</title><link rel="icon" href="${ICON}">
<style>
:root { color-scheme: light dark; --bg: #faf9f6; --fg: #23201c; --muted: #7a746a; --line: #e3dfd6; --card: #fff; --accent: #1f7fae; --accent-ink: #fff; --field: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1c1a; --fg: #ebe7df; --muted: #9a948a; --line: #3a3732; --card: #2c2a26; --accent: #3a9cd0; --accent-ink: #08202c; --field: #23221f; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem 1rem;
  background: var(--bg); color: var(--fg); font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.brand { display: flex; align-items: center; gap: .55rem; margin-bottom: 1.4rem; font-weight: 700; font-size: 1.15rem; color: var(--fg); text-decoration: none; }
.brand small { font-weight: 400; color: var(--muted); }
.card { width: 100%; max-width: 25rem; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1.6rem 1.7rem; box-shadow: 0 10px 30px rgba(0, 0, 0, .07); }
h1 { margin: 0 0 .7rem; font-size: 1.3rem; }
p { margin: 0 0 1rem; }
p:last-child { margin-bottom: 0; }
.muted { color: var(--muted); font-size: .92rem; }
a { color: var(--accent); }
form { margin: 0; }
input { width: 100%; font: inherit; padding: .65rem .8rem; border: 1px solid var(--line); border-radius: 9px; background: var(--field); color: var(--fg); }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
button { width: 100%; font: inherit; font-weight: 600; padding: .65rem .8rem; border: none; border-radius: 9px; background: var(--accent); color: var(--accent-ink); cursor: pointer; }
button:hover { filter: brightness(1.08); }
.code { font: 600 1.5rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .18em; text-align: center; padding: .5rem; border: 1px dashed var(--line); border-radius: 9px; margin-bottom: 1rem; }
footer { margin-top: 1.4rem; font-size: .85rem; color: var(--muted); }
footer a { color: var(--muted); }
</style>
<a class="brand" href="/">${CRITTER}<span>Codinger <small>web</small></span></a>
<main class="card"><h1>${esc(title)}</h1>${body}</main>
<footer><a href="https://codinger.app">codinger.app</a></footer></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

const loginPage = (next: string) => page('Sign in', `<p class="muted">We email you a link to sign in. It works once, for 15 minutes.</p><form method="post"><input type="hidden" name="next" value="${esc(next)}"><p><input type="email" name="email" placeholder="Your email address" autocomplete="email" required autofocus></p><button>Email me a link</button></form>`)
const verifyPage = (t: string) => page('Sign in', `<p class="muted">Click to finish signing in on this browser.</p><form method="post"><input type="hidden" name="t" value="${esc(t)}"><button autofocus>Sign in</button></form>`)
