/**
 * Engine-failure notices: the daemon's rule (fork/engineNotice.ts) and the
 * Modern UI's copy of it (src/next/chat/failures.ts), which reads notices
 * posted before the rule. The inputs are errors behind notices chat.zz.gg
 * stored. The classifiers still read the categories in them, so only the
 * notice may drop them, and an old notice must read as the daemon would
 * post it now.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTICE_DEDUPE_SEC, noticeDedupeKey, noticeDetail } from '../fork/engineNotice.js'
import { failureDetail } from '../../../src/next/chat/failures.js'

const REFUSED = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'
const HINT = 'Check the daemon terminal for details, then wake the agent again.'
const ERRORS = {
  outage: `local claude failed (exit 1): ${Array(10).fill('unknown').join('\n')}\nserver_error\n${REFUSED}`,
  repeated: [
    'local claude failed (exit 1): Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted.',
    'unknown',
    "API Error: JSON Parse error: Unexpected token '('",
    'unknown',
    "API Error: JSON Parse error: Unexpected token '('",
  ].join('\n'),
  killed: 'local codex failed (exit 128): process terminated by SIGKILL',
  json: 'local codex failed (exit 1): {"error":{"message":"All target providers failed."}}',
  bare: 'local claude failed (exit 1): unknown',
}

test('a connection outage keeps the error, not the category of every retry', () => {
  assert.equal(noticeDetail(ERRORS.outage), `local claude failed (exit 1): ${REFUSED}`)
})

test('a repeated error shows once, and prose around it stays in order', () => {
  assert.equal(noticeDetail(ERRORS.repeated), [
    'local claude failed (exit 1): Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted.',
    "API Error: JSON Parse error: Unexpected token '('",
  ].join('\n'))
})

test('errors without categories and errors made only of them come back as they were', () => {
  for (const error of [ERRORS.killed, ERRORS.json, ERRORS.bare]) assert.equal(noticeDetail(error), error)
})

test('an old notice opened in the transcript reads as the daemon posts it now', () => {
  const notice = (error: string) => `PR Summary Bot could not run on local claude: ${error}\n${HINT}`
  for (const [name, error] of Object.entries(ERRORS)) {
    assert.equal(failureDetail(notice(error)), notice(noticeDetail(error)), name)
  }
})

test('an error posts once per window, and the next window is a new message', () => {
  // The runtime makes the client_id from this key; the web app merges messages that share one.
  const window = NOTICE_DEDUPE_SEC * 1000
  const start = window * 2_000_000
  const key = (now: number, detail = ERRORS.killed) => noticeDedupeKey('bot', 'room', detail, now)
  assert.equal(key(start), key(start + window - 1))
  assert.notEqual(key(start), key(start + window))
  assert.notEqual(key(start), key(start, ERRORS.json))
})
