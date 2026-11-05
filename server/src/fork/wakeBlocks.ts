/**
 * The two blocks every wake prompt carries for reference: the agent's memory
 * index and its team (agents/computer/daemon.ts). Every wake lands in the same
 * long-lived engine session, so sending them unchanged each time left dozens
 * of identical copies in the context (30-59% of it for the agents on one
 * instance, 2026-11-04), all of it read again on every model call.
 *
 * A block goes out whole only when the session may lack a recent copy: the
 * session starts fresh, the text changed, the context shrank at some call
 * since the copy was read (a compaction rewrote or dropped it), or the copy
 * sits REFRESH_TOKENS or more back, where the model attends to it less.
 * Otherwise the prompt says in one line that it is unchanged.
 *
 * In memory only: after a daemon restart both go whole on the next wake.
 * Kept free of server imports: the daemon bundle includes it.
 */

/** How far back the latest whole copy may sit, in tokens of the session's context. */
export const REFRESH_TOKENS = 30_000

const MEMORY_HEADING = 'Your memory index (global `memory/MEMORY.md` + current project, if any)'

export type WakeBlockTexts = { memory: string; team: string }
/** Per block: the text to send whole, '' for no block, or null for the one line. */
export type WakeBlockPick = { memory: string | null; team: string | null }

type Name = keyof WakeBlockTexts
const NAMES: readonly Name[] = ['memory', 'team']

/** The memory block of a wake prompt. The one line names the file: a built-in
 *  compaction at the start of the turn can summarize the earlier copy away. */
export function memoryBlock(memory: string | null): string {
  if (memory === null) return `${MEMORY_HEADING}: unchanged since it was last shown above.\n\n`
  return memory ? `${MEMORY_HEADING}:\n${memory}\n\n` : ''
}

/** The team block under the prompt's own heading. The one line names the
 *  command that lists the team, for the same reason. */
export function teamBlock(team: string | null, heading: string): string {
  if (team === null) return 'Your team: unchanged since it was last shown above (`cumora participants` lists everyone).\n'
  return team ? `${heading}:\n${team}\n` : ''
}

/** The size of the agent's own context at one model call, or null when the hop
 *  does not tell it: only an exact hop (persistent Claude, Codex app-server)
 *  is one call's usage; other engines report a turn's sum or nothing, and a
 *  subagent's call or a turn's `rest` measures something else. */
export function hopContext(hop: {
  exact?: true
  sub?: string
  rest?: unknown
  usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}): number | null {
  if (!hop.exact || hop.sub || hop.rest) return null
  const { input_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 } = hop.usage
  return input_tokens + cache_read_input_tokens + cache_creation_input_tokens
}

export class WakeBlocks {
  /** Each block as the session last read it whole, and the context it read it at. */
  private shown = new Map<Name, { text: string; at: number }>()
  /** Blocks the prompt being sent carries whole. They count as read at the
   *  turn's first model call: a stop or a failed spawn before it sends nothing. */
  private pending: Array<{ name: Name; text: string }> = []
  /** The size of the session's latest model call. */
  private last = 0

  /** Called for each attempt of a turn, since a resume that fails is retried
   *  in a fresh session (`resume` null), which has read nothing. */
  pick(resume: string | null, texts: WakeBlockTexts): WakeBlockPick {
    if (resume === null) {
      this.shown.clear()
      this.last = 0
    }
    this.pending = []
    const out: WakeBlockPick = { memory: '', team: '' }
    for (const name of NAMES) {
      const text = texts[name]
      if (!text) continue
      if (this.shown.get(name)?.text === text) {
        out[name] = null
        continue
      }
      out[name] = text
      this.pending.push({ name, text })
    }
    return out
  }

  /** One model call of the agent's own conversation (hopContext). */
  onCall(contextTokens: number): void {
    // The context only shrinks when a compaction rewrites it, which can happen
    // in the middle of a turn: every earlier copy may be gone.
    if (contextTokens < this.last) this.shown.clear()
    this.last = contextTokens
    for (const { name, text } of this.pending) this.shown.set(name, { text, at: contextTokens })
    this.pending = []
    for (const [name, { at }] of this.shown) {
      if (contextTokens - at >= REFRESH_TOKENS) this.shown.delete(name)
    }
  }
}
