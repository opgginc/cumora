/**
 * Which agents wear a bloub avatar, and how: catalogue ids of the vendored
 * engine. A look belongs to the agent for the whole workspace and lives in the
 * fork's SQLite store behind /api/fork/bloub-avatars, so upstream's
 * participants.avatar_url keeps the portrait the classic UI, push and email show.
 *
 * Owners pick the shape, the colour and any accessories in the agent editor
 * (sections/agents/LookStudio.tsx).
 * The expression is not picked: the server gives it the face of the agent's
 * latest message (server/src/fork/mood.ts) and sends `fork.agent.mood`. A
 * changed pick has no realtime event: NextApp loads the looks on start and
 * whenever the app comes back to the foreground.
 */
import { create } from 'zustand'
import { http, ws } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { loadEngine } from './director'
import type { ExpressionId } from './engine/expressions'
import type { ColorId, ShapeId } from './engine/skins'

export interface BloubLook {
  shape: ShapeId
  color: ColorId
  expression: ExpressionId
  /** Catalogue ids of accessories.ts. One this build does not know is kept and not drawn. */
  accessories: string[]
}

/** The part of a look an owner picks. */
export type BloubPick = Pick<BloubLook, 'shape' | 'color' | 'accessories'>

interface State {
  byId: Record<string, BloubLook>
  /** The workspace's looks loaded, or failed to: until then any agent may
   *  turn out to wear a bloub, and its avatar waits (ui/Avatar.tsx). */
  ready: boolean
  load: () => Promise<void>
  /** Saves a pick, or goes back to the portrait with null. Applies locally at
   *  once; a failed write reloads the server's copy and rejects. A write made
   *  in a workspace that is no longer active never rejects, and is not sent if
   *  it was still queued. */
  save: (agentId: string, pick: BloubPick | null) => Promise<void>
}

/** Thrown for a request queued in one workspace once another is active. */
const SWITCHED = new Error('workspace changed')

/** A request still unanswered by then fails: every later request waits behind
 *  it, and every agent's avatar waits for the first load (`ready`). A stalled
 *  connection never answers, and the looks are a few KB. */
const REQUEST_TIMEOUT_MS = 15_000

/** Runs a request that gives up after REQUEST_TIMEOUT_MS. A controller and a
 *  timer, not AbortSignal.timeout: the iOS app still runs on iOS 15, whose
 *  WebKit lacks it. */
async function withDeadline<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await request(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Importing the engine builds its tables in one long task. Once an agent is
 *  known to wear a look, that task runs while the page is idle rather than
 *  during the navigation that first shows a bloub. */
function preloadEngine(): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void loadEngine())
  // Without idle callbacks (WebKit), a short delay still keeps the task out of
  // the start-up work.
  else setTimeout(() => void loadEngine(), 500)
}

export const useBloubLooks = create<State>((set, get) => {
  // Every request waits for the one before it, so the server applies writes
  // in the order they were made and a load answers after every earlier write.
  let tail: Promise<unknown> = Promise.resolve()
  /** Bumped per write; a load that sees it move drops its now older answer. */
  let writes = 0

  function enqueue<T>(request: () => Promise<T>): Promise<T> {
    const epoch = useAuth.getState().contextEpoch
    // A request queued in one workspace must neither reach nor answer the next.
    const current = () => {
      if (useAuth.getState().contextEpoch !== epoch) throw SWITCHED
    }
    const run = tail.then(async () => {
      current()
      // A request that fails after a switch belongs to the old workspace too.
      const value = await request().catch((e: unknown) => { current(); throw e })
      current()
      return value
    })
    tail = run.catch(() => {})
    return run
  }

  useAuth.subscribe((s, prev) => {
    if (s.contextEpoch !== prev.contextEpoch) set({ byId: {}, ready: false })
  })

  // A fork event, outside the client's event union. A look not loaded yet
  // arrives with its face from the next load.
  ws.on((e) => {
    const mood = e as { type: string; participantId?: unknown; expression?: unknown }
    if (mood.type !== 'fork.agent.mood' || typeof mood.participantId !== 'string' || typeof mood.expression !== 'string') return
    const id = mood.participantId
    const look = get().byId[id]
    if (look && look.expression !== mood.expression) {
      set({ byId: { ...get().byId, [id]: { ...look, expression: mood.expression as ExpressionId } } })
    }
  })

  return {
    byId: {},
    ready: false,

    async load() {
      const since = writes
      try {
        const { avatars: sent } = await enqueue(() => withDeadline((signal) =>
          http<{ avatars: Record<string, Omit<BloubLook, 'accessories'> & { accessories?: string[] }> }>('/fork/bloub-avatars', { signal })))
        if (writes === since) {
          // A server from before accessories sends looks without them. The apps
          // carry their own web build, so a newer app meets such a server.
          const avatars = Object.fromEntries(Object.entries(sent).map(([id, look]) => [id, { ...look, accessories: look.accessories ?? [] }]))
          if (Object.keys(avatars).length > 0) preloadEngine()
          // Most foreground returns bring back the same looks; keeping the old
          // object keeps every avatar from re-rendering for nothing.
          if (JSON.stringify(avatars) !== JSON.stringify(get().byId)) set({ byId: avatars })
        }
      } catch (e) {
        // The next workspace's own load settles it.
        if (e === SWITCHED) return
        console.warn('[next] bloub avatars load failed', e)
      }
      // Loaded or not, avatars stop waiting: after a failed load every agent shows its portrait.
      if (!get().ready) set({ ready: true })
    },

    async save(agentId, pick) {
      writes++
      set((s) => {
        const byId = { ...s.byId }
        // A new pick keeps the face the agent has now; a first one starts at rest, as on the server.
        if (pick) byId[agentId] = { ...pick, expression: s.byId[agentId]?.expression ?? 'neutre' }
        else delete byId[agentId]
        return { byId }
      })
      const path = `/fork/bloub-avatars/${encodeURIComponent(agentId)}`
      try {
        await enqueue(() => withDeadline((signal) => http(path, pick ? { method: 'PUT', body: JSON.stringify(pick), signal } : { method: 'DELETE', signal })))
      } catch (e) {
        if (e === SWITCHED) return
        void get().load()
        throw e
      }
    },
  }
})
