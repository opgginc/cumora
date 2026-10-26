import type { Computer, Participant } from '@/types'

/**
 * A browser and T3 Code threads exist only for an active agent on a computer
 * of its own. A Cumora Cloud agent has neither, even in a paid workspace where
 * its `computerId` names the workspace's cloud host (`cloud-<company>`), so
 * the host's kind decides, and an unknown host shows nothing. No React here,
 * so tests call it directly; `useSeesWork` in shared.tsx adds the role.
 */
export const hasWork = (p: Participant, host: Computer | undefined): boolean =>
  p.kind === 'agent' && host !== undefined && noWorkReason(p, host, true) === null

/** Why the viewer gets no screen of an agent, the rules above plus the viewer's role:
 *  off-boarded, a Cumora Cloud agent, or a viewer the routes refuse. Null
 *  when the screen will show, or while the host is not known yet. */
export function noWorkReason(p: Participant, host: Computer | undefined, admin: boolean): 'departed' | 'cloud' | 'locked' | null {
  if (p.departedAt) return 'departed'
  if (!p.computerId || host?.kind === 'cloud') return 'cloud'
  return admin ? null : 'locked'
}
