/**
 * Calendar math for the Next calendar. Everything here is wall-clock time in
 * the viewer's timezone: the store keeps UTC ISO strings, and the grid,
 * labels and editor prefill all speak local dates, so a traveller sees their
 * own clock. Recurrence comes from lib/recurrence, which mirrors the server
 * dispatcher, so the grid shows the same slots the scheduler fires.
 */
import type { Locale } from '@/lib/i18n'
import { nextOccurrenceOnOrAfter } from '@/lib/recurrence'
import type { CalendarEvent, RecurrenceRule } from '@/types'
import type { NT } from '../../i18n'

export type View = 'day' | 'week' | 'month' | 'agenda'
export const VIEWS: View[] = ['day', 'week', 'month', 'agenda']
/** The agenda shows this many days from its start date. */
export const AGENDA_DAYS = 30

export function parseView(raw: string | null): View | null {
  return VIEWS.includes(raw as View) ? raw as View : null
}

/* ── Local dates ────────────────────────────────────────────────────── */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Calendar days, not 24h steps, so wall time survives DST changes. */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const pad = (n: number) => String(n).padStart(2, '0')

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `YYYY-MM-DDTHH:mm`, the form the URL carries for editor prefill. */
export function wallTime(d: Date): string {
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` read as local time; null if malformed. */
export function parseLocal(s: string | null): Date | null {
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/)
  if (!m) return null
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Whole days between two local midnights (rounded: DST days are 23/25h). */
function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000)
}

/* ── Ranges ─────────────────────────────────────────────────────────── */
export interface Range {
  start: Date
  /** Exclusive. */
  end: Date
  days: Date[]
}

/** Weeks start on Sunday, like the classic calendar and the recurrence
 *  weekday numbering (0 = Sunday). */
export function rangeOf(view: View, cursor: Date): Range {
  const day = startOfDay(cursor)
  let start = day
  let count = 1
  if (view === 'week') {
    start = addDays(day, -day.getDay())
    count = 7
  } else if (view === 'agenda') {
    count = AGENDA_DAYS
  } else if (view === 'month') {
    const first = new Date(day.getFullYear(), day.getMonth(), 1)
    const daysInMonth = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate()
    start = addDays(first, -first.getDay())
    count = Math.ceil((first.getDay() + daysInMonth) / 7) * 7
  }
  const days = Array.from({ length: count }, (_, i) => addDays(start, i))
  return { start, end: addDays(start, count), days }
}

/** The cursor one page back or forward. Months keep the day, clamped. */
export function shift(view: View, cursor: Date, dir: 1 | -1): Date {
  if (view === 'month') {
    const target = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1)
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
    target.setDate(Math.min(cursor.getDate(), last))
    return target
  }
  return addDays(cursor, dir * (view === 'day' ? 1 : view === 'week' ? 7 : AGENDA_DAYS))
}

/* ── Occurrences ────────────────────────────────────────────────────── */
export interface Occ {
  ev: CalendarEvent
  start: Date
  /** Equals `start` for events without an end time. */
  end: Date
  key: string
}

/** Guards a runaway rule; a daily series over a six-week month is 42. */
const MAX_PER_EVENT = 400

/**
 * Every occurrence that overlaps [from, to). Cancelled events and finished
 * series stay hidden as in the classic views; paused ones are included (the
 * views dim them) so they can be found and resumed from the calendar.
 */
export function expand(events: CalendarEvent[], from: Date, to: Date): Occ[] {
  const out: Occ[] = []
  for (const ev of events) {
    if (ev.status === 'cancelled' || (ev.recurrence && ev.status === 'done')) continue
    const seed = new Date(ev.startAt)
    if (Number.isNaN(seed.getTime())) continue
    const dur = ev.endAt ? Math.max(0, new Date(ev.endAt).getTime() - seed.getTime()) : 0
    // Start one duration early so a run that began before `from` but is
    // still going inside the range is included.
    let cur = nextOccurrenceOnOrAfter(seed, ev.recurrence, new Date(from.getTime() - dur))
    for (let n = 0; cur && cur.getTime() < to.getTime() && n < MAX_PER_EVENT; n++) {
      if (cur.getTime() + Math.max(dur, 1) > from.getTime()) {
        out.push({ ev, start: cur, end: new Date(cur.getTime() + dur), key: `${ev.id}:${cur.getTime()}` })
      }
      if (!ev.recurrence) break
      cur = nextOccurrenceOnOrAfter(seed, ev.recurrence, new Date(cur.getTime() + 1))
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime())
}

/** Indexes of the range's days that an occurrence touches, clamped to the
 *  range; null when it falls outside. An event ends on the day of its last
 *  minute, so a 23:59 or next-midnight end stays on its own day. */
export function daySpan(o: Occ, range: Range): [number, number] | null {
  const first = dayDiff(range.start, o.start)
  const last = o.end.getTime() > o.start.getTime() ? dayDiff(range.start, new Date(o.end.getTime() - 1)) : first
  if (last < 0 || first >= range.days.length) return null
  return [Math.max(0, first), Math.min(range.days.length - 1, last)]
}

/** Occurrences per day of the range: all-day ones first, then by start. */
export function byDay(occs: Occ[], range: Range): Occ[][] {
  const out: Occ[][] = range.days.map(() => [])
  for (const o of occs) {
    const span = daySpan(o, range)
    if (!span) continue
    for (let i = span[0]; i <= span[1]; i++) out[i].push(o)
  }
  for (const list of out) list.sort((a, b) => Number(b.ev.allDay) - Number(a.ev.allDay))
  return out
}

/* ── Time grid layout ───────────────────────────────────────────────── */
/** Shortest block drawn, in minutes, so point events stay clickable. */
const MIN_BLOCK = 20

export interface Seg {
  occ: Occ
  /** Minutes from the day's midnight, wall clock. */
  top: number
  bottom: number
  col: number
  cols: number
}

/**
 * Timed occurrences cut to one day and laid out side by side where they
 * overlap: a cluster of transitively overlapping blocks shares the column
 * width equally, each block taking the first column that is free.
 */
export function layoutDay(occs: Occ[], day: Date): Seg[] {
  const next = addDays(day, 1)
  const segs: Seg[] = []
  for (const occ of occs) {
    if (occ.ev.allDay) continue
    const s = occ.start
    const e = occ.end.getTime() > s.getTime() ? occ.end : s
    if (s.getTime() >= next.getTime() || (e === s ? s.getTime() < day.getTime() : e.getTime() <= day.getTime())) continue
    const top = s.getTime() < day.getTime() ? 0 : s.getHours() * 60 + s.getMinutes()
    const end = e.getTime() >= next.getTime() ? 1440 : e.getHours() * 60 + e.getMinutes()
    const clamped = Math.min(top, 1440 - MIN_BLOCK)
    segs.push({ occ, top: clamped, bottom: Math.min(1440, Math.max(end, clamped + MIN_BLOCK)), col: 0, cols: 1 })
  }
  segs.sort((a, b) => a.top - b.top || b.bottom - a.bottom)
  let cluster: Seg[] = []
  let colEnds: number[] = []
  let clusterEnd = -1
  const flush = () => {
    for (const s of cluster) s.cols = colEnds.length
    cluster = []
    colEnds = []
  }
  for (const seg of segs) {
    if (seg.top >= clusterEnd) flush()
    let col = colEnds.findIndex((end) => end <= seg.top)
    if (col < 0) {
      col = colEnds.length
      colEnds.push(seg.bottom)
    } else {
      colEnds[col] = seg.bottom
    }
    seg.col = col
    cluster.push(seg)
    clusterEnd = Math.max(clusterEnd, seg.bottom)
  }
  flush()
  return segs
}

/* ── Formatting (Intl, viewer's timezone) ───────────────────────────── */
const cache = new Map<string, Intl.DateTimeFormat>()

export function dtf(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts)
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts)
    cache.set(key, f)
  }
  return f
}

export const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
export const DAY_LONG: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }
const DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
const STAMP: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }

/** Header title for the visible range. */
export function rangeLabel(view: View, cursor: Date, range: Range, locale: Locale): string {
  if (view === 'month') return dtf(locale, { month: 'long', year: 'numeric' }).format(cursor)
  if (view === 'day') return dtf(locale, { weekday: 'short', ...DATE }).format(cursor)
  return dtf(locale, DATE).formatRange(range.start, range.days[range.days.length - 1])
}

/** "9:00 – 10:30 AM"; a run that crosses midnight shows its start only. */
export function timeLabel(o: Occ, locale: Locale): string {
  const f = dtf(locale, TIME)
  return o.end.getTime() > o.start.getTime() && sameDay(o.start, new Date(o.end.getTime() - 1))
    ? f.formatRange(o.start, o.end)
    : f.format(o.start)
}

/** "Sat, Oct 17, 9:00 – 10:30 AM" for the series' own start and end. */
export function whenLabel(ev: CalendarEvent, locale: Locale): string {
  const start = new Date(ev.startAt)
  const end = ev.endAt ? new Date(ev.endAt) : null
  if (ev.allDay) {
    const f = dtf(locale, { weekday: 'short', ...DATE })
    const last = end && end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start
    return sameDay(start, last) ? f.format(start) : f.formatRange(start, last)
  }
  const f = dtf(locale, { ...STAMP, year: 'numeric' })
  return end && end.getTime() > start.getTime() ? f.formatRange(start, end) : f.format(start)
}

export function stampLabel(d: Date, locale: Locale): string {
  return dtf(locale, STAMP).format(d)
}

export function dateLabel(d: Date, locale: Locale): string {
  return dtf(locale, DATE).format(d)
}

/** Short zone name ("GMT+9", "PDT") so travellers know which clock they see. */
export function zoneName(d: Date, locale: Locale): string {
  return dtf(locale, { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? ''
}

/** Weekday names through Intl; 2026-01-04 is a Sunday, so index = getDay(). */
export function weekdayName(index: number, locale: Locale, width: 'short' | 'narrow' = 'short'): string {
  return dtf(locale, { weekday: width }).format(new Date(2026, 0, 4 + index))
}

export function describeRepeat(r: RecurrenceRule | null, nt: NT, locale: Locale): string {
  if (!r) return nt('calendar.repeat.none')
  let base = r.interval > 1 ? nt(`calendar.repeat.every.${r.freq}`, { n: r.interval }) : nt(`calendar.repeat.each.${r.freq}`)
  if (r.freq === 'weekly' && r.byweekday?.length) {
    // A plain separator from the catalogue: Intl.ListFormat puts a conjunction into
    // Korean ("월, 수 및 금") where a calendar writes "월, 수, 금".
    const days = r.byweekday.map((d) => weekdayName(d, locale)).join(nt('calendar.repeat.daySep'))
    base = nt('calendar.repeat.on', { base, days })
  }
  const parts = [base]
  if (r.until) parts.push(nt('calendar.repeat.until', { date: dateLabel(new Date(r.until), locale) }))
  if (r.count) parts.push(nt('calendar.repeat.count', { n: r.count }))
  return parts.join(' · ')
}

/** "10 minutes before · In-app", with the largest whole unit Intl can name. */
export function describeReminder(ev: CalendarEvent, nt: NT, locale: Locale): string {
  const m = ev.reminderMinutesBefore
  if (m == null || !ev.reminderChannel) return nt('calendar.reminder.none')
  const [n, unit] = m % 1440 === 0 ? [m / 1440, 'day'] as const : m % 60 === 0 ? [m / 60, 'hour'] as const : [m, 'minute'] as const
  const lead = m === 0
    ? nt('calendar.reminder.atStart')
    : nt('calendar.reminder.before', { dur: new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(n) })
  return `${lead} · ${nt(`calendar.channel.${ev.reminderChannel}`)}`
}
