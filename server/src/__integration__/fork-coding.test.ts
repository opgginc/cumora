/**
 * The Postgres side of the coding poller (server/src/fork/coding.ts) against a
 * real Postgres: which room a T3 thread belongs to, where its wake goes, who
 * may read a room's list, and when T3 is read every few seconds. The poller copies a thread seconds after
 * its launch, before a Codex turn has recorded anything, so the room must come
 * from the launching turn's own call and never from the turn before it, or the
 * thread is listed in the wrong group room and its wake lands there.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from '../db/pool.js'
import { getForkStore } from '../fork/store.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, teardownAll } from './_helpers.js'

// coding.ts finds its T3 tokens relative to the server's cwd when it loads.
const root = mkdtempSync(join(tmpdir(), 'fork-coding-pg-'))
mkdirSync(join(root, 'server/computer/t3code'), { recursive: true })
writeFileSync(join(root, 'server/computer/t3code/tok'), 'token-123\n')
const cwd = process.cwd()
process.chdir(root)
const { agentCoding, hot, launchRoom, poll } = await import('../fork/coding.js')
process.chdir(cwd)

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => {
  await teardownAll()
  rmSync(root, { recursive: true, force: true })
})

async function call(companyId: string, agentId: string, at: string, purpose: string, room: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO llm_calls (id, company_id, agent_id, purpose, model, conversation_id, created_at) VALUES ($1, $2, $3, $4, 'm', $5, $6)`,
    [randomUUID(), companyId, agentId, purpose, room, at],
  )
}

test('a wake goes to the room of the turn that launched the thread', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const launch = '2026-10-21T02:20:06.353Z'
  await call(companyId, agentId, '2026-10-21T02:19:30Z', 'agent-turn', 'room-before')
  await call(companyId, agentId, '2026-10-21T02:20:08Z', 'inbox-triage', null)
  assert.equal(await launchRoom(agentId, launch), undefined, 'a Codex turn records nothing until it ends')

  await call(companyId, agentId, '2026-10-21T02:20:17.384Z', 'agent-turn', 'dm')
  await call(companyId, agentId, '2026-10-21T02:25:00Z', 'agent-turn', 'room-after')
  assert.equal(await launchRoom(agentId, launch), 'dm')

  await call(companyId, agentId, '2026-10-21T03:00:01Z', 'agent-turn', null)
  assert.equal(await launchRoom(agentId, '2026-10-21T03:00:00Z'), null, 'a turn that answered several rooms has no room')
})

test('a poll keeps the room a thread was launched from and wakes its agent there; a thread of no one room wakes nobody', async (t) => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const group = `g-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id) VALUES ($1, 'group', 'Build', $2::jsonb, 'group', $3)`,
    [group, JSON.stringify([agentId]), companyId],
  )
  // Both came to rest a moment ago, so their first copy wakes for them.
  const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
  const t3Thread = (threadId: string, createdAt: string) => ({
    threadId, title: `[@${agentId}] ${threadId}`, status: 'completed', latestRunId: `run-${threadId}`,
    pullRequests: [], createdAt, updatedAt: at(-5), settledAt: null,
  })
  const threads = [t3Thread('th-group', at(-60)), t3Thread('th-board', at(-40))]
  // th-group's turn answered the group room; th-board's was a board turn, which records no room.
  await call(companyId, agentId, at(-55), 'agent-turn', group)
  await call(companyId, agentId, at(-35), 'agent-turn', null)
  // T3, faked at fetch as an MCP server with one project.
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params: { name: string } }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const listed = body.params.name === 't3_project_list' ? { projects: [{ id: 'p1', deletedAt: null }], nextCursor: null } : { threads, nextCursor: null }
    const result = body.method === 'initialize' ? {} : { structuredContent: listed }
    return Response.json({ jsonrpc: '2.0', id: body.id, result }, { headers: { 'mcp-session-id': 's-1' } })
  })
  // The open Coding tabs hear of the change on the status channel. The client
  // connects in the background and queues nothing offline, so it is faked.
  const { redis } = await import('../redis.js')
  const announced: string[] = []
  t.mock.method(redis, 'publish', (async (_channel: string, message: string) => {
    announced.push((JSON.parse(message) as { companyId: string }).companyId)
    return 1
  }) as never)
  const server = { name: `t3-${randomUUID()}`, url: 'http://t3.example.test/mcp', tokenFile: 'tok' }
  await poll(server)

  assert.deepEqual(announced, [companyId])
  const store = await getForkStore()
  assert.equal(store.codingThread(companyId, server.name, 'th-group')?.conversationId, group)
  assert.equal(store.codingThread(companyId, server.name, 'th-board')?.conversationId, null)
  const { rows } = await pool.query<{ conversation_id: string; body: string }>(
    'SELECT conversation_id, body FROM messages WHERE company_id = $1',
    [companyId],
  )
  assert.deepEqual(rows.map((r) => r.conversation_id), [group], 'one wake, in the room th-group was launched from')
  const wake = JSON.parse(rows[0].body) as { kind: string; assigneeId: string; description: string }
  assert.deepEqual([wake.kind, wake.assigneeId], ['calendar_event', agentId])
  assert.match(wake.description, /th-group/)
  assert.deepEqual(store.codingWakesDue(server.name, ['completed']), [], 'th-board is not tried again either')
})

test('T3 is read every few seconds while an agent is busy or a copied thread still moves', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  // The fork store's file is shared by the suite's files, so the server name is this run's own.
  const server = `t3-${randomUUID()}`
  await pool.query(`UPDATE participants SET status = 'avail', status_updated_at = NOW() - interval '10 minutes' WHERE kind = 'agent'`)
  assert.equal(await hot(server), false)

  await pool.query(`UPDATE participants SET status = 'working', status_updated_at = NOW() WHERE id = $1`, [agentId])
  assert.equal(await hot(server), true, 'a busy agent may launch a thread')
  await pool.query(`UPDATE participants SET status = 'avail', status_updated_at = NOW() - interval '89 seconds' WHERE id = $1`, [agentId])
  assert.equal(await hot(server), true, 'and may have launched one at the end of the turn it just left')
  await pool.query(`UPDATE participants SET status_updated_at = NOW() - interval '91 seconds' WHERE id = $1`, [agentId])
  assert.equal(await hot(server), false)

  const at = new Date().toISOString()
  ;(await getForkStore()).saveCodingThreads([{
    server, threadId: 'th-1', companyId, agentId, title: 'Fix it', status: 'running', runId: 'r-1',
    requestId: null, pullRequests: [], createdAt: at, updatedAt: at, settledAt: null, woken: null,
  }])
  assert.equal(await hot(server), true, 'a running thread will come to rest')
  assert.equal(await hot(`t3-${randomUUID()}`), false, 'only on its own server')
})

test('a list of one room answers only a member of that room, owner or not', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const owner = `u-${randomUUID().slice(0, 8)}`
  await seedUserMembership(owner, companyId)
  const room = (id: string, members: string[]) => pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id) VALUES ($1, 'group', $1, $2::jsonb, 'group', $3)`,
    [id, JSON.stringify(members), companyId],
  )
  await room('g-in', [agentId, owner])
  await room('g-out', [agentId])
  const list = async (query: Record<string, string>) => {
    const res = {
      code: 200,
      body: null as unknown,
      status(code: number) { this.code = code; return this },
      json(body: unknown) { this.body = body; return this },
    }
    await agentCoding(async () => ({ userId: owner, companyId }), { params: { agentId }, query } as never, res as never)
    return res.code
  }
  assert.equal(await list({ room: 'g-in' }), 200)
  assert.equal(await list({ room: 'g-out' }), 404, 'a room the owner is not in answers like a missing room')
  assert.equal(await list({ room: 'g-missing' }), 404)
  assert.equal(await list({}), 200, 'the list of every thread of the agent needs no room')
})
