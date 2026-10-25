import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { ws } from '@/api/client'
import { getMeId, useMe } from '@/stores/auth'
import { isMuted, useConversations } from '@/stores/conversations'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import type { Conversation, Participant } from '@/types'
import { agentButtonRef } from '../agentRefs'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { getRoute, goBack, href, navigate, withRoute } from '../router'
import type { Layout } from '../layout'
import { Avatar, AvatarStack } from '../ui/Avatar'
import { IconButton, T_QUICK } from '../ui/primitives'
import { IChevronDown, IChevronLeft, IHash, IMail, IPanelRight, ISearch, IX } from '../ui/icons'
import { isImeComposing } from '@/lib/keyboard'
import { EditDialog, openEdit } from '../panel/EditDialog'
import { MessageList, type Find } from './MessageList'
import { Composer } from './Composer'
import { TALK_KINDS } from './model'

/** Agents of a room, live ones first. "Live" = typing in this room, or the
 *  server says working/thinking (status is global, typing is per room). */
export function useRoomAgents(c: Conversation | undefined): { agents: Participant[]; live: Participant[] } {
  const typing = useMessages((s) => (c ? s.typing[c.id] : undefined))
  // Comma-joined so the selector returns a primitive and stays stable.
  const streamers = useMessages((s) => (c
    ? Object.values(s.streaming).filter((x) => x.conversationId === c.id).map((x) => x.authorId).join(',')
    : ''))
  const agents = useParticipants(useShallow((s) => (c?.members ?? [])
    .map((id) => s.byId[id])
    .filter((p): p is Participant => !!p && p.kind === 'agent' && !p.departedAt)))
  return useMemo(() => {
    const typers = new Set([...(typing ?? []), ...(streamers ? streamers.split(',') : [])])
    const live = agents.filter((p) => typers.has(p.id) || p.status === 'working' || p.status === 'thinking')
    live.sort((a, b) => Number(typers.has(b.id)) - Number(typers.has(a.id)))
    return { agents, live }
  }, [agents, typing, streamers])
}

function ChatHeader({ c, layout, panelOpen, onSearch, searching }: {
  c: Conversation
  layout: Layout
  panelOpen: boolean
  onSearch: () => void
  searching: boolean
}) {
  const nt = useNT()
  const me = useMe()
  const { agents, live } = useRoomAgents(c)
  const peer = useParticipants((s) => (c.kind === 'direct' ? s.byId[c.members.find((m) => m !== me) ?? ''] : undefined))
  const agentPeer = peer?.kind === 'agent' ? peer : undefined
  const togglePanel = useCallback(() => {
    const r = getRoute()
    if (panelOpen) {
      if (layout === 'full') navigate(withRoute(r, { panel: 'none', peek: null, threadId: null }), { replace: true })
      else goBack(withRoute(r, { panel: null, peek: null, threadId: null }))
    } else {
      navigate(withRoute(r, { panel: layout === 'full' ? null : 'handbook' }), { replace: layout === 'full' })
    }
  }, [panelOpen, layout])

  const glyph = c.kind === 'direct' && peer
    ? <Avatar p={peer} size={24} presence />
    : c.kind === 'email'
      ? <span className="nx-pill__icon"><IMail /></span>
      : agents.length >= 2
        ? <AvatarStack ps={agents} size={22} max={3} />
        : <span className="nx-pill__icon"><IHash /></span>

  const sub = live.length > 0
    ? <span className="nx-pill__sub nx-shimmer">{live.length === 1 ? nt('chat.oneWorking', { name: live[0].name }) : nt('chat.manyWorking', { n: live.length })}</span>
    : c.kind === 'direct' && peer?.role
      ? <span className="nx-pill__sub">{peer.role}</span>
      : c.kind !== 'direct'
        ? <span className="nx-pill__sub">{nt('chat.members', { n: c.members.length })}</span>
        : null

  return (
    <header className="nx-chat__head">
      <div className="nx-chat__side">
        {layout === 'stack' && (
          <IconButton label={nt('chat.back')} onClick={() => goBack(href({ section: 'chats' }))}><IChevronLeft /></IconButton>
        )}
      </div>
      {/* A 1:1 with an agent opens the agent menu (src/next/agentMenu.tsx); Edit stays on the panel's pencil. */}
      <button
        type="button"
        className="nx-pill"
        {...agentButtonRef(agentPeer)}
        onClick={agentPeer ? undefined : openEdit}
        aria-label={agentPeer ? agentPeer.name : nt('chat.edit', { room: c.title })}
      >
        {glyph}
        <span className="nx-pill__text">
          <span className="nx-pill__title">{c.title}</span>
          {sub}
        </span>
      </button>
      <div className="nx-chat__side nx-chat__side--end">
        <IconButton label={nt('chat.search')} active={searching} tipPlace="below" onClick={onSearch}>
          <ISearch />
        </IconButton>
        <IconButton label={nt('panel.label')} active={panelOpen} tipPlace="below" onClick={togglePanel}>
          <IPanelRight />
        </IconButton>
      </div>
      {/* The dialog is a portal, so it also opens over the room panel, which covers this header on a phone. */}
      <EditDialog c={c} agents={agents} />
    </header>
  )
}

/** Find-in-room bar under the header, like a browser's find bar. */
function SearchBar({ q, setQ, index, setIndex, count, onClose }: {
  q: string
  setQ: (v: string) => void
  index: number
  setIndex: (fn: (i: number) => number) => void
  count: number
  onClose: () => void
}) {
  const nt = useNT()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { requestAnimationFrame(() => input.current?.focus()) }, [])
  const older = () => setIndex((i) => (count ? (i + 1) % count : 0))
  const newer = () => setIndex((i) => (count ? (i - 1 + count) % count : 0))
  return (
    <motion.div className="nx-find" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={T_QUICK}>
      <ISearch aria-hidden />
      <input
        ref={input}
        value={q}
        onChange={(e) => { setQ(e.target.value); setIndex(() => 0) }}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) newer(); else older() }
        }}
        placeholder={nt('chat.searchPlaceholder')}
        aria-label={nt('chat.search')}
        enterKeyHint="search"
      />
      <span className="nx-find__count nx-mono" aria-live="polite">{q.trim() ? (count ? `${index + 1}/${count}` : nt('chat.searchNone')) : ''}</span>
      <IconButton small label={nt('chat.searchOlder')} disabled={!count} onClick={older}><IChevronDown style={{ transform: 'rotate(180deg)' }} /></IconButton>
      <IconButton small label={nt('chat.searchNewer')} disabled={!count} onClick={newer}><IChevronDown /></IconButton>
      <IconButton small label={nt('common.close')} onClick={onClose}><IX /></IconButton>
    </motion.div>
  )
}

// Agents often answer in several rows at once; one double click covers them.
const RECEIVED_GAP = 2000

/** Someone else's message arriving in the room on screen plays `received`.
 *  It listens to the live `message.new` event, not the store, because opening
 *  the room and catching up after a reconnect add rows to the store too. */
function useReceivedHaptic(convoId: string, muted: boolean): void {
  useEffect(() => {
    if (muted) return
    let last = -Infinity
    return ws.on((e) => {
      if (e.type !== 'message.new' || e.conversationId !== convoId) return
      if (e.message.authorId === getMeId() || !TALK_KINDS.has(e.message.kind)) return
      if (document.visibilityState !== 'visible' || performance.now() - last < RECEIVED_GAP) return
      last = performance.now()
      haptic('received')
    })
  }, [convoId, muted])
}

export function ChatView({ convoId, layout, panelOpen }: { convoId: string; layout: Layout; panelOpen: boolean }) {
  const c = useConversations((s) => s.list.find((x) => x.id === convoId))
  useReceivedHaptic(convoId, !c || isMuted(c))
  // The transcript pads by the whole floating composer region (its padding
  // and the bottom safe area included), so the newest row clears the bar.
  const [composerH, setComposerH] = useState(80)
  const composerBox = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = composerBox.current
    if (!el) return
    const ro = new ResizeObserver(() => setComposerH(Math.ceil(el.getBoundingClientRect().height)))
    ro.observe(el)
    return () => ro.disconnect()
    // Until the room is in the store the section renders without a composer.
  }, [c === undefined])
  // Find state is per visit to a room, like a browser's find bar.
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(0)
  useEffect(() => { setSearching(false); setQ(''); setIndex(0) }, [convoId])
  const find = useMemo<Find | undefined>(() => (searching ? { q, index, onCount: setCount } : undefined), [searching, q, index])
  if (!c) return <section className="nx-chat" />
  return (
    <section className="nx-chat" aria-label={c.title} data-direct={c.kind === 'direct' || undefined}>
      <ChatHeader c={c} layout={layout} panelOpen={panelOpen} searching={searching} onSearch={() => setSearching((v) => !v)} />
      <AnimatePresence>
        {searching && (
          <SearchBar q={q} setQ={setQ} index={index} setIndex={setIndex} count={count} onClose={() => { setSearching(false); setQ('') }} />
        )}
      </AnimatePresence>
      <MessageList key={convoId} convoId={convoId} bottomInset={composerH + 8} find={find} />
      <div ref={composerBox} className="nx-chat__composer">
        <Composer convoId={convoId} />
      </div>
    </section>
  )
}

export function ChatEmpty() {
  const nt = useNT()
  return (
    <section className="nx-chat nx-chat--empty">
      <div className="nx-empty"><b>{nt('chat.emptyTitle')}</b>{nt('chat.emptyBody')}</div>
    </section>
  )
}
