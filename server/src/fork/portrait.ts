/**
 * Agent portraits at the size the apps draw them. The image API and agents'
 * uploads hand over 1024-1254 px PNGs of 2-3 MB, while the largest avatar the
 * apps draw is 80 CSS px (src/next). A client loads every portrait it shows
 * over the same HTTP/2 connection as the room's messages, so on a slow link a
 * dozen originals held the messages back: on a 70 KB/s link to chat.zz.gg
 * (2026-11-02) a 500-byte response took 21.8 s instead of 0.5 s while four
 * portraits were loading. At 256 px a portrait is 6-13 KB.
 */
import sharp from 'sharp'

/** 80 CSS px on a 3x phone screen is 240 device px. */
const SIZE = 256
/** `cumora avatar set` decodes whatever image an agent points at (up to 8 MB
 *  of bytes) in the server process. 50 megapixels still takes a 48 MP phone
 *  photo; sharp's own default is 268. */
const MAX_INPUT_PIXELS = 50_000_000

/** The image as a square WebP portrait: EXIF orientation applied, centre
 *  cropped (avatars are drawn as circles), the first frame of an animation.
 *  Rejects input libvips cannot read or that has more pixels than the cap. */
export async function portraitWebp(image: Buffer): Promise<Buffer> {
  return sharp(image, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize(SIZE, SIZE, { fit: 'cover' }).webp({ quality: 80 }).toBuffer()
}
