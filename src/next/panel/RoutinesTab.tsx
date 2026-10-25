/**
 * Routines = recurring agent tasks (calendar `agent_task` events) that post
 * into this room, one row per job (`routines.ts` folds the daily events an
 * agent books for "every few hours" into one). A job opens in place
 * (`?routine=`) with Run now, the "every N hours" control, its times and its
 * prompt; a time opens the event itself as a panel peek. Pausing here is the
 * same as pausing it in Calendar. Below the jobs come the room's triggers,
 * routines that fire when a pull request merges (`triggers.tsx`).
 */
import { useEffect, useMemo, useState } from 'react'
import { useCalendar } from '@/stores/calendar'
import { useParticipants } from '@/stores/participants'
import { useLocale, type Locale } from '@/lib/i18n'
import { nextOccurrenceOnOrAfter } from '@/lib/recurrence'
import type { CalendarEvent, Conversation } from '@/types'
import { clock, dateTime } from '../format'
import { haptic } from '../haptics'
import { useNT, type NT } from '../i18n'
import { getRoute, href, linkClick, useRoute, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { Spinner, Switch } from '../ui/primitives'
import { IChevronRight, IRepeat } from '../ui/icons'
import { JobBar } from './JobBar'
import { describeRepeat } from '../sections/calendar/model'
import { errText, RunNow } from '../sections/calendar/parts'
import { everyHours, familiesOf, HOUR_STEPS, isDaily, memberAt, minuteOf, planFor, postsInto, timesFor, titleFor, type Family } from './routines'
import { NewTriggerDialog, TriggerRow, TriggerView, useTriggers } from './triggers'

/** The active member that fires next, or null when every member is paused. */
function nextRun(events: CalendarEvent[]): { id: string; at: Date } | null {
  const now = new Date()
  let best: { id: string; at: Date } | null = null
  for (const e of events) {
    if (e.status !== 'active') continue
    const at = nextOccurrenceOnOrAfter(new Date(e.startAt), e.recurrence, now)
    if (at && (!best || at < best.at)) best = { id: e.id, at }
  }
  return best
}

function rhythm(hours: number, nt: NT): string {
  return hours === 24 ? nt('routines.onceADay') : hours === 1 ? nt('routines.everyHour') : nt('routines.everyHours', { n: hours })
}

function caption(f: Family, next: Date | null, nt: NT, locale: Locale): string {
  const first = f.events[0]
  const hours = everyHours(f)
  const several = f.events.length > 1
  const parts = [
    !first.recurrence ? nt('routines.once', { when: dateTime(first.startAt, locale) })
      : several && hours !== null ? rhythm(hours, nt)
        : several && isDaily(f) ? nt('routines.timesADay', { n: f.events.length })
          : `${describeRepeat(first.recurrence, nt, locale)} · ${clock(new Date(first.startAt), locale)}`,
  ]
  // A single event already says its time; a job of several names the next one.
  if (several && next) parts.push(nt('routines.next', { time: clock(next, locale) }))
  const paused = f.events.filter((e) => e.status === 'paused').length
  if (paused > 0 && paused < f.events.length) parts.push(nt('routines.paused', { n: paused }))
  return parts.join(' · ')
}

/** A row's switch (pausing or resuming every event it stands for) and
 *  chevron; a failed toggle wraps its error under the row. */
function RowEnd({ events, label }: { events: CalendarEvent[]; label: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = events.some((e) => e.status === 'active' || e.status === 'paused')
  return (
    <>
      {busy && <Spinner />}
      <Switch
        label={label}
        checked={events.some((e) => e.status === 'active')}
        disabled={busy || !live}
        onChange={async (on) => {
          setBusy(true)
          setError(null)
          try {
            await Promise.all(events
              .filter((e) => e.status === (on ? 'paused' : 'active'))
              .map((e) => useCalendar.getState().update(e.id, { status: on ? 'active' : 'paused' })))
          } catch (e) {
            setError(errText(e))
          } finally {
            setBusy(false)
          }
        }}
      />
      <IChevronRight aria-hidden />
      {error && <p className="nx-field__error nx-routine__error" role="alert">{error}</p>}
    </>
  )
}

function FamilyRow({ f, face }: { f: Family; face: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const assignee = useParticipants((s) => (face && f.events[0].assigneeId ? s.byId[f.events[0].assigneeId] : undefined))
  const next = useMemo(() => nextRun(f.events), [f.events])
  const r = getRoute()
  // A job with several times (or a daily one that could have several) opens in place; a lone event opens directly.
  const to = f.events.length > 1 || isDaily(f)
    ? withRoute(r, { params: { routine: f.id } })
    : withRoute(r, { peek: { kind: 'event', id: f.id } })
  return (
    <div className="nx-row nx-routine" data-paused={!next || undefined}>
      <a className="nx-routine__open" href={to} onClick={linkClick}>
        {assignee ? <Avatar p={assignee} size={24} /> : <IRepeat />}
        <span className="nx-row__text">
          <span className="nx-routine__title">{f.title || nt('calendar.untitled')}</span>
          <span className="nx-row__hint">{caption(f, next?.at ?? null, nt, locale)}</span>
        </span>
      </a>
      <RowEnd events={f.events} label={nt('routines.active', { title: f.title })} />
    </div>
  )
}

function TimeRow({ e, next, daily }: { e: CalendarEvent; next: boolean; daily: boolean }) {
  const nt = useNT()
  const locale = useLocale()
  const at = new Date(e.startAt)
  return (
    <div className="nx-row nx-routine" data-paused={e.status !== 'active' || undefined}>
      <a className="nx-routine__open" href={withRoute(getRoute(), { peek: { kind: 'event', id: e.id } })} onClick={linkClick}>
        <span className={daily ? 'nx-mono' : undefined}>
          {daily ? clock(at, locale) : `${describeRepeat(e.recurrence, nt, locale)} · ${clock(at, locale)}`}
        </span>
        <span className="nx-routine__state">{next ? nt('routines.nextUp') : ''}</span>
      </a>
      <RowEnd events={[e]} label={nt('routines.active', { title: e.title })} />
    </div>
  )
}

/** "Every N hours" for a daily job: pick a step, see the times it makes,
 *  apply. Times already booked stay with their history; the earliest one
 *  anchors the rest, so the job (and this view's URL) keeps its id. */
function Rhythm({ f }: { f: Family }) {
  const nt = useNT()
  const locale = useLocale()
  const current = everyHours(f)
  const [hours, setHours] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const anchor = minuteOf(f.events[0])
  const times = hours === null ? null : timesFor(anchor, hours)
  const plan = times && planFor(f, times)

  const apply = async () => {
    if (!plan) return
    setBusy(true)
    setError(null)
    const title = titleFor(f)
    const status = f.events.some((e) => e.status === 'active') ? 'active' : 'paused'
    const now = new Date()
    const cal = useCalendar.getState()
    try {
      // New times first: a failure part-way never leaves the job with fewer runs than before.
      await Promise.all(plan.add.map((m) => cal.create(memberAt(f.events[0], m, title(m), status, now))))
      await Promise.all(plan.drop.map((e) => cal.remove(e.id)))
      haptic('success')
      setHours(null)
    } catch (e) {
      haptic('error')
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nx-rows">
      <div className="nx-row">
        <span className="nx-row__text">{nt('routines.repeats')}</span>
        <select
          className="nx-input nx-job__select"
          aria-label={nt('routines.repeats')}
          value={hours ?? current ?? ''}
          disabled={busy}
          onChange={(ev) => {
            const h = Number(ev.target.value)
            setHours(h === current ? null : h)
            setError(null)
          }}
        >
          {current === null && <option value="" disabled>{nt('routines.timesADay', { n: f.events.length })}</option>}
          {HOUR_STEPS.map((h) => <option key={h} value={h}>{rhythm(h, nt)}</option>)}
        </select>
      </div>
      {times && plan && (
        <div className="nx-job__plan">
          {/* The Date constructor carries minutes past 59 into hours. */}
          <p className="nx-mono">{times.map((m) => clock(new Date(2000, 0, 1, 0, m), locale)).join('  ')}</p>
          <p className="nx-row__hint">{nt('routines.plan', { add: plan.add.length, drop: plan.drop.length })}</p>
          {error && <p className="nx-field__error" role="alert">{error}</p>}
          <div className="nx-job__actions">
            <button type="button" className="nx-btn nx-btn--sm" disabled={busy} onClick={() => setHours(null)}>{nt('common.cancel')}</button>
            <button type="button" className="nx-btn nx-btn--sm nx-btn--primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void apply()}>
              {busy && <Spinner />}{nt('routines.apply')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function JobView({ f }: { f: Family }) {
  const nt = useNT()
  const assignee = useParticipants((s) => (f.events[0].assigneeId ? s.byId[f.events[0].assigneeId] : undefined))
  const next = useMemo(() => nextRun(f.events), [f.events])
  const prompt = f.events[0].agentPrompt
  const daily = isDaily(f)
  return (
    <div className="nx-job">
      <JobBar param="routine" label={nt('routines.back')} title={f.title || nt('calendar.untitled')}>
        {/* Runs the time that is due next, or the first when all are paused. */}
        <RunNow ev={f.events.find((e) => e.id === next?.id) ?? f.events[0]} />
      </JobBar>
      {assignee && <p className="nx-job__who"><Avatar p={assignee} size={20} presence />{assignee.name}</p>}
      {daily && <Rhythm f={f} />}
      <h4 className="nx-group-label">{nt('routines.times')}</h4>
      <div className="nx-rows nx-routine-list">
        {f.events.map((e) => <TimeRow key={e.id} e={e} next={e.id === next?.id} daily={daily} />)}
      </div>
      {/* Last, so a long prompt never pushes the controls out of reach. */}
      {prompt && (
        <>
          <h4 className="nx-group-label">{nt('calendar.prompt')}</h4>
          <p className="nx-job__prompt">{prompt}</p>
        </>
      )}
    </div>
  )
}

export function RoutinesTab({ c }: { c: Conversation }) {
  const nt = useNT()
  const route = useRoute()
  const loaded = useCalendar((s) => s.loaded)
  const loading = useCalendar((s) => s.loading)
  const events = useCalendar((s) => s.events)
  useEffect(() => { if (!loaded && !loading) void useCalendar.getState().load() }, [loaded, loading])
  const routines = useMemo(
    () => events.filter((e) => e.kind === 'agent_task' && e.status !== 'cancelled' && postsInto(e, c)),
    [events, c],
  )
  const families = useMemo(() => familiesOf(routines), [routines])
  const triggers = useTriggers(c.id)
  const [adding, setAdding] = useState(false)
  if (!loaded || triggers.list === null && !triggers.error) return <div className="nx-center" aria-busy="true"><Spinner /></div>

  const openId = route.search.get('routine')
  const open = openId ? families.find((f) => f.events.some((e) => e.id === openId)) : undefined
  if (open) return <JobView key={open.id} f={open} />
  const openTrigger = triggers.list?.find((t) => t.id === route.search.get('trigger'))
  if (openTrigger) return <TriggerView key={openTrigger.id} t={openTrigger} onChanged={triggers.reload} />
  // Faces only tell jobs apart when more than one agent runs them.
  const faces = new Set([...routines.map((e) => e.assigneeId), ...(triggers.list ?? []).map((t) => t.assigneeId)]).size > 1
  const empty = families.length === 0 && (triggers.list?.length ?? 0) === 0
  return (
    <div className="nx-routines">
      {empty && <div className="nx-empty">{nt('routines.none')}</div>}
      {!empty && (
        <div className="nx-rows nx-routine-list">
          {families.map((f) => <FamilyRow key={f.id} f={f} face={faces} />)}
          {triggers.list?.map((t) => <TriggerRow key={t.id} t={t} face={faces} onChanged={triggers.reload} />)}
        </div>
      )}
      {triggers.error && <p className="nx-field__error" role="alert">{triggers.error}</p>}
      <button type="button" className="nx-btn nx-btn--outline nx-btn--block" onClick={() => setAdding(true)}>{nt('routines.trigger.new')}</button>
      <a className="nx-btn nx-btn--outline nx-btn--block" href={href({ section: 'calendar' })} onClick={linkClick}>{nt('routines.open')}</a>
      <NewTriggerDialog c={c} open={adding} onClose={() => setAdding(false)} onCreated={triggers.reload} />
    </div>
  )
}
