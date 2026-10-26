/**
 * Right panel of a conversation. Document and board peeks reuse the classic
 * panes (they read the useApp fields that the router projects from the URL);
 * an agent or person peek is the agent drawer (AgentDrawer.tsx), an event
 * peek is the Calendar section's own detail, and the tabs
 * are the redesign's own. The header identity follows whichever agent is
 * working in the room, so a glance says who is busy right now. The room's
 * settings are not a tab: the pencil opens Edit over the chat.
 */
import { lazy, Suspense, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useConversations } from '@/stores/conversations'
import type { Conversation } from '@/types'
import { useNT } from '../i18n'
import { getRoute, goBack, href, navigate, withRoute, type PanelTab, type Route } from '../router'
import type { Layout } from '../layout'
import { Avatar } from '../ui/Avatar'
import { IconButton, Segmented, Spinner, T_FAST } from '../ui/primitives'
import { IChevronLeft, IHash, IPencil, IX } from '../ui/icons'
import { useRoomAgents } from '../chat/ChatView'
import { HandbookTab } from './HandbookTab'
import { CodingTab } from './CodingTab'
import { ComputerTab } from './ComputerTab'
import { AgentDrawer } from './AgentDrawer'
import { MembersTab } from './MembersTab'
import { openEdit } from './EditDialog'
import { FilesTab } from './FilesTab'
import { RoutinesTab } from './RoutinesTab'
import { ThreadView } from './ThreadView'

const DocumentPeekPane = lazy(() => import('@/desktop/DocumentPeekPane').then((m) => ({ default: m.DocumentPeekPane })))
const BoardPeekPane = lazy(() => import('@/desktop/BoardPeekPane').then((m) => ({ default: m.BoardPeekPane })))
const EventDetail = lazy(() => import('../sections/calendar/EventDetail').then((m) => ({ default: m.EventDetail })))

function closePanel(layout: Layout): void {
  const r = getRoute()
  const base = withRoute(r, { panel: null, peek: null, threadId: null })
  if (layout === 'full' && !r.threadId && !r.peek) navigate(withRoute(r, { panel: 'none' }), { replace: true })
  else goBack(base)
}

function Classic({ children, layout }: { children: ReactNode; layout: Layout }) {
  const nt = useNT()
  return (
    <aside className="nx-panel nx-panel--classic">
      {layout === 'stack' && (
        <div className="nx-panel__bar">
          <IconButton label={nt('chat.back')} onClick={() => closePanel(layout)}><IChevronLeft /></IconButton>
        </div>
      )}
      <Suspense fallback={<div className="nx-center"><Spinner /></div>}>{children}</Suspense>
    </aside>
  )
}

function Identity({ c }: { c: Conversation }) {
  const nt = useNT()
  const { live } = useRoomAgents(c)
  const who = live[0]
  return (
    <div className="nx-panel__who">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={who?.id ?? 'room'}
          className="nx-panel__who-inner"
          initial={{ opacity: 0, y: 6, filter: 'blur(2px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -6, filter: 'blur(2px)' }}
          transition={T_FAST}
        >
          {who ? <Avatar p={who} size={48} presence /> : <span className="nx-panel__room"><IHash /></span>}
          <b>{who ? who.name : c.title}</b>
          <span className={who ? 'nx-shimmer' : undefined}>
            {who ? nt('panel.workingNow') : nt('chat.members', { n: c.members.length })}
          </span>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// Coding first: what the room's agents are building is what an owner opens
// the panel for most. The first tab is also the one the panel opens on.
const TABS: PanelTab[] = ['coding', 'handbook', 'computer', 'members', 'files', 'routines']
// A 1:1 room's two members are the room itself.
const DIRECT_TABS = TABS.filter((t) => t !== 'members')

export function RightPanel({ route, layout }: { route: Route; layout: Layout }) {
  const nt = useNT()
  // Each tab opens at its top, not at the scroll position of the tab before.
  const body = useRef<HTMLDivElement>(null)
  const c = useConversations((s) => s.list.find((x) => x.id === route.id))
  if (!c) return null

  if (route.threadId) {
    return (
      <aside className="nx-panel" aria-label={nt('panel.thread')}>
        <div className="nx-panel__bar nx-panel__bar--title">
          {layout === 'stack'
            ? <IconButton label={nt('chat.back')} onClick={() => closePanel(layout)}><IChevronLeft /></IconButton>
            : <span />}
          <h2>{nt('panel.thread')}</h2>
          <IconButton small label={nt('panel.close')} onClick={() => closePanel(layout)}><IX /></IconButton>
        </div>
        <ThreadView convoId={c.id} rootId={route.threadId} />
      </aside>
    )
  }
  if (route.peek?.kind === 'event') {
    const id = route.peek.id
    return (
      <Suspense fallback={<div className="nx-center"><Spinner /></div>}>
        <EventDetail
          key={id}
          rawId={id}
          // Opened from a job in the Routines tab, it steps back to the job.
          stack={layout === 'stack' || route.search.has('routine')}
          onClose={() => goBack(withRoute(getRoute(), { peek: null }))}
          editHref={href({ section: 'calendar', params: { event: id, edit: '1' } })}
        />
      </Suspense>
    )
  }
  if (route.peek?.kind === 'agent') return <AgentDrawer id={route.peek.id} layout={layout} onClose={() => closePanel(layout)} />
  if (route.peek) {
    const pane = route.peek.kind === 'doc' ? <DocumentPeekPane /> : <BoardPeekPane />
    return <Classic layout={layout}>{pane}</Classic>
  }

  const tabs = c.kind === 'direct' ? DIRECT_TABS : TABS
  // A tab this room lacks (Members kept in the URL from a group room) falls back too.
  const tab: PanelTab = route.panel && route.panel !== 'none' && tabs.includes(route.panel) ? route.panel : tabs[0]
  const setTab = (t: PanelTab) => navigate(withRoute(getRoute(), { panel: t }), { replace: true })

  return (
    <aside className="nx-panel" aria-label={nt('panel.label')}>
      <header className="nx-panel__head">
        <div className="nx-panel__bar">
          {layout === 'stack'
            ? <IconButton label={nt('chat.back')} onClick={() => closePanel(layout)}><IChevronLeft /></IconButton>
            : <span />}
          <span className="nx-panel__acts">
            <IconButton small label={nt('panel.edit')} onClick={openEdit}><IPencil /></IconButton>
            <IconButton small label={nt('panel.close')} onClick={() => closePanel(layout)}><IX /></IconButton>
          </span>
        </div>
        <Identity c={c} />
        <Segmented
          label={nt('panel.label')}
          value={tab}
          onChange={setTab}
          items={tabs.map((k) => ({ key: k, label: nt(`panel.${k}`) }))}
        />
      </header>
      <div ref={body} className="nx-panel__body nx-scroll">
        <AnimatePresence mode="wait" initial={false} onExitComplete={() => body.current?.scrollTo(0, 0)}>
          <motion.div
            key={tab}
            className="nx-panel__tab"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            {tab === 'handbook' && <HandbookTab c={c} docked={layout === 'full'} />}
            {tab === 'coding' && <CodingTab c={c} />}
            {tab === 'computer' && <ComputerTab c={c} />}
            {tab === 'members' && <MembersTab c={c} />}
            {tab === 'files' && <FilesTab c={c} />}
            {tab === 'routines' && <RoutinesTab c={c} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  )
}
