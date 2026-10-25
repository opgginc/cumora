/**
 * The Coding tab's text (src/next/panel/codingText.ts). The `?t3=` key must
 * split at its first ':', since a thread id holds one (`mcp:<uuid>`): split
 * anywhere else, the detail asks for another thread. In a message, an image
 * from the developer's machine, which only T3 can show, becomes a label and
 * everything else is left as written: a rewrite inside code would show the
 * label's escapes in the code block and differ from what the copy button copies.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadableImages, parseThreadKey, threadKey } from '../src/next/panel/codingText.ts'

const label = (name: string) => `Image in T3: ${name}`

test('a thread key splits at its first colon, and a malformed one names no thread', () => {
  assert.deepEqual(parseThreadKey('t3code:mcp:1'), { server: 't3code', threadId: 'mcp:1' })
  assert.deepEqual(parseThreadKey(threadKey({ server: 't3code-m4', threadId: 'mcp:2' })), { server: 't3code-m4', threadId: 'mcp:2' })
  for (const bad of ['plain', ':x', 'a:']) assert.equal(parseThreadKey(bad), null, bad)
})

test('an image only T3 can show becomes its label, in italics', () => {
  assert.equal(loadableImages('Before ![Trackpoint at rest](/tmp/tp/nub.png) after', label), 'Before *Image in T3: Trackpoint at rest* after')
  assert.equal(loadableImages('![](/tmp/a_b.png "title")', label), '*Image in T3: a\\_b.png*', 'no alt text: its file name, escaped')
  assert.equal(loadableImages('![a *b* _c_](./x.png)', label), '*Image in T3: a \\*b\\* \\_c\\_*', 'Markdown in the alt text is escaped')
})

test('images on the web, links and code stay as written', () => {
  for (const text of [
    '![shot](https://example.com/shot.png)',
    '![dot](data:image/png;base64,iVBORw0KGgo=)',
    '[log](/tmp/log.txt)',
    'Use `![x](/tmp/x.png)` in a reply',
    'Or ``![x](/tmp/x.png) with ` inside`` in a reply',
    '```md\n![x](/tmp/x.png)\n```',
    '~~~\n![x](/tmp/x.png)\n~~~',
    '````md\n```\n![x](/tmp/x.png)\n```\n````',
    'Cut inside a fence:\n```\n![x](/tmp/x.png)',
  ]) assert.equal(loadableImages(text, label), text)
  assert.equal(
    loadableImages('```\n![x](/tmp/x.png)\n```\n![y](/tmp/y.png)', label),
    '```\n![x](/tmp/x.png)\n```\n*Image in T3: y*',
    'after a fence closes, images are rewritten again',
  )
})
