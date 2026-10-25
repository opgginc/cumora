/**
 * Coding: the T3 Code threads the room's agents launched. The server copies
 * them from T3 (server/src/fork/coding.ts) and says on the workspace's socket
 * when its copy changed, so the tab reads the list again then, and the last
 * answer per agent draws the list at once when the tab opens again. A row
 * opens the thread's detail in place of the list (`?t3=<server>:<thread id>`),
 * which T3 is read for when it opens, and its pull request chips open the pull
 * requests. Owners and admins only, because a title an agent wrote can quote
 * any room. The agent drawer, the Agents wall and workspace and the agent menu
 * read the same lists through `useCoding`; the drawer and the workspace show
 * the list and its detail through `CodingList`.
 */
import { useEffect, useState } from 'react'
import { http, ws } from '@/api/client'
import { useLocale } from '@/lib/i18n'
import { useParticipants } from '@/stores/participants'
import type { Conversation, Participant } from '@/types'
import { agentRef } from '../agentRefs'
import { relative } from '../format'
import { useAdmin } from '../hooks'
import { useNT, type NKey } from '../i18n'
import { getRoute, goBack, linkClick, useRoute, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { IconButton, Spinner } from '../ui/primitives'
import { ICheck, IChevronLeft, IInfo, IStop, IX } from '../ui/icons'
import { errText } from '../sections/calendar/parts'
import { useRoomAgents } from '../chat/ChatView'

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
  questions: Array<{ header: string; text: string; options: Array<{ label: string; description: string }> }>
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

/** The thread `?t3=` names: its T3 server and its id. */
export const threadKey = (t: Pick<Thread, 'server' | 'threadId'>): string => `${t.server}:${t.threadId}`

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

/** The pull request an Agents wall tile shows for a thread: the last one T3 lists. */
export const lastPr = (t: Thread): Thread['pullRequests'][number] | undefined => t.pullRequests[t.pullRequests.length - 1]

/** A running thread counts from its start, a resting one from when it stopped. */
export const threadTime = (t: Thread): string => (isOpenThread(t) ? t.createdAt : t.updatedAt)

/** Newest first, every agent's threads in one list. */
export const newestThreads = (coding: AgentCoding[]): Array<{ t: Thread; agentId: string }> => coding
  .flatMap((c) => c.threads.map((t) => ({ t, agentId: c.agentId })))
  .sort((a, b) => b.t.updatedAt.localeCompare(a.t.updatedAt))

/** Runs `load` now and again whenever the server's copy may have changed;
 *  returns what stops it. */
function followCoding(load: () => void): () => void {
  // Back from the background, the copy may be minutes old.
  const onVisible = () => { if (!document.hidden) load() }
  // `fork.coding` (a fork event, outside the client's event union) says the
  // server's copy changed. `hello` opens every connection, after events missed
  // while the socket was down.
  const off = ws.on((e) => {
    if (e.type === 'hello' || (e as { type: string }).type === 'fork.coding') load()
  })
  load()
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    off()
    document.removeEventListener('visibilitychange', onVisible)
  }
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
    let live = true
    // An event can start a read while an older one is still out; only the
    // newest may draw.
    let latest = 0
    const hit = cached(ids)
    setCoding(hit)
    setFresh(hit === null)
    setError(null)
    const load = async () => {
      if (document.hidden) return
      const mine = ++latest
      try {
        const lists = await Promise.all(ids.split(' ').map(async (agentId) =>
          ({ agentId, ...(await http<Coding>(`/fork/agents/${encodeURIComponent(agentId)}/coding`)) })))
        if (!live || mine !== latest) return
        for (const { agentId, threads, servers } of lists) cache.set(agentId, { threads, servers })
        setCoding(lists)
        setError(null)
      } catch (e) {
        if (live && mine === latest) setError(errText(e))
      }
    }
    const stop = followCoding(() => void load())
    return () => {
      live = false
      stop()
    }
  }, [ids, enabled])
  // While reads are off, the state can still hold the lists of agents asked
  // about before (the menu reopened on someone else); those never show.
  const own = coding !== null && coding.map((c) => c.agentId).join(' ') === ids
  return { coding: own ? coding : null, fresh, error }
}

/** A thread's pull requests, each opening on GitHub. */
function PullRequests({ t, className }: { t: Thread; className: string }) {
  return (
    <>
      {t.pullRequests.map((p) => (
        <a key={p.url} className={`${className} nx-mono`} href={p.url} target="_blank" rel="noopener noreferrer">#{p.number}</a>
      ))}
    </>
  )
}

function CodingRow({ t, to, agent, server }: { t: Thread; to: string; agent?: Participant; server: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const { label, tone, icon } = look(t.status)
  const when = relative(threadTime(t), locale)
  return (
    <div className="nx-row nx-coding" data-tone={tone}>
      {icon}
      {agent && <Avatar p={agent} size={20} />}
      {/* Stretched over the whole row; the pull request chips sit above it. */}
      <a className="nx-row__text nx-coding__open" href={to} onClick={linkClick}>
        <span className="nx-coding__title">{t.title}</span>
        {/* The avatar is hidden from screen readers, so the hint names the agent. */}
        <span className="nx-row__hint">{[agent?.name, nt(label), when, server ? t.server : null].filter(Boolean).join(' · ')}</span>
      </a>
      <PullRequests t={t} className="nx-chip nx-coding__pr" />
    </div>
  )
}

/**
 * One thread in place of the list: its copy at once when the list holds it,
 * then what T3 holds of it now, read again whenever the server's copy changes.
 * A question is answered in the T3 app: the server's T3 token reads only.
 * ponytail: messages a running thread adds show on the next change of its
 * copy or a return to the app; poll here if someone watches a thread live.
 */
function ThreadDetail({ id, listed, several }: { id: string; listed?: { t: Thread; agentId: string }; several: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const t = detail?.thread ?? listed?.t
  const agentId = detail?.thread.agentId ?? listed?.agentId
  // Several agents share the list: the detail names its own, as its row does.
  const agent = useParticipants((s) => (several && agentId ? s.byId[agentId] : undefined))
  useEffect(() => {
    let live = true
    let latest = 0
    const at = id.indexOf(':')
    const path = `/fork/coding/${encodeURIComponent(id.slice(0, at))}/${encodeURIComponent(id.slice(at + 1))}`
    const load = async () => {
      if (document.hidden) return
      const mine = ++latest
      try {
        const d = await http<Detail>(path)
        if (!live || mine !== latest) return
        setDetail(d)
        setError(null)
      } catch (e) {
        if (live && mine === latest) setError(errText(e))
      }
    }
    const stop = followCoding(() => void load())
    return () => {
      live = false
      stop()
    }
  }, [id])

  const bar = (
    <div className="nx-job__bar">
      <IconButton small label={nt('coding.back')} onClick={() => goBack(withRoute(getRoute(), { params: { t3: null } }))}>
        <IChevronLeft />
      </IconButton>
      {t && <h3>{t.title}</h3>}
    </div>
  )
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
          <PullRequests t={t} className="nx-btn nx-btn--outline nx-btn--sm" />
        </div>
      )}
      {!detail ? (
        error ? <p className="nx-field__error" role="alert">{error}</p> : <div className="nx-center" aria-busy="true"><Spinner /></div>
      ) : detail.error ? (
        <p className="nx-field__error" role="alert">{nt('coding.t3Failed', { error: detail.error })}</p>
      ) : (
        <>
          {asked && (
            <>
              <h4 className="nx-group-label">{nt('coding.question')}</h4>
              {detail.questions.map((q) => (
                <div key={`${q.header} ${q.text}`} className="nx-job__prompt nx-coding-question">
                  <span className="nx-row__hint">{q.header}</span>
                  <p>{q.text}</p>
                  {q.options.length > 0 && (
                    <ul>{q.options.map((o) => <li key={o.label}><b>{o.label}</b>{o.description && ` · ${o.description}`}</li>)}</ul>
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
                    <span className="nx-row__hint">{nt(`coding.${m.kind}`)} · {relative(m.at, locale)}</span>
                    <p>{m.text}</p>
                  </div>
                ))}
              </div>
            )}
        </>
      )}
      {/* A later read failed: what the last one showed stays. */}
      {detail && error && <p className="nx-field__error" role="alert">{error}</p>}
    </div>
  )
}

/** The threads of `agents`, newest first, or the one `?t3=` names; a face on
 *  each row and in the detail once there are several agents. */
export function CodingList({ agents }: { agents: Participant[] }) {
  const nt = useNT()
  const route = useRoute()
  const { coding, fresh, error } = useCoding(agents.map((a) => a.id).join(' '))
  const open = route.search.get('t3')

  if (open) {
    const listed = coding ? newestThreads(coding).find(({ t }) => threadKey(t) === open) : undefined
    return <ThreadDetail key={open} id={open} listed={listed} several={agents.length > 1} />
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
