/**
 * The agent menu: one live menu for every place that names an agent. An
 * element marked `data-agent-id` opens it (agentRefs.ts says how); Agents list
 * rows open the agent on a click, so they open this menu through `useHold` and
 * `openAgentMenu`.
 *
 * It shows what the agent is doing now, what it owns (its screen and its T3
 * Code threads, for owners and admins), how to talk to it and what to do with
 * it, and it keeps updating while it is open. Inside a chat its panes open in
 * the room panel's agent drawer, so the conversation stays in view; anywhere
 * else they open the agent's page in Agents.
 */
import { useCallback } from 'react'
import { create } from 'zustand'
import { getServerOrigin } from '@/api/client'
import { canStopAgent, stopAgent } from '@/lib/agentStop'
import { copyText } from '@/lib/clipboard'
import { useLocale } from '@/lib/i18n'
import { useConversations } from '@/stores/conversations'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import type { Participant } from '@/types'
import { relative } from './format'
import { haptic } from './haptics'
import { useOpenDirect } from './hooks'
import { useNT } from './i18n'
import { useLayout } from './layout'
import { getRoute, href, navigate, useRoute, withRoute } from './router'
import { Avatar } from './ui/Avatar'
import { anchorFrom, Menu, type MenuAnchor, type MenuEntry, type MenuItem } from './ui/primitives'
import { IAgents, IAt, ICode, ICompose, IComputer, ICopy, IStop } from './ui/icons'
import { isOpenThread, look, newestThreads, threadTime, useCoding, type Thread } from './panel/CodingTab'
import { threadKey } from './panel/codingText'
import { agentState, isLive, StateText, useHost, useSeesWork } from './sections/agents/shared'
import { bindAgentRefs, hasAgentMenu } from './agentRefs'

/** The agent drawer's panes (`?pane=` beside `peek=agent:<id>`). */
export type AgentPane = 'screen' | 'jobs' | 'profile'

// The menu keeps its agent after it closes, so the exit animation still has rows.
const useAgentMenu = create<{ id: string | null; anchor: MenuAnchor | null; error: string | null }>(
  () => ({ id: null, anchor: null, error: null }),
)

export function openAgentMenu(id: string, anchor: MenuAnchor): void {
  useAgentMenu.setState({ id, anchor, error: null })
}

/** A row's action failed after the menu closed: the menu opens again where it
 *  was and says so, the only place the failure can show (there is no toast). */
function failed(id: string, anchor: MenuAnchor, error: string, cause: unknown): void {
  haptic('error')
  console.warn('[next] agent menu action failed', cause)
  useAgentMenu.setState({ id, anchor, error })
}

/** Binds the menu's triggers on the app's root element (NextApp). */
export function bindAgentMenu(root: HTMLElement): () => void {
  return bindAgentRefs(root, {
    open: (id, el, at) => openAgentMenu(id, at ?? anchorFrom(el)),
    // Open means the menu is on screen, which AgentMenuHost decides by the
    // same test. An anchor can outlive its agent (deleted while the menu was
    // open), and must not keep Enter and Space from opening another agent's menu.
    isOpen: () => {
      const { id, anchor } = useAgentMenu.getState()
      return anchor !== null && hasAgentMenu(useParticipants.getState().byId[id ?? ''])
    },
    // On Android a long press arrives as a contextmenu, so it plays the hold.
    held: () => haptic('hold'),
  })
}

/** Opens one of the agent's panes: the room panel's drawer inside a chat,
 *  the agent's page in Agents anywhere else. `t3` opens one of its threads
 *  in the thread list (panel/codingText.ts threadKey). */
export function openAgentPane(id: string, pane: AgentPane, t3: string | null = null): void {
  const r = getRoute()
  if (r.section === 'chats' && r.id) {
    // Another pane of an open drawer takes its place. A thread opens as a new
    // entry, so Back returns to where it was opened: the drawer, or the chat.
    const same = r.peek?.kind === 'agent' && r.peek.id === id
    navigate(withRoute(r, { peek: { kind: 'agent', id }, threadId: null, params: { pane, t3 } }), { replace: same && !t3 })
    return
  }
  // The workspace shows the screen and the threads together.
  const view = pane === 'profile' ? 'profile' : null
  navigate(r.section === 'agents'
    ? withRoute(r, { id, params: { view, since: null, at: null, t3 } })
    : href({ section: 'agents', id, params: { view, t3 } }))
}

/** The native apps run from a local origin; the server's is the one a link can open. */
const agentLink = (id: string): string => `${getServerOrigin() || location.origin}${href({ section: 'agents', id })}`

function Head({ p, now, error }: { p: Participant; now: Thread | undefined; error: string | null }) {
  const nt = useNT()
  const host = useHost(p)
  return (
    <div className="nx-agent-menu__head">
      <Avatar p={p} size={32} presence={!p.departedAt} />
      <span className="nx-agent-menu__who">
        <b>{p.name}</b>
        <span>
          {p.role && <span>{p.role} · </span>}
          <StateText p={p} state={agentState(p, host)} />
        </span>
        {now && <span className="nx-agent-menu__now">{nt('agentMenu.now', { title: now.title })}</span>}
        {error && <span className="nx-agent-menu__error" role="alert">{error}</span>}
      </span>
    </div>
  )
}

export function AgentMenuHost() {
  const nt = useNT()
  const locale = useLocale()
  const route = useRoute()
  const stack = useLayout() === 'stack'
  const openDirect = useOpenDirect()
  const id = useAgentMenu((s) => s.id)
  const anchor = useAgentMenu((s) => s.anchor)
  const error = useAgentMenu((s) => s.error)
  const close = useCallback(() => useAgentMenu.setState({ anchor: null }), [])
  const found = useParticipants((s) => (id ? s.byId[id] : undefined))
  const p = hasAgentMenu(found) ? found : undefined
  const host = useHost(p)
  const roomId = route.section === 'chats' ? route.id : null
  const inRoom = useConversations((s) => !!p && !!roomId && !!s.list.find((c) => c.id === roomId)?.members.includes(p.id))
  // The agent is typing here: the turn it runs now answers this room. The
  // daemon stops whatever turn the agent runs, so Stop shows only for a turn
  // of this room, never for one in another room (the composer's Stop agrees).
  const typingHere = useMessages((s) => !!p && !!roomId && !!s.typing[roomId]?.includes(p.id))
  const open = anchor !== null && p !== undefined
  const active = !!p && !p.departedAt
  const working = useSeesWork(p)
  const { coding } = useCoding(p?.id ?? '', open && working)

  if (!p) return <Menu open={false} anchor={null} entries={[]} onClose={close} />

  const threads = working && coding ? newestThreads(coding).map((x) => x.t) : []
  const running = threads.filter(isOpenThread)
  const state = agentState(p, host)
  const live = isLive(state)
  // Rows close the menu before their request ends; a failure opens it here again.
  const at = anchor
  const fail = (message: string) => (cause: unknown) => { if (at) failed(p.id, at, message, cause) }

  const owned: MenuItem[] = working ? [
    {
      key: 'screen',
      label: nt('agentMenu.screen'),
      icon: <IComputer />,
      detail: live ? <span className="nx-live-tag">{nt('agentMenu.live')}</span> : undefined,
      shortcut: 'S',
      onSelect: () => openAgentPane(p.id, 'screen'),
    },
    {
      key: 'jobs',
      label: nt('agentMenu.jobs'),
      icon: <ICode />,
      detail: coding ? nt('agentMenu.jobsCount', { active: running.length, total: threads.length }) : undefined,
      shortcut: 'J',
      onSelect: () => openAgentPane(p.id, 'jobs'),
    },
    ...threads.slice(0, 3).map((t): MenuItem => {
      const { tone, icon } = look(t.status)
      return {
        key: `thread-${t.server}-${t.threadId}`,
        label: t.title,
        icon: <span className="nx-agent-menu__thread" data-tone={tone}>{icon}</span>,
        detail: relative(threadTime(t), locale),
        onSelect: () => openAgentPane(p.id, 'jobs', threadKey(t)),
      }
    }),
  ] : []
  const talk: MenuItem[] = active ? [
    {
      key: 'message',
      label: nt('agentMenu.message'),
      icon: <ICompose />,
      shortcut: 'M',
      onSelect: () => { openDirect(p.id).catch(fail(nt('agentMenu.messageFailed'))) },
    },
    // The room's composer adds `@id` to its draft (src/next/chat/Composer.tsx).
    // A drawer or thread over it closes first, and on a phone the panel too, so
    // the draft that changed is the one on screen.
    ...(inRoom ? [{
      key: 'mention',
      label: nt('agentMenu.mention'),
      icon: <IAt />,
      shortcut: '@',
      onSelect: () => {
        const r = getRoute()
        const covered = stack && r.panel !== null && r.panel !== 'none'
        if (r.peek || r.threadId || covered) {
          navigate(withRoute(r, { peek: null, threadId: null, panel: stack ? null : r.panel }), { replace: true })
        }
        window.dispatchEvent(new CustomEvent('nx:mention', { detail: p.id }))
      },
    }] : []),
  ] : []
  // The stop route takes a room (server/src/fork/stop.ts) and posts who
  // stopped the turn there. No one-key shortcut: a stray key must not end a turn.
  const stopRoom = active && inRoom && typingHere && canStopAgent(p) ? roomId : null
  const control: MenuItem[] = [
    ...(stopRoom ? [{
      key: 'stop',
      label: nt('agentMenu.stop'),
      icon: <IStop />,
      danger: true,
      // Success shows as the agent's typing ending; no haptic for it.
      onSelect: () => { stopAgent(stopRoom, p.id).catch(fail(nt('agentMenu.stopFailed'))) },
    }] : []),
    { key: 'profile', label: nt('agentMenu.profile'), icon: <IAgents />, shortcut: 'I', onSelect: () => openAgentPane(p.id, 'profile') },
    {
      key: 'copy',
      label: nt('agentMenu.copyLink'),
      icon: <ICopy />,
      shortcut: 'C',
      onSelect: () => { copyText(agentLink(p.id)).catch(fail(nt('agentMenu.copyFailed'))) },
    },
  ]
  const entries: MenuEntry[] = [owned, talk, control]
    .filter((g) => g.length > 0)
    .flatMap((g, i): MenuEntry[] => (i > 0 ? ['sep', ...g] : g))

  return (
    <Menu
      open={open}
      anchor={anchor}
      onClose={close}
      entries={entries}
      header={<Head p={p} now={running[0]} error={error} />}
    />
  )
}
