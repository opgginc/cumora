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

/** A bare error category, one per Claude Code retry: one lowercase word or snake_case name. */
const CATEGORY = /^[a-z]+(?:_[a-z]+)*$/
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
