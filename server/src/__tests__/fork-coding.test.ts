/**
 * The T3 side of the coding list (server/src/fork/coding.ts). The mark
 * computer/t3-tag.mjs (deploy repo) puts before a T3 thread title is the only
 * link between a thread and the agent that launched it, so reading it wrong
 * lists a thread under nobody or under the wrong agent. A poll reads T3 as an
 * MCP client; T3 is faked at fetch with the shapes T3 answers with, so what is
 * pinned is that contract: paging, a question found through the pending
 * requests, a thread without a pull request list, and the session closed. A
 * thread's detail reads the end of a timeline T3 pages from its start, and
 * shows agent text, so it is pinned that the text is redacted before its cut.
 */
import { test, after, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// coding.ts finds its T3 tokens relative to the server's cwd when it loads.
const root = mkdtempSync(join(tmpdir(), 'fork-coding-'))
mkdirSync(join(root, 'server/computer/t3code'), { recursive: true })
writeFileSync(join(root, 'server/computer/t3code/tok'), 'token-123\n')
writeFileSync(join(root, 'server/computer/t3code/bad'), 'token-line-one\ntoken-line-two\n')
const cwd = process.cwd()
process.chdir(root)
const { markedThreads, parseMark, threadDetail } = await import('../fork/coding.js')
process.chdir(cwd)
after(() => rmSync(root, { recursive: true, force: true }))

const server = (tokenFile: string) => ({ name: 't3code', url: 'http://t3.example.test/mcp', tokenFile })
const thread = (threadId: string, status: string, more: object = {}) => ({
  threadId, title: `[@bot] ${threadId}`, status, latestRunId: `run-${threadId}`, settled: false,
  pullRequests: [], createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:05:00.000Z', ...more,
})

/** A T3 that answers like the real one, recording each tool call and the session's end. */
function fakeT3(t: TestContext, tool: (name: string, args: Record<string, unknown>) => unknown): string[] {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    assert.equal(headers.authorization, 'Bearer token-123')
    if (init.method === 'DELETE') {
      calls.push(`DELETE ${headers['mcp-session-id']}`)
      return new Response(null, { status: 204 })
    }
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params: { name: string; arguments: Record<string, unknown> } }
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 's-1' } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    assert.equal(headers['mcp-session-id'], 's-1')
    calls.push(`${body.params.name} ${JSON.stringify(body.params.arguments)}`)
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: tool(body.params.name, body.params.arguments) } })
  })
  return calls
}

test('a leading mark names the agent, and the rest is the title', () => {
  assert.deepEqual(parseMark('[@credential-manager] 헤더 수정'), { agentId: 'credential-manager', title: '헤더 수정' })
  assert.deepEqual(parseMark('[@pr-summary-bot] [@other] x'), { agentId: 'pr-summary-bot', title: '[@other] x' }, 'the first mark wins')
  assert.deepEqual(parseMark('[@Disagree · coroner] HeliBoard 빌드'), { agentId: 'coroner', title: 'HeliBoard 빌드' }, 'a renamed agent shows its name before its id')
  assert.deepEqual(parseMark('[@A · B · coroner] x'), { agentId: 'coroner', title: 'x' }, 'the id is the last part')
  assert.equal(parseMark('헤더 [@bot] 수정'), null, 'a mark inside the title is not one')
  assert.equal(parseMark('[@] x'), null)
  assert.equal(parseMark('[@two words] x'), null)
  assert.equal(parseMark('[@Disagree · two words] x'), null)
  assert.equal(parseMark('Fix the header'), null)
})

test('a poll reads every page of every live project, asks running threads for a question, and closes its session', async (t) => {
  const calls = fakeT3(t, (name, args) => {
    if (name === 't3_project_list') return { projects: [{ id: 'p1', deletedAt: null }, { id: 'p-gone', deletedAt: '2026-10-01T00:00:00.000Z' }], nextCursor: null }
    if (name === 't3_thread_list' && args.cursor === 0) {
      return {
        threads: [
          thread('th-1', 'running'),
          // T3's own `waiting`: a run that just finished, while T3 saves its checkpoint.
          thread('th-2', 'waiting', { pullRequests: [{ host: 'github.com', number: 7, url: 'https://github.com/o/r/pull/7', source: 'agent', state: null }] }),
        ],
        nextCursor: 2,
      }
    }
    // An older T3 server sends no pull request list at all.
    if (name === 't3_thread_list') return { threads: [thread('th-3', 'completed', { pullRequests: undefined })], nextCursor: null }
    if (name === 't3_pending_request_list') return { requestIds: args.threadId === 'th-1' ? ['q-1'] : [] }
    throw new Error(`unexpected ${name}`)
  })

  const threads = await markedThreads(server('tok'))

  assert.deepEqual(threads.map((x) => [x.threadId, x.status, x.requestId, x.pullRequests]), [
    ['th-1', 'running', 'q-1', []],
    ['th-2', 'waiting', null, [{ number: 7, url: 'https://github.com/o/r/pull/7', state: null }]],
    ['th-3', 'completed', null, []],
  ])
  assert.deepEqual(calls, [
    't3_project_list {"limit":100}',
    't3_thread_list {"projectId":"p1","titleContains":"[@","limit":100,"cursor":0}',
    't3_pending_request_list {"threadId":"th-1"}',
    't3_thread_list {"projectId":"p1","titleContains":"[@","limit":100,"cursor":2}',
    'DELETE s-1',
  ])
})

test('a poll that fails still closes its session, and a malformed token fails without its value', async (t) => {
  const calls = fakeT3(t, () => {
    throw new Error('T3 is down')
  })
  await assert.rejects(markedThreads(server('tok')))
  assert.deepEqual(calls.at(-1), 'DELETE s-1')

  await assert.rejects(markedThreads(server('bad')), (err: Error) => !err.message.includes('token-line'))
})

const item = (position: number, type: string, text: string, textTruncated = false) => ({
  position, type, text, textTruncated, visibility: 'local', updatedAt: '2026-10-20T01:05:00.000Z',
})
const timeline = (thread: object, items: object[], nextPosition: number | null, hasMore: boolean) => ({
  thread: { itemCount: 3, pendingRequestCount: 0, branch: null, ...thread }, recentRuns: [], items, nextPosition, hasMore,
})

test('a detail reads the newest messages from the end of the timeline and the question, redacted, with the T3 app link', async (t) => {
  writeFileSync(join(root, 'server/computer/t3code.json'), JSON.stringify({ scheme: 't3code-dev', servers: [] }))
  const thread = { itemCount: 450, pendingRequestCount: 1, branch: 't3/fix-header' }
  const calls = fakeT3(t, (name, args) => {
    if (name === 't3_environment_read') return { environmentId: 'env-1', label: 'mbp' }
    if (name === 't3_thread_read' && args.limit === 1) return timeline(thread, [item(0, 'user_message', 'x')], 0, true)
    if (name === 't3_thread_read' && args.afterPosition === 249) {
      return timeline(thread, [
        item(260, 'user_message', 'Fix the header'),
        item(270, 'assistant_message', `Pushed with ghp_${'a'.repeat(36)}`),
        item(300, 'proposed_plan', '1. Fix it'),
      ], 300, true)
    }
    if (name === 't3_thread_read' && args.afterPosition === 300) {
      return timeline(thread, [item(400, 'assistant_message', 'b'.repeat(900)), item(449, 'assistant_message', 'Cut by T3', true)], 449, false)
    }
    if (name === 't3_pending_request_list') return { requestIds: ['q-1'] }
    if (name === 't3_pending_request_read') {
      return { requestId: 'q-1', questions: [{ id: 'a', header: 'Deploy', question: 'Push with GITHUB_TOKEN=abc123 now?', options: [{ label: 'Yes', description: 'Push to main' }] }] }
    }
    throw new Error(`unexpected ${name}`)
  })

  const detail = await threadDetail(server('tok'), 'th-1')

  assert.deepEqual(calls, [
    't3_environment_read {}',
    't3_thread_read {"threadId":"th-1","limit":1,"maxCharsPerItem":1}',
    't3_thread_read {"threadId":"th-1","afterPosition":249,"limit":100,"maxCharsPerItem":8000}',
    't3_thread_read {"threadId":"th-1","afterPosition":300,"limit":100,"maxCharsPerItem":8000}',
    't3_pending_request_list {"threadId":"th-1"}',
    't3_pending_request_read {"threadId":"th-1","requestId":"q-1"}',
    'DELETE s-1',
  ])
  assert.equal(detail.link, 't3code-dev://threads/env-1/th-1')
  assert.equal(detail.branch, 't3/fix-header')
  assert.deepEqual(detail.messages.map((m) => [m.id, m.kind, m.text]), [
    [270, 'reply', 'Pushed with [redacted]'],
    [300, 'plan', '1. Fix it'],
    [400, 'reply', `${'b'.repeat(800)}…`],
    [449, 'reply', 'Cut by T3…'],
  ], 'the newest four, cut after redaction, and marked where T3 cut them')
  assert.deepEqual(detail.questions, [{ header: 'Deploy', text: 'Push with GITHUB_TOKEN=[redacted] now?', options: [{ label: 'Yes', description: 'Push to main' }] }])
})

test('a detail asks for no question without a pending request, and refuses a scheme the T3 app does not answer to', async (t) => {
  writeFileSync(join(root, 'server/computer/t3code.json'), JSON.stringify({ servers: [] }))
  const calls = fakeT3(t, (name) => {
    if (name === 't3_environment_read') return { environmentId: 'env-1' }
    if (name === 't3_thread_read') return timeline({}, [item(0, 'user_message', 'Fix the header')], 0, false)
    throw new Error(`unexpected ${name}`)
  })
  const detail = await threadDetail(server('tok'), 'th-1')
  assert.equal(detail.link, 't3code://threads/env-1/th-1', 'T3’s own scheme when the instance names none')
  assert.deepEqual(detail.questions, [])
  assert.ok(calls.includes('t3_thread_read {"threadId":"th-1","afterPosition":-1,"limit":100,"maxCharsPerItem":8000}'), 'a short timeline is read from its start')

  writeFileSync(join(root, 'server/computer/t3code.json'), JSON.stringify({ scheme: 'javascript', servers: [] }))
  await assert.rejects(threadDetail(server('tok'), 'th-1'), /not one the T3 app answers to/)
  assert.equal(calls.at(-1), 'DELETE s-1')
})
