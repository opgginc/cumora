/**
 * Markdown from a T3 thread as the Coding detail (CodingTab.tsx) renders it.
 * T3 shows a reply's images from the developer's own machine (`/tmp/…`); here
 * such a path would load from this app's server and leave an empty frame, so
 * the image becomes a label. Images on the web stay, and code (fenced blocks
 * and inline spans) is shown as written, so an example of image Markdown in a
 * code block is left alone. Kept apart from the component so tests reach it
 * without a DOM (tests/coding-markdown.test.ts).
 */

// A fence runs to its closing fence, or to the end of a message cut inside it.
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/
const LOCAL_IMAGE = /!\[([^\]]*)\]\(\s*(?!https?:\/\/)([^)\s]*)[^)]*\)/gi

/** `text` with each image this app cannot load replaced by `label(name)` in
 *  italics, where the name is the image's alt text, or its file name. */
export function loadableImages(text: string, label: (name: string) => string): string {
  // split() with a capturing group puts the code between the other parts.
  return text.split(CODE).map((part, i) => (i % 2 === 1 ? part : part.replace(LOCAL_IMAGE, (_, alt: string, src: string) =>
    `*${label(alt.trim() || src.split('/').pop() || src).replace(/[\\*_[\]]/g, '\\$&')}*`))).join('')
}
