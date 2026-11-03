/**
 * Transcript times (the redesign's message list). The mistakes worth catching:
 * a burst from one sender stamping every line, a long run losing its times, a
 * silence showing no line or a day change showing a pause line on top of its
 * chip, a pause label rounding the wrong way, and the floating day under the
 * header naming the wrong date or showing over a chip that is still in view.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/types.ts'
import { buildItems, floatingDay, type DayPill, type Item } from '../src/next/chat/model.ts'
import { pauseLength } from '../src/next/format.ts'

let n = 0
/** `at` is a local time on 2026-10-19, or a full local ISO date-time. */
const msg = (authorId: string, at: string): Message => ({
  id: `m${++n}`, conversationId: 'c', authorId, kind: 'text', body: 'x', at: '',
  createdAt: at.includes('T') ? at : `2026-10-19T${at}`,
}) as Message

const stamps = (items: Item[]) => items.map((it) => (it.type === 'msg' ? it.stamp : it.type))

test('a burst gets one time, then one more once the clock reads 5 minutes later', () => {
  // 14:05:41 → 14:10:40 is 4 min 59 s, but the reader sees 02:05 and 02:10.
  const items = buildItems([msg('a', '14:05:41'), msg('a', '14:05:58'), msg('a', '14:09:00'), msg('a', '14:10:40')], 'me', () => false)
  assert.deepEqual(stamps(items), ['turn', 'hidden', 'hidden', 'slot'])
})

test('the reply that answered a question card is a line, so the agent speaks again in a new turn', () => {
  const answer = msg('me', '22:12:10')
  const items = buildItems([msg('a', '22:10:00'), answer, msg('a', '22:12:40')], 'me', (m) => m.id === answer.id)
  assert.deepEqual(stamps(items), ['turn', 'answer', 'turn'])
})

test('a new sender starts a turn, and only a silence of 15 minutes draws a line', () => {
  const items = buildItems([msg('a', '14:10:40'), msg('me', '18:28:03'), msg('a', '18:29:20'), msg('a', '18:38:05')], 'me', () => false)
  assert.deepEqual(stamps(items), ['turn', 'turn', 'turn', 'slot'])
  assert.deepEqual(items.map((it) => it.pause !== null), [false, true, false, false])
})

test('a pause ends the turn; a new day shows its chip, never a pause line', () => {
  const items = buildItems([msg('a', '10:00:00'), msg('a', '10:20:00'), msg('a', '2026-10-20T09:00:00')], 'me', () => false)
  assert.deepEqual(stamps(items), ['turn', 'turn', 'turn'])
  assert.deepEqual(items.map((it) => [it.day !== null, it.pause !== null]), [[true, false], [false, true], [true, false]])
})

test('pause lengths: exact minutes, then 5-minute steps, then whole hours', () => {
  const min = 60_000
  assert.deepEqual(pauseLength(40 * min + 59_000), { h: 0, m: 40 })
  assert.deepEqual(pauseLength(148 * min), { h: 2, m: 30 })
  assert.deepEqual(pauseLength(178 * min), { h: 3, m: 0 })
  assert.deepEqual(pauseLength(258 * min), { h: 4, m: 0 })
})

test('the floating day names the date at its line and steps aside for a chip in view', () => {
  const Y = 1
  const T = 2
  const pill = (day: number, prev: number | null, passed: boolean | null, near: boolean | null): DayPill => ({ day, prev, passed, near })
  // Opened partway into yesterday: no chip is mounted, so the rendered rows say the day.
  assert.deepEqual(floatingDay([], Y), { day: Y, show: true })
  // Rows that cross a day, or a chip not measured yet: keep what is on screen.
  assert.equal(floatingDay([], null), null)
  assert.equal(floatingDay([pill(T, Y, null, null)], Y), null)
  // The last chip under the header names the day, whatever lies below.
  assert.deepEqual(floatingDay([pill(Y, null, true, true), pill(T, Y, false, false)], null), { day: Y, show: true })
  assert.deepEqual(floatingDay([pill(Y, null, true, true), pill(T, Y, true, true)], null), { day: T, show: true })
  // Today's chip below the line names the day before it, and takes the spot as it comes near.
  assert.deepEqual(floatingDay([pill(T, Y, false, false)], null), { day: Y, show: true })
  assert.deepEqual(floatingDay([pill(T, Y, false, true)], null), { day: Y, show: false })
  // The top of the history: the first day's own chip is in view.
  assert.deepEqual(floatingDay([pill(Y, null, false, false)], null), { day: Y, show: false })
})
