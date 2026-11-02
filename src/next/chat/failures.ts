/**
 * Engine-failure notices in the transcript (MessageList FailureLine). The
 * computer's daemon posts one `byoa_engine_failed` notice per failed turn
 * (server/src/agents/computer/daemon.ts publishEngineFailure), so an outage
 * repeats it every half hour: buildItems draws one agent's failures in a row
 * as one line, which says what went wrong in the error's own words and opens
 * to every failure's text. Free of browser imports, so tests run it in node.
 */
import type { Message } from '@/types'

/** A bare error category: one lowercase word or snake_case name. Notices
 *  posted before server/src/fork/engineNotice.ts carry one per Claude Code
 *  retry ("unknown", "server_error"); the server leaves them out of new ones
 *  by the same rule. */
const CATEGORY = /^[a-z]+(?:_[a-z]+)*$/
/** The notice's opening up to the engine's exit: "<agent> could not run on
 *  local claude: local claude failed (exit 1): ". */
const EXIT = /^[^\n]*?\bfailed \(exit -?\d+\): /

/** The text of an engine-failure notice, or null for any other message. */
export function failureText(m: Message): string | null {
  // Most system rows are other notices and membership lines: skip the parse for them.
  if (m.kind !== 'system' || !m.body.includes('"byoa_engine_failed"')) return null
  try {
    const p = JSON.parse(m.body) as { kind?: unknown; noticeKind?: unknown; text?: unknown }
    return p.kind === 'notice' && p.noticeKind === 'byoa_engine_failed' && typeof p.text === 'string' ? p.text : null
  } catch {
    return null
  }
}

/** The notice without bare categories or lines it already showed. The exit
 *  prefix joins the first line that is left. */
export function failureDetail(text: string): string {
  const prefix = EXIT.exec(text)?.[0] ?? ''
  const seen = new Set<string>()
  const lines = text.slice(prefix.length).split('\n').filter((raw) => {
    const line = raw.trim()
    if (!line || CATEGORY.test(line) || seen.has(line)) return false
    seen.add(line)
    return true
  })
  return lines.length > 0 ? prefix + lines.join('\n') : text
}

/** What went wrong, in one line: the last line of the error, without the
 *  agent and exit prefix, and without the hint the daemon ends every notice
 *  with. An error that is a JSON body reads as its message. */
export function failureReason(text: string): string {
  const lines = failureDetail(text).split('\n').filter((l) => l.trim())
  if (lines.length > 1) lines.pop()
  const last = (lines[lines.length - 1] ?? '').replace(EXIT, '').trim()
  // A provider's JSON error, often cut off by the daemon's length cap, so read the field, not the document.
  return (last.startsWith('{') && /"message":"([^"\\]+)"/.exec(last)?.[1]) || last
}
