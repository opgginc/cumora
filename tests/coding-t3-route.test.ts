/**
 * `?t3=` opens a T3 thread in a thread list (src/next/panel/CodingTab.tsx), so
 * withRoute (src/next/router.ts) drops it whenever that list goes. A `t3` left
 * behind reopened an old detail where its list came back, twice in review: a
 * panel tab or drawer pane switch, then an agent page's view switch. There is
 * no DOM in the test runner; router.ts and the classic stores it loads only
 * register listeners when they load, so two stubs stand in.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const g = globalThis as Record<string, unknown>
g.window ??= { addEventListener: () => {} }
g.document ??= { addEventListener: () => {} }
const { parseRoute, withRoute } = await import('../src/next/router.ts')

const t3 = (to: string) => new URL(to, 'http://cumora.test').searchParams.get('t3')
const KEY = 't3code:mcp:1'

test('t3 stays while its thread list stays', () => {
  const room = parseRoute('/next/c/r1', `?panel=coding&t3=${KEY}`)
  assert.equal(t3(withRoute(room, { params: { q: 'x' } })), KEY)
  assert.equal(t3(withRoute(room, { threadId: null })), KEY)
})

test('t3 goes with the list it opened in', () => {
  const room = parseRoute('/next/c/r1', `?panel=coding&t3=${KEY}`)
  assert.equal(t3(withRoute(room, { panel: 'members' })), null, 'another panel tab')
  assert.equal(t3(withRoute(room, { panel: 'none' })), null, 'the panel closing')
  assert.equal(t3(withRoute(room, { peek: { kind: 'agent', id: 'a' } })), null, 'a drawer opening over the tab')

  const drawer = parseRoute('/next/c/r1', `?peek=agent:a&pane=jobs&t3=${KEY}`)
  assert.equal(t3(withRoute(drawer, { params: { pane: 'screen' } })), null, 'another drawer pane')
  assert.equal(t3(withRoute(drawer, { peek: { kind: 'agent', id: 'b' } })), null, 'another agent’s drawer')

  const page = parseRoute('/next/agents/a', `?t3=${KEY}`)
  assert.equal(t3(withRoute(page, { params: { view: 'profile' } })), null, 'another view of the agent’s page')
})

test('a caller that opens a thread passes its own t3 again', () => {
  const drawer = parseRoute('/next/c/r1', `?peek=agent:a&pane=screen&t3=${KEY}`)
  assert.equal(t3(withRoute(drawer, { peek: { kind: 'agent', id: 'a' }, params: { pane: 'jobs', t3: 't3code:mcp:2' } })), 't3code:mcp:2')
  const page = parseRoute('/next/agents/a', '?view=profile')
  assert.equal(t3(withRoute(page, { params: { view: null, t3: KEY } })), KEY)
})
