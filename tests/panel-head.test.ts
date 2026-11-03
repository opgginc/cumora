/**
 * Whom the room panel's header names (src/next/panel/panelHead.ts). A group
 * room names itself even while its agents work: naming one of them would draw
 * the agent drawer's own header (panel/AgentDrawer.tsx), and the room's panel
 * would read as that agent's panel, which opens only when someone asks for it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { headerAgent } from '../src/next/panel/panelHead.ts'

const atlas = { id: 'atlas' }
const iris = { id: 'iris' }

test('a group room names itself while its agents work', () => {
  assert.equal(headerAgent('group', [atlas, iris]), undefined)
  assert.equal(headerAgent('email', [atlas]), undefined)
})

test('a 1:1 room names its agent while it works, and itself otherwise', () => {
  assert.equal(headerAgent('direct', [atlas]), atlas)
  assert.equal(headerAgent('direct', []), undefined)
})
