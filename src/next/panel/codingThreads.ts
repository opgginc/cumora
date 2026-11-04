/**
 * How the Coding tab (CodingTab.tsx) reads a thread, kept apart from the
 * components so tests reach it without a DOM (tests/coding-threads.test.ts):
 * a thread as the server copies it from T3, where it stands, the groups the
 * list shows it in, and which room's list it is in.
 */

export interface Thread {
  server: string
  threadId: string
  title: string
  status: string
  pullRequests: Array<{ number: number; url: string; state: string | null }>
  createdAt: string
  updatedAt: string
  /** When someone settled it in T3, marking it dealt with; null while it is not. */
  settledAt: string | null
}

// T3's thread statuses. T3 shows a run that just finished as `waiting` while
// it saves the checkpoint, and counts it as running; 'question' is the
// server's, for a thread that waits for an answer.
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])
const STOPPED = new Set(['interrupted', 'cancelled', 'rolled_back'])

/** Still going: running, or stopped on a question for someone. */
export const isOpenThread = (t: Thread): boolean => ACTIVE.has(t.status) || t.status === 'question'

// Where a thread can stand, in the order the list groups threads: what waits
// on someone first, then what runs, then how the rest ended, and settled last,
// since nothing is left to do on it.
const STANDINGS = ['waiting', 'running', 'completed', 'failed', 'stopped', 'idle', 'settled'] as const
export type Standing = (typeof STANDINGS)[number]

/** Where a thread stands. Settled in T3 counts only at rest: a settled thread
 *  that moves again stands with the moving ones. */
export function standing(t: Thread): Standing {
  const { status } = t
  if (status === 'question') return 'waiting'
  if (ACTIVE.has(status)) return 'running'
  // How it ended matters less once someone has dealt with it.
  if (t.settledAt !== null) return 'settled'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (STOPPED.has(status)) return 'stopped'
  return 'idle'
}

export interface ThreadGroup {
  standing: Standing
  rows: Array<{ t: Thread; agentId: string }>
}

/** Every agent's threads in their groups, in STANDINGS' order and newest
 *  change first in each; a group without threads is left out. */
export function threadGroups(coding: Array<{ agentId: string; threads: Thread[] }>): ThreadGroup[] {
  const rows = coding
    .flatMap((c) => c.threads.map((t) => ({ t, agentId: c.agentId })))
    .sort((a, b) => b.t.updatedAt.localeCompare(a.t.updatedAt))
  return STANDINGS
    .map((s) => ({ standing: s, rows: rows.filter(({ t }) => standing(t) === s) }))
    .filter((g) => g.rows.length > 0)
}

/** The room whose threads a room panel's Coding tab lists: none in a 1:1
 *  room, which lists every thread of its agent, launched there, elsewhere or
 *  from a turn without one room; the room itself in any other. */
export const codingRoom = (c: { id: string; kind: string }): string | undefined => (c.kind === 'direct' ? undefined : c.id)

/** Where the tab keeps an agent's last list: under the agent, and under the
 *  agent and the room for a list of one room. Agent ids hold no space. */
export const cacheKey = (agentId: string, room: string | undefined): string => (room ? `${agentId} ${room}` : agentId)

/** Whether the lists the tab holds are those of `ids` (space-joined) in
 *  `room`: lists of other agents or of another room never show. */
export const listsOf = (lists: Array<{ agentId: string; room?: string }>, ids: string, room: string | undefined): boolean =>
  lists.map((l) => l.agentId).join(' ') === ids && lists.every((l) => l.room === room)
