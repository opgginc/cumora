import type { ConversationKind } from '@/types'

/**
 * The agent the room panel's header names in place of the room, from the
 * room's agents at work (`useRoomAgents(c).live`). A 1:1 room with an agent is
 * that agent, so its header follows it while it works. Any other room names
 * itself: the agent drawer (AgentDrawer.tsx) draws the same header for one
 * agent, and opens only when someone asks for it.
 */
export function headerAgent<P>(kind: ConversationKind, live: readonly P[]): P | undefined {
  return kind === 'direct' ? live[0] : undefined
}
