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
const { agentCoding, codingThread, markedThreads, parseMark, poll, threadDetail } = await import('../fork/coding.js')
process.chdir(cwd)
after(() => rmSync(root, { recursive: true, force: true }))

const server = (tokenFile: string) => ({ name: 't3code', url: 'http://t3.example.test/mcp', tokenFile })
const thread = (threadId: string, status: string, more: object = {}) => ({
  threadId, title: `[@bot] ${threadId}`, status, latestRunId: `run-${threadId}`, settled: false, settledAt: null,
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
    // An older T3 server sends no pull request list at all. A settled time in
    // another form than toISOString()'s would break the list's text compare.
    if (name === 't3_thread_list') {
      return { threads: [thread('th-3', 'completed', { pullRequests: undefined, settled: true, settledAt: '2026-10-21T09:00:00+09:00' })], nextCursor: null }
    }
    if (name === 't3_pending_request_list') return { requestIds: args.threadId === 'th-1' ? ['q-1'] : [] }
    throw new Error(`unexpected ${name}`)
  })

  const threads = await markedThreads(server('tok'))

  assert.deepEqual(threads.map((x) => [x.threadId, x.status, x.requestId, x.pullRequests, x.settledAt]), [
    ['th-1', 'running', 'q-1', [], null],
    ['th-2', 'waiting', null, [{ number: 7, url: 'https://github.com/o/r/pull/7', state: null }], null],
    ['th-3', 'completed', null, [], '2026-10-21T00:00:00.000Z'],
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
      return timeline(thread, [item(400, 'assistant_message', 'b'.repeat(4_100)), item(449, 'assistant_message', 'Cut by T3\nmid-wo', true)], 449, false)
    }
    if (name === 't3_pending_request_list') return { requestIds: ['q-1'] }
    if (name === 't3_pending_request_read') {
      return { requestId: 'q-1', questions: [{ id: 'a', header: 'Deploy', question: 'Push with GITHUB_TOKEN=abc123 now?', options: [{ label: 'Yes', description: 'Push to main' }] }] }
    }
    throw new Error(`unexpected ${name}`)
  })

  const detail = await threadDetail(server('tok'), 'th-1', 't3code-dev')

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
    [400, 'reply', `${'b'.repeat(3_999)}…`],
    [449, 'reply', 'Cut by T3…'],
  ], 'the newest four, cut after redaction, and marked where T3 cut them, without the token T3 cut through')
  assert.deepEqual(detail.questions, [{ id: 'a', header: 'Deploy', text: 'Push with GITHUB_TOKEN=[redacted] now?', options: [{ label: 'Yes', description: 'Push to main' }] }])
})

test('a message T3 cut loses its unfinished key or token before redaction, so no part of a secret is shown', async (t) => {
  const pem = (body: string, end: boolean) => `-----BEGIN RSA PRIVATE KEY-----\n${body}${end ? '\n-----END RSA PRIVATE KEY-----' : ''}`
  fakeT3(t, (name, args) => {
    if (name === 't3_environment_read') return { environmentId: 'env-1' }
    if (name === 't3_thread_read' && args.limit === 1) return timeline({ itemCount: 4 }, [], null, true)
    if (name === 't3_thread_read') {
      return timeline({ itemCount: 4 }, [
        // The first key shrinks to [redacted], which pulls the second, cut by T3
        // before its END, into the characters the detail shows.
        item(0, 'assistant_message', `Two keys:\n${pem('A'.repeat(3_000), true)}\n${pem('B'.repeat(4_000), false)}`, true),
        // A quoted value of several words, cut before its closing quote: no
        // pattern sees a secret there, whichever word the cut went through.
        item(1, 'assistant_message', 'Config:\n"password": "correct horse battery sta', true),
        // Cut right after a whole key's END marker, and inside one.
        item(2, 'assistant_message', `Key:\n${pem('D'.repeat(3_000), true)}`, true),
        item(3, 'assistant_message', `Key:\n${pem('E'.repeat(3_000), true).replace(/-----$/, '')}`, true),
      ], 3, false)
    }
    throw new Error(`unexpected ${name}`)
  })

  const [keys, quoted, endCut, insideEnd] = (await threadDetail(server('tok'), 'th-1', 't3code')).messages
  assert.ok(keys.text.includes('[redacted]'), 'the whole key is redacted')
  assert.ok(!keys.text.includes('BBBB'), 'the cut key shows nothing of its body')
  assert.ok(keys.text.endsWith('…'))
  assert.equal(quoted.text, 'Config:…', 'the line the cut went through goes, every quoted word with it')
  assert.ok(!endCut.text.includes('DDDD'), `a key cut at the end of its END marker stays redacted: ${endCut.text.slice(0, 80)}`)
  assert.ok(!insideEnd.text.includes('EEEE'), `a key cut inside its END marker shows nothing: ${insideEnd.text.slice(0, 80)}`)
})

test('a detail asks for no question without a pending request, and refuses a scheme the T3 app does not answer to', async (t) => {
  const calls = fakeT3(t, (name) => {
    if (name === 't3_environment_read') return { environmentId: 'env-1' }
    if (name === 't3_thread_read') return timeline({}, [item(0, 'user_message', 'Fix the header')], 0, false)
    throw new Error(`unexpected ${name}`)
  })
  const detail = await threadDetail(server('tok'), 'th-1', 't3code')
  assert.equal(detail.link, 't3code://threads/env-1/th-1')
  assert.deepEqual(detail.questions, [])
  assert.ok(calls.includes('t3_thread_read {"threadId":"th-1","afterPosition":-1,"limit":100,"maxCharsPerItem":8000}'), 'a short timeline is read from its start')

  const before = calls.length
  await assert.rejects(threadDetail(server('tok'), 'th-1', 'javascript'), /not one the T3 app answers to/)
  assert.equal(calls.length, before, 'no T3 session is opened for a link that could not work')
})

test('the detail route answers owners and admins only, and reads T3 only for a thread copied for the workspace', async (t) => {
  // db/pool.js loads env.ts, which exits without OPENAI_API_KEY; pg connects
  // only on a query, and every query is faked here.
  process.env.OPENAI_API_KEY ??= 'test-key'
  const [{ pool }, { getForkStore }] = await Promise.all([import('../db/pool.js'), import('../fork/store.js')])
  let role = 'member'
  let agent = true
  t.mock.method(pool, 'query', async () => ({ rows: [{ role, agent }] }))
  // The store opens in the temporary root: coding.ts loaded it from there.
  ;(await getForkStore()).saveCodingThreads([{
    server: 't3code', threadId: 'th-1', companyId: 'c1', agentId: 'bot', conversationId: null, title: 'Fix the header',
    status: 'completed', runId: 'run-1', requestId: null, pullRequests: [], createdAt: '2026-10-20T01:00:00.000Z',
    updatedAt: '2026-10-20T01:05:00.000Z', settledAt: null, woken: null,
  }])
  writeFileSync(join(root, 'server/computer/t3code.json'), JSON.stringify({ servers: [server('tok')] }))
  // T3's own error text can quote the thread, a secret included.
  let t3Error: string | null = null
  const calls = fakeT3(t, (name) => {
    if (t3Error) throw new Error(t3Error)
    if (name === 't3_environment_read') return { environmentId: 'env-1' }
    if (name === 't3_thread_read') return timeline({}, [item(0, 'user_message', 'Fix the header')], 0, false)
    throw new Error(`unexpected ${name}`)
  })
  const call = async (companyId: string, threadId: string) => {
    const res = {
      code: 200,
      body: null as { link: string | null; error: string | null; thread: { agentId: string } } | null,
      status(code: number) { this.code = code; return this },
      json(body: never) { this.body = body; return this },
    }
    await codingThread(async () => ({ userId: 'u1', companyId }), { params: { server: 't3code', threadId } } as never, res as never)
    return res
  }

  assert.equal((await call('c1', 'th-1')).code, 403, 'a member is refused')
  role = 'owner'
  assert.equal((await call('c2', 'th-1')).code, 404, 'another workspace’s thread is not found')
  assert.equal((await call('c1', 'th-other')).code, 404, 'a thread the server never copied is not found')
  assert.deepEqual(calls, [], 'and none of them reached T3')
  const ok = await call('c1', 'th-1')
  assert.equal(ok.code, 200)
  assert.equal(ok.body?.link, 't3code://threads/env-1/th-1', 'T3’s own scheme when the instance names none')
  assert.equal(ok.body?.thread.agentId, 'bot')

  t3Error = `bad input near GITHUB_TOKEN=ghp_${'z'.repeat(36)}`
  const failed = await call('c1', 'th-1')
  assert.equal(failed.code, 200, 'a T3 that fails still leaves the copy')
  assert.ok(failed.body?.error?.includes('[redacted]') && !failed.body.error.includes('zzzz'), `T3's error is redacted: ${failed.body?.error}`)
  t3Error = null

  writeFileSync(join(root, 'server/computer/t3code.json'), JSON.stringify({ servers: [] }))
  const gone = await call('c1', 'th-1')
  assert.equal(gone.code, 200, 'a T3 server taken off the list still leaves the copy')
  assert.match(gone.body?.error ?? '', /no longer in this instance/)
  assert.equal(gone.body?.link, null)

  // The list route goes through the same gate, one query for the role and the agent.
  const list = async () => {
    const res = {
      code: 200,
      body: null as { threads: Array<{ threadId: string; settledAt: string | null }> } | null,
      status(code: number) { this.code = code; return this },
      json(body: never) { this.body = body; return this },
    }
    await agentCoding(async () => ({ userId: 'u1', companyId: 'c1' }), { params: { agentId: 'bot' } } as never, res as never)
    return res
  }
  assert.deepEqual((await list()).body?.threads, [], 'a T3 server taken off the list lists nothing')
  writeFileSync(join(root, 'server/computer/t3code.json'), JSON.stringify({ servers: [server('tok')] }))
  assert.deepEqual((await list()).body?.threads.map((x) => x.threadId), ['th-1'])
  // Of the settled threads, the list keeps those settled within three days.
  const settled = (threadId: string, hoursAgo: number) => ({
    server: 't3code', threadId, companyId: 'c1', agentId: 'bot', conversationId: null, title: threadId, status: 'completed',
    runId: `run-${threadId}`, requestId: null, pullRequests: [], createdAt: '2026-10-20T01:00:00.000Z',
    updatedAt: new Date().toISOString(), settledAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), woken: null,
  })
  ;(await getForkStore()).saveCodingThreads([settled('th-settled', 71), settled('th-settled-long-ago', 73)])
  assert.deepEqual((await list()).body?.threads.map((x) => [x.threadId, x.settledAt !== null]), [['th-settled', true], ['th-1', false]])
  agent = false
  assert.equal((await list()).code, 404, 'not an agent of the workspace')
  role = 'member'
  assert.equal((await list()).code, 403, 'a member is refused the list too')
})

test('a poll unlists what a whole read no longer finds, keeps the copy when the read fails, and wakes once for one rest', async (t) => {
  // db/pool.js and redis.js load env.ts, which exits without OPENAI_API_KEY.
  // With the HTTP runtime client, redis.js connects only on a command, and
  // publish is faked.
  process.env.OPENAI_API_KEY ??= 'test-key'
  process.env.CUMORA_RUNTIME_CLIENT ??= 'http'
  const [{ pool }, { redis }, { codingWakeKey, getForkStore }] = await Promise.all([
    import('../db/pool.js'), import('../redis.js'), import('../fork/store.js'),
  ])
  // The agent `bot` is in workspace c1, and no turn has recorded a call, so a
  // due wake finds no room and waits for the next poll.
  t.mock.method(pool, 'query', async (sql: string) => ({ rows: sql.includes('llm_calls') ? [] : [{ id: 'bot', company_id: 'c1' }] }))
  const announced: string[] = []
  t.mock.method(redis, 'publish', (async (_channel: string, message: string) => {
    announced.push((JSON.parse(message) as { companyId: string }).companyId)
    return 1
  }) as never)
  let listed: object[] = []
  let down = false
  fakeT3(t, (name) => {
    if (down) throw new Error('T3 is down')
    if (name === 't3_project_list') return { projects: [{ id: 'p1', deletedAt: null }], nextCursor: null }
    if (name === 't3_thread_list') return { threads: listed, nextCursor: null }
    throw new Error(`unexpected ${name}`)
  })
  // Its own server name: the store is the one the route test above wrote to.
  const t3 = { ...server('tok'), name: 'poll-t3' }
  const store = await getForkStore()
  const shown = () => store.codingThreads('c1', 'bot', { servers: [t3.name], open: [], settledSince: '', settledLimit: 20 }).map((x) => x.threadId).sort()
  const now = new Date().toISOString()
  const both = [thread('th-a', 'completed', { updatedAt: now }), thread('th-b', 'idle', { updatedAt: now })]

  listed = both
  await poll(t3)
  assert.deepEqual(shown(), ['th-a', 'th-b'])
  assert.deepEqual(announced, ['c1'])
  // th-a came to rest a moment ago; its agent is woken for it.
  const rested = store.codingThread('c1', t3.name, 'th-a')
  assert.ok(rested)
  store.markCodingWoken(t3.name, 'th-a', codingWakeKey(rested), null, 'room')

  down = true
  announced.length = 0
  await poll(t3)
  assert.deepEqual(shown(), ['th-a', 'th-b'], 'a failed read takes nothing out of the list')
  assert.deepEqual(announced, ['c1'], 'only the failure is news')

  down = false
  listed = [both[1]]
  announced.length = 0
  await poll(t3)
  assert.deepEqual(shown(), ['th-b'], 'a thread T3 no longer lists leaves the list')
  assert.deepEqual(announced, ['c1'])

  // T3 lists it again (unarchived), still within the half hour a new copy would be woken for.
  listed = both
  await poll(t3)
  assert.deepEqual(shown(), ['th-a', 'th-b'])
  assert.deepEqual(store.codingWakesDue(t3.name, ['completed']), [], 'its agent is not woken twice for one rest')
})
