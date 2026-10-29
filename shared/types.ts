// Everything the server and the browser both speak. The server keeps one
// append-only event log per session; the browser folds it into a transcript.

import type { Look } from './looks.ts'
import type { Appearance } from './appearance.ts'
import type { Artifact, PreviewTarget, ProlificaState } from './artifacts.ts'
import type { UpdateMode, UpdateStatus } from './update.ts'
import type { Published } from './share.ts'
import type { EmojiUse } from './emoji.ts'
import type { FileVerdict, LineComment } from './review.ts'

export type Status =
  | 'new'        // never sent anything
  | 'working'    // a turn is in flight
  | 'permission' // blocked on you approving a tool call
  | 'asking'     // finished, and left questions for you
  | 'waiting'    // finished, and you haven't looked yet
  | 'idle'       // finished, seen
  | 'error'

export type PermissionMode = 'auto' | 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

// What the lead drafted for a session, in the shape of your own replies: a
// message, an answer to an <ask>, a reply to a <consider> item, or one marked
// done or set aside. key: the item ("<msg>:<id>"); label: its question or title.
// Drafts from before October 2026 have no kind: they are messages.
export type InboxItem = {
  id: string; text: string; from: string; ts: number
  kind?: 'text' | 'answer' | 'reply' | 'done' | 'dismiss'
  key?: string; label?: string; choices?: string[]; draft?: 'same' | 'edited'
}

export type SessionMeta = {
  id: string
  kind: 'worker' | 'lead'
  title: string
  cwd: string
  parentId: string | null
  model: string | null
  permissionMode: PermissionMode
  flags?: string[]        // extra Claude Code flags it starts with (shared/flags.ts)
  claudeSessionId: string
  started: boolean        // the claude session exists on disk, so we --resume it
  createdAt: number
  lastActivity: number
  status: Status
  running: boolean        // a claude process is alive for it right now
  unread: boolean
  compacting: boolean
  context: { used: number; window: number }
  pendingAsks: number
  pendingCritical?: number   // of pendingAsks: the items marked critical
  pendingReviews?: number    // of pendingAsks: the reviews the agent asked for (<review>)
  lastText: string        // the tail of the last thing Claude said, for overviews
  error: string | null
  archived: boolean
  starred?: boolean       // you starred it: its critter has a yellow aura
  inbox: InboxItem[]      // replies the lead agent drafted for this session
  drafting?: boolean      // you have a reply in progress here (the browser says so), so the lead's wait
  look?: Look             // what its critter wears; Claude picks it (shared/looks.ts)
  titleByUser?: boolean   // you named it at some point
  // Claude renamed a session you had named: your name, to undo to; and a name of Claude's you undid.
  titleBefore?: string
  titleUndone?: string
  order?: number          // its place among its siblings in the sidebar, once dragged there
  group?: string          // the sidebar group you put it in (Settings.groups); a child starts in its parent's
  // The prompt cache: when the last API call started (at the latest), and its TTL (ms). See shared/cache.ts.
  cache?: { at: number; ttl: number }
  notes?: NotesState
  // What its API calls cost (notes and keep-warm included), in dollars at API prices,
  // each priced when it was made (shared/prices.ts); since: when Codinger began to count.
  // keep: the part notes and keep-warm calls cost; hours: [hour start, dollars] for the last 7 days.
  spend?: { usd: number; since: number; keep?: number; hours?: [number, number][] }
  // The first API call's prompt: Claude Code's system prompt and tools, and how much of
  // it other sessions had already cached. What a new session would start from.
  base?: { total: number; read: number }
  // Started with your MCP servers off (server/mcpservers.ts); on: the ones turned on since;
  // missing: a server Claude asked for that Codinger doesn't know, until you press Refresh.
  mcp?: { strict: true; on: string[]; missing?: string }
  // The model it will probably run, until Claude Code reports the real one into model.
  expectedModel?: string
  // Set by a rewind: the next start resumes claudeSessionId cut at this entry, as a fork.
  resumeAt?: string | null
  autopilot?: Autopilot
  // Messages between sessions (server/mail.ts). mailFilter: who else may send to it (unset: every
  // session; set_inbox narrows it); its parent and children always may. mail: messages waiting
  // to go in (it is mid-turn, or held for your OK).
  // mailRun: messages in a row from each sender since you last wrote in either session.
  // parentWaits: its parent sent it work, so the parent hears when it next goes idle.
  mailFilter?: MailFilter
  mail?: Mail[]
  mailRun?: Record<string, number>
  parentWaits?: boolean
  share?: Published       // its transcript, published read-only (server/share.ts)
}

// none: only its parent and children (the default); only: those, and the sessions in ids.
export type MailFilter = { mode: 'any' | 'only' | 'none'; ids?: string[] }
// A message from one session to another. replyTo: the message it answers, and the start of
// its text. idle: Codinger's note that a child ended its turn. held: past the limit of
// messages in a row, it waits for your OK. step: from a child to its parent, it waits for the
// child's next tool call or the end of its turn; endTurn: the child's turn ended after it.
export type Mail = {
  id: string; from: string; title: string; text: string; ts: number
  replyTo?: { id: string; text: string }; idle?: boolean; held?: boolean; step?: boolean; endTurn?: boolean
}

// Autopilot (server/autopilot.ts): after each turn Codinger tells Claude to go on, until the
// budget is spent or Claude stops. unit: dollars at API prices, or a share (0–1) of the 5-hour
// or weekly limit. from: the session's spend and the limit's share used when it started;
// used: the budget spent so far, in its unit; idle: turns in a row with no tool call.
export type BudgetUnit = 'usd' | 'fiveHour' | 'sevenDay'
export type Autopilot = {
  goal: string; unit: BudgetUnit; budget: number; used: number
  from: { usd: number; share?: number }; at: number; turns: number; idle: number
  ended?: { reason: string; at: number }
}

// Rolling notes on a session, and the keep-warm calls that keep its prompt cache
// alive while it waits for you (server/notes.ts).
export type NotesState = {
  at?: number              // when the notes file was last written
  upTo?: number            // the session's lastActivity that those notes cover
  running?: 'notes' | 'ping'
  quiet?: number           // the lastActivity this spell of quiet started at
  spent?: number           // dollars at API prices (shared/prices.ts) the calls cost in this spell
  calls?: number
  end?: { reason: string; at: number }  // keep-warm stopped for this spell; at: when the cache expires
  off?: string             // keep-warm stopped for this session until you turn it on again
  size?: number            // tokens in the notes, roughly
}

export type ImageRef = { url: string; mediaType: string }

// A quote's position inside one rendered message: per markdown block, the
// Marginer quote pieces (text runs + their occurrence numbers) in that block.
export type AnchorPiece = { block: number; quotes: string[]; nths: number[] }
export type Anchor = { msg: string; pieces: AnchorPiece[] }
// A place in an artifact's page (web/src/frame/notes.ts): an element, or text inside one.
// pid: the data-pid of the element, or of the nearest one around it; path: a CSS path from there
// (or from <body>) when the element has no data-pid of its own; tag: "svg rect", "div"...;
// label: what the element says (aria-label, data-label, or its text); text: selected text, and
// which occurrence of it in the element it is. v: an old version of the artifact; at: the time of
// the artifact's last change when the comment began (its highlight shows until the next change).
export type ArtifactAnchor = { artifact: string; v?: number; at?: number; pid?: string; path?: string; tag?: string; label?: string; text?: { quote: string; nth: number } }

export type Part =
  | { kind: 'text'; text: string; images?: ImageRef[] }
  // itemKey: the <consider> item this comment replies to ("<msg>:<id>").
  // whole: a reaction to a whole paragraph or list item.
  | { kind: 'note'; text: string; quote: string; anchor: Anchor; images?: ImageRef[]; itemKey?: string; whole?: boolean }
  // A comment on an element or text of an artifact in the preview pane.
  | { kind: 'artifact'; text: string; quote: string; anchor: ArtifactAnchor; images?: ImageRef[] }
  // draft: the answer to a <draft>, sent back as Claude wrote it or edited.
  | { kind: 'answer'; text: string; askKey: string; question: string; choices?: string[]; images?: ImageRef[]; draft?: 'same' | 'edited' }
  // Questions and items the user saw and set aside.
  | { kind: 'dismiss'; text: string; items: { key: string; label: string }[]; images?: ImageRef[] }
  // Items the user marked done; `text` on one is a problem they hit doing it.
  // result: how a command the item asked for went.
  | { kind: 'done'; text: string; items: { key: string; label: string; text?: string; result?: string }[]; images?: ImageRef[] }
  // Verdicts on the agent's changes and comments on their lines (shared/review.ts).
  | { kind: 'review'; text: string; files: FileVerdict[]; comments: LineComment[]; images?: ImageRef[] }
  // A message from another session (see Mail); relation: what the sender is to this session.
  | { kind: 'mail'; text: string; id: string; from: string; title: string; relation?: 'parent' | 'child'; replyTo?: { id: string; text: string }; idle?: boolean; endTurn?: boolean; images?: ImageRef[] }

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }

type E<T extends string, B> = { seq: number; ts: number; t: T } & B

export type Event =
  // uuid: the id Claude Code gave the message in its transcript (we choose it);
  // csid: the Claude session it went to. A rewind cuts the transcript there.
  | E<'user', { parts: Part[]; from?: string; uuid?: string; csid?: string; tasks?: string[] }>   // tasks: ids of tasks whose end it tells of
  | E<'assistant', { msgId: string; blocks: Block[]; synthetic?: boolean }>
  | E<'tool_result', { toolUseId: string; text: string; isError: boolean }>
  | E<'permission', { requestId: string; toolName: string; input: any; description?: string; canAlways: boolean; toolUseId?: string }>
  | E<'permission_resolved', { requestId: string; resolution: 'allow' | 'always' | 'deny' | 'cancelled' }>
  | E<'notice', { text: string; level: 'info' | 'warn' | 'error'; task?: string }>   // task: the id of a task that ended
  | E<'result', { durationMs: number; isError: boolean; text?: string }>

// Claude Code's login: 'pending' while `claude auth login` waits for you (url: its sign-in page).
export type AuthState = { state: 'ok' | 'needed' | 'pending' | 'failed'; url?: string; error?: string }
// Remote access through web.codinger.app (server/remote.ts). linked: it has its token;
// linking: waiting for you to approve the code on the web.
export type RemoteStatus = { hub: string; name: string; label?: string; on: boolean; linked: boolean; connected: boolean; linking?: { code: string; url: string } }

// rate: how much of each window a dollar of spend (at API prices) uses, as server/meter.ts estimates it.
// overage: extra usage paid for the call that sent this report.
export type Usage = { fiveHour?: number; sevenDay?: number; resetsAt?: number; status?: string; overage?: boolean; rate?: { fiveHour?: number; sevenDay?: number; pairs: number } }
// trackedFiles: files whose history Codinger keeps, besides AGENTS.md, CLAUDE.md and LEAD_NOTES.md.
// selfRestart: offer to restart when Codinger's own code changes (for working on Codinger); off by default.
// resumeCut: a turn the server's stop cut short (a crash, a forced stop; not a restart, which keeps it
// running) goes on when the server starts again; off by default.
// appearance: unset until you pick one, which the first load asks you to do.
// groupOrder: the lead's folders, once you drag one. groups: the sidebar's groups you made, top first. cacheGuard: tokens; see shared/cache.ts.
// notes, keepWarmHours, keepWarmMax, keepWarmUsage: see server/notes.ts.
// estimates: agents may estimate in agent time and dollars, and save each estimate with what the work took (server/estimates.ts); on by default.
// plan: what you pay a month (yearly: you pay for a year, usd is that over 12), for the plan
// you confirmed it for. reviewSeen: the last weekly and monthly review you closed. See shared/costs.ts.
export type SessionGroup = { id: string; name: string }
export type Settings = {
  leadAutoSend: boolean; autoModeMigrated?: boolean; trackedFiles?: string[]; selfRestart?: boolean; resumeCut?: boolean
  appearance?: Appearance; groupOrder?: string[]; groups?: SessionGroup[]; cacheGuard?: number
  notes?: boolean; estimates?: boolean; keepWarmHours?: number; keepWarmMax?: number; keepWarmUsage?: number
  // MCP servers: new sessions start with them off (default), except those always on;
  // Claude may turn one on itself (default) or must ask you.
  mcpStartOff?: boolean; mcpAlways?: string[]; mcpClaude?: boolean
  plan?: { tier: string; usd: number; yearly?: boolean }; reviewSeen?: { week?: string; month?: string }
  autoUpdate?: UpdateMode   // updates from origin/main (server/update.ts); unset: ask
  emoji?: EmojiUse          // the reaction emoji you use, to put first in the rows and the picker
}

export type ServerMsg =
  | { type: 'hello'; sessions: SessionMeta[]; settings: Settings; usage: Usage; platform: string; home: string; auth: AuthState; stale?: boolean; staleAt?: number; update?: UpdateStatus; remote?: RemoteStatus; device?: 'laptop' | 'desktop' }
  | { type: 'device'; device: 'laptop' | 'desktop' }
  | { type: 'remote'; remote: RemoteStatus }
  | { type: 'auth'; auth: AuthState }
  // The server's code on disk is newer than the running server.
  | { type: 'stale'; stale: boolean; staleAt?: number }
  | { type: 'update'; update: UpdateStatus }
  // A tracked file has a new version.
  | { type: 'file'; path: string }
  // A command run from a <run> block ended.
  | { type: 'run'; sessionId: string; token: string; code: number; tail: string }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'event'; sessionId: string; event: Event }
  | { type: 'delta'; sessionId: string; text: string; reset?: boolean }
  // Events from seq on are gone (a rewind).
  | { type: 'truncate'; sessionId: string; seq: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'settings'; settings: Settings }
  | { type: 'tasks'; tasks: Task[] }
  // Every artifact (server/artifacts.ts); port: where the server that runs them listens.
  | { type: 'artifacts'; artifacts: Artifact[]; port: number; prolifica: ProlificaState }
  // An agent showed something in its session's preview pane (show_artifact).
  | { type: 'preview'; sessionId: string; target: PreviewTarget; at: number }

// A long-running command an agent started with start_task (server/tasks.ts).
// notify: how the agent hears that it ended: with its next message, in a turn of
// its own, or by stopping the turn it is in. told: it has heard.
export type TaskNotify = 'next' | 'turn' | 'interrupt'
export type Task = {
  id: string; sid: string; title: string; command: string; cwd: string; pid: number
  started: number; ended?: number; code?: number | null; stopped?: 'user' | 'agent'
  notify: TaskNotify; told?: boolean
  progress?: { pct: number; label?: string }   // read from a progress bar near the end of its log, while it runs
}

export type SlashCommand = { name: string; description: string; argumentHint: string }
export type HistoryItem = {
  id: string; cwd: string; title: string; firstPrompt: string; lastPrompt: string
  mtime: number; size: number; continuedIn: string | null; codingerId: string | null
}
export type RecentDir = { path: string; ts: number; source: 'codinger' | 'claude' | 'both' }
// roots: the drives, on Windows.
export type DirListing = { path: string; parent: string | null; dirs: string[]; roots?: string[] }
