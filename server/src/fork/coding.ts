/**
 * Coding: the T3 Code threads each agent launched, listed in the room panel's
 * Coding tab (src/next/panel/CodingTab.tsx), and a wake for the agent when one
 * comes to rest or asks a question.
 *
 * T3 keeps no record of which MCP client made a thread, so the computer marks
 * it: a PreToolUse hook in Claude Code and Codex (computer/t3-tag.mjs in the
 * deploy repo) puts `[@<agent id>] ` before the title of every
 * t3_thread_launch, or `[@<name> · <agent id>] ` once the agent's name stops
 * matching its id. The server reads every project of every T3 server for
 * titles with that mark and copies them into the fork store, so a missed poll
 * or a restart loses nothing: T3 holds the record. A read lists every project
 * of a server, so it comes every few seconds only while T3 may be changing a
 * marked thread (hot) and once a minute otherwise, and each server is read on
 * its own, so one that sleeps holds back nothing. A change is announced to the
 * workspace, whose open Coding tabs then read their list again. A thread keeps
 * the agent of its first copy, so renaming it in T3 does not move it. A thread
 * renamed without its mark, archived or deleted in T3 stays as it was last read.
 *
 * compose names the T3 servers in T3_FILE (the MCP server name Claude Code
 * knows each by, its URL and its token file) and mounts the server's own T3
 * tokens read-only under TOKEN_DIR. They are approved Read only in T3, so they
 * list threads but cannot start one. They last 30 days without a refresh, so a
 * failing server is shown under the list instead of the list going quiet.
 *
 * A row of the list opens the thread's detail, which reads T3 when it opens:
 * the thread's branch, its newest messages and the question it waits on, and
 * the address the T3 Code app opens it at. A Read only token cannot answer a
 * question, so the detail sends the viewer to the T3 app for that.
 *
 * When a thread ends or waits for the answer to a question, the agent that
 * launched it is woken through ./dispatch.ts, like a trigger (./triggers.ts). The hook cannot
 * tell which room the agent was working in, so the wake goes to the room of the
 * turn that launched the thread: the computer's daemon puts the room of each
 * turn on its calls in upstream's llm_calls (launchRoom).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Request, Response } from 'express'
import type { AuthedRequest } from '../auth.js'
import { postWake, type Wake } from './dispatch.js'
import { preview, redact } from './redact.js'
import { isPrivileged } from './roles.js'
import { codingWakeKey, getForkStore, type CodingThread, type NewCodingThread } from './store.js'

// The poller asks this often whether a T3 server is hot (two small queries)
// and reads it then; otherwise it reads it once a minute, for a person acting
// on a marked thread in T3 itself.
const HOT_MS = 3_000
const COLD_MS = 60_000
// T3's statuses of a thread that is still moving (the Coding tab's ACTIVE).
const MOVING = ['preparing', 'queued', 'starting', 'running', 'waiting'] as const
// Same convention as the recorder: relative to the server's cwd, where compose
// puts the T3 server list and mounts the server's T3 tokens.
const T3_FILE = resolve(process.cwd(), 'server/computer/t3code.json')
const TOKEN_DIR = resolve(process.cwd(), 'server/computer/t3code')
const PROTOCOL = '2025-06-18'
// What computer/t3-tag.mjs puts before a title: the agent id, a slug like
// recorder.ts's AGENT_ID, made from the name the agent was created with. Once
// the agent's name stops matching it, the name and ` · ` come before the id.
// The id is the last part, since a name may hold ` · ` itself (the hook drops
// `]` from it). T3's titleContains filter looks for the mark's opening.
const MARK = '[@'
const MARKED = /^\[@(?:[^\]]* · )?([a-z0-9][a-z0-9._-]{0,99})\] ?/i
// Where a thread rests until someone acts on it: T3's statuses, and 'question'
// for a running thread that waits for an answer. T3's own `waiting` is not one:
// T3 shows a run that just finished as waiting while it saves the checkpoint.
const WAKE_STATUSES = ['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back', 'question'] as const
// A thread first copied this long after it came to rest is history: the store
// was new or the server was down, and its agent is not woken for it.
const STALE_MS = 30 * 60_000
// ponytail: the Coding tab shows each agent's 10 most recently changed
// threads; page the route if someone needs the older ones there.
const LIST = 10
// A thread's detail shows its newest MESSAGES as Markdown, each cut to TEXT
// characters, which leaves a usual reply whole for its copy button. T3 sends
// T3_TEXT, twice TEXT, so redact() sees a secret whole before the cut. T3
// pages a timeline from its start and counts every item in it, tool calls
// too, so the messages are looked for among the newest TAIL items.
// ponytail: a thread busy with tools for longer than TAIL items shows no
// messages; the T3 app shows them all.
const MESSAGES = 4
const TEXT = 4_000
const T3_TEXT = TEXT * 2
const TAIL = 200
// T3's message items, as the detail names them.
const KINDS = new Map<string, ThreadDetail['messages'][number]['kind']>([
  ['user_message', 'request'], ['assistant_message', 'reply'], ['proposed_plan', 'plan'],
])
// The schemes the T3 Code app answers to: `t3code`, and `t3code-dev` or
// `t3code-preview` for its other builds (T3's packages/shared/src/promptLinks.ts).
const T3_SCHEME = /^t3code(?:-[a-z]+)?$/

interface T3Server { name: string; url: string; tokenFile: string }
/** T3_FILE: the T3 servers, and the scheme of the T3 app that opens their
 *  threads (`t3code` when it names none). A server's name is an MCP server
 *  name, which holds no ':', so the client's `?t3=<server>:<thread id>` key
 *  splits at its first ':' even though a thread id holds one (`mcp:<uuid>`). */
interface T3File { scheme?: string; servers: T3Server[] }
interface T3Thread {
  threadId: string
  title: string
  status: string
  latestRunId: string | null
  // Missing on older T3 servers. A state is null until T3 has read the host.
  pullRequests?: Array<{ number: number; url: string; state: string | null }>
  createdAt: string
  updatedAt: string
}
/** A marked thread as read from T3, with its question if it waits for an answer. */
type ReadThread = Omit<T3Thread, 'pullRequests'> & Pick<CodingThread, 'pullRequests' | 'requestId'>
/** What t3_thread_read answers, as far as the detail reads it. */
interface T3Timeline {
  thread: { itemCount: number; pendingRequestCount: number; branch: string | null }
  items: Array<{ position: number; type: string; text: string | null; textTruncated: boolean; updatedAt: string }>
  nextPosition: number | null
  hasMore: boolean
}
/** One question of a pending request, as t3_pending_request_read answers it. */
interface T3Question { id: string; header: string; question: string; options: Array<{ label: string; description: string }> }
/** What a thread's detail shows beyond its copy, its text redacted (threadDetail). */
export interface ThreadDetail {
  branch: string | null
  questions: Array<{ id: string; header: string; text: string; options: Array<{ label: string; description: string }> }>
  messages: Array<{ id: number; kind: 'request' | 'reply' | 'plan'; text: string; at: string }>
  /** Where the T3 Code app opens the thread. */
  link: string
}
interface ToolResult { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }
interface T3Session {
  call: <T>(name: string, args: Record<string, unknown>) => Promise<T>
  /** Ends the session; T3 keeps a session it is not told about until it restarts. */
  close: () => Promise<void>
}

/** The launching agent's id and the title without its mark, or null when no agent marked the title. */
export function parseMark(title: string): { agentId: string; title: string } | null {
  const m = MARKED.exec(title)
  return m ? { agentId: m[1], title: title.slice(m[0].length) } : null
}

function t3File(): T3File {
  if (!existsSync(T3_FILE)) return { servers: [] }
  return JSON.parse(readFileSync(T3_FILE, 'utf8')) as T3File
}

/** A message as the detail shows it: preview() redacts before it cuts and
 *  keeps the lines, and "…" also marks where T3 cut it. */
function clip(text: string, cut: boolean): string {
  const shown = preview(text, TEXT, { keepLines: true }) ?? ''
  return cut && !shown.endsWith('…') ? `${shown}…` : shown
}

/** Ends a T3 session. One left open costs T3 a little memory until it
 *  restarts, so a failed close is logged rather than failing the read. */
async function closeQuietly(t3: T3Session, server: T3Server): Promise<void> {
  await t3.close().catch((err: unknown) => console.warn(`[fork] could not close the T3 session on ${server.name}:`, err))
}

/** Opens an MCP session with a T3 server. */
async function connect(server: T3Server): Promise<T3Session> {
  const token = readFileSync(join(TOKEN_DIR, server.tokenFile), 'utf8').trim()
  // Checked here, without the value: fetch would put a malformed header value
  // in its error, and the error reaches the log and the Coding tab.
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error(`${server.tokenFile} does not hold a one-line token`)
  let session: string | null = null
  let id = 0
  const headers = (): Record<string, string> => ({
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL } : {}),
  })
  const post = async (message: { method: string; params: object; id?: number }): Promise<unknown> => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`T3 answered ${res.status}${res.status === 401 ? ': the token may have expired' : ''}`)
    }
    session ??= res.headers.get('mcp-session-id')
    // A notification is answered with an empty 202.
    if (message.id === undefined) {
      await res.body?.cancel()
      return null
    }
    // T3 answers with JSON; the transport also allows an event stream, which T3 does not use.
    if (!res.headers.get('content-type')?.includes('application/json')) throw new Error(`T3 answered ${res.headers.get('content-type')}, not JSON`)
    const reply = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (reply.error) throw new Error(reply.error.message)
    return reply.result
  }
  await post({ id: ++id, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cumora-coding', version: '1' } } })
  await post({ method: 'notifications/initialized', params: {} })
  return {
    call: async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = (await post({ id: ++id, method: 'tools/call', params: { name, arguments: args } })) as ToolResult
      if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? 'failed'}`)
      return (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null')) as T
    },
    close: async () => {
      if (!session) return
      const res = await fetch(server.url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(15_000) })
      await res.body?.cancel()
      if (!res.ok) throw new Error(`T3 answered ${res.status} to closing the session`)
    },
  }
}

/** Every thread of every project on the server whose title carries a mark.
 *  T3 lists threads per project only, for a caller outside a T3 thread.
 *  Exported for tests, which fake T3 at fetch.
 *  ponytail: one t3_thread_list per project per read, each filtered by T3
 *  to marked titles. Skip projects without marked threads if T3 feels it. */
export async function markedThreads(server: T3Server): Promise<ReadThread[]> {
  const t3 = await connect(server)
  try {
    const projects: Array<{ id: string; deletedAt: string | null }> = []
    for (let cursor: number | undefined; ;) {
      const page = await t3.call<{ projects: typeof projects; nextCursor?: number | null }>('t3_project_list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
      projects.push(...page.projects)
      if (typeof page.nextCursor !== 'number' || page.projects.length === 0) break
      cursor = page.nextCursor
    }
    const threads: ReadThread[] = []
    for (const p of projects) {
      if (p.deletedAt) continue
      for (let cursor = 0; ;) {
        const page = await t3.call<{ threads: T3Thread[]; nextCursor?: number | null }>('t3_thread_list', { projectId: p.id, titleContains: MARK, limit: 100, cursor })
        for (const t of page.threads) {
          // T3 tells a question by its pending request, not by the thread's
          // status: the run stays running while it waits for the answer.
          const asked = t.status === 'running'
            ? (await t3.call<{ requestIds: string[] }>('t3_pending_request_list', { threadId: t.threadId })).requestIds
            : []
          const pullRequests = (t.pullRequests ?? []).map(({ number, url, state }) => ({ number, url, state }))
          threads.push({ ...t, pullRequests, requestId: asked[0] ?? null })
        }
        if (typeof page.nextCursor !== 'number' || page.threads.length === 0) break
        cursor = page.nextCursor
      }
    }
    return threads
  } finally {
    await closeQuietly(t3, server)
  }
}

/** What a thread's detail shows beyond the copy, read from T3 when it opens,
 *  with its link in `scheme`: the scheme of the T3 app build the instance's
 *  people use, since a build other than T3's own answers only to its own.
 *  Exported for tests, which fake T3 at fetch. */
export async function threadDetail(server: T3Server, threadId: string, scheme: string): Promise<ThreadDetail> {
  // Checked first: a mistyped scheme fails before T3 is read for nothing.
  if (!T3_SCHEME.test(scheme)) throw new Error(`the T3 app scheme ${scheme} is not one the T3 app answers to`)
  const t3 = await connect(server)
  try {
    const { environmentId } = await t3.call<{ environmentId: string }>('t3_environment_read', {})
    // The first read only learns how long the timeline is.
    const { thread } = await t3.call<T3Timeline>('t3_thread_read', { threadId, limit: 1, maxCharsPerItem: 1 })
    const items: T3Timeline['items'] = []
    for (let after = Math.max(-1, thread.itemCount - TAIL - 1); ;) {
      const page = await t3.call<T3Timeline>('t3_thread_read', { threadId, afterPosition: after, limit: 100, maxCharsPerItem: T3_TEXT })
      items.push(...page.items)
      if (!page.hasMore || page.nextPosition === null) break
      after = page.nextPosition
    }
    // A pending request may also be an approval, which T3 does not list here.
    const [requestId] = thread.pendingRequestCount > 0
      ? (await t3.call<{ requestIds: string[] }>('t3_pending_request_list', { threadId })).requestIds
      : []
    const questions = requestId
      ? (await t3.call<{ questions: T3Question[] }>('t3_pending_request_read', { threadId, requestId })).questions
      : []
    const messages = items.flatMap((m) => {
      const kind = KINDS.get(m.type)
      return kind ? [{ m, kind }] : []
    }).slice(-MESSAGES)
    return {
      // The agent may have named the branch, so it is agent text too.
      branch: thread.branch === null ? null : redact(thread.branch),
      questions: questions.map((q) => ({
        id: q.id,
        header: redact(q.header),
        text: redact(q.question),
        options: q.options.map((o) => ({ label: redact(o.label), description: redact(o.description) })),
      })),
      messages: messages.map(({ m, kind }) => ({ id: m.position, kind, text: clip(m.text ?? '', m.textTruncated), at: m.updatedAt })),
      link: `${scheme}://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
    }
  } finally {
    await closeQuietly(t3, server)
  }
}

/** The workspace of each id that is an agent; ids that are not stay out. */
async function agentCompanies(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  // Imported here, not at the top: db/pool.js loads env.ts, which exits
  // without OPENAI_API_KEY and would kill the tests that import this module.
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ id: string; company_id: string }>(
    `SELECT id, company_id FROM participants WHERE id = ANY($1::text[]) AND kind = 'agent'`,
    [ids],
  )
  return new Map(rows.map((r) => [r.id, r.company_id]))
}

/** The room of the turn that launched a thread at `at`: the room on the first
 *  turn call the agent records from then on. Claude Code records each model
 *  call as it ends (the launching call, or the next one, which reads the
 *  launch's result) and Codex a whole turn when it ends, so that call is the
 *  launching turn's. undefined while the turn has recorded nothing since the
 *  launch; null when the turn had no one room.
 *  ponytail: a turn that answers several rooms at once records none of them,
 *  and its thread wakes nobody.
 *  Exported for tests. */
export async function launchRoom(agentId: string, at: string): Promise<string | null | undefined> {
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ conversation_id: string | null }>(
    `SELECT conversation_id FROM llm_calls
      WHERE agent_id = $1 AND purpose = 'agent-turn' AND created_at >= $2::timestamptz
      ORDER BY created_at LIMIT 1`,
    [agentId, at],
  )
  return rows.length === 0 ? undefined : rows[0].conversation_id
}

/** Whether T3 may be changing a marked thread on `server` now: a thread copied
 *  from it is still moving, or an agent's status was set or renewed within the
 *  busy lease. A computer agent renews it all through a turn, where it may
 *  launch a thread, and sets it again when the turn ends, so a launch at the
 *  very end of a turn is still read soon.
 *  Exported for tests. */
export async function hot(server: string): Promise<boolean> {
  if ((await getForkStore()).codingThreadIn(server, MOVING)) return true
  // Imported here, like db/pool.js: status.js loads it.
  const [{ pool }, { BUSY_STATUS_LEASE_MS }] = await Promise.all([import('../db/pool.js'), import('../status.js')])
  const { rows } = await pool.query<{ busy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM participants WHERE kind = 'agent' AND status_updated_at > NOW() - $1 * interval '1 millisecond'
     ) AS busy`,
    [BUSY_STATUS_LEASE_MS],
  )
  return rows[0].busy
}

/** Tells the open Coding tabs of each workspace that its copy changed, so they
 *  read it again. Like ./agentTool.ts, it goes straight to Redis on the status
 *  channel, which ws.ts fans out to the workspace. It names no thread: every
 *  member gets it, and a title is for owners and admins. */
async function announce(companyIds: Set<string>): Promise<void> {
  if (companyIds.size === 0) return
  // Imported here: redis.js loads env.ts, which exits without OPENAI_API_KEY in tests.
  const { redis, CH_STATUS } = await import('../redis.js')
  for (const companyId of companyIds) await redis.publish(CH_STATUS, JSON.stringify({ type: 'fork.coding', companyId }))
}

/** Every workspace with an agent: a failing T3 server shows under each one's list. */
async function agentWorkspaces(): Promise<string[]> {
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM participants WHERE kind = 'agent'`)
  return rows.map((r) => r.company_id)
}

function wakeOf(t: CodingThread, room: string): Wake {
  const where = `on the T3 MCP server ${t.server} (threadId ${t.threadId})`
  const question = t.status === 'question'
  return {
    companyId: t.companyId,
    assigneeId: t.agentId,
    conversationId: room,
    eventKind: 'coding',
    // Everyone in the room can read this message, so it carries no text of the
    // thread: a title is agent text that can quote any room, which agentCoding
    // shows to owners and admins only. The agent reads the thread itself.
    title: question ? 'A T3 Code thread needs an answer' : `A T3 Code thread is ${t.status}`,
    description: `The T3 Code thread ${t.threadId} on ${t.server}, whose title carries your mark, ${question ? 'waits for an answer' : `is ${t.status}`}.`,
    agentPrompt: question
      ? `Read its question with t3_pending_request_read (requestId ${t.requestId}) ${where}. Answer it with t3_pending_request_respond when the answer is yours to give, or ask the people in this room. Never answer with a secret or a credential unless a person in this room tells you to.`
      : `Read how it went with t3_thread_read ${where} and tell this room in a short message, unless you already did.`,
    scheduledFor: t.updatedAt,
  }
}

async function wake(t: CodingThread): Promise<void> {
  const store = await getForkStore()
  const key = codingWakeKey(t)
  const room = t.conversationId ?? await launchRoom(t.agentId, t.createdAt)
  // The launching turn is still running and has recorded nothing since the
  // launch, so the agent is busy anyway: a later poll asks again.
  if (room === undefined) return
  if (room === null) {
    console.warn(`[fork] T3 thread ${t.threadId} of ${t.agentId} is ${t.status}, but the room it was launched from is unknown`)
    store.markCodingWoken(t.server, t.threadId, key, 'the room it was launched from is unknown')
    return
  }
  // Claimed before the post, like a trigger firing (./triggers.ts): a crash
  // between the two must not wake the agent twice.
  store.markCodingWoken(t.server, t.threadId, key, null, room)
  try {
    await postWake(wakeOf(t, room))
  } catch (err) {
    console.error(`[fork] could not wake ${t.agentId} for T3 thread ${t.threadId}:`, err)
    store.markCodingWoken(t.server, t.threadId, key, err instanceof Error ? err.message : String(err))
  }
}

// Why the last poll of each T3 server failed, shown under the coding list. The
// same failure on every poll is logged once.
const pollErrors = new Map<string, string>()

async function poll(server: T3Server): Promise<void> {
  const failed = pollErrors.get(server.name)
  const seen: Array<{ thread: ReadThread; agentId: string; title: string }> = []
  try {
    for (const thread of await markedThreads(server)) {
      const mark = parseMark(thread.title)
      if (mark) seen.push({ thread, ...mark })
    }
    pollErrors.delete(server.name)
  } catch (err) {
    // Shown under every workspace's list, and T3's error text can quote a thread.
    const message = redact(err instanceof Error ? err.message : String(err))
    if (failed !== message) console.error(`[fork] T3 poll of ${server.name} failed:`, err)
    pollErrors.set(server.name, message)
  }
  const store = await getForkStore()
  const companies = await agentCompanies([...new Set(seen.map((s) => s.agentId))])
  const known = store.codingThreadKeys()
  const threads: NewCodingThread[] = []
  for (const { thread, agentId, title } of seen) {
    const companyId = companies.get(agentId)
    if (!companyId) continue
    const t: CodingThread = {
      server: server.name, threadId: thread.threadId, companyId, agentId,
      // Found by its first wake: the launching turn may not have recorded a call yet.
      conversationId: null,
      title, status: thread.requestId ? 'question' : thread.status, runId: thread.latestRunId, requestId: thread.requestId,
      pullRequests: thread.pullRequests, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    }
    const fresh = !known.has(`${server.name} ${thread.threadId}`)
    threads.push({ ...t, woken: fresh && Date.now() - Date.parse(t.updatedAt) > STALE_MS ? codingWakeKey(t) : null })
  }
  const changed = store.saveCodingThreads(threads)
  if (pollErrors.get(server.name) !== failed) for (const id of await agentWorkspaces()) changed.add(id)
  await announce(changed)
  for (const t of store.codingWakesDue(server.name, WAKE_STATUSES)) await wake(t)
}

let started = false

export function startCodingPoller(): void {
  if (started) return
  started = true
  for (const server of t3File().servers) {
    let read = 0
    // The same failure on every tick is logged once.
    let failed: string | null = null
    const tick = async () => {
      try {
        if (Date.now() - read >= COLD_MS || await hot(server.name)) {
          read = Date.now()
          await poll(server)
        }
        failed = null
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (failed !== message) console.error(`[fork] coding poll of ${server.name} failed:`, err)
        failed = message
      }
      setTimeout(() => void tick(), HOT_MS).unref()
    }
    setTimeout(() => void tick(), 15_000).unref()
  }
}

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/** Whether the viewer may read what agents code, answering 403 when not:
 *  workspace owners and admins only, since a thread's title and messages are
 *  agent text, which can quote any room. Both coding routes go through here. */
async function mayReadCoding(companyId: string, userId: string, res: Response): Promise<boolean> {
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ role: string | null }>(
    'SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2',
    [companyId, userId],
  )
  if (isPrivileged(rows[0]?.role)) return true
  res.status(403).json({ error: 'only workspace owners and admins can read what agents code' })
  return false
}

/** A copied thread as both coding routes send it. */
const shownThread = (t: CodingThread) => ({
  server: t.server, threadId: t.threadId, title: redact(t.title), status: t.status,
  pullRequests: t.pullRequests, createdAt: t.createdAt, updatedAt: t.updatedAt,
})

/** GET /api/fork/agents/:agentId/coding: an agent's newest threads. */
export async function agentCoding(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const { userId, companyId } = await requireCompany(req)
  if (!(await mayReadCoding(companyId, userId, res))) return
  const agentId = String(req.params.agentId)
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ agent: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM participants WHERE id = $1 AND company_id = $2 AND kind = 'agent') AS agent`,
    [agentId, companyId],
  )
  if (!rows[0].agent) {
    res.status(404).json({ error: 'not found' })
    return
  }
  const threads = (await getForkStore()).codingThreads(companyId, agentId, LIST)
  res.json({
    threads: threads.map(shownThread),
    servers: t3File().servers.map((s) => ({ name: s.name, error: pollErrors.get(s.name) ?? null })),
  })
}

/** GET /api/fork/coding/:server/:threadId: one thread as copied, with what T3
 *  holds of it now (threadDetail). The server's token reads every thread on
 *  its T3 server, so only a thread copied for an agent of the viewer's
 *  workspace is read. When T3 cannot be read, the copy comes with the reason.
 *  Exported for tests. */
export async function codingThread(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const { userId, companyId } = await requireCompany(req)
  if (!(await mayReadCoding(companyId, userId, res))) return
  const t = (await getForkStore()).codingThread(companyId, String(req.params.server), String(req.params.threadId))
  if (!t) {
    res.status(404).json({ error: 'not found' })
    return
  }
  let detail: ThreadDetail | null = null
  let error: string | null = null
  try {
    const { scheme = 't3code', servers } = t3File()
    const server = servers.find((s) => s.name === t.server)
    if (!server) throw new Error(`the T3 server ${t.server} is no longer in this instance's list`)
    detail = await threadDetail(server, t.threadId, scheme)
  } catch (err) {
    // T3's own error text can quote the thread.
    error = redact(err instanceof Error ? err.message : String(err))
  }
  res.json({
    thread: { ...shownThread(t), agentId: t.agentId },
    ...(detail ?? { branch: null, questions: [], messages: [], link: null }),
    error,
  })
}
