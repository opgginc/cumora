import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { AnimatePresence, motion, useTransform, type MotionValue } from 'framer-motion'
import { useConversations } from '@/stores/conversations'
import { useSwipeBackProps } from '@/mobile/useSwipeBack'
import { goBack, href, navigate, withRoute, type Route } from '../router'
import type { Layout } from '../layout'
import { useNT, type NKey } from '../i18n'
import { SPRING_SHEET, T_FAST, useCoarse } from '../ui/primitives'
import { RightPanel } from '../panel/RightPanel'
import { Sidebar } from './Sidebar'
import { ChatEmpty, ChatView } from './ChatView'

const LAST_ROOM_KEY = 'nx.lastRoom'

/** A column the mouse resizes from its inner edge. Its width is a custom
 *  property on `.nx-chats`, where shell.css floors it at `min` (keep the two
 *  in step) and keeps the chat column at least CHAT_MIN wide. */
interface Edge {
  key: string
  prop: string
  min: number
  max: number
  /** 1: the column grows as its handle moves right (the chat list); -1: the room panel. */
  dir: 1 | -1
  label: NKey
}
const LIST: Edge = { key: 'nx.listWidth', prop: '--nx-list-w', min: 220, max: 480, dir: 1, label: 'chats.resize' }
const PANEL: Edge = { key: 'nx.panelWidth', prop: '--nx-panel-w', min: 320, max: 720, dir: -1, label: 'panel.resize' }
// The `minmax(400px, 1fr)` chat track in shell.css.
const CHAT_MIN = 400
const ARROW_STEP = 16

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The width this device last chose for a column, or null for the default. */
function useStoredWidth(key: string): [number | null, (w: number | null) => void] {
  const [width, setWidth] = useState(() => Number(localStorage.getItem(key)) || null)
  const store = (w: number | null) => {
    setWidth(w)
    try {
      if (w === null) localStorage.removeItem(key)
      else localStorage.setItem(key, String(w))
    } catch (e) {
      console.warn('[chats] could not store the column width', e)
    }
  }
  return [width, store]
}

/** The handle on a column's inner edge: drag it, move it with the arrow keys
 *  once focused, or double-click it for the default width. Mouse only, so
 *  ChatsSection leaves it out on touch screens. */
function Resizer({ edge, width, onChange }: { edge: Edge; width: number; onChange: (w: number | null) => void }) {
  const nt = useNT()
  const drag = useRef<{ x: number; start: number; max: number; w: number; raf: number } | null>(null)

  // Layout is read once per gesture: the column's drawn width (a narrow window
  // may draw less than the stored one), and how far it may grow before the
  // chat column next to it would drop under CHAT_MIN.
  const span = (handle: HTMLElement) => {
    const col = handle.parentElement!
    const chat = (edge.dir === 1 ? col.nextElementSibling : col.previousElementSibling)!
    const start = Math.round(col.getBoundingClientRect().width)
    const room = Math.round(chat.getBoundingClientRect().width) - CHAT_MIN
    return { start, max: Math.min(edge.max, start + Math.max(0, room)) }
  }
  const grid = (handle: HTMLElement) => handle.parentElement!.parentElement!

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // No text selection and no focus ring from a mouse press.
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    handle.dataset.dragging = ''
    const { start, max } = span(handle)
    drag.current = { x: e.clientX, start, max, w: start, raf: 0 }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    d.w = clamp(d.start + edge.dir * Math.round(e.clientX - d.x), edge.min, d.max)
    // The grid restyles once per frame and React stays out until the drop.
    const g = grid(e.currentTarget)
    if (!d.raf) d.raf = requestAnimationFrame(() => { d.raf = 0; g.style.setProperty(edge.prop, `${d.w}px`) })
  }
  // Capture ends after pointerup and pointercancel alike.
  const onLostPointerCapture = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    cancelAnimationFrame(d.raf)
    delete e.currentTarget.dataset.dragging
    if (d.w === d.start) {
      // A press that moved nothing keeps the stored width, even one a narrow
      // window draws smaller, and undoes any frame drawn on the way.
      grid(e.currentTarget).style.setProperty(edge.prop, `${width}px`)
      return
    }
    grid(e.currentTarget).style.setProperty(edge.prop, `${d.w}px`)
    onChange(d.w)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? ARROW_STEP : e.key === 'ArrowLeft' ? -ARROW_STEP : 0
    if (!step) return
    e.preventDefault()
    const { start, max } = span(e.currentTarget)
    const w = clamp(start + edge.dir * step, edge.min, max)
    if (w !== start) onChange(w)
  }

  return (
    <div
      className="nx-resizer"
      data-edge={edge.dir === 1 ? 'end' : 'start'}
      role="separator"
      aria-orientation="vertical"
      aria-label={nt(edge.label)}
      aria-valuenow={width}
      aria-valuemin={edge.min}
      aria-valuemax={edge.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(null)}
    />
  )
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
  const [list, setList] = useStoredWidth(LIST.key)
  const [panel, setPanel] = useStoredWidth(PANEL.key)
  if (layout === 'stack') return <StackChats route={route} />
  const open = panelVisible(route, layout)
  // Defaults: the list gives the chat 20px more on a split window.
  const listW = list ?? (layout === 'split' ? 260 : 280)
  const panelW = panel ?? 360
  const widths = { [LIST.prop]: `${listW}px`, [PANEL.prop]: `${panelW}px` } as CSSProperties
  return (
    <div className="nx-chats" data-panel={open && layout === 'full' ? 'dock' : undefined} style={widths}>
      <div className="nx-chats__list">
        <Sidebar activeId={route.id} />
        {!coarse && <Resizer edge={LIST} width={listW} onChange={setList} />}
      </div>
      {route.id ? <ChatView convoId={route.id} layout={layout} panelOpen={open} /> : <ChatEmpty />}
      {layout === 'full' ? (
        open && route.id && (
          <motion.div className="nx-panel-dock" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={T_FAST}>
            {/* Before the panel, so Tab meets it between the chat and the panel, where it sits. */}
            {!coarse && <Resizer edge={PANEL} width={panelW} onChange={setPanel} />}
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
    </div>
  )
}
