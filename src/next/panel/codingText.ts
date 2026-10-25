/**
 * Text the Coding tab (CodingTab.tsx) reads and writes, kept apart from the
 * components so tests reach it without a DOM (tests/coding-text.test.ts): the
 * `?t3=` key of a thread, and a T3 message's Markdown as the detail renders it.
 */

/** The thread `?t3=` names: its T3 server and its id. */
export const threadKey = (t: { server: string; threadId: string }): string => `${t.server}:${t.threadId}`

/** threadKey read back, or null. A thread id holds ':' itself (`mcp:<uuid>`)
 *  and a server name never does (server/src/fork/coding.ts T3File), so the
 *  key splits at its first ':'. */
export function parseThreadKey(key: string): { server: string; threadId: string } | null {
  const at = key.indexOf(':')
  return at > 0 && at < key.length - 1 ? { server: key.slice(0, at), threadId: key.slice(at + 1) } : null
}

// One pass, left to right, so code is taken whole before an image inside it
// is seen: a fence (``` or ~~~, three or more) runs to the same fence on a
// line of its own, or to the end of a message cut inside it; then inline
// code; then an image that is not on the web.
const PART = /(`{3,}|~{3,})[\s\S]*?(?:\n\1|$)|`[^`\n]*`|!\[([^\]]*)\]\(\s*(?!https?:\/\/)([^)\s]*)[^)]*\)/gi

/**
 * `text` with each image this app cannot load replaced by `label(name)` in
 * italics, the name being its alt text or its file name. T3 shows images from
 * the developer's own machine (`/tmp/…`); here such a path would load from this
 * app's server and leave an empty frame. Images on the web stay, and code is
 * shown as written, so the copy button's text and the screen agree there.
 */
export function loadableImages(text: string, label: (name: string) => string): string {
  return text.replace(PART, (part: string, _fence: string | undefined, alt: string | undefined, src: string | undefined) =>
    src === undefined ? part : `*${label(alt?.trim() || src.split('/').pop() || src).replace(/[\\*_[\]]/g, '\\$&')}*`)
}
