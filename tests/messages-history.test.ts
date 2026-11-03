import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { create } from 'zustand'
import type { ApiMessage } from '../src/api/client'
import { applyReplyCountDelta } from '../src/lib/replyCount'
import { NO_ANSWERS, transcriptItems, transcriptKeys, type Answers } from '../src/next/chat/cardAnswers'
import { loadOlderUntilShown } from '../src/next/chat/model'
import type { Message } from '../src/types'

// Execute the actual store with an in-memory API, without loading the browser
// client's Vite environment or auth persistence. Each test gets a fresh store.
const source = readFileSync(new URL('../src/stores/messages.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const loadStore = compileFunction(outputText, ['require', 'exports', 'console'])

/** The client's ApiError (message plus HTTP status), which the store checks with instanceof. */
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

function messages(first: number, last: number): ApiMessage[] {
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const sequence = first + index
    return {
      id: `m-${sequence}`, conversationId: 'chat', authorId: 'user',
      kind: 'text', body: String(sequence), at: '12:00', sequence,
    }
  })
}

function setup(last: number, cache: Message[] = messages(1, 80), serverMessages = messages(1, last)) {
  const requests: { before?: number; limit?: number }[] = []
  const api = {
    async getMessages(_id: string, options: { before?: number; limit?: number }) {
      requests.push(options)
      return serverMessages.filter((m) => options.before === undefined || m.sequence < options.before)
        .slice(-(options.limit ?? 80))
    },
  }
  // Stand-ins for the chat list and the selection; a room the server answers 404 for must leave both.
  const rooms = create(() => ({ list: [{ id: 'chat' }, { id: 'other' }] }))
  const app = create<{ selectedConversationId: string | null; selectConversation: (id: string | null) => void }>((set) => ({
    selectedConversationId: 'chat',
    selectConversation: (id) => set({ selectedConversationId: id }),
  }))
  const dependencies: Record<string, unknown> = {
    zustand: { create },
    '@/api/client': { api, ApiError },
    '@/lib/replyCount': { applyReplyCountDelta },
    '@/stores/auth': { getMeId: () => 'user' },
    '@/stores/app': { useApp: app },
    '@/stores/conversations': { useConversations: rooms },
  }
  const exports = {} as typeof import('../src/stores/messages')
  loadStore((name: string) => {
    assert.ok(name in dependencies, `Unexpected store dependency: ${name}`)
    return dependencies[name]
  }, exports, { ...console, warn() {} })
  const store = exports.useMessages
  store.setState({
    byConvo: { chat: cache },
    hasMoreOlder: { chat: false },
    firstItemIndex: { chat: exports.VIRTUOSO_FIRST_INDEX_BASE },
  })
  const sequences = () => store.getState().byConvo.chat.map((m) => (m as ApiMessage).sequence)
  return { store, api, requests, sequences, rooms, app }
}

describe('a room the server answers 404 for', () => {
  // Why the row has to go: the comment on the 404 branch of loadConversation.
  it('leaves the chat list along with the selection', async () => {
    const { store, api, rooms, app } = setup(80, [])
    api.getMessages = async () => { throw new ApiError('not found (404)', 404) }
    await store.getState().loadConversation('chat')
    assert.deepEqual(rooms.getState().list.map((c) => c.id), ['other'])
    assert.equal(app.getState().selectedConversationId, null)
  })

  it('stays listed after a failure that is not a 404', async () => {
    const { store, api, rooms } = setup(80, [])
    api.getMessages = async () => { throw new Error('Failed to fetch') }
    await store.getState().loadConversation('chat')
    assert.deepEqual(rooms.getState().list.map((c) => c.id), ['chat', 'other'])
  })

  it('stays listed when a 403 or 500 says "not found"', async () => {
    for (const status of [403, 500]) {
      const { store, api, rooms } = setup(80, [])
      api.getMessages = async () => { throw new ApiError(`participant not found (${status})`, status) }
      await store.getState().loadConversation('chat')
      assert.deepEqual(rooms.getState().list.map((c) => c.id), ['chat', 'other'], `status ${status}`)
    }
  })
})

describe('message history after reconnect', () => {
  for (const method of ['reloadConversation', 'loadConversation'] as const) {
    describe(method, () => {
      for (const [last, cursors] of [
        [100, [undefined]],
        [160, [undefined, 81]],
        [200, [undefined, 121]],
        [400, [undefined, 321, 241, 161, 81]],
      ] as const) {
        it(`fills cached 1–80 through ${last} without gaps or duplicates`, async () => {
          const { store, requests, sequences } = setup(last)
          const anchor = store.getState().firstItemIndex.chat
          await store.getState()[method]('chat')

          assert.deepEqual(sequences(), messages(1, last).map((m) => m.sequence))
          assert.deepEqual(requests.map((r) => r.before), [...cursors])
          assert.ok(requests.every((r) => r.limit === 80))
          assert.equal(store.getState().firstItemIndex.chat, anchor)
          assert.equal(store.getState().loaded.has('chat'), true)
        })
      }

      it('fetches only the latest page for an empty cache', async () => {
        const { store, requests, sequences } = setup(200, [])
        await store.getState()[method]('chat')
        assert.deepEqual(sequences(), messages(121, 200).map((m) => m.sequence))
        assert.equal(requests.length, 1)
      })

      it('ignores optimistic sequences when choosing the backfill boundary', async () => {
        const optimistic = { ...messages(1, 1)[0], id: 'temp', sequence: Number.MAX_SAFE_INTEGER, pending: true }
        const { store, sequences } = setup(200, [...messages(1, 80), optimistic])
        await store.getState()[method]('chat')
        assert.deepEqual(sequences(), [...messages(1, 200).map((m) => m.sequence), Number.MAX_SAFE_INTEGER])
        assert.equal(store.getState().byConvo.chat.at(-1), optimistic)
      })

      it('backfills even when a live message arrived after the reconnect', async () => {
        // On reconnect the store invalidates `loaded` for every conversation
        // except the open one, so this one backfills when the user next opens
        // it. But `applyEvent` appends live `message.new` rows to byConvo for
        // ANY cached conversation, and that lands before the user gets there.
        // One such row raises max(sequence) past the outage, the loop's
        // `page[0].sequence > latest` goes false, and the whole backfill is
        // skipped — a silent permanent hole.
        const live = messages(300, 300)
        const { store, sequences } = setup(300, [...messages(1, 80), ...live])
        await store.getState()[method]('chat')

        assert.deepEqual(
          sequences(), messages(1, 300).map((m) => m.sequence),
          'the outage was never bridged because one live message raised the watermark past it',
        )
      })

      it('keeps the cache intact on a failed backfill and fills the gap on retry', async () => {
        const { store, api, sequences } = setup(200)
        const originalCache = store.getState().byConvo.chat
        const getMessages = api.getMessages
        api.getMessages = async (id, options) => {
          if (options.before !== undefined) throw new Error('offline')
          return getMessages(id, options)
        }
        await store.getState()[method]('chat')
        assert.equal(store.getState().byConvo.chat, originalCache)
        assert.equal(store.getState().loading.has('chat'), false)

        api.getMessages = getMessages
        await store.getState()[method]('chat')
        assert.deepEqual(sequences(), messages(1, 200).map((m) => m.sequence))
      })
    })
  }

  it('bridges across a hole in the cache without duplicating what is held', async () => {
    // A rolled-back INSERT leaves a real hole in `sequence`. The completeness
    // watermark stops at it, so the bridge re-fetches rows we already hold —
    // which is the safe direction, as long as the merge does not duplicate.
    const holed = [...messages(1, 40), ...messages(42, 80)]
    const { store, sequences } = setup(200, holed)
    await store.getState().loadConversation('chat')

    const got = sequences()
    assert.deepEqual(got, [...got].sort((a, b) => a - b), 'the merge left the list out of order')
    assert.equal(new Set(got).size, got.length, 'the bridge duplicated messages it already held')
    assert.ok(got.includes(200) && got.includes(81), 'the gap after the hole was not bridged')
  })

  it('preserves messages received while the backfill request is in flight', async () => {
    const { store, api, sequences } = setup(200)
    const getMessages = api.getMessages
    let finishPage!: (page: ApiMessage[]) => void
    let backfillStarted!: () => void
    const started = new Promise<void>((resolve) => { backfillStarted = resolve })
    api.getMessages = async (id, options) => {
      if (options.before === undefined) return getMessages(id, options)
      backfillStarted()
      return new Promise<ApiMessage[]>((resolve) => { finishPage = resolve })
    }
    const reload = store.getState().reloadConversation('chat')
    await Promise.race([
      started,
      reload.then(() => { throw new Error('Reload completed without fetching the missing page') }),
    ])
    assert.deepEqual(sequences(), messages(1, 80).map((m) => m.sequence))
    store.getState().applyEvent({ type: 'message.new', conversationId: 'chat', message: messages(201, 201)[0] })
    finishPage(messages(41, 120))
    await reload
    assert.deepEqual(sequences(), messages(1, 201).map((m) => m.sequence))
  })

  it('leaves older history and its scroll anchor to loadOlder', async () => {
    const { store, requests, sequences } = setup(280, messages(81, 160))
    store.setState({ hasMoreOlder: { chat: true } })
    const anchor = store.getState().firstItemIndex.chat
    await store.getState().reloadConversation('chat')
    assert.deepEqual(sequences(), messages(81, 280).map((m) => m.sequence))
    assert.equal(store.getState().firstItemIndex.chat, anchor)

    await store.getState().loadOlder('chat')
    assert.deepEqual(sequences(), messages(1, 280).map((m) => m.sequence))
    assert.equal(requests.at(-1)?.before, 81)
    assert.equal(store.getState().firstItemIndex.chat, anchor - 80)
  })
})

describe('older pages the redesigned transcript does not draw', () => {
  /** Calendar firings, which buildItems leaves out of the transcript. */
  const firings = (first: number, last: number): ApiMessage[] =>
    messages(first, last).map((m) => ({ ...m, authorId: 'calendar', kind: 'system' }))
  type Store = ReturnType<typeof setup>['store']
  const drawn = (store: Store, answers: Answers = NO_ANSWERS) => transcriptItems(store.getState().byConvo.chat, 'user', answers).length
  const showOlder = (store: Store, answers: Answers = NO_ANSWERS, alive = () => true) => loadOlderUntilShown(
    () => store.getState().loadOlder('chat'),
    () => store.getState().byConvo.chat,
    (list) => transcriptKeys(list, 'user', answers),
    alive,
  )

  it('pages past a run of firings to the newest row it draws', async () => {
    // A routine room whose agent last spoke 290 firings ago: its newest page draws nothing.
    const { store, requests } = setup(300, [], [...messages(1, 10), ...firings(11, 300)])
    await store.getState().loadConversation('chat')
    assert.equal(drawn(store), 0)

    assert.equal(await showOlder(store), true)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221, 141, 61])
    assert.equal(drawn(store), 10)
  })

  it('pages past a secret reply among firings, which the transcript leaves out too', async () => {
    const answers: Answers = new Map([['m-200', { kind: 'secret', question: 'm-q' }]])
    const { store, requests } = setup(300, [], [...messages(1, 10), ...firings(11, 199), ...messages(200, 200), ...firings(201, 300)])
    await store.getState().loadConversation('chat')

    assert.equal(await showOlder(store, answers), true)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221, 141, 61])
    assert.equal(drawn(store, answers), 10)
  })

  it('stops where the history starts', async () => {
    const { store, requests } = setup(200, [], firings(1, 200))
    await store.getState().loadConversation('chat')
    assert.equal(await showOlder(store), false)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 121, 41])
  })

  it('stops once the room is left', async () => {
    const { store, requests } = setup(300, [], firings(1, 300))
    await store.getState().loadConversation('chat')
    assert.equal(await showOlder(store, NO_ANSWERS, () => requests.length < 2), false)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221])
  })

  it('stops after a failed page instead of asking again and again', async () => {
    const { store, api, requests } = setup(300, [], firings(1, 300))
    await store.getState().loadConversation('chat')
    api.getMessages = async (_id, options) => {
      requests.push(options)
      throw new Error('offline')
    }
    assert.equal(await showOlder(store), false)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221])
  })

  it('says the rows above changed when the history ends on a page that joined the top chip', async () => {
    // The last page lands rows above and joins the chip in one go, so the chip's
    // key changes and no row counts as landed above it; the history then ends.
    const tools = messages(6, 300).map((m) => ({ ...m, authorId: 'bot', kind: 'tool' as const }))
    const { store, requests } = setup(300, [], [...messages(1, 5), ...tools])
    await store.getState().loadConversation('chat')

    assert.equal(await showOlder(store), true)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221, 141, 61])
    assert.equal(drawn(store), 6)
  })

  it('pages past tool rows that only join the work chip on top', async () => {
    // An agent's long tool run: each older page adds rows to the first chip, not a row above it.
    const tools = messages(61, 300).map((m) => ({ ...m, authorId: 'bot', kind: 'tool' as const }))
    const { store, requests } = setup(300, [], [...messages(1, 60), ...tools])
    await store.getState().loadConversation('chat')
    assert.equal(drawn(store), 1)

    assert.equal(await showOlder(store), true)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221, 141, 61])
    assert.equal(drawn(store), 61)
  })

  it('after a page that changes the top chip key, pages on until a row lands above the new first row', async () => {
    // MessageList anchors Virtuoso by row key, so a chip whose key changed resets
    // that anchor: the first row's index moves again only with a row above the new first row.
    const tools = messages(101, 300).map((m) => ({ ...m, authorId: 'bot', kind: 'tool' as const }))
    const said = messages(100, 100).map((m) => ({ ...m, authorId: 'bot' }))
    const { store, requests } = setup(300, [], [...messages(1, 60), ...firings(61, 99), ...said, ...tools])
    await store.getState().loadConversation('chat')

    assert.equal(await showOlder(store), true)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221, 141, 61])
    assert.equal(drawn(store), 62)
  })

  it('keeps paging when a row arrives at the bottom meanwhile', async () => {
    const { store, api, requests } = setup(300, [], [...messages(1, 10), ...firings(11, 299), ...messages(300, 300)])
    await store.getState().loadConversation('chat')
    const getMessages = api.getMessages
    api.getMessages = async (id, options) => {
      const page = await getMessages(id, options)
      if (options.before === 221) store.getState().applyEvent({ type: 'message.new', conversationId: 'chat', message: messages(301, 301)[0] })
      return page
    }

    assert.equal(await showOlder(store), true)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221, 141, 61])
  })

  it('stops after a failed page even when a row arrives at the bottom meanwhile', async () => {
    const { store, api, requests } = setup(300, [], firings(1, 300))
    await store.getState().loadConversation('chat')
    api.getMessages = async (_id, options) => {
      requests.push(options)
      store.getState().applyEvent({ type: 'message.new', conversationId: 'chat', message: messages(301, 301)[0] })
      throw new Error('offline')
    }

    assert.equal(await showOlder(store), false)
    assert.deepEqual(requests.map((r) => r.before), [undefined, 221])
  })

  it('stops at once while another load is running', async () => {
    const { store, api, requests } = setup(300, [], firings(1, 300))
    await store.getState().loadConversation('chat')
    const getMessages = api.getMessages
    let release!: () => void
    api.getMessages = (id, options) => new Promise((resolve) => { release = () => resolve(getMessages(id, options)) })
    const running = store.getState().loadOlder('chat')

    assert.equal(await showOlder(store), false)
    assert.equal(requests.length, 1)
    release()
    await running
  })
})
