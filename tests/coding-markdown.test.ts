/**
 * The Coding detail's Markdown (src/next/panel/codingMarkdown.ts): an image
 * from the developer's machine, which only T3 can show, becomes a label, and
 * everything else is left as written. A rewrite inside code would show the
 * label's escapes in the code block and differ from what the copy button
 * copies.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadableImages } from '../src/next/panel/codingMarkdown.ts'

const label = (name: string) => `Image in T3: ${name}`

test('an image only T3 can show becomes its label, in italics', () => {
  assert.equal(loadableImages('Before ![Trackpoint at rest](/tmp/tp/nub.png) after', label), 'Before *Image in T3: Trackpoint at rest* after')
  assert.equal(loadableImages('![](/tmp/a_b.png "title")', label), '*Image in T3: a\\_b.png*', 'no alt text: its file name, escaped')
  assert.equal(loadableImages('![a *b* _c_](./x.png)', label), '*Image in T3: a \\*b\\* \\_c\\_*', 'Markdown in the alt text is escaped')
})

test('images on the web, links and code stay as written', () => {
  for (const text of [
    '![shot](https://example.com/shot.png)',
    '[log](/tmp/log.txt)',
    'Use `![x](/tmp/x.png)` in a reply',
    '```md\n![x](/tmp/x.png)\n```',
    'Cut inside a fence:\n```\n![x](/tmp/x.png)',
  ]) assert.equal(loadableImages(text, label), text)
  assert.equal(
    loadableImages('```\n![x](/tmp/x.png)\n```\n![y](/tmp/y.png)', label),
    '```\n![x](/tmp/x.png)\n```\n*Image in T3: y*',
    'after a fence closes, images are rewritten again',
  )
})
