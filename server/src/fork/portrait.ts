/**
 * Agent portraits at the size the apps draw them. The image API and agents'
 * uploads hand over 1024-1254 px PNGs of 2-3 MB, while the largest avatar the
 * apps draw is 80 CSS px (src/next). A client loads every portrait it shows
 * over the same HTTP/2 connection as the room's messages, so on a slow link a
 * dozen originals held the messages back: on a 70 KB/s link to chat.zz.gg
 * (2026-11-02) a 500-byte response took 21.8 s instead of 0.5 s while four
 * portraits were loading. At 256 px a portrait is 6-13 KB.
 */
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

/** 80 CSS px on a 3x phone screen is 240 device px. */
const SIZE = 256
/** `cumora avatar set` decodes whatever image an agent points at (up to 8 MB
 *  of bytes) in the server process. 50 megapixels still takes a 48 MP phone
 *  photo; sharp's own default is 268. */
const MAX_INPUT_PIXELS = 50_000_000

/** The raster format of an image by its first bytes, for the four a portrait
 *  may come in. Anything else an agent points at (an SVG, a TIFF, a HEIF)
 *  never reaches libvips's decoders in the server process. */
function rasterFormat(b: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** The image as a square WebP portrait: EXIF orientation applied, centre
 *  cropped (avatars are drawn as circles), the first frame of an animation.
 *  Rejects anything but PNG, JPEG, GIF and WebP, and images over the pixel cap. */
export async function portraitWebp(image: Buffer): Promise<Buffer> {
  if (!rasterFormat(image)) throw new Error('source image is not a PNG, JPEG, GIF or WebP')
  return sharp(image, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize(SIZE, SIZE, { fit: 'cover' }).webp({ quality: 80 }).toBuffer()
}

/** Stores an agent's new portrait under a key of its own and returns its URL.
 *  A new key, never the old one: the R2 gate serves `avatars/` as immutable
 *  and browsers keep a local one for an hour, so a rewritten key would keep
 *  showing the old picture. */
export async function storePortrait(agentId: string, image: Buffer): Promise<string> {
  const portrait = await portraitWebp(image)
  // Imported here: storage loads env.ts, which exits without OPENAI_API_KEY under node --test.
  const { storage } = await import('../storage.js')
  return storage.put(`avatars/avatar-${agentId}-${randomUUID().slice(0, 8)}.webp`, portrait, 'image/webp')
}
