/**
 * Portraits are stored at the size the apps draw them (fork/portrait.ts): a
 * square 256 px WebP, whatever the source's format and shape.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { portraitWebp } from '../fork/portrait.js'

test('a wide PNG becomes a square 256 px WebP', async () => {
  const png = await sharp({ create: { width: 1254, height: 900, channels: 3, background: '#c0392b' } }).png().toBuffer()
  const meta = await sharp(await portraitWebp(png)).metadata()
  assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height }, { format: 'webp', width: 256, height: 256 })
})

test('bytes that are not an image are refused', async () => {
  await assert.rejects(portraitWebp(Buffer.from('not an image')))
})
