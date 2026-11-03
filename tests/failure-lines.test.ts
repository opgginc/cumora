/**
 * Engine-failure lines (src/next/chat/failures.ts, buildItems). The mistakes
 * worth catching: an outage's notices, half an hour apart with Calendar
 * firings between them, not joining into one line; a line taking in another
 * agent's failure, the next day's, or a notice that is not a failed run;
 * losing a line (the list's scroll anchor, an opened line) when a failure
 * joins it at either end; and the line's reason showing a retry category,
 * the agent prefix or the hint instead of the error. How an opened failure
 * reads is pinned against the daemon in server/src/__tests__/fork-engine-notice.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/types.ts'
import { buildItems, keyOf, rowIndexOf } from '../src/next/chat/model.ts'
import { failureReason } from '../src/next/chat/failures.ts'

let n = 0
/** `t` is a local time on 2026-11-01, or a full local ISO date-time. */
const row = (authorId: string, t: string, kind: Message['kind'], body: string): Message => ({
  id: `m${++n}`, conversationId: 'c', authorId, kind, body, at: '',
  createdAt: t.includes('T') ? t : `2026-11-01T${t}`,
}) as Message
const notice = (authorId: string, t: string, text: string) => row(authorId, t, 'system', JSON.stringify({ kind: 'notice', noticeKind: 'byoa_engine_failed', text }))
const firing = (t: string) => row('calendar', t, 'system', JSON.stringify({ kind: 'calendar_event', title: 'Merge digest' }))
const say = (authorId: string, t: string) => row(authorId, t, 'text', 'hi')
const items = (rows: Message[], opened: ReadonlySet<string> = new Set()) => buildItems(rows, 'me', () => false, opened)

const HINT = 'Check the daemon terminal for details, then wake the agent again.'
/** What PR Summary Bot's DM held after the 2026-11-01 outage, three times over. */
const REFUSED = [
  'PR Summary Bot could not run on local claude: local claude failed (exit 1): unknown',
  ...Array(9).fill('unknown'),
  'server_error',
  'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
  HINT,
].join('\n')
const failure = (authorId: string, t: string) => notice(authorId, t, REFUSED)

test("one agent's failures join across pauses and firings, but not across agents or days", () => {
  const list = items([
    failure('bot', '04:51:39'), firing('05:00:00'), failure('bot', '05:16:53'), failure('bot', '05:40:18'),
    failure('other', '05:41:00'), failure('bot', '05:42:00'),
    failure('bot', '2026-11-02T00:10:00'),
  ])
  assert.deepEqual(list.map((it) => (it.type === 'fail' ? `${it.authorId}×${it.msgs.length}` : it.type)), ['bot×3', 'other×1', 'bot×1', 'bot×1'])
})

test('a notice of the kind that is not a failed run keeps its own row', () => {
  const paused = notice('bot', '05:00:00', 'Elon Musk is paused because its Codex session could not be migrated: rollout missing\nRestore the rollout in the original Codex home.')
  assert.deepEqual(items([failure('bot', '04:51:39'), paused]).map((it) => it.type), ['fail', 'line'])
})

test('a line is found again by any of its failures when one joins at either end', () => {
  const [a, b, c] = [failure('bot', '04:51:39'), failure('bot', '05:16:53'), failure('bot', '05:40:18')]
  const talk = say('me', '04:00:00')
  // Older pages: the line keeps its key, so paging sees the row stay put.
  assert.deepEqual(items([talk, a, b]).map((it) => it.key), items([talk, b]).map((it) => it.key))
  // A new failure moves the key; the line is still the one holding b.
  const live = items([talk, b, c])
  assert.notEqual(live[1].key, items([talk, b])[1].key)
  assert.equal(rowIndexOf(live, keyOf(b)), 1)
  assert.equal(rowIndexOf(items([talk, a, b, c]), keyOf(a)), 1)
})

test('an older page lands above an opened line as a line of its own, and new failures still join it', () => {
  const [a, b, c] = [failure('bot', '04:51:39'), failure('bot', '05:16:53'), failure('bot', '05:40:18')]
  const talk = say('me', '04:00:00')
  const shape = (list: ReturnType<typeof items>) => list.map((it) => (it.type === 'fail' ? `fail×${it.msgs.length}` : it.type))
  const opened = new Set([b.id])
  const newest = items([b], opened)
  // An older page brings a talk row and a: they land above the opened line,
  // which keeps its key and its failures, so the list's anchor moves down by two rows.
  const paged = items([talk, a, b], opened)
  assert.deepEqual(shape(paged), ['msg', 'fail×1', 'fail×1'])
  assert.equal(paged[2].key, newest[0].key)
  assert.equal(rowIndexOf(paged, keyOf(b)), 2)
  // A failure that arrives later joins the opened line at its bottom.
  assert.deepEqual(shape(items([talk, a, b, c], opened)), ['msg', 'fail×1', 'fail×2'])
  // A line nobody opened takes the older page in, as before.
  assert.deepEqual(shape(items([talk, a, b, c])), ['msg', 'fail×3'])
})

test('notices sharing a client_id, as the runtime gave them before each window got its own, stay apart', () => {
  const [a, b] = [failure('bot', '04:51:39'), failure('bot', '05:40:18')]
  a.clientId = 'runtime-notice:same'
  b.clientId = 'runtime-notice:same'
  const list = items([a, say('me', '05:00:00'), b])
  assert.deepEqual(list.map((it) => it.type), ['fail', 'msg', 'fail'])
  assert.notEqual(list[0].key, list[2].key)
})

test("a line's reason is the error's last line, without retry categories, the agent prefix or the hint", () => {
  assert.equal(failureReason(REFUSED), 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)')
  assert.equal(
    failureReason("Fact Researcher could not run on local claude: local claude failed (exit 1): unknown\nAPI Error: JSON Parse error: Unexpected token '('\nOpen Claude Code on that computer and sign in, refresh quota, or add credits, then wake the agent again."),
    "API Error: JSON Parse error: Unexpected token '('",
  )
  assert.equal(failureReason(`Elon Musk could not run on local codex: local codex failed (exit 128): process terminated by SIGKILL\n${HINT}`), 'process terminated by SIGKILL')
  // The daemon cuts long errors, so a provider's JSON body often ends mid-way.
  assert.equal(
    failureReason(`Trouble Maker could not run on local codex: local codex failed (exit 1): {"error":{"message":"All target providers failed.","target_providers":["openai"],"atte\n${HINT}`),
    'All target providers failed.',
  )
})
