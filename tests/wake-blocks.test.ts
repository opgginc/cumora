/**
 * The memory index and team in wake prompts (server/src/fork/wakeBlocks.ts).
 * The mistakes worth catching: a block left out of a session that has no
 * recent copy (a fresh session, a resume retried fresh, a prompt the model
 * never read, a compaction, a copy drifted far back, a changed text), and a
 * block repeated whole while the session still holds a recent copy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextOf, REFRESH_TOKENS, WakeBlocks } from '../server/src/fork/wakeBlocks.ts'

const texts = { memory: '- [A](a.md) — a fact', team: '- atlas — writer' }

/** A wake whose prompt the model read at `context` tokens. */
function wake(blocks: WakeBlocks, resume: string | null, context: number, t = texts) {
  const pick = blocks.pick(resume, t)
  blocks.onCall(context)
  return pick
}

test('a fresh session gets both blocks whole, and the next wake one line each', () => {
  const blocks = new WakeBlocks()
  assert.deepEqual(wake(blocks, null, 40_000), texts)
  assert.deepEqual(blocks.pick('s1', texts), { memory: null, team: null })
})

test('a block whose text changed goes whole again, the other stays one line', () => {
  const blocks = new WakeBlocks()
  wake(blocks, null, 40_000)
  const changed = { ...texts, memory: `${texts.memory}\n- [B](b.md) — another` }
  assert.deepEqual(blocks.pick('s1', changed), { memory: changed.memory, team: null })
})

test('a copy drifted REFRESH_TOKENS back goes whole again', () => {
  const blocks = new WakeBlocks()
  wake(blocks, null, 40_000)
  blocks.onCall(40_000 + REFRESH_TOKENS - 1)
  assert.deepEqual(blocks.pick('s1', texts), { memory: null, team: null })
  blocks.onCall(40_000 + REFRESH_TOKENS)
  assert.deepEqual(blocks.pick('s1', texts), texts)
})

test('the distance counts from where the latest whole copy was read', () => {
  const blocks = new WakeBlocks()
  wake(blocks, null, 40_000)
  blocks.onCall(40_000 + REFRESH_TOKENS)
  wake(blocks, 's1', 40_000 + REFRESH_TOKENS + 5_000)
  blocks.onCall(40_000 + REFRESH_TOKENS + 6_000)
  assert.deepEqual(blocks.pick('s1', texts), { memory: null, team: null })
})

test('a context that shrank since the copy was read (a compaction) gets both whole', () => {
  const blocks = new WakeBlocks()
  wake(blocks, null, 400_000)
  blocks.onCall(60_000)
  assert.deepEqual(blocks.pick('s1', texts), texts)
})

test('a resume retried in a fresh session gets both whole', () => {
  const blocks = new WakeBlocks()
  wake(blocks, null, 40_000)
  assert.deepEqual(blocks.pick('s1', texts), { memory: null, team: null })
  assert.deepEqual(blocks.pick(null, texts), texts)
})

test('blocks of a prompt the model never read go whole on the next wake', () => {
  const blocks = new WakeBlocks()
  blocks.pick(null, texts)
  assert.deepEqual(blocks.pick('s1', texts), texts)
})

test('an empty block is no block, never the one line', () => {
  const blocks = new WakeBlocks()
  assert.deepEqual(wake(blocks, null, 40_000, { memory: texts.memory, team: '' }), { memory: texts.memory, team: '' })
  assert.deepEqual(blocks.pick('s1', { memory: texts.memory, team: '' }), { memory: null, team: '' })
})

test('a call\'s size counts what it read, cached or not, and not what it wrote', () => {
  const usage = { input_tokens: 3, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 1_200, output_tokens: 900 }
  assert.equal(contextOf(usage), 201_203)
  assert.equal(contextOf({}), 0)
})
