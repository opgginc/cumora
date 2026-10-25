/**
 * URL-first routing for the Next redesign.
 *
 * The URL is the only source of truth: every screen, selection, panel and peek
 * is derived from `location`. The classic stores still read `useApp` (App.tsx
 * marks conversations read from `view` + `selectedConversationId`, the toast
 * and push handlers call `selectConversation`, message cards call
 * `openDocumentPeek`, ...), so this module keeps `useApp` as a projection of
 * the URL and turns those legacy writes back into navigations.
 */
import { useCallback, useSyncExternalStore, type MouseEvent } from 'react'
import { useApp } from '@/stores/app'
import type { ViewKey } from '@/types'

export const NEXT_BASE = '/next'

export type Section =
  | 'chats' | 'whispers' | 'agents' | 'boards' | 'calendar' | 'docs'
  | 'shipping' | 'library' | 'observability' | 'convene' | 'me'

export type PanelTab = 'handbook' | 'coding' | 'computer' | 'members' | 'files' | 'routines'

/** Right-panel peeks opened from inside a conversation. */
export type Peek =
  | { kind: 'agent'; id: string }
  | { kind: 'doc'; id: string }
  | { kind: 'board'; id: string; cardId: string | null }
  | { kind: 'event'; id: string }

export interface Route {
  section: Section
  /** Conversation, whisper, agent, board, document or settings section id. */
  id: string | null
  /** Thread root message id (chats only). */
  threadId: string | null
  /** Explicit panel tab; `none` = closed; null = the layout's default. */
  panel: PanelTab | 'none' | null
  peek: Peek | null
  search: URLSearchParams
}

const SECTION_SEGMENTS: Record<string, Section> = {
  c: 'chats',
  whispers: 'whispers',
  agents: 'agents',
  boards: 'boards',
  calendar: 'calendar',
  docs: 'docs',
  shipping: 'shipping',
  library: 'library',
  observability: 'observability',
  convene: 'convene',
  me: 'me',
}

const PANEL_TABS = new Set<PanelTab>(['handbook', 'coding', 'computer', 'members', 'files', 'routines'])

export const SECTION_VIEW: Record<Section, ViewKey['view']> = {
  chats: 'conversations',
  whispers: 'whispers',
  agents: 'agents',
  boards: 'boards',
  calendar: 'calendar',
  docs: 'documents',
  shipping: 'shipping',
  library: 'library',
  observability: 'observability',
  convene: 'convene',
  me: 'me',
}

const VIEW_SECTION = Object.fromEntries(
  Object.entries(SECTION_VIEW).map(([section, view]) => [view, section]),
) as Record<ViewKey['view'], Section>

export function isNextPath(pathname: string): boolean {
  return pathname === NEXT_BASE || pathname.startsWith(`${NEXT_BASE}/`)
}

function parsePeek(raw: string | null): Peek | null {
  if (!raw) return null
  const [kind, id, extra] = raw.split(':')
  if (!id) return null
  if (kind === 'agent') return { kind, id }
  if (kind === 'doc') return { kind, id }
  if (kind === 'event') return { kind, id }
  if (kind === 'board') return { kind, id, cardId: extra || null }
  return null
}

function encodePeek(p: Peek): string {
  return p.kind === 'board' ? `board:${p.id}${p.cardId ? `:${p.cardId}` : ''}` : `${p.kind}:${p.id}`
}

export function parseRoute(pathname: string, searchString: string): Route {
  const search = new URLSearchParams(searchString)
  const parts = pathname.slice(NEXT_BASE.length).split('/').filter(Boolean).map(decodeURIComponent)
  const section = SECTION_SEGMENTS[parts[0] ?? ''] ?? 'chats'
  const id = parts[1] ?? null
  const threadId = section === 'chats' && parts[2] === 't' ? parts[3] ?? null : null
  const rawPanel = search.get('panel')
  const panel = rawPanel === 'none' ? 'none' : PANEL_TABS.has(rawPanel as PanelTab) ? rawPanel as PanelTab : null
  return { section, id, threadId, panel, peek: parsePeek(search.get('peek')), search }
}

export interface RouteInput {
  section: Section
  id?: string | null
  threadId?: string | null
  panel?: PanelTab | 'none' | null
  peek?: Peek | null
  /** Extra query params (card, event, q, ...). */
  params?: Record<string, string | null | undefined>
}

export function href(r: RouteInput): string {
  const segment = Object.entries(SECTION_SEGMENTS).find(([, s]) => s === r.section)?.[0] ?? 'c'
  let path = NEXT_BASE
  if (r.section !== 'chats' || r.id) path += `/${segment}`
  if (r.id) path += `/${encodeURIComponent(r.id)}`
  if (r.section === 'chats' && r.id && r.threadId) path += `/t/${encodeURIComponent(r.threadId)}`
  const q = new URLSearchParams()
  if (r.panel) q.set('panel', r.panel)
  if (r.peek) q.set('peek', encodePeek(r.peek))
  for (const [k, v] of Object.entries(r.params ?? {})) if (v) q.set(k, v)
  const qs = q.toString()
  return qs ? `${path}?${qs}` : path
}

/** The same route with some fields changed (keeps panel/peek unless told). */
export function withRoute(cur: Route, patch: Partial<RouteInput>): string {
  const params: Record<string, string> = {}
  cur.search.forEach((v, k) => { if (k !== 'panel' && k !== 'peek') params[k] = v })
  // `pane` picks a pane of one agent peek (panel/AgentDrawer.tsx), so it is
  // dropped whenever the peek closes or changes, even to another agent's.
  // `t3` opens a T3 thread in a thread list (panel/CodingTab.tsx), so it goes
  // whenever that list goes: with the peek, and when a panel tab, a drawer
  // pane or an agent page's view changes (tests/coding-t3-route.test.ts).
  // A caller that wants them passes them again in `params`.
  // Only a value that differs counts as a change: a caller may pass the panel
  // or the (absent) peek as they are, like the agent menu's Mention.
  const samePeek = patch.peek === null ? cur.peek === null
    : patch.peek !== undefined && cur.peek !== null && encodePeek(patch.peek) === encodePeek(cur.peek)
  const peekChanged = patch.peek !== undefined && !samePeek
  if (peekChanged) delete params.pane
  const changes = (key: string) => patch.params !== undefined && key in patch.params && (patch.params[key] ?? null) !== cur.search.get(key)
  const listGone = peekChanged || (patch.panel !== undefined && patch.panel !== cur.panel) || changes('pane') || changes('view')
  if (listGone) delete params.t3
  return href({
    section: patch.section ?? cur.section,
    id: patch.id !== undefined ? patch.id : cur.id,
    threadId: patch.threadId !== undefined ? patch.threadId : cur.threadId,
    panel: patch.panel !== undefined ? patch.panel : cur.panel,
    peek: patch.peek !== undefined ? patch.peek : cur.peek,
    params: { ...params, ...patch.params },
  })
}

/* ── Location store ─────────────────────────────────────────────────── */

const NAV_EVENT = 'nx:navigate'
let cachedKey = ''
let cachedRoute: Route = parseRoute(NEXT_BASE, '')
/** Depth of history entries this app pushed, so Back can stay in-app. */
let depth = 0

function snapshot(): Route {
  const key = location.pathname + location.search
  if (key !== cachedKey) {
    cachedKey = key
    cachedRoute = parseRoute(location.pathname, location.search)
  }
  return cachedRoute
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb)
  window.addEventListener(NAV_EVENT, cb)
  return () => {
    window.removeEventListener('popstate', cb)
    window.removeEventListener(NAV_EVENT, cb)
  }
}

export function getRoute(): Route {
  return snapshot()
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search) return
  if (opts.replace) {
    history.replaceState({ nxDepth: depth }, '', to)
  } else {
    depth += 1
    history.pushState({ nxDepth: depth }, '', to)
  }
  window.dispatchEvent(new Event(NAV_EVENT))
}

/** Back within the app when there is in-app history, else go to `fallback`. */
export function goBack(fallback: string): void {
  const stateDepth = (history.state as { nxDepth?: number } | null)?.nxDepth ?? 0
  if (stateDepth > 0) history.back()
  else navigate(fallback, { replace: true })
}

window.addEventListener('popstate', () => {
  depth = (history.state as { nxDepth?: number } | null)?.nxDepth ?? 0
})

export function useNavigate(): (to: string, opts?: { replace?: boolean }) => void {
  return useCallback((to: string, opts?: { replace?: boolean }) => navigate(to, opts), [])
}

/** onClick for `<a href>` links: client-side push for plain left clicks, the
 *  browser's own behavior for Cmd/Ctrl/Shift/middle clicks (new tab works). */
export function linkClick(e: MouseEvent<HTMLAnchorElement>, opts: { replace?: boolean } = {}): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const to = e.currentTarget.getAttribute('href')
  if (!to || !isNextPath(to.split('?')[0])) return
  e.preventDefault()
  navigate(to, opts)
}

/* ── Legacy projection ──────────────────────────────────────────────── */

let projecting = false

/**
 * Write the route into `useApp`. `stacked` = the narrow layout, where the
 * chat is its own screen: `mobileStack` must say whether it is on top,
 * because App.tsx only marks a conversation read while it is being watched.
 */
export function projectRoute(route: Route, stacked: boolean): void {
  const s = useApp.getState()
  const isChat = route.section === 'chats' && route.id !== null
  const next: Partial<ReturnType<typeof useApp.getState>> = {
    view: SECTION_VIEW[route.section],
    selectedConversationId: route.section === 'chats' ? route.id : s.selectedConversationId,
    mobileStack: stacked ? (isChat ? (route.panel && route.panel !== 'none' ? 'info' : 'chat') : 'list') : 'chat',
    openThread: isChat && route.threadId ? { convoId: route.id!, rootId: route.threadId } : null,
    infoAgentId: route.peek?.kind === 'agent' ? route.peek.id : null,
    openDocumentId: route.peek?.kind === 'doc' ? route.peek.id : null,
    openBoardId: route.peek?.kind === 'board' ? route.peek.id : null,
    openBoardCardId: route.peek?.kind === 'board' ? route.peek.cardId : null,
    openCalendarEventId: route.peek?.kind === 'event' ? route.peek.id : null,
  }
  const changed = (Object.keys(next) as Array<keyof typeof next>).some((k) => {
    const a = s[k]
    const b = next[k]
    if (k === 'openThread') return (a as typeof s.openThread)?.rootId !== (b as typeof s.openThread)?.rootId
      || (a as typeof s.openThread)?.convoId !== (b as typeof s.openThread)?.convoId
    return a !== b
  })
  if (!changed) return
  projecting = true
  try {
    useApp.setState(next)
  } finally {
    projecting = false
  }
}

/** Translate writes that classic code makes to `useApp` into navigations. */
export function bindLegacyWrites(): () => void {
  return useApp.subscribe((s, prev) => {
    if (projecting) return
    const cur = snapshot()
    if (s.view !== prev.view || s.selectedConversationId !== prev.selectedConversationId) {
      const section = VIEW_SECTION[s.view] ?? 'chats'
      if (section === 'chats') {
        if (s.selectedConversationId !== cur.id || cur.section !== 'chats') {
          navigate(href({ section: 'chats', id: s.selectedConversationId }))
        }
      } else if (section !== cur.section) {
        // Classic "open in full" buttons set the artifact, then the view.
        const id = section === 'docs' ? s.openDocumentId : section === 'boards' ? s.openBoardId : null
        const params = section === 'calendar' && s.openCalendarEventId ? { event: s.openCalendarEventId }
          : section === 'boards' && s.openBoardCardId ? { card: s.openBoardCardId }
            : undefined
        navigate(href({ section, id, params }))
      }
      return
    }
    if (s.openThread !== prev.openThread) {
      navigate(withRoute(cur, { threadId: s.openThread?.rootId ?? null }))
      return
    }
    const peek: Peek | null = s.infoAgentId ? { kind: 'agent', id: s.infoAgentId }
      : s.openDocumentId ? { kind: 'doc', id: s.openDocumentId }
        : s.openBoardId ? { kind: 'board', id: s.openBoardId, cardId: s.openBoardCardId }
          : s.openCalendarEventId ? { kind: 'event', id: s.openCalendarEventId }
            : null
    const prevPeek = cur.peek
    const same = (peek === null && prevPeek === null)
      || (peek !== null && prevPeek !== null && encodePeek(peek) === encodePeek(prevPeek))
    if (!same) navigate(withRoute(cur, { peek, threadId: peek ? null : cur.threadId }))
  })
}
