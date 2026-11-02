/**
 * Engine-failure lines (src/next/chat/failures.ts, buildItems). The mistakes
 * worth catching: an outage's notices, half an hour apart with Calendar
 * firings between them, not joining into one line; a line taking in another
 * agent's failure or the next day's; older pages changing a line's key, which
 * the list's scroll anchor and paging follow; and the line's reason showing a
 * retry category, the agent prefix or the hint instead of the error.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/types.ts'
import { buildItems } from '../src/next/chat/model.ts'
import { failureDetail, failureReason } from '../src/next/chat/failures.ts'

let n = 0
/** `t` is a local time on 2026-11-01, or a full local ISO date-time. */
const row = (authorId: string, t: string, kind: Message['kind'], body: string): Message => ({
  id: `m${++n}`, conversationId: 'c', authorId, kind, body, at: '',
  createdAt: t.includes('T') ? t : `2026-11-01T${t}`,
}) as Message
const failure = (authorId: string, t: string, text: string) => row(authorId, t, 'system', JSON.stringify({ kind: 'notice', noticeKind: 'byoa_engine_failed', text }))
const firing = (t: string) => row('calendar', t, 'system', JSON.stringify({ kind: 'calendar_event', title: 'Merge digest' }))
const items = (rows: Message[]) => buildItems(rows, 'me', () => false)

const HINT = 'Check the daemon terminal for details, then wake the agent again.'
/** What PR Summary Bot's DM held after the 2026-11-01 outage, three times over. */
const REFUSED = [
  'PR Summary Bot could not run on local claude: local claude failed (exit 1): unknown',
  ...Array(9).fill('unknown'),
  'server_error',
  'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
  HINT,
].join('\n')

test("one agent's failures join across pauses and firings, but not across agents or days", () => {
  const list = items([
    failure('bot', '04:51:39', REFUSED), firing('05:00:00'), failure('bot', '05:16:53', REFUSED), failure('bot', '05:40:18', REFUSED),
    failure('other', '05:41:00', REFUSED), failure('bot', '05:42:00', REFUSED),
    failure('bot', '2026-11-02T00:10:00', REFUSED),
  ])
  assert.deepEqual(list.map((it) => (it.type === 'fail' ? `${it.authorId}×${it.msgs.length}` : it.type)), ['bot×3', 'other×1', 'bot×1', 'bot×1'])
})

test('older failures joining a line keep its key', () => {
  const [a, b, c] = [failure('bot', '04:51:39', REFUSED), failure('bot', '05:16:53', REFUSED), failure('bot', '05:40:18', REFUSED)]
  assert.deepEqual(items([a, b, c]).map((it) => it.key), items([b, c]).map((it) => it.key))
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

test('an opened failure reads as the error and the hint', () => {
  assert.equal(
    failureDetail(REFUSED),
    `PR Summary Bot could not run on local claude: local claude failed (exit 1): API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)\n${HINT}`,
  )
})
