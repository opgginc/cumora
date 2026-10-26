/**
 * The Postgres side of the coding poller (server/src/fork/coding.ts) against a
 * real Postgres: which room a T3 thread's wake goes to, and when T3 is read
 * every few seconds. The poller copies a thread seconds after its launch,
 * before a Codex turn has recorded anything, so the room must come from the
 * launching turn's own call and never from the turn before it, or the wake
 * lands in the wrong room.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { hot, launchRoom } from '../fork/coding.js'
import { getForkStore } from '../fork/store.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

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
    server, threadId: 'th-1', companyId, agentId, conversationId: null, title: 'Fix it', status: 'running', runId: 'r-1',
    requestId: null, pullRequests: [], createdAt: at, updatedAt: at, settledAt: null, woken: null,
  }])
  assert.equal(await hot(server), true, 'a running thread will come to rest')
  assert.equal(await hot(`t3-${randomUUID()}`), false, 'only on its own server')
})
