/**
 * Coding: the T3 Code threads the room's agents launched. The server copies
 * them from T3 (server/src/fork/coding.ts) and says on the workspace's socket
 * when its copy changed, so the tab reads the list again then, and the last
 * answer per agent draws the list at once when the tab opens again. A row
 * opens the thread's detail in place of the list (`?t3=<server>:<thread id>`),
 * which T3 is read for when it opens, and its pull request chip opens the last
 * pull request. Owners and admins only, because a title an agent wrote can quote
 * any room. The agent drawer, the agent's workspace and the agent menu read
 * the same lists through `useCoding`; the drawer and the workspace show
 * the list and its detail through `CodingList`.
 */
import { useEffect, useRef, useState } from 'react'
import { http, ws } from '@/api/client'
import { RichBody } from '@/components/Message'
import { useLocale } from '@/lib/i18n'
import { useParticipants } from '@/stores/participants'
import type { Conversation, Participant } from '@/types'
import { agentRef } from '../agentRefs'
import { relative } from '../format'
import { useAdmin, useCopy } from '../hooks'
import { useNT, type NKey } from '../i18n'
import { linkClick, useRoute, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { IconButton, Spinner } from '../ui/primitives'
import { ICheck, ICopy, IInfo, IStop, IX } from '../ui/icons'
import { errText } from '../sections/calendar/parts'
import { useRoomAgents } from '../chat/ChatView'
import { loadableImages, parseThreadKey, threadKey } from './codingText'
import { JobBar } from './JobBar'

export interface Thread {
  server: string
  threadId: string
  title: string
  status: string
  pullRequests: Array<{ number: number; url: string; state: string | null }>
  createdAt: string
  updatedAt: string
}
interface Coding { threads: Thread[]; servers: Array<{ name: string; error: string | null }> }
type AgentCoding = Coding & { agentId: string }
/** GET /api/fork/coding/:server/:threadId: the copy, and what T3 holds of the thread now. */
interface Detail {
  thread: Thread & { agentId: string }
  branch: string | null
  questions: Array<{ id: string; header: string; text: string; options: Array<{ label: string; description: string }> }>
  messages: Array<{ id: number; kind: 'request' | 'reply' | 'plan'; text: string; at: string }>
  /** Where the T3 Code app opens the thread; null when T3 could not be read. */
  link: string | null
  /** Why T3 could not be read. */
  error: string | null
}

// T3's thread statuses, in the words and colours the row uses. T3 shows a run
// that just finished as `waiting` while it saves the checkpoint, and counts it
// as running; 'question' is the server's, for a thread that waits for an answer.
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])
const STOPPED = new Set(['interrupted', 'cancelled', 'rolled_back'])

/** Still going: running, or stopped on a question for someone. */
export const isOpenThread = (t: Thread): boolean => ACTIVE.has(t.status) || t.status === 'question'

// The last answer for each agent, so the list draws at once when the tab opens
// again, and its entrance plays only the first time (src/next/AGENTS.md).
const cache = new Map<string, Coding>()
const cached = (ids: string): AgentCoding[] | null => {
  const lists = ids.split(' ').map((agentId) => {
    const c = cache.get(agentId)
    return c ? { agentId, ...c } : null
  })
  return lists.every((l) => l !== null) ? (lists as AgentCoding[]) : null
}

export function look(status: string): { label: NKey; tone: string; icon: JSX.Element } {
  if (status === 'question') return { label: 'coding.waiting', tone: 'warn', icon: <IInfo aria-hidden /> }
  if (ACTIVE.has(status)) return { label: 'coding.running', tone: 'live', icon: <Spinner /> }
  if (status === 'completed') return { label: 'coding.completed', tone: 'live', icon: <ICheck aria-hidden /> }
  if (status === 'failed') return { label: 'coding.failed', tone: 'bad', icon: <IX aria-hidden /> }
  if (STOPPED.has(status)) return { label: 'coding.stopped', tone: 'muted', icon: <IStop aria-hidden /> }
  return { label: 'coding.idle', tone: 'muted', icon: <span className="nx-coding__dot" aria-hidden /> }
}

/** The pull request a list row shows for a thread: the last one T3 lists. */
export const lastPr = (t: Thread): Thread['pullRequests'][number] | undefined => t.pullRequests[t.pullRequests.length - 1]

/** A running thread counts from its start, a resting one from when it stopped. */
export const threadTime = (t: Thread): string => (isOpenThread(t) ? t.createdAt : t.updatedAt)

/** Newest first, every agent's threads in one list. */
export const newestThreads = (coding: AgentCoding[]): Array<{ t: Thread; agentId: string }> => coding
  .flatMap((c) => c.threads.map((t) => ({ t, agentId: c.agentId })))
  .sort((a, b) => b.t.updatedAt.localeCompare(a.t.updatedAt))

/**
 * Reads now and again when the app comes back to the foreground, and with
 * `socket` also whenever the server's copy may have changed; only the newest
 * read lands. Returns what stops it, with `load` for a read its caller asks for.
 */
function follow<T>(
  read: () => Promise<T>,
  land: (data: T) => void,
  fail: (error: string) => void,
  socket: boolean,
): (() => void) & { load: () => void } {
  let live = true
  // An event can start a read while an older one is still out; only the
  // newest may land.
  let latest = 0
  const load = async () => {
    if (document.hidden) return
    const mine = ++latest
    try {
      const data = await read()
      if (live && mine === latest) land(data)
    } catch (e) {
      if (live && mine === latest) fail(errText(e))
    }
  }
  // Back from the background, the copy may be minutes old. load() itself
  // skips the change to hidden.
  const onVisible = () => void load()
  // `fork.coding` (a fork event, outside the client's event union) says the
  // server's copy changed. `hello` opens every connection, after events missed
  // while the socket was down.
  const off = socket
    ? ws.on((e) => { if (e.type === 'hello' || (e as { type: string }).type === 'fork.coding') void load() })
    : () => {}
  void load()
  document.addEventListener('visibilitychange', onVisible)
  const stop = () => {
    live = false
    off()
    document.removeEventListener('visibilitychange', onVisible)
  }
  return Object.assign(stop, { load: () => void load() })
}

/**
 * The threads of some agents (`ids`, space-joined), read again whenever the
 * server's copy changes. `enabled` false skips the reads, for a viewer the
 * route refuses or a menu that is closed.
 */
export function useCoding(ids: string, enabled = true): { coding: AgentCoding[] | null; fresh: boolean; error: string | null } {
  const [coding, setCoding] = useState(() => cached(ids))
  // Only a list that arrives with a first answer fades in.
  const [fresh, setFresh] = useState(() => cached(ids) === null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    const hit = cached(ids)
    setCoding(hit)
    setFresh(hit === null)
    setError(null)
    return follow(
      () => Promise.all(ids.split(' ').map(async (agentId) =>
        ({ agentId, ...(await http<Coding>(`/fork/agents/${encodeURIComponent(agentId)}/coding`)) }))),
      (lists) => {
        for (const { agentId, threads, servers } of lists) cache.set(agentId, { threads, servers })
        setCoding(lists)
        setError(null)
      },
      setError,
      true,
    )
  }, [ids, enabled])
  // While reads are off, the state can still hold the lists of agents asked
  // about before (the menu reopened on someone else); those never show.
  const own = coding !== null && coding.map((c) => c.agentId).join(' ') === ids
  return { coding: own ? coding : null, fresh, error }
}

function CodingRow({ t, to, agent, server }: { t: Thread; to: string; agent?: Participant; server: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const { label, tone, icon } = look(t.status)
  const pr = lastPr(t)
  const when = relative(threadTime(t), locale)
  return (
    <div className="nx-row nx-coding" data-tone={tone}>
      {icon}
      {agent && <Avatar p={agent} size={20} />}
      {/* Stretched over the whole row; the pull request chip sits above it. */}
      <a className="nx-row__text nx-coding__open" href={to} onClick={linkClick}>
        <span className="nx-coding__title">{t.title}</span>
        {/* The avatar is hidden from screen readers, so the hint names the agent. */}
        <span className="nx-row__hint">{[agent?.name, nt(label), when, server ? t.server : null].filter(Boolean).join(' · ')}</span>
      </a>
      {/* One chip leaves the title room. The detail lists every pull request,
          and a tap on the count opens the detail like the rest of the row. */}
      {pr && <a className="nx-chip nx-mono nx-coding__pr" href={pr.url} target="_blank" rel="noopener noreferrer">#{pr.number}</a>}
      {t.pullRequests.length > 1 && <span className="nx-chip nx-mono">+{t.pullRequests.length - 1}</span>}
    </div>
  )
}

/** Copies a message's Markdown as the server sent it: redacted, and ending in
 *  "…" where it was cut. Always shown, since touch has no hover. */
function CopyMessage({ text }: { text: string }) {
  const { done, label, copy } = useCopy()
  return (
    <IconButton small label={label} onClick={() => copy(text)}>
      {done === 'copied' ? <ICheck aria-hidden /> : <ICopy aria-hidden />}
    </IconButton>
  )
}

/**
 * One thread in place of the list: its copy at once when the list holds it,
 * then what T3 holds of it now. Each read opens a T3 session on the
 * developer's machine, so T3 is read again only when this thread's copy in
 * the list changes (the list follows the workspace's events) or the app comes
 * back to the foreground, not on every change in the workspace. A question is
 * answered in the T3 app: the server's T3 token reads only.
 * ponytail: messages a running thread adds show on the next change of its
 * copy or a return to the app; poll here if someone watches a thread live.
 */
function ThreadDetail({ open, listed, several }: {
  open: Pick<Thread, 'server' | 'threadId'>
  listed?: { t: Thread; agentId: string }
  several: boolean
}) {
  const nt = useNT()
  const locale = useLocale()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const t = detail?.thread ?? listed?.t
  const agentId = detail?.thread.agentId ?? listed?.agentId
  // Several agents share the list: the detail names its own, as its row does.
  const agent = useParticipants((s) => (several && agentId ? s.byId[agentId] : undefined))
  const path = `/fork/coding/${encodeURIComponent(open.server)}/${encodeURIComponent(open.threadId)}`
  const reload = useRef<() => void>(() => {})
  useEffect(() => {
    const stop = follow(() => http<Detail>(path), (d) => { setDetail(d); setError(null) }, setError, false)
    reload.current = stop.load
    return stop
  }, [path])
  // The list's copy of this thread. Its first arrival (a thread opened from a
  // link, before the list loaded) is no change: T3 was read when the detail opened.
  const changed = listed ? `${listed.t.status} ${listed.t.updatedAt}` : null
  const seen = useRef(changed)
  useEffect(() => {
    if (seen.current !== null && changed !== null && changed !== seen.current) reload.current()
    seen.current = changed
  }, [changed])

  const bar = <JobBar param="t3" label={nt('chat.back')} title={t?.title} />
  // A link opened afresh shows nothing of the thread until the server answers.
  if (!t) {
    return (
      <div className="nx-job">
        {bar}
        {error ? <div className="nx-empty" role="alert">{error}</div> : <div className="nx-center" aria-busy="true"><Spinner /></div>}
      </div>
    )
  }
  const { label, tone, icon } = look(t.status)
  const asked = !!detail && detail.questions.length > 0
  return (
    <div className="nx-job">
      {bar}
      <p className="nx-job__who nx-coding" data-tone={tone}>
        {icon}
        {agent && (
          <span className="nx-coding-thread__agent" {...agentRef(agent, agent.name)}>
            <Avatar p={agent} size={20} />
            {agent.name}
          </span>
        )}
        <span>{[nt(label), relative(threadTime(t), locale), t.server].join(' · ')}</span>
      </p>
      {detail?.branch && <p className="nx-job__who nx-mono nx-coding-thread__branch">{detail.branch}</p>}
      {(detail?.link || t.pullRequests.length > 0) && (
        <div className="nx-coding-thread__acts">
          {/* Same window: a custom scheme opened in a new one is dropped by the
              desktop app's window handler; the browser, the desktop app and
              the phone's WebView hand it to the T3 app. A waiting question
              makes it the one thing to do here. */}
          {detail?.link && (
            <a className={`nx-btn nx-btn--sm ${asked ? 'nx-btn--primary' : 'nx-btn--outline'}`} href={detail.link}>{nt('coding.openInT3')}</a>
          )}
          {t.pullRequests.map((p) => (
            <a key={p.url} className="nx-btn nx-btn--outline nx-btn--sm nx-mono" href={p.url} target="_blank" rel="noopener noreferrer">#{p.number}</a>
          ))}
        </div>
      )}
      {!detail ? (
        !error && <div className="nx-center" aria-busy="true"><Spinner /></div>
      ) : detail.error ? (
        <p className="nx-field__error" role="alert">{nt('coding.t3Failed', { error: detail.error })}</p>
      ) : (
        <>
          {asked && (
            <>
              <h4 className="nx-group-label">{nt('coding.question')}</h4>
              {detail.questions.map((q) => (
                <div key={q.id} className="nx-job__prompt nx-coding-question">
                  <span className="nx-row__hint">{q.header}</span>
                  <p>{q.text}</p>
                  {/* Options keep T3's order and are never reordered, so the index is their identity. */}
                  {q.options.length > 0 && (
                    <ul>{q.options.map((o, i) => <li key={i}><b>{o.label}</b>{o.description && ` · ${o.description}`}</li>)}</ul>
                  )}
                </div>
              ))}
              <p className="nx-job__who">{nt('coding.answerInT3')}</p>
            </>
          )}
          <h4 className="nx-group-label">{nt('coding.messages')}</h4>
          {detail.messages.length === 0
            ? <p className="nx-job__who">{nt('coding.noMessages')}</p>
            : (
              <div className="nx-rows">
                {detail.messages.map((m) => (
                  <div key={m.id} className="nx-coding-message">
                    <div className="nx-coding-message__head">
                      <span className="nx-row__hint">{nt(`coding.${m.kind}`)} · {relative(m.at, locale)}</span>
                      <CopyMessage text={m.text} />
                    </div>
                    {/* The chat's Markdown: RichBody drops raw HTML, and nx-bubble__text
                        gives its blocks the chat's rhythm (chat.css). */}
                    <div className="nx-bubble__text nx-coding-message__text">
                      <RichBody body={loadableImages(m.text, (name) => nt('coding.image', { name }))} />
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      )}
      {/* The first read or a later one failed; a later failure keeps what the last read showed. */}
      {error && <p className="nx-field__error" role="alert">{error}</p>}
    </div>
  )
}

/** The threads of `agents`, newest first, or the one `?t3=` names; a face on
 *  each row and in the detail once there are several agents. */
export function CodingList({ agents }: { agents: Participant[] }) {
  const nt = useNT()
  const route = useRoute()
  const { coding, fresh, error } = useCoding(agents.map((a) => a.id).join(' '))
  const key = route.search.get('t3')
  // A malformed key names no thread, so the list shows.
  const open = key ? parseThreadKey(key) : null

  if (key && open) {
    const listed = coding ? newestThreads(coding).find(({ t }) => threadKey(t) === key) : undefined
    return <ThreadDetail key={key} open={open} listed={listed} several={agents.length > 1} />
  }
  if (coding === null) {
    return error
      ? <div className="nx-empty" role="alert">{error}</div>
      : <div className="nx-center" aria-busy="true"><Spinner /></div>
  }
  const byId = new Map(agents.map((a) => [a.id, a]))
  const rows = newestThreads(coding)
  const servers = coding[0]?.servers ?? []
  return (
    <>
      {rows.length === 0
        ? <div className="nx-empty">{nt(agents.length === 1 ? 'coding.noneAgent' : 'coding.none')}</div>
        : (
          <div className={fresh ? 'nx-rows nx-coding-list' : 'nx-rows'}>
            {rows.map(({ t, agentId }) => (
              <CodingRow
                key={threadKey(t)}
                t={t}
                to={withRoute(route, { params: { t3: threadKey(t) } })}
                agent={agents.length > 1 ? byId.get(agentId) : undefined}
                server={servers.length > 1}
              />
            ))}
          </div>
        )}
      {/* A failing T3 server may be holding threads back, even when none show. */}
      {servers.filter((s) => s.error).map((s) => <p key={s.name} className="nx-field__error" role="alert">{nt('coding.serverError', { server: s.name, error: s.error ?? '' })}</p>)}
      {error && <p className="nx-field__error" role="alert">{error}</p>}
    </>
  )
}

export function CodingTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const { agents } = useRoomAgents(c)
  const admin = useAdmin()
  if (agents.length === 0) return <div className="nx-empty">{nt('panel.noAgents')}</div>
  if (!admin) return <div className="nx-empty"><b>{nt('coding.locked')}</b>{nt('coding.lockedBody')}</div>
  return <CodingList agents={agents} />
}
