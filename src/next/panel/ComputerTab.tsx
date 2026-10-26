/**
 * Computer: an agent's browser, live. The server relays agent-browser's screen
 * stream (server/src/fork/screen.ts) as long polls rather than a stream,
 * because the phone app's fetch goes through native HTTP. A click, a wheel turn
 * or a key on the screen reaches the page; on a touch screen a tap clicks and a
 * vertical drag scrolls. Text from a phone keyboard, an IME or the clipboard
 * goes through the field under the screen. Owners and admins only, because the
 * browser shows every site the agent is signed in to. The agent drawer and the
 * Agents workspace show the same `Screen`.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { http } from '@/api/client'
import type { Conversation, Participant } from '@/types'
import { useAdmin } from '../hooks'
import { useNT } from '../i18n'
import { Dialog, IconButton, Spinner } from '../ui/primitives'
import { IExpand } from '../ui/icons'
import { errText } from '../sections/calendar/parts'
import { useRoomAgents } from '../chat/ChatView'
import { AgentChips, usePickedAgent } from './AgentChips'

interface Poll { state: 'open' | 'closed'; seq: number; frame?: string; width?: number; url: string | null }
type Input = Record<string, string | number>

// Both resolve early when the poll is aborted (unmount, agent switch, large
// view opening), so cleanup never waits on a backoff or a hidden tab.
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', done)
})
const shown = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (!document.hidden || signal.aborted) { resolve(); return }
  const done = () => {
    if (document.hidden) return
    off()
    resolve()
  }
  const off = () => { document.removeEventListener('visibilitychange', done); signal.removeEventListener('abort', stop) }
  const stop = () => { off(); resolve() }
  document.addEventListener('visibilitychange', done)
  signal.addEventListener('abort', stop)
})

/**
 * Reads an agent's screen until `signal` aborts, one answer or failure at a
 * time: it rests while the app is in the background and retries a failed read
 * after 3 s. A first read answers with the newest frame the server holds.
 */
async function* screenReads(agentId: string, signal: AbortSignal): AsyncGenerator<{ poll: Poll } | { error: unknown }> {
  const path = `/fork/agents/${encodeURIComponent(agentId)}/screen`
  let after = 0
  while (!signal.aborted) {
    if (document.hidden) {
      await shown(signal)
      continue
    }
    let read: { poll: Poll } | { error: unknown }
    try {
      read = { poll: await http<Poll>(`${path}?after=${after}`, { signal }) }
    } catch (error) {
      read = { error }
    }
    // An abort rejects the fetch; that is cleanup, not an error.
    if (signal.aborted) return
    if ('poll' in read) after = read.poll.seq
    yield read
    // The server holds a read open until a frame comes; only a failure waits here.
    if ('error' in read) await sleep(3_000, signal)
  }
}

// CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. The browser runs on
// Linux, so the Mac's Command works there as Control (select all, copy).
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.shiftKey ? 8 : 0)
const BUTTONS = ['left', 'middle', 'right']

// The keys a touch screen has no other way to press. Enter's text makes the
// page see a keypress, which is what submits a form.
const KEYS = {
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
}
const press = ({ text, ...key }: { key: string; code: string; windowsVirtualKeyCode: number; text?: string }): Input[] => [
  { type: 'input_keyboard', eventType: 'keyDown', ...key, ...(text ? { text } : {}) },
  { type: 'input_keyboard', eventType: 'keyUp', ...key },
]

export function Screen({ agent, big = false }: { agent: Participant; big?: boolean }) {
  const nt = useNT()
  const canvas = useRef<HTMLCanvasElement>(null)
  // The page's size in CSS pixels, from the newest frame: clicks are given in it.
  const page = useRef({ w: 0, h: 0 })
  const [state, setState] = useState<'loading' | Poll['state']>('loading')
  // A frame has been painted: the canvas stays hidden until then, so its box
  // never flashes the default aspect before the first frame fills it.
  const [drawn, setDrawn] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [large, setLarge] = useState(false)
  const path = `/fork/agents/${encodeURIComponent(agent.id)}/screen`

  // One request at a time, so a release never overtakes its press; what
  // piles up meanwhile goes out together.
  const queue = useRef<Input[]>([])
  const sending = useRef(false)
  const send = (...events: Input[]) => {
    queue.current.push(...events)
    if (sending.current) return
    sending.current = true
    void (async () => {
      while (queue.current.length > 0) {
        const events = queue.current.splice(0, 200)
        try {
          await http(`${path}/input`, { method: 'POST', body: JSON.stringify({ events }) })
        } catch (e) {
          setError(errText(e))
        }
      }
      sending.current = false
    })()
  }

  useEffect(() => {
    // The large view polls on its own, so this one rests meanwhile.
    if (large) return
    // Aborting on cleanup drops the in-flight long poll at once (up to 5s
    // otherwise), so an agent switch does not leave a stale request holding a
    // connection on the phone's native HTTP pool.
    const ac = new AbortController()
    const { signal } = ac
    void (async () => {
      for await (const read of screenReads(agent.id, signal)) {
        if ('error' in read) {
          setError(errText(read.error))
          continue
        }
        const r = read.poll
        if (r.frame) {
          // A frame that does not decode says so and waits for the next one,
          // instead of ending the loop with the screen frozen on the last.
          try {
            const bytes = Uint8Array.from(atob(r.frame), (c) => c.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
            const c = canvas.current
            if (!signal.aborted && c) {
              if (c.width !== bitmap.width) c.width = bitmap.width
              if (c.height !== bitmap.height) c.height = bitmap.height
              c.getContext('2d')?.drawImage(bitmap, 0, 0)
              // Height from the frame's aspect; see ScreenPoll.width in server/src/fork/screen.ts.
              const w = r.width || bitmap.width
              page.current = { w, h: (w * bitmap.height) / bitmap.width }
              setDrawn(true)
            }
            bitmap.close()
          } catch (e) {
            setError(errText(e))
            continue
          }
        }
        // A browser that closed drops its last frame, so the next open waits
        // for a fresh one instead of flashing the stale page.
        if (r.state === 'closed') setDrawn(false)
        setState(r.state)
        setUrl(r.url)
        setError(null)
      }
    })()
    return () => ac.abort()
  }, [agent.id, large])

  const at = (e: { clientX: number; clientY: number }, r = canvas.current?.getBoundingClientRect()) => {
    if (!r || r.width === 0) return { x: 0, y: 0 }
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * page.current.w),
      y: Math.round(((e.clientY - r.top) / r.height) * page.current.h),
    }
  }

  // The wheel needs a listener that may cancel, so the panel does not scroll too.
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1
      send({ type: 'input_mouse', eventType: 'mouseWheel', ...at(e), deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: mods(e) })
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  })

  // A press within 500 ms and 4 px of the last one counts as its double click.
  const last = useRef({ t: 0, x: 0, y: 0, count: 0 })
  const touch = useRef<{ x: number; y: number; lastY: number; scrolled: boolean } | null>(null)

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    if (e.pointerType === 'touch') {
      touch.current = { x: e.clientX, y: e.clientY, lastY: e.clientY, scrolled: false }
      return
    }
    e.currentTarget.focus()
    const p = at(e)
    const l = last.current
    const count = e.timeStamp - l.t < 500 && Math.abs(p.x - l.x) < 4 && Math.abs(p.y - l.y) < 4 ? Math.min(l.count + 1, 3) : 1
    last.current = { t: e.timeStamp, ...p, count }
    send({ type: 'input_mouse', eventType: 'mousePressed', ...p, button: BUTTONS[e.button] ?? 'left', clickCount: count, modifiers: mods(e) })
  }
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const t = touch.current
    if (e.pointerType === 'touch') {
      if (!t || (!t.scrolled && Math.abs(e.clientY - t.y) < 8)) return
      t.scrolled = true
      const r = e.currentTarget.getBoundingClientRect()
      const deltaY = ((t.lastY - e.clientY) / r.height) * page.current.h
      t.lastY = e.clientY
      send({ type: 'input_mouse', eventType: 'mouseWheel', ...at({ clientX: t.x, clientY: t.y }, r), deltaX: 0, deltaY })
      return
    }
    // Only a drag moves the mouse there; hovering would send a stream for nothing.
    if (e.buttons) send({ type: 'input_mouse', eventType: 'mouseMoved', ...at(e), button: 'left', modifiers: mods(e) })
  }
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      const t = touch.current
      touch.current = null
      if (!t || t.scrolled || Math.abs(e.clientX - t.x) >= 8) return
      const p = at(e)
      send(
        { type: 'input_mouse', eventType: 'mousePressed', ...p, button: 'left', clickCount: 1 },
        { type: 'input_mouse', eventType: 'mouseReleased', ...p, button: 'left', clickCount: 1 },
      )
      return
    }
    send({ type: 'input_mouse', eventType: 'mouseReleased', ...at(e), button: BUTTONS[e.button] ?? 'left', clickCount: last.current.count, modifiers: mods(e) })
  }

  const onKey = (e: KeyboardEvent<HTMLCanvasElement>, down: boolean) => {
    // An IME composes text the page cannot follow key by key; that goes through the field.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    // The app's shortcuts, and Escape closing the large view, stay out of it.
    e.stopPropagation()
    const event: Input = { type: 'input_keyboard', eventType: down ? 'keyDown' : 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: mods(e) }
    // A key down that types carries its text; Enter's makes the keypress that submits a form.
    if (down && e.key === 'Enter') event.text = '\r'
    else if (down && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) event.text = e.key
    send(event)
  }

  const type = (e: FormEvent) => {
    e.preventDefault()
    if (!text) return
    send(...Array.from(text, (ch) => ({ type: 'input_keyboard', eventType: 'char', text: ch })))
    setText('')
  }

  return (
    <div className={big ? 'nx-screen nx-screen--big' : 'nx-screen'}>
      {state === 'open' && (
        <div className="nx-screen__bar">
          <span className="nx-screen__url nx-mono" title={url ?? undefined}>{url}</span>
          {!big && <IconButton small label={nt('computer.expand')} onClick={() => setLarge(true)}><IExpand /></IconButton>}
        </div>
      )}
      {/* Mounted while closed too, so the first frame has somewhere to land;
          hidden until a frame is drawn, so its box never flashes the default aspect. */}
      <canvas
        ref={canvas}
        hidden={state !== 'open' || !drawn}
        className="nx-screen__view"
        tabIndex={0}
        aria-label={nt('computer.screen', { name: agent.name })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { touch.current = null }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => onKey(e, true)}
        onKeyUp={(e) => onKey(e, false)}
      />
      {(state === 'loading' || (state === 'open' && !drawn)) && <div className="nx-center" aria-busy="true"><Spinner /></div>}
      {state === 'closed' && (
        <div className="nx-empty">
          <b>{nt('computer.closed', { name: agent.name })}</b>
          {nt('computer.closedBody', { name: agent.name })}
        </div>
      )}
      {state === 'open' && (
        <form className="nx-screen__type" onSubmit={type}>
          <input
            className="nx-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={nt('computer.type')}
            aria-label={nt('computer.type')}
            enterKeyHint="send"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="nx-btn nx-btn--primary" disabled={!text}>{nt('computer.send')}</button>
          <span className="nx-screen__keys">
            <button type="button" className="nx-btn nx-btn--outline" onClick={() => send(...press(KEYS.tab))}>{nt('computer.tab')}</button>
            <button type="button" className="nx-btn nx-btn--outline" onClick={() => send(...press(KEYS.backspace))}>{nt('computer.backspace')}</button>
            <button type="button" className="nx-btn nx-btn--outline" onClick={() => send(...press(KEYS.enter))}>{nt('computer.enter')}</button>
          </span>
        </form>
      )}
      {error && <p className="nx-field__error" role="alert">{error}</p>}
      {!big && (
        <Dialog open={large} onClose={() => setLarge(false)} title={nt('computer.title', { name: agent.name })} wide>
          <Screen agent={agent} big />
        </Dialog>
      )}
    </div>
  )
}

export function ComputerTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const { agents } = useRoomAgents(c)
  const picked = usePickedAgent(agents)
  const admin = useAdmin()
  if (!picked) return <div className="nx-empty">{nt('panel.noAgents')}</div>
  if (!admin) return <div className="nx-empty"><b>{nt('coding.locked')}</b>{nt('computer.lockedBody')}</div>
  return (
    <>
      <AgentChips agents={agents} picked={picked} />
      <Screen key={picked.id} agent={picked} />
    </>
  )
}
