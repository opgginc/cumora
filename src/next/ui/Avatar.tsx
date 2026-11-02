import { memo, type CSSProperties } from 'react'
import type { Participant } from '@/types'
import { AVATAR_IMG_LOADING, useAvatarImg } from '@/lib/avatarCache'
import { useAuth } from '@/stores/auth'
import { useComputers } from '@/stores/computers'
import { BloubAvatar } from '../bloub/BloubAvatar'
import { useBloubLooks } from '../bloub/looks'

export type Presence = 'avail' | 'live' | 'waiting' | 'off'

/** One presence vocabulary for every avatar: working/thinking agents are
 *  "live" (breathing ring), idle online is a green dot, waiting is amber,
 *  anything else draws nothing. A BYOA agent whose computer is offline is
 *  offline regardless of its last reported status. */
export function usePresence(p: Participant | undefined): Presence {
  const selfId = useAuth((s) => s.user?.id)
  const host = useComputers((s) => (p?.computerId ? s.byId[p.computerId] : undefined))
  if (!p) return 'off'
  if (p.id === selfId && p.kind === 'human') return 'avail'
  if (host && host.kind !== 'cloud' && host.status !== 'online') return 'off'
  if (p.status === 'working' || p.status === 'thinking') return 'live'
  if (p.status === 'waiting') return 'waiting'
  if (p.status === 'avail') return 'avail'
  return 'off'
}

interface Props {
  p: Participant
  size?: number
  /** Show the presence dot / live ring. */
  presence?: boolean
  className?: string
}

function AvatarImpl({ p, size = 32, presence = false, className }: Props) {
  const look = useBloubLooks((s) => (p.kind === 'agent' ? s.byId[p.id] : undefined))
  // Until the looks load, an agent may still turn out to wear a bloub: its
  // portrait would be a download nobody sees, on the connection the room's
  // messages need. It waits as a blank disc that still shows its presence.
  const unknown = useBloubLooks((s) => p.kind === 'agent' && !s.ready)
  // A bloub plays the agent's state itself, so it carries no presence dot or ring.
  if (look) return <BloubAvatar agentId={p.id} look={look} size={size} className={className} />
  return <Portrait p={p} size={size} presence={presence} className={className} blank={unknown} />
}

function Portrait({ p, size = 32, presence = false, className, blank = false }: Props & { blank?: boolean }) {
  // The <img> is a portrait's one download, kept by the browser's cache: an
  // agent's new portrait gets a new storage key, so its URL changes with it.
  const src = blank ? null : (p.avatarUrl ?? null)
  const { showImg, imgKey, onError } = useAvatarImg(src)
  const state = usePresence(presence ? p : undefined)
  const dot = Math.max(8, Math.round(size * 0.26))
  const style: CSSProperties = {
    width: size,
    height: size,
    background: showImg || blank ? 'var(--muted)' : p.avatarBg,
    fontSize: Math.max(11, Math.round(size * 0.4)),
  }
  return (
    <span className={className ? `nx-avatar ${className}` : 'nx-avatar'} style={style} aria-hidden>
      {showImg ? (
        <img key={imgKey} src={src ?? ''} alt="" loading={AVATAR_IMG_LOADING} decoding="async" onError={onError} draggable={false} />
      ) : (
        !blank && p.initial
      )}
      {presence && state === 'live' && <span className="nx-avatar__live" />}
      {presence && (state === 'avail' || state === 'waiting') && (
        <span className="nx-avatar__dot" data-s={state} style={{ width: dot, height: dot }} />
      )}
    </span>
  )
}

export const Avatar = memo(AvatarImpl)

export function AvatarStack({ ps, size = 24, max = 3 }: { ps: Participant[]; size?: number; max?: number }) {
  const shown = ps.slice(0, max)
  return (
    <span className="nx-avatar-stack">
      {shown.map((p) => <Avatar key={p.id} p={p} size={size} />)}
    </span>
  )
}
