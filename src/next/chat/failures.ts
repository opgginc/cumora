/**
 * Engine-failure notices in the transcript (MessageList FailureLine). The
 * computer's daemon posts one `byoa_engine_failed` notice per failed turn
 * (server/src/agents/computer/daemon.ts publishEngineFailure), so an outage
 * repeats it every half hour: buildItems draws one agent's failures in a row
 * as one line, which says what went wrong in the error's own words and opens
 * to every failure's text. Free of browser imports, so tests run it in node.
 */
// Relative, not '@/types': server/src/__tests__/fork-engine-notice.test.ts
// type-checks this file under the server's tsconfig, which has no '@' alias.
import type { Message } from '../../types'

/** How publishEngineFailure opens every notice it posts: "<agent> could not
 *  run on local <engine>: <error>", then one line of hint. A Codex session
 *  that could not be migrated posts the same kind to say its agent is paused,
 *  and keeps its own row. */
const RUN_FAILED = /^[^\n]* could not run on local \S+: /

// The rule below is server/src/fork/engineNotice.ts noticeDetail, which leaves
// these lines out of new notices. The server image has no src/ and this build
// has no server/, so each keeps a copy, and
// server/src/__tests__/fork-engine-notice.test.ts pins the two together.
/** A bare error category, one per Claude Code retry: one lowercase word or snake_case name. */
const CATEGORY = /^[a-z]+(?:_[a-z]+)*$/
/** The error's opening up to the engine's exit: "… failed (exit 1): ". */
const EXIT = /^[^\n]*?\bfailed \(exit -?\d+\): /

function errorDetail(error: string): string {
  const prefix = EXIT.exec(error)?.[0] ?? ''
  const seen = new Set<string>()
  const lines = error.slice(prefix.length).split('\n').filter((raw) => {
    const line = raw.trim()
    if (!line || CATEGORY.test(line) || seen.has(line)) return false
    seen.add(line)
    return true
  })
  return lines.length > 0 ? prefix + lines.join('\n') : error
}

/** The text of an engine-failure notice, or null for any other message. */
export function failureText(m: Message): string | null {
  // Most system rows are other notices and membership lines: skip the parse for them.
  if (m.kind !== 'system' || !m.body.includes('"byoa_engine_failed"')) return null
  try {
    const p = JSON.parse(m.body) as { kind?: unknown; noticeKind?: unknown; text?: unknown }
    const ok = p.kind === 'notice' && p.noticeKind === 'byoa_engine_failed' && typeof p.text === 'string'
    return ok && RUN_FAILED.test(p.text as string) ? (p.text as string) : null
  } catch {
    return null
  }
}

/** The notice's error, without bare categories or lines it already showed, and its hint. */
function parts(text: string): { error: string; hint: string | null } {
  const lines = text.split('\n')
  const hint = lines.length > 1 ? (lines.pop() as string) : null
  return { error: errorDetail(lines.join('\n')), hint }
}

/** The notice as a person reads it once the line is opened. */
export function failureDetail(text: string): string {
  const { error, hint } = parts(text)
  return hint === null ? error : `${error}\n${hint}`
}

/** What went wrong, in one line: the error's last line, without the agent and
 *  exit prefix. An error that is a JSON body reads as its message. */
export function failureReason(text: string): string {
  const lines = parts(text).error.split('\n').filter((l) => l.trim())
  const last = (lines[lines.length - 1] ?? '').replace(EXIT, '').trim()
  // A provider's JSON error, often cut off by the daemon's length cap, so read the field, not the document.
  return (last.startsWith('{') && /"message":"([^"\\]+)"/.exec(last)?.[1]) || last
}
