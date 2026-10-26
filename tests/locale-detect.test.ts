/**
 * A device with no stored language takes the browser's (src/lib/i18n.ts
 * detectLocale): the first tag whose primary subtag matches a locale in
 * LOCALES, so a new locale needs no detection code of its own.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectLocale } from '../src/lib/i18n.ts'

function withLanguages(languages: string[], run: () => void) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { language: languages[0], languages }, configurable: true })
  try {
    run()
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}

test('the first browser tag a locale covers wins', () => {
  const cases: Array<[string[], string]> = [
    [['ko-KR'], 'ko'],
    [['zh-TW'], 'zh-CN'],
    [['zh-Hans-CN'], 'zh-CN'],
    [['en-GB'], 'en'],
    [['fr', 'ko-KR', 'en'], 'ko'],
  ]
  for (const [tags, want] of cases) withLanguages(tags, () => assert.equal(detectLocale(), want, tags.join(',')))
})

test('a language no locale covers falls back to English', () => {
  // Konkani (kok) only shares its first letters with Korean.
  for (const tags of [['fr-FR'], ['kok'], ['ja', 'de']]) withLanguages(tags, () => assert.equal(detectLocale(), 'en', tags.join(',')))
})
