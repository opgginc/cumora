import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import { AnimatePresence, motion, useTransform, type MotionValue } from 'framer-motion'
import { useConversations } from '@/stores/conversations'
import { useSwipeBackProps } from '@/mobile/useSwipeBack'
import { goBack, href, navigate, withRoute, type Route } from '../router'
import type { Layout } from '../layout'
import { useNT } from '../i18n'
import { SPRING_SHEET, T_FAST, useCoarse } from '../ui/primitives'
import { RightPanel } from '../panel/RightPanel'
import { Sidebar } from './Sidebar'
import { ChatEmpty, ChatView } from './ChatView'
import { CHAT_MIN, LIST, PANEL, clamp, readWidth, type Edge } from './columns'

const LAST_ROOM_KEY = 'nx.lastRoom'
const ARROW_STEP = 16

/** The widths this device chose, by storage key; null keeps the default. */
const useWidths = create<Record<string, number | null>>(() => ({ [LIST.key]: readWidth(LIST), [PANEL.key]: readWidth(PANEL) }))

function setWidth(edge: Edge, w: number | null): void {
  useWidths.setState({ [edge.key]: w })
  try {
    if (w === null) localStorage.removeItem(edge.key)
    else localStorage.setItem(edge.key, String(w))
  } catch (e) {
    console.warn('[chats] could not store the column width', e)
  }
}

/** The handle on a column's inner edge. A drag moves only its line, with
 *  `transform`, and the column takes the new width once on release, so no
 *  frame of the drag lays out the chat list or the transcript. Arrow keys move
 *  a focused handle, and a double-click restores the default width. Mouse
 *  only: ChatsSection leaves it out on touch screens. */
function Resizer({ edge }: { edge: Edge }) {
  const nt = useNT()
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; start: number; max: number; w: number } | null>(null)
  // The width the column is drawn at, which a narrow window keeps under the
  // chosen one. Screen readers hear this, the width the arrow keys start from.
  const [drawn, setDrawn] = useState<number>()
  useEffect(() => {
    const col = ref.current?.parentElement
    if (!col) return
    const ro = new ResizeObserver(([entry]) => setDrawn(Math.round(entry.borderBoxSize[0].inlineSize)))
    ro.observe(col)
    return () => ro.disconnect()
  }, [])

  // Layout is read once per gesture: where the column starts, and how far it
  // may grow before the chat column next to it would drop under CHAT_MIN.
  const span = (handle: HTMLElement) => {
    const col = handle.parentElement!
    const chat = (edge.dir === 1 ? col.nextElementSibling : col.previousElementSibling)!
    const start = Math.round(col.getBoundingClientRect().width)
    const room = Math.round(chat.getBoundingClientRect().width) - CHAT_MIN
    return { start, max: Math.min(edge.max, start + Math.max(0, room)) }
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // No text selection and no focus ring from a mouse press.
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    handle.dataset.dragging = ''
    const { start, max } = span(handle)
    drag.current = { x: e.clientX, start, max, w: start }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    d.w = clamp(d.start + edge.dir * Math.round(e.clientX - d.x), edge.min, d.max)
    // Only the handle restyles: shell.css shifts its line by this much.
    e.currentTarget.style.setProperty('--nx-ghost', `${edge.dir * (d.w - d.start)}px`)
  }
  // Capture ends after pointerup and pointercancel alike.
  const onLostPointerCapture = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    delete e.currentTarget.dataset.dragging
    e.currentTarget.style.removeProperty('--nx-ghost')
    // A press that moved nothing keeps the stored width, even one a narrow window draws smaller.
    if (d.w !== d.start) setWidth(edge, d.w)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? ARROW_STEP : e.key === 'ArrowLeft' ? -ARROW_STEP : 0
    if (!step) return
    e.preventDefault()
    const { start, max } = span(e.currentTarget)
    const w = clamp(start + edge.dir * step, edge.min, max)
    if (w !== start) setWidth(edge, w)
  }

  return (
    <div
      ref={ref}
      className="nx-resizer"
      data-edge={edge.dir === 1 ? 'end' : 'start'}
      role="separator"
      aria-orientation="vertical"
      aria-label={nt(edge.label)}
      aria-valuenow={drawn}
      aria-valuemin={edge.min}
      aria-valuemax={edge.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setWidth(edge, null)}
    />
  )
}

/** The chats grid. Only this re-renders when a width changes: the columns
 *  inside come from ChatsSection's last render, so they keep theirs. */
function ChatsGrid({ layout, dock, children }: { layout: Layout; dock: boolean; children: ReactNode }) {
  const coarse = useCoarse()
  const list = useWidths((s) => s[LIST.key])
  const panel = useWidths((s) => s[PANEL.key])
  // A touch screen has no handle to take a width back, so it keeps the
  // defaults even when a mouse on this device stored others. On a split
  // window the list leaves the chat 20px more. shell.css sizes the grid from
  // these alone, so columns.ts holds the only numbers.
  const style = {
    [LIST.prop]: `${(!coarse && list) || (layout === 'split' ? 260 : 280)}px`,
    [LIST.minProp]: `${LIST.min}px`,
    [PANEL.prop]: `${(!coarse && panel) || 360}px`,
    [PANEL.minProp]: `${PANEL.min}px`,
    '--nx-chat-min': `${CHAT_MIN}px`,
  } as CSSProperties
  return <div className="nx-chats" data-panel={dock ? 'dock' : undefined} style={style}>{children}</div>
}

/** Whether the right panel shows for this route at this width. Thread and
 *  peeks always show; tabs show when asked, or by default on wide windows. */
export function panelVisible(route: Route, layout: Layout): boolean {
  if (route.section !== 'chats' || !route.id) return false
  if (route.threadId || route.peek) return true
  if (route.panel === 'none') return false
  return route.panel !== null || layout === 'full'
}

/** `/next` on a wide window opens the room you were last in (or the newest),
 *  the way a desktop messenger reopens where you left off. */
function useDefaultRoom(route: Route, layout: Layout): void {
  const loaded = useConversations((s) => s.loaded)
  const first = useConversations((s) => s.list.find((c) => c.kind !== 'whisper')?.id ?? null)
  useEffect(() => {
    if (route.id) {
      localStorage.setItem(LAST_ROOM_KEY, route.id)
      return
    }
    if (layout === 'stack' || !loaded) return
    const last = localStorage.getItem(LAST_ROOM_KEY)
    const exists = last && useConversations.getState().list.some((c) => c.id === last)
    const target = exists ? last : first
    if (target) navigate(href({ section: 'chats', id: target }), { replace: true })
  }, [route.id, layout, loaded, first])
}

function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

/** A pushed screen: slides in from the right, follows the finger on a swipe
 *  from anywhere, and the screen underneath peeks back with parallax. */
function Pushed({ swipe, z, children }: { swipe: ReturnType<typeof useSwipeBackProps>; z: number; children: ReactNode }) {
  const w = useWidth()
  return (
    <motion.div
      className="nx-pushed"
      initial={{ x: w }}
      animate={{ x: 0 }}
      exit={{ x: w }}
      transition={SPRING_SHEET}
      {...swipe.props}
      style={{ ...swipe.props.style, zIndex: z }}
    >
      {children}
    </motion.div>
  )
}

function useParallax(top: MotionValue<number>, w: number): MotionValue<number> {
  return useTransform(top, (v) => (-w * 0.3) + (Math.min(v, w) / w) * w * 0.3)
}

function StackChats({ route }: { route: Route }) {
  const w = useWidth()
  const chatOpen = route.id !== null
  const panelOpen = panelVisible(route, 'stack')
  const chatSwipe = useSwipeBackProps(() => goBack(href({ section: 'chats' })))
  const panelSwipe = useSwipeBackProps(() => goBack(withRoute(route, { panel: null, peek: null, threadId: null })))
  const baseX = useParallax(chatSwipe.x, w)
  const chatX = useParallax(panelSwipe.x, w)
  return (
    <div className="nx-stackview">
      <motion.div className="nx-stackview__base" style={{ x: chatOpen ? baseX : 0 }} {...(chatOpen ? { inert: '' } : {})}>
        <Sidebar activeId={route.id} />
      </motion.div>
      <AnimatePresence initial={false}>
        {chatOpen && (
          <Pushed key="chat" swipe={chatSwipe} z={1}>
            <motion.div className="nx-pushed__inner" style={{ x: panelOpen ? chatX : 0 }} {...(panelOpen ? { inert: '' } : {})}>
              <ChatView convoId={route.id!} layout="stack" panelOpen={panelOpen} />
            </motion.div>
          </Pushed>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {chatOpen && panelOpen && (
          <Pushed key="panel" swipe={panelSwipe} z={2}>
            <RightPanel route={route} layout="stack" />
          </Pushed>
        )}
      </AnimatePresence>
    </div>
  )
}

export function ChatsSection({ route, layout }: { route: Route; layout: Layout }) {
  useDefaultRoom(route, layout)
  const coarse = useCoarse()
  if (layout === 'stack') return <StackChats route={route} />
  const open = panelVisible(route, layout)
  return (
    <ChatsGrid layout={layout} dock={open && layout === 'full'}>
      <div className="nx-chats__list">
        <Sidebar activeId={route.id} />
        {!coarse && <Resizer edge={LIST} />}
      </div>
      {route.id ? <ChatView convoId={route.id} layout={layout} panelOpen={open} /> : <ChatEmpty />}
      {layout === 'full' ? (
        open && route.id && (
          <motion.div className="nx-panel-dock" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={T_FAST}>
            {/* Before the panel, so Tab meets it between the chat and the panel, where it sits. */}
            {!coarse && <Resizer edge={PANEL} />}
            <RightPanel route={route} layout={layout} />
          </motion.div>
        )
      ) : (
        <AnimatePresence>
          {open && route.id && (
            <div className="nx-panel-overlay" key="overlay">
              <motion.div
                className="nx-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={T_FAST}
                onClick={() => goBack(withRoute(route, { panel: null, peek: null, threadId: null }))}
              />
              <motion.div
                className="nx-panel-sheet"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={SPRING_SHEET}
              >
                <RightPanel route={route} layout={layout} />
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      )}
    </ChatsGrid>
  )
}
