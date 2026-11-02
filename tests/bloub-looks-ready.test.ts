/**
 * The bloub looks' `ready` (src/next/bloub/looks.ts), which every agent avatar
 * waits for before it draws a portrait (ui/Avatar.tsx). The mistakes worth
 * catching: a load that answers or fails leaving the avatars blank, a load
 * overtaken by a pick or a workspace switch settling the wrong state, and the
 * request going out without the deadline that turns a stalled one into a
 * failure.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { create } from 'zustand'

// The actual store with an in-memory API, as tests/messages-history.test.ts runs its store.
const source = readFileSync(new URL('../src/next/bloub/looks.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const loadStore = compileFunction(outputText, ['require', 'exports', 'console'])

type Http = (path: string, init?: RequestInit) => Promise<unknown>
interface Looks { ready: boolean; byId: Record<string, { color: string }>; load(): Promise<void>; save(id: string, pick: unknown): Promise<void> }

function setup(http: Http) {
  const useAuth = create(() => ({ contextEpoch: 0 }))
  const dependencies: Record<string, unknown> = {
    zustand: { create },
    '@/api/client': { http, ws: { on: () => () => {} } },
    '@/stores/auth': { useAuth },
    './director': { loadEngine: () => {} },
  }
  const exports: { useBloubLooks?: { getState(): Looks } } = {}
  loadStore((id: string) => {
    if (!(id in dependencies)) throw new Error(`unexpected import ${id}`)
    return dependencies[id]
  }, exports, { ...console, warn: () => {} })
  return { looks: () => exports.useBloubLooks!.getState(), useAuth }
}

const LOOK = { shape: 'round', color: 'rouge', expression: 'neutre', accessories: [] }
/** The next turn, once a queued request has gone out. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a load that answers or fails stops the avatars waiting', async () => {
  const ok = setup(async () => ({ avatars: { bot: LOOK } }))
  assert.equal(ok.looks().ready, false)
  await ok.looks().load()
  assert.equal(ok.looks().ready, true)
  assert.deepEqual(Object.keys(ok.looks().byId), ['bot'])

  const failed = setup(async () => { throw new Error('offline') })
  await failed.looks().load()
  assert.equal(failed.looks().ready, true)
  assert.deepEqual(failed.looks().byId, {})
})

test('the request carries a deadline', async () => {
  let signal: unknown
  const s = setup(async (_path, init) => { signal = init?.signal; return { avatars: {} } })
  await s.looks().load()
  assert.ok(signal instanceof AbortSignal)
})

test('a pick made while a load is out keeps the pick, and the load still settles', async () => {
  let answer: (value: unknown) => void = () => {}
  const s = setup((_path, init) => (init?.method ? Promise.resolve({}) : new Promise((resolve) => { answer = resolve })))
  const loading = s.looks().load()
  await settle()
  void s.looks().save('bot', { shape: 'round', color: 'bleu', accessories: [] })
  answer({ avatars: { bot: LOOK } })
  await loading
  assert.equal(s.looks().ready, true)
  assert.equal(s.looks().byId.bot.color, 'bleu')
})

test('a workspace switch blanks the avatars until that workspace loads', async () => {
  const answers: Array<(value: unknown) => void> = []
  const s = setup(() => new Promise((resolve) => { answers.push(resolve) }))
  const first = s.looks().load()
  await settle()
  s.useAuth.setState({ contextEpoch: 1 })
  answers[0]({ avatars: { bot: LOOK } })
  await first
  assert.equal(s.looks().ready, false)
  assert.deepEqual(s.looks().byId, {})

  const second = s.looks().load()
  await settle()
  answers[1]({ avatars: {} })
  await second
  assert.equal(s.looks().ready, true)
})
