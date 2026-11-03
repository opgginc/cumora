/**
 * The Coding tab's groups (src/next/panel/codingThreads.ts): the groups come
 * in their fixed order with settled last, newest change first in each, and a
 * group without threads is left out. A thread settled in T3 that moves or asks
 * again stands with the moving ones: filed under Settled, nobody would see it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { threadGroups, type Thread } from '../src/next/panel/codingThreads.ts'

const thread = (threadId: string, status: string, updatedAt: string, settledAt: string | null = null): Thread => ({
  server: 't3code',
  threadId,
  title: threadId,
  status,
  pullRequests: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt,
  settledAt,
})

test('groups every agent\'s threads by where they stand, settled last', () => {
  const groups = threadGroups([
    {
      agentId: 'a',
      threads: [
        thread('settled-old', 'completed', '2026-11-03T01:00:00.000Z', '2026-11-03T01:00:00.000Z'),
        thread('done', 'completed', '2026-11-03T02:00:00.000Z'),
        thread('run-old', 'running', '2026-11-03T03:00:00.000Z'),
      ],
    },
    {
      agentId: 'b',
      threads: [
        thread('settled-new', 'failed', '2026-11-03T05:00:00.000Z', '2026-11-03T05:00:00.000Z'),
        thread('moving-again', 'running', '2026-11-03T06:00:00.000Z', '2026-11-03T04:00:00.000Z'),
        thread('asks-again', 'question', '2026-11-03T00:30:00.000Z', '2026-11-02T00:00:00.000Z'),
      ],
    },
  ])
  assert.deepEqual(
    groups.map((g) => [g.standing, g.rows.map((r) => `${r.agentId}/${r.t.threadId}`)]),
    [
      ['waiting', ['b/asks-again']],
      ['running', ['b/moving-again', 'a/run-old']],
      ['completed', ['a/done']],
      ['settled', ['b/settled-new', 'a/settled-old']],
    ],
  )
})
