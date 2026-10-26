/**
 * Deleting an agent for good, the parts outside Postgres: what the fork store
 * drops and queues, the Handbook recorder leaving a deleted agent's home, and
 * which files the computer removes. The last is where a mistake deletes
 * another agent's transcripts, since Claude Code's folder names map '/' and
 * '-' alike.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeAgentFiles } from '../fork/computer-purge.js'
import { createRecorder } from '../fork/recorder.js'
import { openForkStore } from '../fork/store.js'

const dir = mkdtempSync(join(tmpdir(), 'fork-purge-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const write = (path: string, text = 'x\n') => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

test('the store drops the agent, keeps its id from being given out again, and queues its files for its computer only', async () => {
  const store = await openForkStore(join(dir, 'store.sqlite'))
  store.setBloubAvatar('c1', 'atlas', { shape: 'goutte', color: 'rose' })
  store.setBloubAvatar('c1', 'nova', { shape: 'goutte', color: 'rose' })
  const own = store.createTrigger({ companyId: 'c1', createdBy: 'u1', conversationId: 'dm', assigneeId: 'atlas', title: 't', prompt: 'p', repo: 'o/r', profile: 'gh' })
  const other = store.createTrigger({ companyId: 'c1', createdBy: 'u1', conversationId: 'room', assigneeId: 'nova', title: 't', prompt: 'p', repo: 'o/r', profile: 'gh' })
  store.claimFire(own.id, 'pr:1', '2026-10-20T00:00:00.000Z', '#1')
  const work = store.createCategory('c1', 'u1', 'Work')
  store.setRoomCategory('c1', 'u1', 'dm', work.id)
  store.setRoomCategory('c1', 'u1', 'room', work.id)
  store.setPinOrder('c1', 'u1', ['dm', 'room'])
  const coding = (agentId: string) => ({
    server: 't3code', threadId: `th-${agentId}`, companyId: 'c1', agentId, conversationId: 'dm', title: 't', status: 'running',
    runId: null, requestId: null, pullRequests: [], createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', settledAt: null, woken: null,
  })
  store.saveCodingThreads([coding('atlas'), coding('nova')])

  store.purgeAgent('c1', 'atlas', ['dm'], 'computer-1')

  assert.deepEqual(Object.keys(store.bloubAvatars('c1')), ['nova'])
  assert.deepEqual(store.codingThreads('c1', 'atlas', { servers: ['t3code'], open: [], settledSince: '2026-10-20T00:00:00.000Z', settledLimit: 20 }), [])
  assert.equal(store.codingThreads('c1', 'nova', { servers: ['t3code'], open: [], settledSince: '2026-10-20T00:00:00.000Z', settledLimit: 20 }).length, 1)
  assert.equal(store.trigger('c1', own.id), null)
  assert.ok(store.trigger('c1', other.id))
  const layout = store.layout('c1', 'u1')
  assert.deepEqual(layout.rooms, { room: work.id })
  assert.deepEqual(layout.pinOrder, ['room'])
  assert.deepEqual(store.computerPurges('computer-1'), ['atlas'])
  assert.deepEqual(store.computerPurges('computer-2'), [])

  // Another computer cannot clear it; its own computer can. The id stays taken.
  store.clearComputerPurge('computer-2', 'atlas')
  assert.deepEqual(store.computerPurges('computer-1'), ['atlas'])
  store.clearComputerPurge('computer-1', 'atlas')
  assert.deepEqual(store.computerPurges('computer-1'), [])
  assert.deepEqual([...store.purgedAgents()], ['atlas'])

  // An agent without a computer to clean is still never given out again.
  store.purgeAgent('c1', 'nova', [], null)
  assert.deepEqual([...store.purgedAgents()].sort(), ['atlas', 'nova'])
})

test('the Handbook never records a deleted agent\'s home again, even when its computer removes it between two polls', async () => {
  const roots = { agents: join(dir, 'rec', 'agents'), skills: join(dir, 'rec', 'skills') }
  const home = join(roots.agents, 'atlas')
  write(join(home, 'CLAUDE.md'), '# Atlas\n')
  write(join(home, 'memory', 'MEMORY.md'), '- index\n')
  const store = await openForkStore(join(dir, 'rec.sqlite'))
  let clock = Date.parse('2026-10-20T10:00:00.000Z')
  const poll = createRecorder(store, roots, () => clock)
  assert.equal(poll(), 2)

  // Purged and cleaned by its computer before the recorder looks again: the
  // removal must not come back as deletions.
  store.purgeAgent('c1', 'atlas', [], 'computer-1')
  rmSync(home, { recursive: true })
  store.clearComputerPurge('computer-1', 'atlas')
  clock += 60_000
  assert.equal(poll(), 0)
  assert.deepEqual(store.fileVersions(['atlas'], null), [])

  // Nor does a home that reappears under the id (a computer that never got the
  // purge) count as anyone's.
  write(join(home, 'CLAUDE.md'), '# Atlas, again\n')
  clock += 60_000
  assert.equal(poll(), 0)
  assert.deepEqual(store.fileVersions(['atlas'], null), [])
})

test('the computer removes the agent\'s home, sessions and transcripts, and only transcripts that ran in its home', async () => {
  const root = join(dir, 'computer')
  const claude = join(root, '.claude')
  const agents = join(root, '.cumora', 'agents')
  const projects = join(claude, 'projects')
  const folder = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')
  // A transcript as Claude Code writes it: session-start lines first, then
  // lines that carry the working directory.
  const transcript = (cwd: string) => `{"type":"queue-operation"}\n{"type":"user","cwd":${JSON.stringify(cwd)}}\n`
  const project = (cwd: string) => write(join(projects, folder(cwd), 's.jsonl'), transcript(cwd))
  for (const agent of ['pr', 'pr-summary-bot', 'velvet']) {
    write(join(agents, agent, 'CLAUDE.md'))
    write(join(root, '.cumora', 'sessions', agent, 'claude.session'))
    project(join(agents, agent))
  }
  project(join(agents, 'pr', 'workspace'))
  write(join(root, '.cumora', 'sessions', 'pr.session'))
  // pr-summary-bot's workspace transcripts, with its home already gone: the
  // folder name alone would pass for pr's.
  project(join(agents, 'pr-summary-bot', 'workspace'))
  rmSync(join(agents, 'pr-summary-bot'), { recursive: true })
  // A folder under pr's prefix whose transcripts name no directory stays.
  write(join(projects, `${folder(join(agents, 'pr'))}-notes`, 's.jsonl'), '{"type":"summary"}\n')

  await removeAgentFiles('pr', root, claude)

  assert.deepEqual(readdirSync(agents).sort(), ['velvet'])
  assert.deepEqual(readdirSync(join(root, '.cumora', 'sessions')).sort(), ['pr-summary-bot', 'velvet'])
  assert.deepEqual(readdirSync(projects).sort(), [
    folder(join(agents, 'pr')) + '-notes',
    folder(join(agents, 'pr-summary-bot')),
    folder(join(agents, 'pr-summary-bot', 'workspace')),
    folder(join(agents, 'velvet')),
  ].sort())

  // Removing again is a no-op, and a path is never built from a non-id.
  await removeAgentFiles('pr', root, claude)
  await assert.rejects(removeAgentFiles('../velvet', root, claude))
  assert.ok(existsSync(join(agents, 'velvet')))
})
