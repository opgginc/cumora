/**
 * Engine-failure notices (fork/engineNotice.ts). The inputs are the errors the
 * daemon held when chat.zz.gg posted its notices: the classifiers still read
 * the categories in them, so only the notice may drop them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noticeDetail } from '../fork/engineNotice.js'

const REFUSED = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'

test('a connection outage keeps the error, not the category of every retry', () => {
  const error = `local claude failed (exit 1): ${Array(10).fill('unknown').join('\n')}\nserver_error\n${REFUSED}`
  assert.equal(noticeDetail(error), `local claude failed (exit 1): ${REFUSED}`)
})

test('a repeated error shows once, and prose around it stays in order', () => {
  const error = [
    'local claude failed (exit 1): Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted.',
    'unknown',
    "API Error: JSON Parse error: Unexpected token '('",
    'unknown',
    "API Error: JSON Parse error: Unexpected token '('",
  ].join('\n')
  assert.equal(noticeDetail(error), [
    'local claude failed (exit 1): Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted.',
    "API Error: JSON Parse error: Unexpected token '('",
  ].join('\n'))
})

test('errors without categories and errors made only of them come back as they were', () => {
  const killed = 'local codex failed (exit 128): process terminated by SIGKILL'
  assert.equal(noticeDetail(killed), killed)
  const json = 'local codex failed (exit 1): {"error":{"message":"All target providers failed."}}'
  assert.equal(noticeDetail(json), json)
  const bare = 'local claude failed (exit 1): unknown'
  assert.equal(noticeDetail(bare), bare)
})
