/**
 * The memory index and team in wake prompts (server/src/fork/wakeBlocks.ts).
 * The mistakes worth catching: a block left out of a session that has no
 * recent copy (a fresh session, a resume retried fresh, a prompt the model
 * never read, a compaction, even one in the middle of a turn, a copy drifted
 * far back, a changed text, an engine whose hops do not tell the context's
 * size), and a block repeated whole while the session still holds a recent copy.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRunner } from '../agents/computer/daemon.js'
import type { EngineHopReport, EngineRunResult } from '../agents/computer/engine.js'
import { hopContext, memoryBlock, REFRESH_TOKENS, teamBlock, WakeBlocks } from '../fork/wakeBlocks.js'

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

test('a compaction in the middle of a turn counts even after the context grew back', () => {
  const blocks = new WakeBlocks()
  wake(blocks, null, 100_000)
  blocks.onCall(120_000)
  blocks.onCall(110_000)
  blocks.onCall(115_000)
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
  assert.equal(memoryBlock(''), '')
  assert.equal(teamBlock(''), '')
})

test('the one lines name where the block can be read again, and the team keeps its guidance', () => {
  assert.match(memoryBlock(null), /memory\/MEMORY\.md/)
  assert.match(teamBlock(null), /trust it over memory; `cumora participants`/)
  assert.match(teamBlock('- atlas'), /^Your team right now \(trust over memory .*\):\n- atlas\n$/)
})

test('only an exact call of the agent\'s own conversation tells the context\'s size', () => {
  const usage = { input_tokens: 3, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 1_200, output_tokens: 900 }
  assert.equal(hopContext({ exact: true, usage }), 201_203)
  // Grok and ZCode report `{}` when the result carries no usage; Gemini,
  // Cursor and one-shot Codex report a turn's sum. Neither is exact.
  assert.equal(hopContext({ usage: {} }), null)
  assert.equal(hopContext({ usage }), null)
  assert.equal(hopContext({ exact: true, sub: 'toolu_1', usage }), null)
  assert.equal(hopContext({ exact: true, rest: { subs: [] }, usage }), null)
})

// The daemon's wiring (agents/computer/daemon.ts): which hops count as calls,
// and which session a turn's prompt is built for.
type Runner = {
  sessionId: string | null
  engineSession: { alive: boolean } | null
  hopReporter: { push(): void } | null
  wakeBlocks: WakeBlocks
  runEngineAttempt(prompt: string, resume: string | null): Promise<EngineRunResult>
  resetEngineSession(reason: string): Promise<void>
  runWithSessionRecovery(delta: (resume: string | null) => string): Promise<EngineRunResult>
  onEngineHop(report: EngineHopReport, purpose: 'agent-turn'): void
}

/** A runner whose engine attempts are recorded instead of run; each returns
 *  the next of `results`, then success. */
function runner(t: TestContext, results: EngineRunResult[] = []) {
  const r = new AgentRunner(
    { serverUrl: 'https://server.example.test', computerId: 'fixture', deviceToken: 'fixture' },
    { id: 'fixture', name: 'Fixture', role: null, systemPrompt: null, engine: 'claude', model: null, fastModel: null },
    'claude',
  ) as unknown as Runner
  const attempts: Array<{ prompt: string; resume: string | null }> = []
  t.mock.method(r, 'runEngineAttempt', async (prompt: string, resume: string | null) => {
    attempts.push({ prompt, resume })
    return results.shift() ?? { exitCode: 0 }
  })
  t.mock.method(r, 'resetEngineSession', async () => {})
  r.hopReporter = { push: () => {} }
  return { r, attempts }
}

const call = (context: number, over: Partial<EngineHopReport> = {}): EngineHopReport =>
  ({ model: 'fixture-model', usage: { cache_read_input_tokens: context }, exact: true, ...over })
/** A wake prompt's blocks, picked as the daemon's wakes pick them. */
const delta = (r: Runner) => (resume: string | null) => {
  const blocks = r.wakeBlocks.pick(resume, texts)
  return memoryBlock(blocks.memory) + teamBlock(blocks.team)
}
const whole = memoryBlock(texts.memory) + teamBlock(texts.team)
const lines = memoryBlock(null) + teamBlock(null)

test('only an exact first block of the agent\'s own call confirms the blocks it read', (t) => {
  const { r } = runner(t)
  // Grok and ZCode send `{}`; a repeat is a later block of a call already counted.
  const hops = [
    call(40_000, { exact: undefined }),
    call(0, { usage: {}, exact: undefined }),
    call(40_000, { repeat: true }),
    call(40_000, { sub: 'toolu_1' }),
  ]
  for (const hop of hops) {
    r.wakeBlocks.pick(null, texts)
    r.onEngineHop(hop, 'agent-turn')
    assert.deepEqual(r.wakeBlocks.pick('s1', texts), texts)
  }
  r.wakeBlocks.pick(null, texts)
  r.onEngineHop(call(40_000), 'agent-turn')
  assert.deepEqual(r.wakeBlocks.pick('s1', texts), { memory: null, team: null })
})

test('a turn on the live engine process gets one line, and its retry in a fresh session both whole', async (t) => {
  const { r, attempts } = runner(t, [{ exitCode: 1, error: 'No conversation found with session ID: stale' }])
  r.sessionId = 'stale'
  r.engineSession = { alive: true }
  r.wakeBlocks.pick(null, texts)
  r.onEngineHop(call(40_000), 'agent-turn')
  await r.runWithSessionRecovery(delta(r))
  assert.deepEqual(attempts, [{ prompt: lines, resume: 'stale' }, { prompt: whole, resume: null }])
})

test('a turn that starts a new engine process gets both whole, though the engine resumes', async (t) => {
  // The persistent Codex session starts a new thread when thread/resume fails.
  const { r, attempts } = runner(t)
  r.sessionId = 's1'
  r.wakeBlocks.pick(null, texts)
  r.onEngineHop(call(40_000), 'agent-turn')
  r.engineSession = null
  await r.runWithSessionRecovery(delta(r))
  assert.deepEqual(attempts, [{ prompt: whole, resume: 's1' }])
})
