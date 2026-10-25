/**
 * The agent drawer: an agent's T3 Code threads, screen and profile in the room
 * panel, at `peek=agent:<id>` with `&pane=jobs|screen|profile` (and `&t3=` for
 * one of its threads, CodingTab.tsx). The agent
 * menu, the Members tab and @mentions open it inside a chat, so the
 * conversation stays in view; the Agents section shows the same parts as the
 * agent's workspace. Screen and threads are for owners and admins (the routes
 * refuse anyone else); a person, or an agent for anyone else, gets the profile.
 */
import { lazy, Suspense } from 'react'
import { useParticipants } from '@/stores/participants'
import type { AgentPane } from '../agentMenu'
import { useNT } from '../i18n'
import type { Layout } from '../layout'
import { getRoute, href, navigate, parseRoute, useRoute, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { IconButton, Segmented, Spinner } from '../ui/primitives'
import { IChevronLeft, IX } from '../ui/icons'
import { agentState, refreshRoster, StateText, useHost, useHostPending, useSeesWork } from '../sections/agents/shared'
import { CodingList } from './CodingTab'
import { Screen } from './ComputerTab'

const Profile = lazy(() => import('../sections/agents/Profile').then((m) => ({ default: m.Profile })))

export function AgentDrawer({ id, layout, onClose }: { id: string; layout: Layout; onClose: () => void }) {
  const nt = useNT()
  const route = useRoute()
  const p = useParticipants((s) => s.byId[id])
  const seesWork = useSeesWork(p)
  const host = useHost(p)
  // A `pane=screen` link must not show the profile until the host lands.
  const hostPending = useHostPending(p)

  // The threads come first: they are what an owner opens an agent for most,
  // and unlike the screen they hold no stream.
  const panes: AgentPane[] = seesWork ? ['jobs', 'screen', 'profile'] : ['profile']
  // A peek without a pane (a Members row, a classic profile link) shows the
  // first pane: the threads, or the profile for anyone who cannot see them.
  const asked = route.search.get('pane') as AgentPane | null
  const pane = asked && panes.includes(asked) ? asked : panes[0]

  return (
    <aside className="nx-panel" aria-label={p?.name ?? nt('agents.notFound')}>
      <header className="nx-panel__head">
        <div className="nx-panel__bar">
          {layout === 'stack'
            ? <IconButton label={nt('chat.back')} onClick={onClose}><IChevronLeft /></IconButton>
            : <span />}
          <IconButton small label={nt('panel.close')} onClick={onClose}><IX /></IconButton>
        </div>
        {p && (
          <div className="nx-panel__who-inner">
            <Avatar p={p} size={48} presence={!p.departedAt} />
            <b>{p.name}</b>
            {p.kind === 'agent' ? <StateText p={p} state={agentState(p, host)} /> : <span>{p.role ?? nt('agents.teammate')}</span>}
          </div>
        )}
        {panes.length > 1 && (
          <Segmented
            label={nt('drawer.label')}
            value={pane}
            onChange={(k) => navigate(withRoute(getRoute(), { params: { pane: k } }), { replace: true })}
            items={panes.map((k) => ({ key: k, label: nt(`drawer.${k}`) }))}
          />
        )}
      </header>
      <div className="nx-panel__body nx-scroll">
        {!p ? <div className="nx-empty">{nt('agents.notFound')}</div>
          : hostPending ? <div className="nx-center" aria-busy="true"><Spinner /></div>
          : pane === 'screen' ? <Screen key={p.id} agent={p} />
            : pane === 'jobs' ? <CodingList agents={[p]} />
              : (
                <Suspense fallback={<div className="nx-center"><Spinner /></div>}>
                  {/* Its Edit and Off-board open their dialogs in Agents. */}
                  <Profile p={p} route={parseRoute(href({ section: 'agents', id: p.id }), '')} onRefresh={refreshRoster} />
                </Suspense>
              )}
      </div>
    </aside>
  )
}
