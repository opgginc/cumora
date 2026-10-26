/** Helpers and small pieces shared by the agents list, profile and
 *  dialogs, and by the agent menu and drawer outside this section. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useMe } from '@/stores/auth'
import { useComputers } from '@/stores/computers'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { Computer, EngineId, Participant, Status } from '@/types'
import { useNT } from '../../i18n'
import { href, navigate, withRoute, type Route } from '../../router'
import { elapsed } from '../../format'
import { useAdmin, useNow } from '../../hooks'
import { Segmented, type SegItem } from '../../ui/primitives'
import { hasWork, noWorkReason } from './hasWork'
// Here rather than in index.tsx: the agent menu and drawer draw these parts
// in chats before the section's own chunk ever loads.
import './agents.css'

/** Status as the team sees it. The server's status, unless the agent was
 *  off-boarded or its own computer is offline: then nothing it last reported
 *  is current (the same rule as `usePresence` in ui/Avatar). */
type AgentState = Status | 'offline' | 'departed'

export function agentState(p: Participant, host: Computer | undefined): AgentState {
  if (p.departedAt) return 'departed'
  if (host && host.kind !== 'cloud' && host.status !== 'online') return 'offline'
  return p.status
}

/** The computer an agent runs on, once the computers have loaded. */
export const useHost = (p: Participant | undefined): Computer | undefined =>
  useComputers((s) => (p?.computerId ? s.byId[p.computerId] : undefined))

/** The viewer sees the agent's browser and T3 Code threads: they own or
 *  administer the workspace (the routes answer no one else), and the agent
 *  has them (`hasWork`). The menu, drawer and page all ask this. */
export function useSeesWork(p: Participant | undefined): boolean {
  const admin = useAdmin()
  const host = useHost(p)
  return admin && p !== undefined && hasWork(p, host)
}

/** The computers are still loading for a viewer who may see the agent's
 *  work: the agent's page and drawer wait, rather than open on its profile
 *  and switch to its work once its host lands. The store swallows a failed
 *  load, so one quiet retry reads it back from `loaded` (as Me › Computers
 *  does), and a failure ends the wait. */
export function useHostPending(p: Participant | undefined): boolean {
  const admin = useAdmin()
  const loaded = useComputers((s) => s.loaded)
  const [failed, setFailed] = useState(false)
  // With no host to go on, null means the agent may still have a computer.
  const pending = admin && !loaded && !failed && p?.kind === 'agent' && noWorkReason(p, undefined, true) === null
  useEffect(() => {
    if (!pending) return
    void useComputers.getState().refresh().then(() => setFailed(!useComputers.getState().loaded))
  }, [pending])
  return pending
}

/** Working or thinking: the breathing ring, the shimmer and the menu's Live tag. */
export const isLive = (s: AgentState): boolean => s === 'working' || s === 'thinking'

/** Busy for the filter and the timer: live, or blocked on a person. */
export const isBusy = (s: AgentState): boolean => isLive(s) || s === 'waiting'

export type Filter = 'all' | 'working' | 'idle' | 'departed'
const FILTERS: Filter[] = ['all', 'working', 'idle', 'departed']

export function parseFilter(raw: string | null): Filter {
  return FILTERS.includes(raw as Filter) ? raw as Filter : 'all'
}

/** The roster's URL, keeping the filter the user picked. */
export function listHref(route: Route): string {
  return href({ section: 'agents', params: { filter: route.search.get('filter') } })
}

/** Hiring, editing, off-boarding and deleting change the roster and the DM list. */
export async function refreshRoster(): Promise<void> {
  await Promise.all([useParticipants.getState().refresh(), useConversations.getState().reload()])
}

export interface Team { agents: Participant[]; busy: Set<string>; former: Participant[]; humans: Participant[] }

/** The agents a filter shows: the list's rows for every filter but All. */
export function agentsFor(team: Team, filter: Filter): Participant[] {
  if (filter === 'working') return team.agents.filter((p) => team.busy.has(p.id))
  if (filter === 'idle') return team.agents.filter((p) => !team.busy.has(p.id))
  return filter === 'departed' ? team.former : team.agents
}

/** What an empty Working or Idle filter says. */
export const EMPTY_FILTER = { working: 'agents.noneWorking', idle: 'agents.noneIdle' } as const

/** Everyone the section shows: active agents (and which of them are busy),
 *  off-boarded ones, and the viewer's human teammates. */
export function useTeam(): Team {
  const me = useMe()
  const people = useParticipants(useShallow((s) => Object.values(s.byId).sort((a, b) => a.name.localeCompare(b.name))))
  const hosts = useComputers((s) => s.byId)
  return useMemo(() => {
    const out: Team = { agents: [], busy: new Set<string>(), former: [], humans: [] }
    for (const p of people) {
      if (p.kind === 'human') {
        if (p.id !== me) out.humans.push(p)
      } else if (p.departedAt) {
        out.former.push(p)
      } else {
        out.agents.push(p)
        if (isBusy(agentState(p, p.computerId ? hosts[p.computerId] : undefined))) out.busy.add(p.id)
      }
    }
    // Most recently off-boarded first, as the classic roster ordered them.
    out.former.sort((a, b) => (b.departedAt ?? '').localeCompare(a.departedAt ?? ''))
    return out
  }, [people, hosts, me])
}

/** All / Working / Idle (/ Former once someone left), with counts. */
export function FilterTabs({ route, team }: { route: Route; team: Team }) {
  const nt = useNT()
  const filter = parseFilter(route.search.get('filter'))
  const count = (n: number) => <span className="nx-agents-count nx-mono">{n}</span>
  const tabs: Array<SegItem<Filter>> = [
    { key: 'all', label: nt('agents.filter.all') },
    { key: 'working', label: nt('agents.filter.working'), badge: count(team.busy.size) },
    { key: 'idle', label: nt('agents.filter.idle'), badge: count(team.agents.length - team.busy.size) },
    // Former only exists once someone has been off-boarded.
    ...(team.former.length > 0 || filter === 'departed'
      ? [{ key: 'departed' as const, label: nt('agents.filter.departed'), badge: count(team.former.length) }]
      : []),
  ]
  return (
    <Segmented
      label={nt('agents.filters')}
      value={filter}
      items={tabs}
      onChange={(k) => navigate(withRoute(route, { params: { filter: k === 'all' ? null : k } }), { replace: true })}
    />
  )
}

/** Query params of the dialogs this section opens. */
export const DIALOG_PARAMS = ['new', 'edit', 'offboard', 'purge'] as const
export const NO_DIALOG = { new: null, edit: null, offboard: null, purge: null }

/** The current screen with one dialog open (and no other). */
export function dialogHref(route: Route, dialog: typeof DIALOG_PARAMS[number]): string {
  return withRoute(route, { params: { ...NO_DIALOG, [dialog]: '1' } })
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Engine an agent runs on, by AgentEditor's rules: Cumora Cloud is the managed
 * engine; a computer's agent follows that computer's first engine unless it
 * pinned another (a provider profile pins Claude Code). `null` while the
 * agent's computer is not loaded, so the UI never guesses "cloud".
 */
export function engineOf(p: Participant, host: Computer | undefined): { id: EngineId; inherited: boolean } | null {
  if (!host) return p.computerId ? null : { id: 'managed', inherited: false }
  if (host.kind === 'cloud') return { id: 'managed', inherited: false }
  const advertised = host.availableEngines
  const pinned: EngineId | null = p.providerProfile ? 'claude' : p.engine && p.engine !== 'managed' ? p.engine : null
  // Official production omits `engineInherit`; there an engine equal to the
  // computer default counts as following it, as in the editor.
  const inherited = !pinned || p.engineInherit === true
    || (p.engineInherit === undefined && !p.providerProfile && pinned === advertised[0])
  const id = inherited ? advertised[0] ?? pinned : pinned
  return id ? { id, inherited } : null
}

/** The model an unpinned agent gets: its provider profile's, else the
 *  computer's per-engine default, else what the engine's CLI reports. */
export function defaultModelOf(p: Participant, host: Computer | undefined, engine: EngineId): string | null {
  if (!host) return null
  const detected = host.detectedEngines?.find((e) => e.id === engine)
  if (p.providerProfile) return detected?.providerProfiles?.find((x) => x.id === p.providerProfile)?.model ?? null
  return host.engineDefaults?.[engine]?.model ?? detected?.modelCatalog?.defaultModel ?? null
}

export function providerLabel(p: Participant, host: Computer | undefined): string | null {
  if (!p.providerProfile) return null
  const profiles = host?.detectedEngines?.find((e) => e.id === 'claude')?.providerProfiles
  return profiles?.find((x) => x.id === p.providerProfile)?.label ?? p.providerProfile
}

export interface Roster {
  state: 'loading' | 'error' | 'ready'
  retry: () => void
}

/** First load of the roster. The participants store logs fetch errors instead
 *  of keeping them, so a failure shows as "still not loaded after a fetch". */
export function useRoster(): Roster {
  const loaded = useParticipants((s) => s.loaded)
  const [failed, setFailed] = useState(false)
  const retry = useCallback(() => {
    setFailed(false)
    void useParticipants.getState().refresh().then(() => setFailed(!useParticipants.getState().loaded))
  }, [])
  useEffect(() => {
    if (!useParticipants.getState().loaded) retry()
  }, [retry])
  return { state: loaded ? 'ready' : failed ? 'error' : 'loading', retry }
}

export function LoadError({ onRetry }: { onRetry: () => void }) {
  const nt = useNT()
  return (
    <div className="nx-empty" role="alert">
      <b>{nt('agents.loadFailed')}</b>
      <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={onRetry}>{nt('agents.retry')}</button>
    </div>
  )
}

/** "Working 2:31": the state, with a 1 Hz timer from `statusUpdatedAt` while
 *  the agent is busy. Only busy agents subscribe to the shared clock. */
export function StateText({ p, state }: { p: Participant; state: AgentState }) {
  const nt = useNT()
  const locale = useLocale()
  const ticking = isBusy(state)
  // The shared clock drives the 1 Hz re-render; the time itself is read here
  // because the clock's last tick can be stale until its first new one.
  useNow(ticking)
  const now = Date.now()
  const since = p.statusUpdatedAt ? Date.parse(p.statusUpdatedAt) : Number.NaN
  const label = state === 'departed' && p.departedAt
    ? nt('agents.departedOn', { date: new Date(p.departedAt).toLocaleDateString(locale, { dateStyle: 'medium' }) })
    : nt(`agents.state.${state}`)
  return (
    <span className="nx-agents-state" data-s={state}>
      <span className={isLive(state) ? 'nx-shimmer' : undefined}>{label}</span>
      {ticking && Number.isFinite(since) && <span className="nx-mono">{elapsed(now - since)}</span>}
    </span>
  )
}
