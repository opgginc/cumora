/**
 * The avatar part of the agent editor (UI Buffet concept 8, "Look Studio"): a
 * portrait or an animated bloub, shown where people meet it (a message, a
 * member chip, a mention, beside the other agents) at the sizes it is drawn
 * there. The classic AgentEditor draws it in place of its colour and portrait
 * fields, on its own portrait state, and saves the bloub after the profile, so
 * the editor's one Save keeps both.
 *
 * The bloub's face is not picked: it is the face of the agent's latest message
 * (server/src/fork/mood.ts). The stage's moments play one instead. Its
 * accessories are picked like a shape, any number at once.
 */
import { useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { AgentEditor, PALETTE as BACKGROUNDS, type AvatarSlot, type PortraitState } from '@/components/AgentEditor'
import { useParticipants } from '@/stores/participants'
import type { Participant } from '@/types'
import { ACCESSORIES } from '../../bloub/accessories'
import { BloubAvatar, BloubStill, inkProps, PALETTE } from '../../bloub/BloubAvatar'
import { stage, unstage } from '../../bloub/director'
import type { ExpressionId } from '../../bloub/engine/expressions'
import { SHAPES } from '../../bloub/engine/skins'
import { useBloubLooks, type BloubLook, type BloubPick } from '../../bloub/looks'
import type { Mode } from '../../bloub/program'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { Avatar } from '../../ui/Avatar'
import { ISpark } from '../../ui/icons'
import { Segmented, Spinner } from '../../ui/primitives'

/** The bloub the owner changed. An unset field keeps what the agent has. */
interface Draft { animated?: boolean; pick?: BloubPick }

/** What a moment plays: the mode, whether a message was just posted, and the face it leaves. */
const PLAYS = {
  idle: { mode: 'idle', posted: false, face: 'neutre' },
  thinking: { mode: 'thinking', posted: false, face: 'neutre' },
  working: { mode: 'working', posted: false, face: 'neutre' },
  posted: { mode: 'idle', posted: true, face: 'neutre' },
  happy: { mode: 'idle', posted: true, face: 'heureux' },
  sad: { mode: 'idle', posted: true, face: 'triste' },
} satisfies Record<string, { mode: Mode; posted: boolean; face: ExpressionId }>
type Moment = keyof typeof PLAYS
/** Other agents beside the draft: enough to compare, few enough for a phone. */
const LINEUP = 4

const oneOf = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!

/** A first look: any shape, in a colour no other agent wears while one is left. */
function randomLook(taken: ReadonlySet<string>): BloubPick {
  const free = PALETTE.filter((c) => !taken.has(c.id))
  return { shape: oneOf(SHAPES).id, color: oneOf(free.length > 0 ? free : PALETTE).id, accessories: [] }
}

/** The colours the bloubs of the other active agents wear. */
function takenColors(byId: Record<string, Participant>, looks: Record<string, BloubLook>, agentId: string | undefined): Set<string> {
  return new Set(Object.values(byId).flatMap((p) =>
    (p.kind === 'agent' && !p.departedAt && p.id !== agentId && looks[p.id] ? [looks[p.id].color] : [])))
}

/** The classic editor with the Look Studio in place of its avatar fields. Key
 *  it by the agent, so a draft never carries over to another one. A new agent
 *  starts Animated, with the first look a choice of Animated would pick. */
export function LookEditor({ agent, onClose, onSaved }: { agent: Participant | null; onClose: () => void; onSaved?: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => (agent ? {} : {
    animated: true,
    pick: randomLook(takenColors(useParticipants.getState().byId, useBloubLooks.getState().byId, undefined)),
  }))
  const avatar: AvatarSlot = {
    render: (portrait) => <LookStudio agent={agent} portrait={portrait} draft={draft} setDraft={setDraft} />,
    // Both writes are idempotent, so an unchanged pick is simply written again.
    save: async (agentId) => {
      const { save } = useBloubLooks.getState()
      if (draft.animated === false) await save(agentId, null)
      else if (draft.pick) await save(agentId, draft.pick)
    },
  }
  return <AgentEditor agent={agent} onClose={onClose} onSaved={onSaved} avatar={avatar} />
}

function Choice({ label, on, dim = false, onPick, children }: {
  label: string
  on: boolean
  dim?: boolean
  onPick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" className="nx-look__choice" aria-pressed={on} data-dim={dim || undefined} aria-label={label} title={label} onClick={onPick}>
      {children}
    </button>
  )
}

function Choices({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="nx-look__group">
      <span className="nx-look__label">{label}</span>
      <div className="nx-look__choices" role="group" aria-label={label}>{children}</div>
      {hint && <span className="nx-look__note">{hint}</span>}
    </div>
  )
}

function LookStudio({ agent, portrait, draft, setDraft }: {
  agent: Participant | null
  portrait: PortraitState
  draft: Draft
  setDraft: Dispatch<SetStateAction<Draft>>
}) {
  const nt = useNT()
  const stageId = `look:${agent?.id ?? 'new'}`
  const saved = useBloubLooks((s) => (agent ? s.byId[agent.id] : undefined))
  const looks = useBloubLooks((s) => s.byId)
  const byId = useParticipants((s) => s.byId)
  const [moment, setMoment] = useState<Moment | null>(null)
  useEffect(() => () => unstage(stageId), [stageId])

  const name = agent?.name ?? nt('agents.newAgent')
  const animated = draft.animated ?? saved !== undefined
  const pick = draft.pick ?? (saved ? { shape: saved.shape, color: saved.color, accessories: saved.accessories } : undefined)
  const face = moment ? PLAYS[moment].face : saved?.expression ?? 'neutre'
  const look = useMemo<BloubLook | null>(
    () => (pick ? { shape: pick.shape, color: pick.color, expression: face, accessories: pick.accessories } : null),
    [pick?.shape, pick?.color, pick?.accessories, face],
  )

  // The other agents, those wearing a bloub first, since only those can look alike.
  const others = useMemo(() => Object.values(byId)
    .filter((p) => p.kind === 'agent' && !p.departedAt && p.id !== agent?.id)
    .sort((a, b) => Number(Boolean(looks[b.id])) - Number(Boolean(looks[a.id])) || a.name.localeCompare(b.name)),
  [byId, looks, agent?.id])
  const taken = useMemo(() => takenColors(byId, looks, agent?.id), [byId, looks, agent?.id])
  const twin = animated && pick ? others.find((p) => looks[p.id]?.color === pick.color) : undefined
  // Accessories tell two bloubs of one shape and colour apart; one this build
  // does not draw does not.
  const worn = (accessories: readonly string[]) => accessories.filter((id) => (ACCESSORIES as readonly string[]).includes(id)).sort().join(' ')
  const same = twin && pick && looks[twin.id].shape === pick.shape && worn(looks[twin.id].accessories) === worn(pick.accessories)
  const warning = twin ? nt(same ? 'agents.lookSame' : 'agents.lookSameColor', { name: twin.name }) : null

  // The portrait as it would be saved, drawn under the stage's own id so the
  // agent's saved bloub does not stand in for it.
  const asPortrait: Participant = {
    ...(agent ?? { kind: 'agent' as const, status: 'avail' as const }),
    id: stageId,
    name,
    initial: name.charAt(0).toUpperCase(),
    avatarBg: portrait.avatarBg,
    avatarUrl: portrait.avatarUrl,
  }
  const drawn = (size: number) => (animated && look
    ? <BloubAvatar agentId={stageId} look={look} size={size} />
    : <Avatar p={asPortrait} size={size} />)

  const choose = (key: 'portrait' | 'animated') => {
    // The first look is random, in a colour no other agent wears while one is left.
    if (key === 'animated') setDraft((d) => ({ ...d, animated: true, pick: d.pick ?? pick ?? randomLook(taken) }))
    else setDraft((d) => ({ ...d, animated: false }))
  }
  const play = (m: Moment) => {
    setMoment(m)
    stage(stageId, PLAYS[m].mode, PLAYS[m].posted)
  }

  return (
    <section className="nx-look" aria-label={nt('agents.look')}>
      <span className="nx-look__label">{nt('agents.look')}</span>
      <div className="nx-look__body">
        <div className="nx-look__stage" aria-hidden>
          <div className="nx-look__msg">
            {drawn(28)}
            <div className="nx-look__msg-text">
              <span><b>{name}</b> <span className="nx-look__time nx-mono">{nt('agents.lookNow')}</span></span>
              <span>{nt('agents.lookSample')}</span>
            </div>
          </div>
          <div className="nx-look__pills">
            <span className="nx-look__chip">{drawn(18)}{name}</span>
            <span className="nx-look__mention">{drawn(16)}@{name}</span>
          </div>
          <div className="nx-look__lineup">
            {others.slice(0, LINEUP).map((p) => <Avatar key={p.id} p={p} size={32} />)}
            <span className="nx-look__me">{drawn(32)}</span>
          </div>
          {warning && <p className="nx-look__warn">{warning}</p>}
        </div>
        <div className="nx-look__controls">
          <Segmented
            label={nt('agents.look')}
            value={animated ? 'animated' : 'portrait'}
            onChange={choose}
            items={[{ key: 'portrait', label: nt('agents.lookPortrait') }, { key: 'animated', label: nt('agents.lookAnimated') }]}
          />
          {animated && pick ? (
            <>
              <Choices label={nt('agents.bloubShape')}>
                {SHAPES.map(({ id }) => (
                  <Choice key={id} label={nt(`agents.bloub.shape.${id}`)} on={pick.shape === id} onPick={() => setDraft((d) => ({ ...d, pick: { ...pick, shape: id } }))}>
                    <BloubStill look={{ shape: id, color: pick.color, expression: 'neutre', accessories: pick.accessories }} size={22} />
                  </Choice>
                ))}
              </Choices>
              <Choices label={nt('agents.bloubColor')} hint={taken.size > 0 ? nt('agents.lookTaken') : undefined}>
                {PALETTE.map(({ id }) => (
                  <Choice key={id} label={nt(`agents.bloub.color.${id}`)} on={pick.color === id} dim={taken.has(id)} onPick={() => setDraft((d) => ({ ...d, pick: { ...pick, color: id } }))}>
                    <span className="nx-look__swatch nx-ink" {...inkProps(id)} />
                  </Choice>
                ))}
              </Choices>
              <div className="nx-look__group">
                <span className="nx-look__label">{nt('agents.bloubAccessories')}</span>
                <div className="nx-look__toggles" role="group" aria-label={nt('agents.bloubAccessories')}>
                  {ACCESSORIES.map((id) => {
                    const on = pick.accessories.includes(id)
                    const accessories = on ? pick.accessories.filter((worn) => worn !== id) : [...pick.accessories, id]
                    return (
                      <button
                        key={id}
                        type="button"
                        className="nx-btn nx-btn--sm nx-btn--outline nx-look__toggle"
                        aria-pressed={on}
                        onClick={() => setDraft((d) => ({ ...d, pick: { ...pick, accessories } }))}
                      >
                        {nt(`agents.bloub.accessory.${id}`)}
                      </button>
                    )
                  })}
                </div>
              </div>
              <p className="nx-look__note">{nt('agents.lookFace', { name })} {nt('agents.lookPortraitStays')}</p>
            </>
          ) : (
            <>
              {agent ? (
                <div className="nx-look__row">
                  <button
                    type="button"
                    className="nx-btn nx-btn--outline nx-btn--sm"
                    disabled={portrait.generating}
                    aria-busy={portrait.generating}
                    onClick={async () => haptic((await portrait.generate()) ? 'success' : 'error')}
                  >
                    {portrait.generating ? <Spinner /> : <ISpark />}
                    {portrait.avatarUrl ? nt('agents.portraitAgain') : nt('agents.portraitPaint')}
                  </button>
                  {portrait.avatarUrl && !portrait.generating && (
                    <button type="button" className="nx-btn nx-btn--sm" onClick={() => portrait.setAvatarUrl(null)}>
                      {nt('agents.portraitClear')}
                    </button>
                  )}
                </div>
              ) : (
                <p className="nx-look__note">{nt('agents.portraitAfterHire')}</p>
              )}
              {portrait.generating && <p className="nx-look__note">{nt('agents.portraitPainting', { name })}</p>}
              <Choices label={nt('agents.portraitBackground')}>
                {BACKGROUNDS.map((c) => (
                  <Choice key={c} label={c} on={portrait.avatarBg === c} onPick={() => portrait.setAvatarBg(c)}>
                    <span className="nx-look__swatch" style={{ background: c }} />
                  </Choice>
                ))}
              </Choices>
            </>
          )}
        </div>
      </div>
      {animated && look && (
        <div className="nx-look__group">
          <span className="nx-look__label">{nt('agents.lookMoments')}</span>
          <div className="nx-look__moments" role="group" aria-label={nt('agents.lookMoments')}>
            {(Object.keys(PLAYS) as Moment[]).map((m) => (
              <button key={m} type="button" className="nx-btn nx-btn--sm nx-btn--outline nx-look__moment" aria-pressed={moment === m} onClick={() => play(m)}>
                {nt(`agents.moment.${m}`)}
              </button>
            ))}
          </div>
        </div>
      )}
      {portrait.error && <p className="nx-agents-error" role="alert">{nt('agents.portraitFailed', { error: portrait.error })}</p>}
    </section>
  )
}
