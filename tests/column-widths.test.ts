/**
 * A stored chat-list or room-panel width (src/next/chat/columns.ts) reaches the
 * grid only as a whole number inside its column's range. Anything else means
 * the default: a negative width would drop the whole grid-template-columns
 * declaration, and a storage that throws must not take the chat screen down.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LIST, PANEL, parseWidth, readWidth } from '../src/next/chat/columns.ts'

test('a stored width inside its range is kept, rounded to a pixel', () => {
  assert.equal(parseWidth('380', LIST), 380)
  assert.equal(parseWidth('380.6', LIST), 381)
})

test('a stored width outside its range is clamped into it', () => {
  assert.equal(parseWidth('5000', LIST), LIST.max)
  assert.equal(parseWidth('-50', PANEL), PANEL.min)
})

test('a missing or unreadable width means the default', () => {
  for (const raw of [null, '', '  ', 'abc', 'NaN', 'Infinity']) assert.equal(parseWidth(raw, LIST), null, String(raw))
})

test('a storage that throws on read leaves the default', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const warn = console.warn
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => { throw new Error('SecurityError') } },
    configurable: true,
  })
  console.warn = () => {}
  try {
    assert.equal(readWidth(LIST), null)
  } finally {
    console.warn = warn
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
})
