/**
 * The two blocks every wake prompt carries for reference: the agent's memory
 * index and its team (agents/computer/daemon.ts). Every wake lands in the same
 * long-lived engine session, so sending them unchanged each time left dozens
 * of identical copies in the context (30-59% of it for the agents on one
 * instance, 2026-11-04), all of it read again on every model call.
 *
 * A block goes out whole only when the session may lack a recent copy: the
 * session starts fresh, the text changed, the context shrank since the copy
 * was read (a compaction rewrote or dropped it), or the copy sits
 * REFRESH_TOKENS or more back, where the model attends to it less. Otherwise
 * the prompt says in one line that it is unchanged.
 *
 * In memory only: after a daemon restart both go whole on the next wake.
 * Kept free of server imports: the daemon bundle includes it.
 */

/** How far back the latest whole copy may sit, in tokens of the session's context. */
export const REFRESH_TOKENS = 30_000

/** Names the files too: a built-in compaction at the start of the turn can
 *  summarize the earlier copy away before the next wake sends it whole. */
export const MEMORY_UNCHANGED = 'Your memory index (global `memory/MEMORY.md` + current project, if any): unchanged since it was last shown above.'
export const TEAM_UNCHANGED = 'Your team: unchanged since it was last shown above.'

export type WakeBlockTexts = { memory: string; team: string }
/** Per block: the text to send whole, '' for no block, or null for the one line. */
export type WakeBlockPick = { memory: string | null; team: string | null }

type Name = keyof WakeBlockTexts
const NAMES: readonly Name[] = ['memory', 'team']

/** A model call's size: everything it read, cached or not. */
export function contextOf(usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): number {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}

export class WakeBlocks {
  /** Each block as the session last read it whole, and the context it read it at. */
  private shown = new Map<Name, { text: string; at: number }>()
  /** Blocks the prompt being sent carries whole. They count as read at the
   *  turn's first model call: a stop or a failed spawn before it sends nothing. */
  private pending: Array<{ name: Name; text: string }> = []
  /** The size of the session's latest model call. */
  private context: number | null = null

  /** Called for each attempt of a turn, since a resume that fails is retried
   *  in a fresh session (`resume` null), which has read nothing. */
  pick(resume: string | null, texts: WakeBlockTexts): WakeBlockPick {
    if (resume === null) {
      this.shown.clear()
      this.context = null
    }
    this.pending = []
    const out: WakeBlockPick = { memory: '', team: '' }
    for (const name of NAMES) {
      const text = texts[name]
      if (!text) continue
      const last = this.shown.get(name)
      const now = this.context
      if (last && last.text === text && now !== null && now >= last.at && now - last.at < REFRESH_TOKENS) {
        out[name] = null
        continue
      }
      out[name] = text
      this.pending.push({ name, text })
    }
    return out
  }

  /** One model call of the agent's own conversation, not a subagent's. */
  onCall(contextTokens: number): void {
    for (const { name, text } of this.pending) this.shown.set(name, { text, at: contextTokens })
    this.pending = []
    this.context = contextTokens
  }
}
