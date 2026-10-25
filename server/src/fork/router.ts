import { Router, type Request, type Response, type NextFunction } from 'express'
import type { AuthedRequest } from '../auth.js'
import { ForkLimitError, getForkStore } from './store.js'
import { agentHandbook } from './handbook.js'
import { agentCoding, codingThread, startCodingPoller } from './coding.js'
import { startRecorder } from './recorder.js'
import { startMoods } from './mood.js'
import { stopAgent } from './stop.js'
import { answerChoice, listCards, sendSecret, startCardSweeper } from './cards.js'
import { computerPurges, purgeAgent } from './purge.js'
import { agentScreen, agentScreenInput } from './screen.js'
import { roomTokens } from './tokens.js'
import { isPrivileged } from './roles.js'
import { LIMITS, checkTrigger, listProfiles, runNow, shownTrigger, startTriggerPoller } from './triggers.js'

type CompanyContext = { userId: string; companyId: string }

export interface ForkRouterDeps {
  requireCompany(req: Request & AuthedRequest): Promise<CompanyContext>
  /** The calling computer's daemon, by its device token. */
  requireDevice(req: Request & AuthedRequest): Promise<{ computerId: string }>
}

class ForkError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function categoryName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length < 1 || name.length > 60) throw new ForkError(400, 'name must be 1 to 60 characters')
  return name
}

function routeKey(value: string, label: string): string {
  if (value.length > 100) throw new ForkError(400, `${label} must be at most 100 characters`)
  return value
}

/** A bloub catalogue id. The client knows the catalogue and draws an unknown id
 *  as its default, so the server only keeps the value short and plain. */
function lookId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z]{1,24}$/.test(value)) throw new ForkError(400, `${label} must be 1 to 24 lowercase letters`)
  return value
}

/** The accessories of a pick: catalogue ids like a shape's, each once. Left
 *  out, the pick keeps what the agent wears. */
export function accessoryIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  // More than the client's catalogue has, so a newer client's ids still fit.
  if (!Array.isArray(value) || value.length > 8) throw new ForkError(400, 'accessories must be a list of at most 8 ids')
  return [...new Set(value.map((id) => lookId(id, 'accessory')))]
}

/** Changing how an agent looks changes it for everyone in the workspace, so it
 *  takes the same bar as upstream's PUT /api/agents/:id: owner or admin. */
async function requireAgentEditor(companyId: string, userId: string, participantId: string): Promise<void> {
  // Imported here, not at the top: db/pool.js loads env.ts, which exits
  // without OPENAI_API_KEY and would kill the tests that import this module.
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ kind: string | null; role: string | null }>(
    `SELECT (SELECT kind FROM participants WHERE id = $1 AND company_id = $2) AS kind,
            (SELECT role FROM company_members WHERE company_id = $2 AND user_id = $3) AS role`,
    [participantId, companyId, userId],
  )
  const role = rows[0]?.role
  if (!isPrivileged(role)) throw new ForkError(403, 'this action requires an owner or admin of the workspace')
  if (rows[0]?.kind !== 'agent') throw new ForkError(404, 'agent not found')
}

function text(value: unknown, label: string, max: number): string {
  const s = typeof value === 'string' ? value.trim() : ''
  if (s.length < 1 || s.length > max) throw new ForkError(400, `${label} must be 1 to ${max} characters`)
  return s
}

/** The caller is a member of the room, and so is the agent when one is named:
 *  a room's triggers are its members' business, like its routines. 404 like a
 *  missing room otherwise (src/next/AGENTS.md). */
async function requireRoom(companyId: string, userId: string, conversationId: string, agentId: string | null = null): Promise<void> {
  const { pool } = await import('../db/pool.js')
  const { rows } = await pool.query<{ agent: boolean }>(
    `SELECT ($4::text IS NULL OR EXISTS (
              SELECT 1 FROM conversation_members m
                JOIN participants p ON p.id = m.participant_id AND p.company_id = m.company_id
               WHERE m.conversation_id = $1 AND m.company_id = $2 AND m.participant_id = $4
                 AND p.kind = 'agent' AND p.departed_at IS NULL)) AS agent
       FROM conversation_members
      WHERE conversation_id = $1 AND company_id = $2 AND participant_id = $3`,
    [conversationId, companyId, userId, agentId],
  )
  if (!rows[0]) throw new ForkError(404, 'room not found')
  if (!rows[0].agent) throw new ForkError(404, 'agent not found in the room')
}

/** Fork-only endpoints under /api/fork, backed by the SQLite store in ./store.ts.
 *  Every row is scoped by the caller's own (companyId, userId) from requireCompany.
 *  Created once at boot, which is also when the Handbook's recorder, the bloub
 *  moods, the trigger poller, the T3 coding poller and the card sweeper start. */
export function createForkRouter(deps: ForkRouterDeps): Router {
  const router = Router()
  startRecorder()
  startMoods()
  startTriggerPoller()
  startCodingPoller()
  startCardSweeper()

  router.get('/room-layout', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    res.json((await getForkStore()).layout(companyId, userId))
  })

  router.get('/agents/:agentId/handbook', (req, res) => agentHandbook(deps.requireCompany, req, res))
  router.get('/agents/:agentId/coding', (req, res) => agentCoding(deps.requireCompany, req, res))
  router.get('/coding/:server/:threadId', (req, res) => codingThread(deps.requireCompany, req, res))
  router.get('/agents/:agentId/screen', (req, res) => agentScreen(deps.requireCompany, req, res))
  router.post('/agents/:agentId/screen/input', (req, res) => agentScreenInput(deps.requireCompany, req, res))
  router.post('/rooms/:conversationId/agents/:agentId/stop', (req, res) => stopAgent(deps.requireCompany, req, res))
  router.get('/rooms/:conversationId/tokens', (req, res) => roomTokens(deps.requireCompany, req, res))

  router.get('/cards', (req, res) => listCards(deps.requireCompany, req, res))
  router.post('/cards/:messageId/answer', (req, res) => answerChoice(deps.requireCompany, req, res))
  router.post('/cards/:messageId/secret', (req, res) => sendSecret(deps.requireCompany, req, res))

  router.post('/categories', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const name = categoryName(req.body?.name)
    res.status(201).json({ category: (await getForkStore()).createCategory(companyId, userId, name) })
  })

  router.patch('/categories/:id', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const body = req.body ?? {}
    const patch: { name?: string; position?: number; hidden?: boolean } = {}
    if (body.name !== undefined) patch.name = categoryName(body.name)
    if (body.position !== undefined) {
      if (typeof body.position !== 'number' || !Number.isFinite(body.position)) {
        throw new ForkError(400, 'position must be a finite number')
      }
      patch.position = body.position
    }
    if (body.hidden !== undefined) {
      if (typeof body.hidden !== 'boolean') throw new ForkError(400, 'hidden must be a boolean')
      patch.hidden = body.hidden
    }
    if (!(await getForkStore()).updateCategory(companyId, userId, req.params.id, patch)) {
      throw new ForkError(404, 'category not found')
    }
    res.json({ ok: true })
  })

  router.delete('/categories/:id', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    if (!(await getForkStore()).deleteCategory(companyId, userId, req.params.id)) {
      throw new ForkError(404, 'category not found')
    }
    res.json({ ok: true })
  })

  router.put('/rooms/:conversationId/category', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const conversationId = routeKey(req.params.conversationId, 'conversationId')
    const categoryId: unknown = req.body?.categoryId
    if (categoryId !== null && typeof categoryId !== 'string') {
      throw new ForkError(400, 'categoryId must be a string or null')
    }
    if (!(await getForkStore()).setRoomCategory(companyId, userId, conversationId, categoryId)) {
      throw new ForkError(404, 'category not found')
    }
    res.json({ ok: true })
  })

  router.put('/pin-order', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const ids: unknown = req.body?.conversationIds
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new ForkError(400, 'conversationIds must be an array of strings')
    }
    if (new Set(ids).size !== ids.length) throw new ForkError(400, 'conversationIds must not repeat')
    const store = await getForkStore()
    store.setPinOrder(companyId, userId, ids.map((id) => routeKey(id, 'conversationId')))
    res.json({ ok: true })
  })

  router.put('/groups/:key/collapsed', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const key = routeKey(req.params.key, 'key')
    const collapsed: unknown = req.body?.collapsed
    if (typeof collapsed !== 'boolean') throw new ForkError(400, 'collapsed must be a boolean')
    if (!(await getForkStore()).setCollapsed(companyId, userId, key, collapsed)) {
      throw new ForkError(404, 'group not found')
    }
    res.json({ ok: true })
  })

  router.get('/bloub-avatars', async (req, res) => {
    const { companyId } = await deps.requireCompany(req)
    res.json({ avatars: (await getForkStore()).bloubAvatars(companyId) })
  })

  router.put('/bloub-avatars/:participantId', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const participantId = routeKey(req.params.participantId, 'participantId')
    const body = req.body ?? {}
    // The expression is not picked: it follows the agent's messages (./mood.ts).
    const look = { shape: lookId(body.shape, 'shape'), color: lookId(body.color, 'color'), accessories: accessoryIds(body.accessories) }
    await requireAgentEditor(companyId, userId, participantId)
    const store = await getForkStore()
    store.setBloubAvatar(companyId, participantId, look)
    res.json({ ok: true })
  })

  router.get('/triggers/profiles', async (req, res) => {
    await deps.requireCompany(req)
    res.json({ profiles: listProfiles() })
  })

  router.get('/triggers', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const conversationId = routeKey(String(req.query.conversation ?? ''), 'conversation')
    if (!conversationId) throw new ForkError(400, 'conversation is required')
    await requireRoom(companyId, userId, conversationId)
    const triggers = (await getForkStore()).triggers(companyId, conversationId)
    res.json({ triggers: triggers.map(shownTrigger) })
  })

  router.post('/triggers', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const body = req.body ?? {}
    const conversationId = routeKey(text(body.conversationId, 'conversationId', 100), 'conversationId')
    const assigneeId = routeKey(text(body.assigneeId, 'assigneeId', 100), 'assigneeId')
    const fields = checkTrigger(body)
    if (typeof fields === 'string') throw new ForkError(400, fields)
    await requireRoom(companyId, userId, conversationId, assigneeId)
    const trigger = (await getForkStore()).createTrigger({ companyId, createdBy: userId, conversationId, assigneeId, ...fields })
    res.status(201).json({ trigger: shownTrigger(trigger) })
  })

  router.patch('/triggers/:id', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const store = await getForkStore()
    const trigger = store.trigger(companyId, req.params.id)
    if (!trigger) throw new ForkError(404, 'trigger not found')
    await requireRoom(companyId, userId, trigger.conversationId)
    const body = req.body ?? {}
    const patch: { status?: 'active' | 'paused'; title?: string; prompt?: string } = {}
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'paused') throw new ForkError(400, 'status must be active or paused')
      patch.status = body.status
    }
    if (body.title !== undefined) patch.title = text(body.title, 'title', LIMITS.title)
    if (body.prompt !== undefined) patch.prompt = text(body.prompt, 'prompt', LIMITS.prompt)
    store.updateTrigger(companyId, trigger.id, patch)
    res.json({ ok: true })
  })

  router.delete('/triggers/:id', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const store = await getForkStore()
    const trigger = store.trigger(companyId, req.params.id)
    if (!trigger) throw new ForkError(404, 'trigger not found')
    await requireRoom(companyId, userId, trigger.conversationId)
    store.deleteTrigger(companyId, trigger.id)
    res.json({ ok: true })
  })

  router.post('/triggers/:id/run-now', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const trigger = (await getForkStore()).trigger(companyId, req.params.id)
    if (!trigger) throw new ForkError(404, 'trigger not found')
    await requireRoom(companyId, userId, trigger.conversationId)
    const pr = await runNow(trigger)
    if (!pr) throw new ForkError(404, 'the repository has no merged pull request')
    res.json({ ok: true, pr })
  })

  router.delete('/bloub-avatars/:participantId', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const participantId = routeKey(req.params.participantId, 'participantId')
    await requireAgentEditor(companyId, userId, participantId)
    const store = await getForkStore()
    store.clearBloubAvatar(companyId, participantId)
    res.json({ ok: true })
  })

  // Deleting an agent for good (./purge.ts). Only an off-boarded one, so the
  // step that cannot be undone always comes after one that can.
  router.delete('/agents/:agentId', async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const agentId = routeKey(req.params.agentId, 'agentId')
    await requireAgentEditor(companyId, userId, agentId)
    const result = await purgeAgent(companyId, agentId)
    if (result === 'not_found') throw new ForkError(404, 'agent not found')
    if (result === 'active') throw new ForkError(409, 'off-board the agent before deleting it')
    res.json({ ok: true })
  })

  // The computer's daemon removes deleted agents' files (./computer-purge.ts).
  router.get('/computers/me/purges', async (req, res) => {
    const { computerId } = await deps.requireDevice(req)
    res.json({ agentIds: await computerPurges(computerId) })
  })

  router.delete('/computers/me/purges/:agentId', async (req, res) => {
    const { computerId } = await deps.requireDevice(req)
    ;(await getForkStore()).clearComputerPurge(computerId, routeKey(req.params.agentId, 'agentId'))
    res.json({ ok: true })
  })

  // Other errors (requireCompany's HttpError, store failures) fall through to
  // the API's global errorHandler.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ForkError) { res.status(err.status).json({ error: err.message }); return }
    if (err instanceof ForkLimitError) { res.status(400).json({ error: err.message }); return }
    next(err)
  })
  return router
}
