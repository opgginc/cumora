/** Date/time formatting for the redesign. Everything renders in the viewer's
 *  own timezone through Intl, so a traveller sees their local clock. */
import type { Locale } from '@/lib/i18n'

const cache = new Map<string, Intl.DateTimeFormat>()

function fmt(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts)
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts)
    cache.set(key, f)
  }
  return f
}

export function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Sidebar stamp: time today, weekday within a week, else a short date. Korean's
 *  short weekday is one syllable ("금") that reads as a word on its own, so Korean
 *  takes the long form ("금요일"), as Korean phones show it. */
export function listStamp(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (days <= 0) return fmt(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
  if (days < 7) return fmt(locale, { weekday: locale === 'ko' ? 'long' : 'short' }).format(d)
  return fmt(locale, { month: 'short', day: 'numeric' }).format(d)
}

/** Day separator label for the transcript. */
export function dayLabel(d: Date, locale: Locale, today: string, yesterday: string): string {
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (days === 0) return today
  if (days === 1) return yesterday
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return fmt(locale, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(d)
}

export function clock(d: Date, locale: Locale): string {
  return fmt(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
}

/** "9:07 – 9:28 PM": Intl writes the shared part once. Across midnight it would
 *  add both dates, which overflow a one-line label, so the times stand alone
 *  there ("11:58 PM – 12:30 AM"); the day chip above already gives the date. */
export function clockRange(from: Date, to: Date, locale: Locale): string {
  const f = fmt(locale, { hour: '2-digit', minute: '2-digit' })
  return from.toDateString() === to.toDateString() ? f.formatRange(from, to) : `${f.format(from)} – ${f.format(to)}`
}

/** "Monday, October 19, 2026" */
export function fullDate(d: Date, locale: Locale): string {
  return fmt(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d)
}

/** "06:31:40 PM GMT+9": to the second, with the viewer's UTC offset. */
export function exactTime(d: Date, locale: Locale): string {
  return fmt(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset' }).format(d)
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
]

/** "in 6 days", "2 hours ago", in the viewer's language. */
export function relative(iso: string, locale: Locale): string {
  const ms = new Date(iso).getTime() - Date.now()
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of UNITS) if (Math.abs(ms) >= size) return rtf.format(Math.round(ms / size), unit)
  return rtf.format(Math.round(ms / 60_000), 'minute')
}

/** How long a pause line says a silence lasted: exact minutes under an hour,
 *  5-minute steps under three hours, whole hours beyond. */
export function pauseLength(ms: number): { h: number; m: number } {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return { h: 0, m: min }
  if (min < 180) {
    const r = Math.round(min / 5) * 5
    return { h: Math.floor(r / 60), m: r % 60 }
  }
  return { h: Math.round(min / 60), m: 0 }
}

/** The time today, with the date before that, and the year before this one. */
export function dateTime(iso: string, locale: Locale): string {
  const d = new Date(iso)
  const now = new Date()
  if (startOfDay(d) === startOfDay(now)) return clock(d, locale)
  return fmt(locale, d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)
}

/** "0:42", "12:05", "1:02:09" — elapsed time for live work. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
