/**
 * The engine error a person reads in a `byoa_engine_failed` notice
 * (computer/daemon.ts publishEngineFailure).
 *
 * The daemon's error string also feeds its classifiers (rate limit, operator
 * fix, session reset), and Claude Code's error categories in it are signals
 * for them: every `api_retry` event and the CLI's own error message carry
 * `error: "rate_limit" | "overloaded" | "server_error" | "unknown" | ...`,
 * which engineDiagnosticText keeps one per line. In a notice they are noise:
 * one Connection refused outage printed "unknown" ten times and
 * "server_error" once above the actual error. So only the notice drops them.
 *
 * src/next/chat/failures.ts applies the same rule to notices posted before
 * this. The server image has no src/ and the web build has no server/, so
 * each keeps a copy, and server/src/__tests__/fork-engine-notice.test.ts pins
 * the two together.
 */

import { createHash } from 'node:crypto'

/** How long one engine failure stays a single notice (dedupeTtlSec). */
export const NOTICE_DEDUPE_SEC = 900

/** The dedupe key of an engine-failure notice. The runtime also makes the
 *  notice's client_id from it (runtime/inproc-client.ts postSystemNotice) and
 *  hands that id out again once the window lapses, while the web app takes a
 *  new message carrying a client_id it holds as the same message and drops the
 *  older one. So every window gets a key of its own: within one, the same
 *  error posts once, and an outage's failures half an hour apart stay apart. */
export function noticeDedupeKey(agentId: string, conversationId: string, detail: string, now = Date.now()): string {
  const error = createHash('sha1').update(detail).digest('hex').slice(0, 12)
  return `byoa_engine_failed:${agentId}:${conversationId}:${error}:${Math.floor(now / (NOTICE_DEDUPE_SEC * 1000))}`
}

/** An error category Claude Code puts on each retry and on its own error
 *  message, alone on a line (the names its api_retry events use). Only these:
 *  any other one-word line, such as "killed" or "timeout", is the error itself. */
const CATEGORY = /^(?:unknown|rate_limit|overloaded|server_error|authentication_failed|cloud_credential_error)$/
/** The error's opening up to the engine's exit: "local claude failed (exit 1): ". */
const EXIT = /^[^\n]*?\bfailed \(exit -?\d+\): /

/** `error` without lines that are a bare error category or that it already
 *  showed. The exit prefix stays and joins the first line that is left. An
 *  error made only of such lines comes back as it was. */
export function noticeDetail(error: string): string {
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
