/**
 * The fork's SQLite store keeps each user's chat-list layout. These cover the
 * cases where a mistake would silently lose or leak layout data: unassigning,
 * cascading a category delete, user scoping, surviving a reopen from disk, a
 * failed write or open, and the per-user caps that keep the file small.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import {
  ForkLimitError, MAX_CATEGORIES, MAX_FILE_VERSIONS, MAX_PIN_ORDER, MAX_ROOM_ASSIGNMENTS, SECRET_TTL_MS, codingWakeKey, getForkStore, openForkStore,
  type NewCodingThread,
} from '../fork/store.js'

const dir = mkdtempSync(join(tmpdir(), 'fork-store-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('room layout round-trips and stays per user', async () => {
  const file = join(dir, 'nested', 'fork.sqlite')
  const store = await openForkStore(file)

  const work = store.createCategory('c1', 'u1', 'Work')
  const home = store.createCategory('c1', 'u1', 'Home')
  assert.ok(home.position > work.position, 'new categories append after the last one')

  assert.equal(store.setRoomCategory('c1', 'u1', 'room-a', work.id), true)
  assert.equal(store.setRoomCategory('c1', 'u1', 'room-b', work.id), true)
  assert.equal(store.setRoomCategory('c1', 'u1', 'room-c', home.id), true)
  assert.deepEqual(store.layout('c1', 'u1').rooms, { 'room-a': work.id, 'room-b': work.id, 'room-c': home.id })

  // Moving to null unassigns.
  assert.equal(store.setRoomCategory('c1', 'u1', 'room-b', null), true)
  assert.deepEqual(store.layout('c1', 'u1').rooms, { 'room-a': work.id, 'room-c': home.id })

  // Collapsed keys round-trip, including a category's own id.
  store.setCollapsed('c1', 'u1', 'other', true)
  store.setCollapsed('c1', 'u1', work.id, true)
  store.setCollapsed('c1', 'u1', 'other', false)
  assert.deepEqual(store.layout('c1', 'u1').collapsed, [work.id])

  // Reordering moves Home before Work.
  assert.equal(store.updateCategory('c1', 'u1', home.id, { name: 'House', position: 0.5 }), true)
  assert.deepEqual(store.layout('c1', 'u1').categories.map((c) => c.name), ['House', 'Work'])

  // Another user in the same company sees nothing and cannot use u1's category.
  assert.deepEqual(store.layout('c1', 'u2'), { categories: [], rooms: {}, collapsed: [], pinOrder: [] })
  assert.equal(store.setRoomCategory('c1', 'u2', 'room-a', work.id), false)
  assert.equal(store.updateCategory('c1', 'u2', work.id, { name: 'Stolen' }), false)
  assert.equal(store.deleteCategory('c1', 'u2', work.id), false)

  // Deleting a category unassigns its rooms and drops its collapsed key.
  assert.equal(store.deleteCategory('c1', 'u1', work.id), true)
  assert.equal(store.deleteCategory('c1', 'u1', work.id), false)
  assert.deepEqual(store.layout('c1', 'u1'), {
    categories: [{ id: home.id, name: 'House', position: 0.5, hidden: false }],
    rooms: { 'room-c': home.id },
    collapsed: [],
    pinOrder: [],
  })

  // A fresh store over the same file sees everything written so far.
  const reopened = await openForkStore(file)
  assert.deepEqual(reopened.layout('c1', 'u1'), store.layout('c1', 'u1'))
})

test('a failed write leaves memory as the file has it', async () => {
  const file = join(dir, 'failed-write', 'fork.sqlite')
  const store = await openForkStore(file)
  const keep = store.createCategory('c1', 'u1', 'Keep')
  const before = store.layout('c1', 'u1')

  // A directory where save() writes its temp file makes the write throw.
  mkdirSync(`${file}.tmp`)
  assert.throws(() => store.createCategory('c1', 'u1', 'Lost'))
  assert.throws(() => store.deleteCategory('c1', 'u1', keep.id))
  assert.deepEqual(store.layout('c1', 'u1'), before)

  // Once writes work again, the rolled-back changes do not reach disk either.
  rmSync(`${file}.tmp`, { recursive: true })
  store.setCollapsed('c1', 'u1', 'other', true)
  const reopened = await openForkStore(file)
  assert.deepEqual(reopened.layout('c1', 'u1'), { ...before, collapsed: ['other'] })
})

test('a failed open is retried on the next call', async (t) => {
  const file = join(dir, 'failed-open', 'fork.sqlite')
  mkdirSync(join(dir, 'failed-open'))
  writeFileSync(file, 'not a database, not a database, not a database, not a database')
  const logged = t.mock.method(console, 'error', () => {})

  await assert.rejects(getForkStore(file))
  assert.equal(logged.mock.callCount(), 1)

  rmSync(file)
  const store = await getForkStore(file)
  assert.deepEqual(store.layout('c1', 'u1'), { categories: [], rooms: {}, collapsed: [], pinOrder: [] })
  assert.equal(await getForkStore(file), store, 'a successful open is cached')
})

test('one user cannot grow the file without bound', async () => {
  const file = join(dir, 'limits', 'fork.sqlite')
  const store = await openForkStore(file)

  for (let i = 0; i < MAX_CATEGORIES; i++) store.createCategory('c1', 'u1', `Cat ${i}`)
  assert.throws(() => store.createCategory('c1', 'u1', 'One too many'), ForkLimitError)
  const cat = store.createCategory('c1', 'u2', 'Other user')

  // Collapsed keys are the built-in section or the caller's own categories.
  assert.equal(store.setCollapsed('c1', 'u2', 'other', true), true)
  assert.equal(store.setCollapsed('c1', 'u2', cat.id, true), true)
  assert.equal(store.setCollapsed('c1', 'u2', 'anything', true), false)
  assert.equal(store.setCollapsed('c1', 'u1', cat.id, true), false)
  assert.deepEqual(store.layout('c1', 'u1').collapsed, [])

  // Seeding MAX_ROOM_ASSIGNMENTS rows through the store would rewrite the file
  // that many times, so they go in with one statement.
  const SQL = await initSqlJs()
  const raw = new SQL.Database(readFileSync(file))
  raw.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO room_assignments SELECT 'c1', 'u2', 'room-' || i, ? FROM n`,
    [MAX_ROOM_ASSIGNMENTS, cat.id],
  )
  writeFileSync(file, raw.export())
  const full = await openForkStore(file)

  assert.throws(() => full.setRoomCategory('c1', 'u2', 'room-new', cat.id), ForkLimitError)
  // Moving a room that is already counted, or unassigning one, still works.
  assert.equal(full.setRoomCategory('c1', 'u2', 'room-1', cat.id), true)
  assert.equal(full.setRoomCategory('c1', 'u2', 'room-2', null), true)
  assert.equal(full.setRoomCategory('c1', 'u2', 'room-new', cat.id), true)
})

test('opening an older file runs the steps it has not had', async () => {
  const file = join(dir, 'migrate', 'fork.sqlite')
  const store = await openForkStore(file)
  const work = store.createCategory('c1', 'u1', 'Work')
  store.setCollapsed('c1', 'u1', work.id, true)

  // Wind the file back to schema version 1: undo the later steps, and add the
  // rows a version-1 client could write, when 'former' was a group key.
  const SQL = await initSqlJs()
  const raw = new SQL.Database(readFileSync(file))
  raw.run('ALTER TABLE room_categories DROP COLUMN hidden; DROP TABLE pin_order; DROP TABLE computer_file_versions; DROP TABLE bloub_avatars; DROP TABLE triggers; DROP TABLE trigger_fires; DROP TABLE computer_purges; DROP TABLE purged_agents; DROP TABLE coding_threads; DROP TABLE cards;')
  raw.run("INSERT INTO collapsed_groups VALUES ('c1', 'u1', 'former'), ('c1', 'u1', 'other')")
  raw.run('PRAGMA user_version = 1')
  writeFileSync(file, raw.export())

  const upgraded = await openForkStore(file)
  const layout = upgraded.layout('c1', 'u1')
  assert.deepEqual(layout.collapsed.sort(), [work.id, 'other'].sort())
  assert.deepEqual(layout.categories.map((c) => c.hidden), [false], 'existing categories start visible')
  upgraded.setPinOrder('c1', 'u1', ['room-a'])
  assert.deepEqual(upgraded.layout('c1', 'u1').pinOrder, ['room-a'])
  upgraded.recordFileVersions([{ scope: 'atlas', path: 'CLAUDE.md', at: '2026-10-18T00:00:00.000Z', content: 'x', baseline: true }])
  assert.equal(upgraded.latestFileVersions().length, 1)
  upgraded.setBloubAvatar('c1', 'agent-a', { shape: 'cercle', color: 'encre' })
  assert.deepEqual(Object.keys(upgraded.bloubAvatars('c1')), ['agent-a'])
})

test('file versions keep each file’s history, and `since` picks the base', async () => {
  const file = join(dir, 'versions', 'fork.sqlite')
  const store = await openForkStore(file)
  const v = (scope: string, path: string, at: string, content: string | null, baseline = false) =>
    ({ scope, path, at: `2026-10-18T${at}:00.000Z`, content, baseline })
  store.recordFileVersions([
    v('atlas', 'CLAUDE.md', '01:00', 'one', true),
    v('atlas', 'memory/MEMORY.md', '01:00', 'index', true),
    v('', 'git-lore/SKILL.md', '01:00', 'shared', true),
    v('nova', 'CLAUDE.md', '01:00', 'other agent', true),
  ])
  store.recordFileVersions([
    v('atlas', 'CLAUDE.md', '03:00', 'two'),
    v('atlas', 'CLAUDE.md', '05:00', 'three'),
    v('atlas', 'memory/MEMORY.md', '04:00', null),
  ])

  const at = (rows: Array<{ path: string; at: string; content: string | null }>) =>
    rows.map((r) => `${r.path}@${r.at.slice(11, 16)}=${r.content}`)
  // At 04:30 CLAUDE.md held "two" (its base), and only later versions follow.
  assert.deepEqual(at(store.fileVersions(['atlas', ''], '2026-10-18T04:30:00.000Z')), [
    'git-lore/SKILL.md@01:00=shared',
    'CLAUDE.md@03:00=two',
    'CLAUDE.md@05:00=three',
    'memory/MEMORY.md@04:00=null',
  ])
  assert.equal(store.fileVersions(['atlas', ''], null).length, 6, 'no since: the whole history')
  assert.deepEqual(store.fileVersions([], null), [])
  assert.deepEqual(at(store.latestFileVersions().filter((r) => r.path !== 'git-lore/SKILL.md')).sort(), [
    'CLAUDE.md@01:00=other agent',
    'CLAUDE.md@05:00=three',
    'memory/MEMORY.md@04:00=null',
  ], 'the newest version of each file, a deletion included')
  assert.deepEqual(store.fileScopes(), ['atlas', 'nova'], 'the shared folder is not an agent')

  // A failed write records nothing, so the recorder can send it again.
  mkdirSync(`${file}.tmp`)
  assert.throws(() => store.recordFileVersions([v('atlas', 'CLAUDE.md', '06:00', 'four')]))
  rmSync(`${file}.tmp`, { recursive: true })
  const reopened = await openForkStore(file)
  assert.deepEqual(at(reopened.fileVersions(['atlas'], '2026-10-18T05:30:00.000Z')), ['CLAUDE.md@05:00=three', 'memory/MEMORY.md@04:00=null'])
})

test('a bloub avatar is the agent look for the whole company, with the face of its latest message', async () => {
  const file = join(dir, 'bloub', 'fork.sqlite')
  const store = await openForkStore(file)
  store.setBloubAvatar('c1', 'agent-a', { shape: 'galet', color: 'violet' })
  store.setBloubAvatar('c2', 'agent-a', { shape: 'cercle', color: 'encre' })
  assert.equal(store.bloubAvatars('c1')['agent-a']?.expression, 'neutre', 'a new look starts at rest')

  // A message's face sticks through a new pick, and a new pick replaces the row.
  assert.equal(store.setBloubExpression('c1', 'agent-a', 'heureux'), true)
  store.setBloubAvatar('c1', 'agent-a', { shape: 'nuage', color: 'rose', accessories: ['ears', 'whiskers'] })
  assert.deepEqual(store.bloubAvatars('c1'), { 'agent-a': { shape: 'nuage', color: 'rose', expression: 'heureux', accessories: ['ears', 'whiskers'] } })
  assert.deepEqual(store.bloubAvatars('c2'), { 'agent-a': { shape: 'cercle', color: 'encre', expression: 'neutre', accessories: [] } })

  // An app built before accessories sends no list, and must not take them off.
  store.setBloubAvatar('c1', 'agent-a', { shape: 'galet', color: 'rose' })
  assert.deepEqual(store.bloubAvatars('c1')['agent-a']?.accessories, ['ears', 'whiskers'])
  store.setBloubAvatar('c1', 'agent-a', { shape: 'galet', color: 'rose', accessories: [] })
  assert.deepEqual(store.bloubAvatars('c1')['agent-a']?.accessories, [])
  assert.equal(store.setBloubExpression('c1', 'agent-b', 'triste'), false, 'an agent without a bloub gets no face')

  // Clearing one company's look leaves the other's, survives a reopen, and clearing twice is harmless.
  store.clearBloubAvatar('c1', 'agent-a')
  store.clearBloubAvatar('c1', 'agent-a')
  const reopened = await openForkStore(file)
  assert.deepEqual(reopened.bloubAvatars('c1'), {})
  assert.deepEqual(Object.keys(reopened.bloubAvatars('c2')), ['agent-a'])
})

test('faces picked before moods existed go back to rest', async () => {
  const file = join(dir, 'bloub-v5', 'fork.sqlite')
  ;(await openForkStore(file)).setBloubAvatar('c1', 'agent-a', { shape: 'galet', color: 'violet' })
  const SQL = await initSqlJs()
  const raw = new SQL.Database(readFileSync(file))
  raw.run("UPDATE bloub_avatars SET expression = 'timide'; ALTER TABLE bloub_avatars DROP COLUMN accessories; DROP TABLE triggers; DROP TABLE trigger_fires; DROP TABLE computer_purges; DROP TABLE purged_agents; DROP TABLE coding_threads; DROP TABLE cards; PRAGMA user_version = 5")
  writeFileSync(file, raw.export())
  const upgraded = (await openForkStore(file)).bloubAvatars('c1')['agent-a']
  assert.equal(upgraded?.expression, 'neutre')
  assert.deepEqual(upgraded?.accessories, [], 'a look from before accessories wears none')
})

test('a file keeps its newest versions, and the oldest one left is its baseline', async () => {
  const store = await openForkStore(join(dir, 'prune', 'fork.sqlite'))
  const v = (path: string, i: number, baseline = false) =>
    ({ scope: 'atlas', path, at: new Date(Date.UTC(2026, 9, 18) + i * 60_000).toISOString(), content: `${path} ${i}`, baseline })
  const versionsOf = (path: string) => store.fileVersions(['atlas'], null).filter((r) => r.path === path)
  // CLAUDE.md appeared in a home already watched: a change, not a baseline.
  store.recordFileVersions([v('CLAUDE.md', 0), v('memory/MEMORY.md', 0, true)])
  store.recordFileVersions(Array.from({ length: MAX_FILE_VERSIONS - 1 }, (_, i) => v('memory/MEMORY.md', i + 1)))
  assert.equal(versionsOf('memory/MEMORY.md').length, MAX_FILE_VERSIONS, 'a file at the cap loses nothing')

  // Each version past the cap pushes the oldest out, and the oldest left
  // reads as the text first known, not as the file's creation.
  store.recordFileVersions([v('memory/MEMORY.md', MAX_FILE_VERSIONS)])
  store.recordFileVersions([v('memory/MEMORY.md', MAX_FILE_VERSIONS + 1)])
  const kept = versionsOf('memory/MEMORY.md')
  assert.equal(kept.length, MAX_FILE_VERSIONS)
  assert.deepEqual(kept.filter((r) => r.baseline).map((r) => r.content), ['memory/MEMORY.md 2'])
  assert.equal(kept.at(-1)?.content, `memory/MEMORY.md ${MAX_FILE_VERSIONS + 1}`)
  assert.deepEqual(versionsOf('CLAUDE.md').map((r) => [r.content, r.baseline]), [['CLAUDE.md 0', false]], 'a file under the cap stays as it was')

  // The pruning is on disk, not only in memory.
  const reopened = await openForkStore(join(dir, 'prune', 'fork.sqlite'))
  assert.equal(reopened.fileVersions(['atlas'], null).length, MAX_FILE_VERSIONS + 1)
})

test('hidden categories and the tile order stay per user', async () => {
  const store = await openForkStore(join(dir, 'hidden-pins', 'fork.sqlite'))
  const work = store.createCategory('c1', 'u1', 'Work')
  assert.equal(store.updateCategory('c1', 'u1', work.id, { hidden: true }), true)
  assert.deepEqual(store.layout('c1', 'u1').categories.map((c) => [c.name, c.hidden]), [['Work', true]])
  // A rename leaves the flag alone; another user cannot flip it.
  store.updateCategory('c1', 'u1', work.id, { name: 'Office' })
  assert.equal(store.layout('c1', 'u1').categories[0].hidden, true)
  assert.equal(store.updateCategory('c1', 'u2', work.id, { hidden: false }), false)

  // Setting the order replaces it, including dropping rooms left out.
  store.setPinOrder('c1', 'u1', ['room-b', 'room-a', 'room-c'])
  store.setPinOrder('c1', 'u1', ['room-c', 'room-b'])
  assert.deepEqual(store.layout('c1', 'u1').pinOrder, ['room-c', 'room-b'])
  assert.deepEqual(store.layout('c1', 'u2').pinOrder, [])
  assert.throws(() => store.setPinOrder('c1', 'u1', Array.from({ length: MAX_PIN_ORDER + 1 }, (_, i) => `room-${i}`)), ForkLimitError)
  assert.deepEqual(store.layout('c1', 'u1').pinOrder, ['room-c', 'room-b'], 'a refused order changes nothing')
})

test('a trigger fires an event once, keeps its latest fire, and goes with its fires', async () => {
  const store = await openForkStore(join(dir, 'triggers.sqlite'))
  const input = { companyId: 'c1', createdBy: 'u1', conversationId: 'room', assigneeId: 'bot', title: 'Deploy', prompt: 'ship it', repo: 'o/r', profile: 'p' }
  const t = store.createTrigger(input)
  assert.deepEqual(store.triggers('c1', 'room'), [t])
  assert.equal(store.trigger('c2', t.id), null, 'scoped by company')

  assert.equal(store.claimFire(t.id, 'pr:1', '2026-10-19T01:00:00Z', '#1 one'), true)
  assert.equal(store.claimFire(t.id, 'pr:1', '2026-10-19T01:00:01Z', '#1 again'), false)
  store.settleFire(t.id, 'pr:1', { error: 'room gone' })
  assert.equal(store.claimFire(t.id, 'pr:2', '2026-10-19T02:00:00Z', '#2 two'), true)
  store.settleFire(t.id, 'pr:2', { messageId: 'm-2' })
  assert.deepEqual(store.trigger('c1', t.id)?.lastFire, { at: '2026-10-19T02:00:00Z', label: '#2 two', error: null })
  assert.equal(store.trigger('c1', t.id)?.fires, 2)

  assert.equal(store.updateTrigger('c1', t.id, { status: 'paused' }), true)
  assert.deepEqual(store.activeTriggers(), [])
  assert.equal(store.deleteTrigger('c1', t.id), true)
  assert.equal(store.claimFire(t.id, 'pr:1', '2026-10-19T03:00:00Z', '#1'), true, 'its fires went with it')
})

test('a coding thread keeps its first agent and room, and wakes its agent once per run and rest, and per question', async () => {
  const file = join(dir, 'coding.sqlite')
  const store = await openForkStore(file)
  const REST = ['completed', 'failed', 'question']
  // None of these threads is settled, so the list's cutoff for settled ones does not matter here.
  const LIST = { servers: ['t3code'], open: ['running', 'question'], settledSince: '2026-10-01T00:00:00.000Z', settledLimit: 20 }
  const thread = (status: string, more: Partial<NewCodingThread> = {}): NewCodingThread => ({
    server: 't3code', threadId: 'th-1', companyId: 'c1', agentId: 'bot', conversationId: 'room', title: 'Fix the header',
    status, runId: 'run-1', requestId: null, pullRequests: [], createdAt: '2026-10-20T01:00:00Z', updatedAt: '2026-10-20T01:05:00Z',
    settledAt: null, woken: null, ...more,
  })
  const due = () => store.codingWakesDue('t3code', REST).map((t) => `${t.threadId}:${t.runId}:${t.status}:${t.requestId ?? ''}`)
  const wakeAll = () => { for (const t of store.codingWakesDue('t3code', REST)) store.markCodingWoken(t.server, t.threadId, codingWakeKey(t), null) }

  // The poller announces a change to the workspaces it returns, and reads a moving thread's server again soon.
  assert.deepEqual([...store.saveCodingThreads([thread('running')])], ['c1'])
  assert.deepEqual([...store.saveCodingThreads([thread('running')])], [], 'an unchanged thread is no change')
  assert.equal(store.codingThreadIn('t3code', ['running']), true)
  assert.equal(store.codingThreadIn('t3code-m4', ['running']), false, 'per server')
  assert.deepEqual(store.codingWakesDue('t3code-m4', ['running']), [], 'per server')
  assert.deepEqual(store.codingThreads('c2', 'bot', LIST), [], 'scoped by company')
  assert.equal(store.codingThread('c1', 't3code', 'th-1')?.status, 'running')
  assert.equal(store.codingThread('c2', 't3code', 'th-1'), null, 'a detail is scoped by company too')
  assert.deepEqual(due(), [], 'a running thread wakes nobody')

  // Two questions in one run wake the agent twice; the answer in between wakes nobody.
  store.saveCodingThreads([thread('question', { requestId: 'q-1' })])
  assert.deepEqual(due(), ['th-1:run-1:question:q-1'])
  wakeAll()
  store.saveCodingThreads([thread('running')])
  assert.deepEqual(due(), [])
  store.saveCodingThreads([thread('question', { requestId: 'q-2' })])
  assert.deepEqual(due(), ['th-1:run-1:question:q-2'])
  wakeAll()

  // Later polls pass no room and may carry another mark; the first copy's stay.
  store.saveCodingThreads([thread('completed', { conversationId: null, agentId: 'other', pullRequests: [{ number: 7, url: 'https://x/7', state: null }] })])
  const [done] = store.codingThreads('c1', 'bot', LIST)
  assert.equal(done.conversationId, 'room')
  assert.deepEqual(done.pullRequests, [{ number: 7, url: 'https://x/7', state: null }])
  assert.deepEqual(due(), ['th-1:run-1:completed:'])

  store.markCodingWoken('t3code', 'th-1', codingWakeKey(done), null, 'another room')
  assert.equal(store.codingThreads('c1', 'bot', LIST)[0].conversationId, 'room', 'a wake keeps the room the thread has')
  const reopened = await openForkStore(file)
  assert.deepEqual(reopened.codingWakesDue('t3code', REST), [], 'woken once, across a restart')
  reopened.saveCodingThreads([thread('completed', { runId: 'run-2' })])
  assert.deepEqual(reopened.codingWakesDue('t3code', REST).map((t) => t.runId), ['run-2'], 'a new run wakes again')

  // A thread first copied long after it came to rest arrives woken.
  reopened.saveCodingThreads([thread('failed', { threadId: 'th-old', runId: 'r', woken: codingWakeKey({ runId: 'r', status: 'failed', requestId: null }) })])
  assert.ok(!reopened.codingWakesDue('t3code', REST).some((t) => t.threadId === 'th-old'))
  assert.deepEqual([...reopened.codingThreadKeys()].sort(), ['t3code th-1', 't3code th-old'])

  // The poller copies a thread without a room; its first wake keeps the room it found.
  reopened.saveCodingThreads([thread('completed', { threadId: 'th-new', conversationId: null })])
  const [fresh] = reopened.codingWakesDue('t3code', REST).filter((t) => t.threadId === 'th-new')
  assert.equal(fresh.conversationId, null)
  reopened.markCodingWoken('t3code', 'th-new', codingWakeKey(fresh), null, 'the room')
  assert.equal(reopened.codingThreads('c1', 'bot', LIST).find((t) => t.threadId === 'th-new')?.conversationId, 'the room')
})

test('the coding list holds every unsettled or moving thread and the newest settled ones, and a whole read unlists what T3 no longer lists', async () => {
  const store = await openForkStore(join(dir, 'coding-list', 'fork.sqlite'))
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 26) + minutes * 60_000).toISOString()
  const thread = (threadId: string, settledAt: string | null, minutes: number, more: Partial<NewCodingThread> = {}): NewCodingThread => ({
    server: 't3code', threadId, companyId: 'c1', agentId: 'bot', conversationId: null, title: threadId, status: 'completed',
    runId: `run-${threadId}`, requestId: null, pullRequests: [], createdAt: at(0), updatedAt: at(minutes), settledAt, woken: null, ...more,
  })
  const list = (servers = ['t3code', 't3code-m4']) =>
    store.codingThreads('c1', 'bot', { servers, open: ['running', 'question'], settledSince: at(0), settledLimit: 20 })
  // More of each than the 20 settled ones the list keeps, one settled before
  // the cutoff that changed after it (its pull request merged), and one
  // settled before the cutoff that runs again.
  store.saveCodingThreads([
    ...Array.from({ length: 25 }, (_, i) => thread(`open-${i}`, null, i)),
    ...Array.from({ length: 25 }, (_, i) => thread(`done-${i}`, at(100 + i), 100 + i)),
    thread('done-old', at(-1), 200),
    thread('done-old-running', at(-1), 50, { status: 'running' }),
  ])
  const listed = list()
  const resting = (t: { settledAt: string | null; status: string }) => t.settledAt !== null && t.status !== 'running'
  assert.deepEqual(
    listed.filter((t) => !resting(t)).map((t) => t.threadId).sort(),
    [...Array.from({ length: 25 }, (_, i) => `open-${i}`), 'done-old-running'].sort(),
    'every unsettled thread, and a settled one that moves again however long ago it was settled',
  )
  assert.deepEqual(
    listed.filter(resting).map((t) => t.threadId),
    Array.from({ length: 20 }, (_, i) => `done-${24 - i}`),
    'the 20 settled last, none settled before the cutoff',
  )
  assert.deepEqual(listed.map((t) => t.updatedAt), listed.map((t) => t.updatedAt).sort().reverse(), 'the most recently changed first')

  // Settling and moving again are changes the open tabs hear about.
  assert.deepEqual([...store.saveCodingThreads([thread('open-0', at(300), 300)])], ['c1'])
  assert.equal(store.codingThread('c1', 't3code', 'open-0')?.settledAt, at(300))
  assert.deepEqual([...store.saveCodingThreads([thread('open-0', null, 301)])], ['c1'])

  // A server taken off the instance's list lists nothing, and a whole read of
  // a server unlists what it did not find there and nothing of another server.
  store.saveCodingThreads([thread('m4-1', null, 0, { server: 't3code-m4' })])
  assert.ok(list().some((t) => t.threadId === 'm4-1'))
  assert.ok(!list(['t3code']).some((t) => t.threadId === 'm4-1'))
  assert.deepEqual([...store.unlistCodingThreads('t3code', ['open-0', 'not-copied'])], ['c1'])
  assert.deepEqual(list().map((t) => t.threadId).sort(), ['m4-1', 'open-0'])
  assert.deepEqual([...store.unlistCodingThreads('t3code', ['open-0'])], [], 'nothing left to unlist is no change')
  assert.equal(store.codingThreadIn('t3code', ['running']), false, 'a running thread T3 stopped listing keeps no server hot')

  // Listed again, a thread comes back without waking its agent again for the rest it was woken for.
  const back = thread('open-5', null, 5)
  store.markCodingWoken('t3code', 'open-5', codingWakeKey(back), null, 'room')
  assert.deepEqual([...store.saveCodingThreads([back])], ['c1'], 'coming back is a change')
  assert.ok(list().some((t) => t.threadId === 'open-5'))
  assert.deepEqual(store.codingWakesDue('t3code', ['completed']).filter((t) => t.threadId === 'open-5'), [])
  assert.deepEqual([...store.unlistCodingThreads('t3code-m4', [])], ['c1'], 'a read that found nothing unlists every thread')
})

test('a card takes one answer, opens again when its reply was not posted, and goes with its agent', async () => {
  const store = await openForkStore(join(dir, 'cards', 'fork.sqlite'))
  const ask = { companyId: 'c1', conversationId: 'room', agentId: 'bot', question: 'Deploy main?' }
  const card = store.createCard({ ...ask, messageId: 'm-q', kind: 'choice', options: ['Deploy', 'Wait'] })
  assert.deepEqual([card.options, card.answer, card.expiresAt], [['Deploy', 'Wait'], null, null])
  assert.equal(store.card('c2', 'm-q'), null, 'scoped by company')

  const at = '2026-10-20T01:00:00.000Z'
  assert.equal(store.claimAnswer('c1', 'm-q', { by: 'u1', at, option: 1, text: null, clientId: 'card-1' }), true)
  assert.equal(store.claimAnswer('c1', 'm-q', { by: 'u2', at, option: 0, text: null, clientId: 'card-2' }), false, 'the first answer closes it')
  store.releaseAnswer('c1', 'm-q', 'card-1')
  assert.equal(store.card('c1', 'm-q')?.answer, null, 'an answer whose reply was not posted opens it again')
  assert.equal(store.claimAnswer('c1', 'm-q', { by: 'u2', at, option: 0, text: null, clientId: 'card-2' }), true)
  assert.deepEqual(store.pendingAnswers().map((p) => [p.companyId, p.card.messageId]), [['c1', 'm-q']])
  store.settleAnswer('c1', 'm-q', 'card-2', 'm-a')
  const rev = store.card('c1', 'm-q')?.rev ?? 0
  store.settleAnswer('c1', 'm-q', 'card-2', 'm-a')
  store.releaseAnswer('c1', 'm-q', 'card-2')
  assert.deepEqual(store.card('c1', 'm-q')?.answer, { by: 'u2', at, option: 0, text: null, clientId: 'card-2', messageId: 'm-a' }, 'a posted answer stays')
  assert.equal(store.card('c1', 'm-q')?.rev, rev, 'settling again and a late release change nothing')
  assert.ok(rev >= 4, 'every change bumped it: claim, release, claim, settle')
  assert.deepEqual(store.pendingAnswers(), [])

  const reopened = await openForkStore(join(dir, 'cards', 'fork.sqlite'))
  assert.deepEqual(reopened.cards('c1', 'room').map((c) => c.messageId), ['m-q'])
  reopened.purgeAgent('c1', 'bot', [], null)
  assert.deepEqual(reopened.cards('c1', 'room'), [])
})

test('an answer in the person\'s own words keeps its text, also in a file from before it could', async () => {
  const file = join(dir, 'cards-v11', 'fork.sqlite')
  const ask = { companyId: 'c1', conversationId: 'room', agentId: 'bot', kind: 'choice' as const, question: 'Deploy main?', options: ['Deploy', 'Wait'] }
  ;(await openForkStore(file)).createCard({ ...ask, messageId: 'm-q' })
  const SQL = await initSqlJs()
  const raw = new SQL.Database(readFileSync(file))
  raw.run('ALTER TABLE cards DROP COLUMN answer_text; ALTER TABLE coding_threads DROP COLUMN settled_at; ALTER TABLE coding_threads DROP COLUMN unlisted; PRAGMA user_version = 11')
  writeFileSync(file, raw.export())

  const store = await openForkStore(file)
  const at = '2026-10-23T13:00:00.000Z'
  assert.equal(store.claimAnswer('c1', 'm-q', { by: 'u1', at, option: null, text: 'After the release notes', clientId: 'card-1' }), true)
  assert.deepEqual((await openForkStore(file)).card('c1', 'm-q')?.answer,
    { by: 'u1', at, option: null, text: 'After the release notes', clientId: 'card-1', messageId: null })
})

test('a sent secret goes once to the agent that asked, and the file keeps no trace of it', async () => {
  const file = join(dir, 'secrets', 'fork.sqlite')
  const store = await openForkStore(file)
  const ask = { companyId: 'c1', conversationId: 'room', agentId: 'bot', kind: 'secret' as const, question: 'OpenAI key', options: [] }
  store.createCard({ ...ask, messageId: 'm-s' })
  assert.equal(store.takeSecret('c1', 'm-s', 'bot'), 'waiting')
  const sent = new Date()
  store.claimAnswer('c1', 'm-s', { by: 'u1', at: sent.toISOString(), option: null, text: null, clientId: 'card-1' }, 'SEALED-ONE')
  assert.equal(store.card('c1', 'm-s')?.expiresAt, new Date(sent.getTime() + SECRET_TTL_MS).toISOString())
  assert.equal(store.takeSecret('c1', 'm-s', 'bot'), 'waiting', 'not before its reply is posted: the card may still open again')
  store.settleAnswer('c1', 'm-s', 'card-1', 'm-a1')
  assert.equal(store.takeSecret('c1', 'm-s', 'other-bot'), 'missing', 'only the agent that asked')
  assert.equal(store.takeSecret('c2', 'm-s', 'bot'), 'missing', 'scoped by company')
  assert.deepEqual(store.takeSecret('c1', 'm-s', 'bot'), { sealed: 'SEALED-ONE' })
  assert.equal(store.takeSecret('c1', 'm-s', 'bot'), 'taken')
  assert.deepEqual([Boolean(store.card('c1', 'm-s')?.takenAt), store.card('c1', 'm-s')?.expiresAt], [true, null])

  // Nobody takes this one within a day: a room load past that drops it.
  store.createCard({ ...ask, messageId: 'm-late' })
  store.claimAnswer('c1', 'm-late', { by: 'u1', at: sent.toISOString(), option: null, text: null, clientId: 'card-2' }, 'SEALED-TWO')
  store.settleAnswer('c1', 'm-late', 'card-2', 'm-a2')
  store.dropExpiredSecrets(new Date(sent.getTime() + SECRET_TTL_MS - 1000))
  assert.ok(readFileSync(file).includes('SEALED-TWO'), 'kept until its day is over')
  store.dropExpiredSecrets(new Date(sent.getTime() + SECRET_TTL_MS + 1000))
  assert.equal(store.takeSecret('c1', 'm-late', 'bot'), 'expired')

  const bytes = readFileSync(file)
  assert.ok(!bytes.includes('SEALED-ONE') && !bytes.includes('SEALED-TWO'), 'secure_delete zeroed both')
})
