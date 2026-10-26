import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '@/api/client'
import { copyText } from '@/lib/clipboard'
import { getMeId, useAuth } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import type { Conversation, Participant } from '@/types'
import { haptic } from './haptics'
import { useNT } from './i18n'
import { href, navigate } from './router'

/* One shared 1 Hz clock for every elapsed-time label, instead of an
   interval per component. Subscribers only exist while something live
   is on screen, so an idle app runs no timer at all. */
let now = Date.now()
const listeners = new Set<() => void>()
let timer: number | null = null

function subscribeNow(cb: () => void): () => void {
  listeners.add(cb)
  if (timer === null) {
    // The clock was idle, so the value the first render read is stale:
    // refresh it and repaint the new subscriber at once, not a second later.
    now = Date.now()
    queueMicrotask(cb)
    timer = window.setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, 1000)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

export function useNow(enabled = true): number {
  return useSyncExternalStore(enabled ? subscribeNow : noopSubscribe, () => (enabled ? now : 0))
}

function noopSubscribe(): () => void {
  return () => {}
}

/** A copy button's state: `copy(text)` copies, and `done` and `label` say how
 *  it went for 1.5 s, so the button can show a check (no haptic for a copy
 *  that worked) or a failure, which plays the error haptic. */
export function useCopy(): { done: 'copied' | 'failed' | null; label: string; copy: (text: string) => void } {
  const nt = useNT()
  const [done, setDone] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(null), 1500)
    return () => window.clearTimeout(t)
  }, [done])
  const copy = useCallback((text: string) => {
    copyText(text).then(() => setDone('copied'), () => { haptic('error'); setDone('failed') })
  }, [])
  const label = done === 'copied' ? nt('msg.copied') : done === 'failed' ? nt('msg.copyFailed') : nt('msg.copy')
  return { done, label, copy }
}

/** The viewer owns or administers the active workspace: the fork's agent
 *  routes (screen, coding, handbook) answer only them. */
export function useAdmin(): boolean {
  return useAuth((s) => {
    const role = s.companies.find((x) => x.id === s.activeCompanyId)?.role
    return role === 'owner' || role === 'admin'
  })
}

/** The other participant of a direct conversation. */
export function directPeer(c: Conversation, byId: Record<string, Participant>): Participant | undefined {
  const me = getMeId()
  const id = c.members.find((m) => m !== me) ?? c.members[0]
  return id ? byId[id] : undefined
}

/** Find the 1:1 room with someone, creating it on first use, and open it. */
export function useOpenDirect(): (participantId: string) => Promise<void> {
  return useCallback(async (participantId: string) => {
    const me = getMeId()
    const existing = useConversations.getState().list.find((c) =>
      c.kind === 'direct' && c.members.includes(participantId) && (c.members.length === 1 || c.members.includes(me ?? '')),
    )
    if (existing) {
      navigate(href({ section: 'chats', id: existing.id }))
      return
    }
    const { id } = await api.openDirect(participantId)
    await useConversations.getState().reload()
    navigate(href({ section: 'chats', id }))
  }, [])
}

/** How long a finger rests before a press becomes a hold. */
export const HOLD_MS = 420

// iOS (Safari and the app's WKWebView) never turns a long press into a
// contextmenu; Android does. iPadOS reports itself as a Mac with touch.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/**
 * Press-and-hold on touch, right-click with a mouse: both open the same menu.
 * The click that a finger lift produces after a hold is swallowed so the row
 * underneath does not also navigate.
 */
export function useHold(onHold: (x: number, y: number) => void) {
  const timer = useRef<number | null>(null)
  const start = useRef({ x: 0, y: 0 })
  const fired = useRef(false)
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      fired.current = false
      // A long press on anything inside the row that names an agent (an
      // avatar, a name, an @mention) becomes a contextmenu on Android, which
      // opens the agent menu (agentRefs.ts); holding too would open two
      // sheets. iOS sends none, so there the row's own menu opens.
      if (!IOS && (e.target as Element).closest('[data-agent-id]')) return
      start.current = { x: t.clientX, y: t.clientY }
      clear()
      timer.current = window.setTimeout(() => {
        fired.current = true
        haptic('hold')
        onHold(start.current.x, start.current.y)
      }, HOLD_MS)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (t && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) clear()
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      if (fired.current) return
      onHold(e.clientX, e.clientY)
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}

export function openPalette(mode: 'all' | 'people' = 'all'): void {
  window.dispatchEvent(new CustomEvent('nx:palette', { detail: mode }))
}
