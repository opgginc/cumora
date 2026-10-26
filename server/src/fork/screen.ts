/**
 * The Computer tab: an agent's browser, live. agent-browser runs one headless
 * Chromium per agent on the computer, in the session named after the agent
 * (the shims in the deploy repo), and its dashboard streams each session's
 * screen and takes clicks and keys for it. The server keeps one stream per
 * agent while someone watches and answers long polls with the newest frame:
 * the phone app's fetch goes through native HTTP (CapacitorHttp), which hands
 * over a response only when it ends, so a stream would never reach it.
 */
import http from 'node:http'
import type { Request, Response } from 'express'
import WebSocket from 'ws'
import type { AuthedRequest } from '../auth.js'
import { isPrivileged } from './roles.js'

// The dashboard listens on the computer's loopback, and computer/start.sh in
// the deploy repo relays it to port 4849 on the compose network. It skips its
// access token when the Host header is loopback, so the server asks as
// localhost:4848.
const DASHBOARD = { host: 'computer', port: 4849 }
const LOOPBACK = 'localhost:4848'

const MAX_FPS = 10 // the most frames per second the dashboard sends one stream
const HOLD_MS = 5_000 // a poll waits this long for something newer
const IDLE_MS = 30_000 // a stream nobody polled for this long closes
const RETRY_MS = 3_000 // a browser that is not open is looked for this often
const HANDSHAKE_MS = 10_000 // give up a stalled websocket upgrade so it retries

export interface ScreenPoll {
  state: 'open' | 'closed'
  /** Bumps on every change; the next poll sends it back as `after`. */
  seq: number
  /** Base64 JPEG, only when a frame newer than `after` arrived. */
  frame?: string
  /** The page's width in CSS pixels, the space clicks are given in, or 0 when
   *  agent-browser sent none (then the frame's width stands in). No height:
   *  agent-browser reports the window's, not the page's
   *  (vercel-labs/agent-browser#1613), so clients take it from the frame's
   *  aspect. */
  width?: number
  url: string | null
}

function dashboardSessions(): Promise<Array<{ session: string; port: number }>> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      ...DASHBOARD,
      path: '/api/sessions',
      timeout: 3_000,
      // The dashboard wants a same-origin Referer on its API as well.
      headers: { host: LOOPBACK, referer: `http://${LOOPBACK}/` },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`dashboard answered ${res.statusCode}`)); return }
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('dashboard timed out')))
    req.on('error', reject)
  })
}

class Screen {
  state: ScreenPoll['state'] = 'closed'
  seq = 0
  private frame: { data: string; width: number; seq: number } | null = null
  private url: string | null = null
  private ws: WebSocket | null = null
  private retry: NodeJS.Timeout | null = null
  private waiters = new Set<() => void>()
  private known = false
  private ended = false
  polled = Date.now()

  /** `sessions` lists the dashboard's sessions; tests give their own. */
  constructor(readonly agentId: string, private readonly sessions = dashboardSessions) { void this.connect() }

  private bump(): void {
    this.seq++
    for (const wake of [...this.waiters]) wake()
  }

  private async connect(): Promise<void> {
    this.retry = null
    if (this.ended) return
    let port: number | undefined
    try {
      const found = (await this.sessions()).find((s) => s.session === this.agentId)?.port
      // The port goes straight into the ws URL path, so only a real port number does.
      if (typeof found === 'number' && Number.isInteger(found) && found > 0 && found <= 65535) port = found
    } catch (e) {
      // A dashboard that is down looks like a browser that is not open; the
      // next try finds it again.
      console.warn(`[fork] screen of ${this.agentId}: ${(e as Error).message}`)
    }
    if (this.ended) return
    if (!port) {
      // The first look answers polls that were waiting to learn the state.
      if (!this.known) { this.known = true; this.bump() }
      this.retry = setTimeout(() => void this.connect(), RETRY_MS)
      return
    }
    // handshakeTimeout so a half-open upgrade (TCP up, HTTP never finishes)
    // fails into the close handler and retries, instead of sitting forever.
    const ws = new WebSocket(`ws://${DASHBOARD.host}:${DASHBOARD.port}/api/session/${port}/stream`, { headers: { host: LOOPBACK }, handshakeTimeout: HANDSHAKE_MS })
    this.ws = ws
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'config', maxFps: MAX_FPS }))
      this.known = true
      this.state = 'open'
      this.bump()
    })
    ws.on('message', (raw) => this.receive(String(raw)))
    // `close` follows every `error`.
    ws.on('error', (e) => console.warn(`[fork] screen of ${this.agentId}: ${e.message}`))
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      this.state = 'closed'
      this.frame = null
      this.url = null
      this.known = true
      this.bump()
      if (!this.ended) this.retry = setTimeout(() => void this.connect(), RETRY_MS)
    })
  }

  private receive(raw: string): void {
    let msg: { type?: string; data?: string; metadata?: { deviceWidth?: number }; url?: string; tabs?: Array<{ active?: boolean; url?: string }> }
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'frame' && typeof msg.data === 'string') {
      this.frame = { data: msg.data, width: msg.metadata?.deviceWidth ?? 0, seq: this.seq + 1 }
      this.bump()
      return
    }
    // `url` follows navigation in the active tab, `tabs` names the active tab
    // when the stream opens and whenever a tab opens or closes.
    const url = msg.type === 'url' ? msg.url : msg.type === 'tabs' ? msg.tabs?.find((t) => t.active)?.url : undefined
    if (typeof url === 'string' && url !== this.url) {
      this.url = url
      this.bump()
    }
  }

  poll(after: number, signal: AbortSignal): Promise<ScreenPoll> {
    this.polled = Date.now()
    if (this.seq > after || signal.aborted) return Promise.resolve(this.snapshot(after))
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        this.waiters.delete(done)
        resolve(this.snapshot(after))
      }
      const timer = setTimeout(done, HOLD_MS)
      signal.addEventListener('abort', done)
      this.waiters.add(done)
    })
  }

  private snapshot(after: number): ScreenPoll {
    const frame = this.frame && this.frame.seq > after
      ? { frame: this.frame.data, width: this.frame.width }
      : {}
    return { state: this.state, seq: this.seq, url: this.url, ...frame }
  }

  /** Sends input events in order; false when the browser is not open. */
  send(events: object[]): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    for (const e of events) ws.send(JSON.stringify(e))
    return true
  }

  idle(now: number): boolean {
    return this.waiters.size === 0 && now - this.polled > IDLE_MS
  }

  end(): void {
    this.ended = true
    if (this.retry) clearTimeout(this.retry)
    const ws = this.ws
    this.ws = null
    ws?.close()
  }
}

const screens = new Map<string, Screen>()
let sweeper: NodeJS.Timeout | null = null

function screenOf(agentId: string): Screen {
  let screen = screens.get(agentId)
  if (!screen) {
    screen = new Screen(agentId)
    screens.set(agentId, screen)
  }
  sweeper ??= setInterval(() => {
    const now = Date.now()
    for (const [id, s] of screens) if (s.idle(now)) { s.end(); screens.delete(id) }
  }, 10_000).unref()
  return screen
}

const MOUSE = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'])
const KEY = new Set(['keyDown', 'keyUp', 'rawKeyDown', 'char'])
const BUTTONS = new Set(['left', 'middle', 'right', 'none'])

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null
const int = (v: unknown, min: number, max: number): number => Math.round(num(v, min, max) ?? 0)

/** The input events a client may send, rebuilt field by field, or null when
 *  any of them is not one. agent-browser drops a key event whose optional
 *  string is null, so a missing `key`, `code` or `text` stays out. */
export function parseScreenInput(body: unknown): object[] | null {
  const events = (body as { events?: unknown } | null)?.events
  if (!Array.isArray(events) || events.length < 1 || events.length > 200) return null
  const out: object[] = []
  for (const raw of events) {
    const e = (raw ?? {}) as Record<string, unknown>
    if (e.type === 'input_mouse' && MOUSE.has(e.eventType as string)) {
      const x = num(e.x, 0, 10_000)
      const y = num(e.y, 0, 10_000)
      if (x === null || y === null) return null
      out.push({
        type: 'input_mouse', eventType: e.eventType, x, y,
        button: BUTTONS.has(e.button as string) ? e.button : 'none',
        clickCount: int(e.clickCount, 0, 3),
        deltaX: num(e.deltaX, -10_000, 10_000) ?? 0,
        deltaY: num(e.deltaY, -10_000, 10_000) ?? 0,
        modifiers: int(e.modifiers, 0, 15),
      })
    } else if (e.type === 'input_keyboard' && KEY.has(e.eventType as string)) {
      const key: Record<string, unknown> = {
        type: 'input_keyboard', eventType: e.eventType,
        windowsVirtualKeyCode: int(e.windowsVirtualKeyCode, 0, 255),
        modifiers: int(e.modifiers, 0, 15),
      }
      for (const field of ['key', 'code', 'text']) {
        const v = e[field]
        if (v === undefined) continue
        if (typeof v !== 'string' || v.length > 32) return null
        key[field] = v
      }
      out.push(key)
    } else {
      return null
    }
  }
  return out
}

type Requirer = (req: Request & AuthedRequest) => Promise<{ userId: string; companyId: string }>

/** The agent of the route, for workspace owners and admins only: the browser
 *  shows every site the agent is signed in to, and input drives it live. The
 *  role is checked on every call, not cached, so demoting a viewer or deleting
 *  the agent cuts off both watching and driving at once (as agentCoding does).
 *  Null once it has answered. */
async function gate(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<string | null> {
  const { userId, companyId } = await requireCompany(req)
  const agentId = String(req.params.agentId)
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ role: string | null; agent: boolean }>(
    `SELECT (SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2) AS role,
            EXISTS (SELECT 1 FROM participants WHERE id = $3 AND company_id = $1 AND kind = 'agent') AS agent`,
    [companyId, userId, agentId],
  )
  const role = rows[0]?.role
  if (!isPrivileged(role)) {
    res.status(403).json({ error: 'only workspace owners and admins can see an agent’s browser' })
    return null
  }
  if (!rows[0].agent) {
    res.status(404).json({ error: 'not found' })
    return null
  }
  return agentId
}

/** GET /api/fork/agents/:agentId/screen?after=<seq>: the browser's state, and
 *  its newest frame when one arrived after `after`. Waits up to HOLD_MS for a
 *  change when there is none. */
export async function agentScreen(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const agentId = await gate(requireCompany, req, res)
  if (!agentId) return
  const after = Math.max(0, Number(req.query.after) || 0)
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  const poll = await screenOf(agentId).poll(after, abort.signal)
  if (abort.signal.aborted) return
  res.setHeader('Cache-Control', 'no-store')
  res.json(poll)
}

/** POST /api/fork/agents/:agentId/screen/input {events}: clicks, wheel turns
 *  and keys for the open browser, in order. */
export async function agentScreenInput(requireCompany: Requirer, req: Request & AuthedRequest, res: Response): Promise<void> {
  const agentId = await gate(requireCompany, req, res)
  if (!agentId) return
  const events = parseScreenInput(req.body)
  if (!events) { res.status(400).json({ error: 'events must be 1 to 200 input_mouse or input_keyboard events' }); return }
  if (!screens.get(agentId)?.send(events)) { res.status(409).json({ error: 'the browser is not open' }); return }
  res.json({ ok: true })
}
