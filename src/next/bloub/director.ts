/**
 * Runs the bloub avatars on screen. Every avatar of one agent (its chat-list
 * row, its messages, the panel) shares that agent's engine, and one
 * requestAnimationFrame loop drives them all: each frame samples an engine
 * once and draws it into the visible views of that agent. The loop stops when
 * no view is visible and starts again when one is.
 *
 * Signals come from the stores and the socket, not from React: the agent's
 * status and its computer (program.ts modeOf), the kind of tool it runs
 * (`fork.agent.tool`, acted out by tools.ts), and the messages it posts.
 */
import { ws } from '@/api/client'
import { useComputers } from '@/stores/computers'
import { useParticipants } from '@/stores/participants'
import type { Message } from '@/types'
import { TALK_KINDS } from '../chat/model'
import { AccessoryRig, earFace, outlineOf } from './accessories'
import type { BotEngine } from './engine/engine'
import { EXPRESSION_BY_ID, type ExpressionId } from './engine/expressions'
import { RAYON } from './engine/repere'
import { SHAPE_BY_ID } from './engine/skins'
import type { BloubLook } from './looks'
import { advance, flash, modeOf, POSTED, programFor, type Mode, type Playhead } from './program'
import { ACTS, isToolKind, type ToolKind } from './tools'
import { createView } from './view'

/** A status that flips for a moment (a 0.2 s tool call) would flash a whole
 *  state in and out. So the first change applies at once, and each mode is
 *  then held at least this long, the latest wanted mode winning. */
const MIN_HOLD = 1.2
/** Seconds a tool prop takes to rise in, and to sink away. */
const PROP_IN = 0.35
const PROP_OUT = 0.25
/** An act aims the eyes anew every frame, so the engine follows each aim within a frame. */
const AIM_MORPH = 1 / 60

type Engines = typeof import('./engine/engine')
let engines: Promise<Engines> | null = null
/** The engine module tabulates its eye offsets when it loads (about 25 ms on a
 *  laptop, several times that on a phone), so it is not loaded with the app:
 *  looks.ts preloads it at idle once an agent wears a look, and otherwise the
 *  first bloub to appear loads it. */
export function loadEngine(): Promise<Engines> {
  return (engines ??= import('./engine/engine'))
}

type View = ReturnType<typeof createView> & { visible: boolean }

/** A tool act playing since `since`, or fading out since `until`. */
interface Act { kind: ToolKind; since: number; until?: number }

interface Bot {
  engine: BotEngine | null
  /** Places the accessories the look wears, from each frame of `engine`. */
  rig: AccessoryRig
  /** Seconds added to the shared clock, so agents blink and glance at their own moments. */
  offset: number
  look: BloubLook
  mode: Mode
  head: Playhead
  wanted: Mode
  /** The kind of tool the agent last reported, and the one the playing program acts out. */
  tool: ToolKind | null
  appliedTool: ToolKind | null
  act: Act | null
  leaving: Act | null
  appliedAt: number
  timer: number
  views: Set<View>
  visible: number
}

const bots = new Map<string, Bot>()
let raf = 0
const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
const still = () => reducedMotion?.matches === true

const clock = () => performance.now() / 1000
const timeOf = (bot: Bot) => clock() + bot.offset

function offsetOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (h >>> 0) % 600
}

const shapeOf = (look: Pick<BloubLook, 'shape'>) => SHAPE_BY_ID.get(look.shape)?.radii ?? null
const expressionOf = (look: Pick<BloubLook, 'expression'>) => EXPRESSION_BY_ID.get(look.expression) ?? null
const easeOut = (k: number) => 1 - (1 - Math.min(1, Math.max(0, k))) ** 3

/** Modes the editor's preview stage plays (sections/agents/LookStudio.tsx), by
 *  the stage's own id, which no participant has. */
const staged = new Map<string, Mode>()

function modeFor(id: string): Mode {
  const forced = staged.get(id)
  if (forced) return forced
  const p = useParticipants.getState().byId[id]
  if (!p) return 'idle'
  return modeOf(p, p.computerId ? useComputers.getState().byId[p.computerId] : undefined)
}

/** The step the playhead is on: its state, how long it holds, and its tool. */
const stepOf = (bot: Bot) => bot.head.program.steps[bot.head.index]

/** The agent's face on screen: an act's while one plays, else its own. */
const faceOf = (bot: Bot): ExpressionId => (bot.act ? ACTS[bot.act.kind].face : bot.look.expression)

/** Starts or ends the tool act of the step the playhead is on, at time `at`:
 *  the act wears its kind's face, and ending it gives back the agent's own
 *  face and gaze. */
function syncAct(bot: Bot, at: number) {
  const kind = stepOf(bot)[2] ?? null
  if (kind === (bot.act?.kind ?? null)) return
  if (bot.act) {
    bot.leaving = { ...bot.act, until: at }
    bot.engine?.setLook(null, at)
  }
  bot.act = kind ? { kind, since: at } : null
  bot.engine?.setExpression(EXPRESSION_BY_ID.get(faceOf(bot)) ?? null, at)
}

/** Gives the ears the face of the state on screen, or the agent's. */
function syncEars(bot: Bot, at: number) {
  bot.rig.setFace(earFace(stepOf(bot)[0], faceOf(bot)), at)
}

function frame() {
  raf = 0
  const now = clock()
  let drawn = false
  for (const bot of bots.values()) {
    const engine = bot.engine
    if (!engine || bot.visible === 0) continue
    const t = now + bot.offset
    advance(bot.head, t, (state, at) => {
      engine.setState(state, at)
      syncAct(bot, at)
      syncEars(bot, at)
    })
    // Reduced motion: each state is drawn once, settled, and nothing loops.
    // That frame is taken a second into the state, or now if that is later, so
    // a shape, face or gaze set since then is in it, and sampled half a second
    // on, once their morphs have ended.
    const at = still() ? Math.max(t, bot.head.since + 1) : t
    const acts: Array<{ kind: ToolKind; t: number; presence: number }> = []
    if (bot.act) {
      engine.setLook(ACTS[bot.act.kind].look(at - bot.act.since), at, AIM_MORPH)
      acts.push({ kind: bot.act.kind, t: at - bot.act.since, presence: still() ? 1 : easeOut((at - bot.act.since) / PROP_IN) })
    }
    const leaving = bot.leaving
    if (leaving?.until !== undefined) {
      const left = (at - leaving.until) / PROP_OUT
      if (left >= 1 || still() || leaving.kind === bot.act?.kind) bot.leaving = null
      else acts.push({ kind: leaving.kind, t: at - leaving.since, presence: 1 - easeOut(left) })
    }
    const sampled = still() ? at + 0.5 : at
    const f = engine.sample(sampled)
    const gear = bot.rig.update(f, outlineOf(engine), sampled, bot.look, !still())
    // The body leans aside as far as the props have come in.
    const lean = acts.reduce((most, act) => Math.max(most, act.presence), 0)
    for (const view of bot.views) {
      if (!view.visible) continue
      view.draw(f, gear)
      view.props(acts)
      view.lean(lean)
    }
    drawn = true
  }
  if (drawn && !still()) raf = requestAnimationFrame(frame)
}

function wake() {
  if (!raf) raf = requestAnimationFrame(frame)
}

function play(bot: Bot, head: Playhead) {
  bot.head = head
  bot.engine?.setState(head.program.steps[0][0], head.since)
  syncAct(bot, head.since)
  syncEars(bot, head.since)
  wake()
}

function applyMode(bot: Bot) {
  bot.timer = 0
  const tool = bot.wanted === 'working' ? bot.tool : null
  if (bot.wanted === bot.mode && tool === bot.appliedTool) return
  const t = timeOf(bot)
  // Under reduced motion a turn neither opens with burst nor closes with comet.
  play(bot, { program: programFor(still() ? null : bot.mode, bot.wanted, tool), index: 0, since: t })
  bot.mode = bot.wanted
  bot.appliedTool = tool
  bot.appliedAt = t
}

function requestMode(bot: Bot, mode: Mode) {
  bot.wanted = mode
  if (bot.timer) return
  const wait = bot.appliedAt + MIN_HOLD - timeOf(bot)
  if (wait <= 0) applyMode(bot)
  else bot.timer = window.setTimeout(() => applyMode(bot), wait * 1000)
}

function wink(bot: Bot) {
  if (still()) return
  // burst and comet already mark the turn; a wink would cut them short.
  const current = bot.head.program.steps[bot.head.index][0]
  if (current === 'burst' || current === 'comet') return
  play(bot, { program: flash(POSTED, bot.mode, bot.appliedTool), index: 0, since: timeOf(bot) })
}

function posted(message: Message) {
  const bot = bots.get(message.authorId)
  if (bot && TALK_KINDS.has(message.kind)) wink(bot)
}

/** The kind of tool comes as a hint beside the status, and often before it:
 *  it is kept until the next one and acted out whenever the agent is working. */
function toolReported(participantId: unknown, tool: unknown) {
  const bot = typeof participantId === 'string' ? bots.get(participantId) : undefined
  if (!bot) return
  bot.tool = isToolKind(tool) ? tool : null
  requestMode(bot, bot.wanted)
}

let wired = false
function wire() {
  if (wired) return
  wired = true
  const sync = () => { for (const [id, bot] of bots) requestMode(bot, modeFor(id)) }
  useParticipants.subscribe((s, prev) => { if (s.byId !== prev.byId) sync() })
  useComputers.subscribe((s, prev) => { if (s.byId !== prev.byId) sync() })
  ws.on((e) => {
    if (e.type === 'message.new') posted(e.message)
    // A fork event (server/src/fork/agentTool.ts), outside the client's event union.
    const fork = e as { type: string; participantId?: unknown; tool?: unknown }
    if (fork.type === 'fork.agent.tool') toolReported(fork.participantId, fork.tool)
  })
  reducedMotion?.addEventListener('change', wake)
}

/** Off-screen views (a scrolled-away row, a closed panel) are not drawn. */
const observed = new WeakMap<Element, (visible: boolean) => void>()
const watcher = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) observed.get(entry.target)?.(entry.isIntersecting)
  })
  : null


/** Starts animating `svg` as an avatar of `agentId` and returns the function
 *  that stops it. The agent's engine is created with its first view and
 *  dropped with its last. */
export function attach(agentId: string, svg: SVGSVGElement, look: BloubLook): () => void {
  wire()
  let bot = bots.get(agentId)
  if (!bot) {
    const offset = offsetOf(agentId)
    const mode = modeFor(agentId)
    const t = clock() + offset
    const start: Playhead = { program: programFor(null, mode), index: 0, since: t }
    const rig = new AccessoryRig(offset, earFace(start.program.steps[0][0], look.expression))
    const created: Bot = {
      engine: null, rig, offset, look, mode, wanted: mode, tool: null, appliedTool: null, act: null, leaving: null,
      appliedAt: t, timer: 0, views: new Set(), visible: 0, head: start,
    }
    bots.set(agentId, created)
    bot = created
    void loadEngine().then(({ BotEngine }) => {
      if (bots.get(agentId) !== created) return
      const { head } = created
      const face = EXPRESSION_BY_ID.get(faceOf(created)) ?? null
      const engine = new BotEngine(RAYON, head.program.steps[head.index][0], shapeOf(created.look), face)
      // Start the state at the playhead's time, so a burst already half played is not replayed.
      engine.reset(head.program.steps[head.index][0], head.since)
      created.engine = engine
      wake()
    })
  }
  const owner = bot
  const view: View = { ...createView(svg), visible: watcher === null }
  if (view.visible) owner.visible++
  owner.views.add(view)
  observed.set(svg, (visible) => {
    if (visible === view.visible) return
    view.visible = visible
    owner.visible += visible ? 1 : -1
    if (visible) wake()
  })
  watcher?.observe(svg)
  wake()
  return () => {
    watcher?.unobserve(svg)
    observed.delete(svg)
    if (view.visible) owner.visible--
    owner.views.delete(view)
    if (owner.views.size > 0) return
    window.clearTimeout(owner.timer)
    bots.delete(agentId)
  }
}

/** Plays `mode` on the preview stage `id` in place of an agent's status, and
 *  with `posted` the wink of a message. `unstage` lets the id go. */
export function stage(id: string, mode: Mode, posted = false): void {
  staged.set(id, mode)
  const bot = bots.get(id)
  if (!bot) return
  // A click answers at once: the hold only keeps a flapping status from flashing.
  window.clearTimeout(bot.timer)
  bot.wanted = mode
  applyMode(bot)
  if (posted) wink(bot)
}

export function unstage(id: string): void {
  staged.delete(id)
}

/** A new shape or face morphs in, and accessories come or go; the colour is
 *  CSS on each view. */
export function restyle(agentId: string, look: BloubLook): void {
  const bot = bots.get(agentId)
  if (!bot) return
  bot.look = look
  const t = timeOf(bot)
  bot.engine?.setShape(shapeOf(look), t)
  // While an act plays, its face stays; the agent's own comes back when it ends.
  if (!bot.act) bot.engine?.setExpression(expressionOf(look), t)
  syncEars(bot, t)
  wake()
}

/** Draws one resting frame of a look into `svg`, for the picker. */
export function drawStill(svg: SVGSVGElement, look: Pick<BloubLook, 'shape' | 'expression' | 'accessories'>): () => void {
  let live = true
  const { draw } = createView(svg)
  void loadEngine().then(({ BotEngine }) => {
    if (!live) return
    const engine = new BotEngine(RAYON, 'idle', shapeOf(look), expressionOf(look))
    // 1 s in: before the first scheduled blink, with the gaze near its rest.
    const frame = engine.sample(1)
    draw(frame, new AccessoryRig(0, look.expression).update(frame, outlineOf(engine), 1, look, false))
  })
  return () => { live = false }
}
