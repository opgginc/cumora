import { isCalendarNotice } from '@/lib/conversationRow'
import type { Message } from '@/types'

/** Messages a bubble can show. Tool/thought rows are work, not conversation. */
const WORK_KINDS = new Set<Message['kind']>(['tool', 'thought'])
const LINE_KINDS = new Set<Message['kind']>(['system', 'whisper-link'])
/** Messages that take a turn in the conversation, which a person reads as a
 *  message. Work steps arrive in bursts while an agent works, and system
 *  lines are not someone talking (a membership line names the person who
 *  acted as its author). */
export const TALK_KINDS = new Set<Message['kind']>(['text', 'attachment', 'email', 'poll'])
/** Consecutive messages closer than this join one bubble group. */
const GROUP_GAP_MS = 5 * 60_000
/** Inside a turn, a message shows its time once the clock reads this many minutes past the last
 *  time shown. Counted in clock minutes, the way a reader compares two times on screen. */
const STAMP_GAP_MIN = 5
/** A silence at least this long gets a line saying how long it lasted, and ends the turn. */
const PAUSE_MS = 15 * 60_000

export type Pos = 'single' | 'first' | 'middle' | 'last'
/** Where a message's time shows by default: on the name row that starts a
 *  turn, in the message's own slot, or only on hover or when every time is asked for. */
export type Stamp = 'turn' | 'slot' | 'hidden'

/** `day` marks the first item of a calendar day; `pause` is the silence (ms)
 *  before an item that starts a pause line. An item never has both. */
export type Item =
  | { type: 'msg'; key: string; msg: Message; mine: boolean; pos: Pos; stamp: Stamp; day: Date | null; pause: number | null; at: Date }
  | { type: 'work'; key: string; authorId: string; msgs: Message[]; day: Date | null; pause: number | null; at: Date }
  | { type: 'line'; key: string; msg: Message; day: Date | null; pause: number | null; at: Date }
  /** A reply that answered a question card (chat/cards.ts), drawn as one line. */
  | { type: 'answer'; key: string; msg: Message; day: Date | null; pause: number | null; at: Date }

export function createdAt(m: Message): Date {
  const iso = (m as Message & { createdAt?: string }).createdAt
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d : new Date()
}

export function keyOf(m: Message): string {
  return m.clientId ?? m.id
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * Flatten a transcript into render items: tool/thought runs collapse into a
 * single work item per author, the first item of each calendar day carries
 * the day separator, a silence of PAUSE_MS or more inside a day carries a
 * pause line, and bubbles from one author in quick succession get
 * first/middle/last positions so corners group like a messenger.
 *
 * Times: a turn is one sender's unbroken run of messages (a day chip, a pause
 * line or anything that is not a message ends it). Its first message shows its
 * time on the name row; later ones show theirs only once the clock is
 * STAMP_GAP_MIN past the last time shown, so a burst gets one time, not one per line.
 * Calendar firings are left out: the room panel's Routines tab tracks runs. A
 * reply that answered a question card (`isAnswer`) is an answer line, which
 * ends the turn like any line.
 */
export function buildItems(messages: Message[], meId: string | null, isAnswer: (m: Message) => boolean): Item[] {
  const out: Item[] = []
  let prevAt: Date | null = null
  let shownMin = 0
  for (const m of messages) {
    if (isCalendarNotice(m)) continue
    const at = createdAt(m)
    const day = prevAt && sameDay(prevAt, at) ? null : at
    const pause = prevAt && !day && at.getTime() - prevAt.getTime() >= PAUSE_MS ? at.getTime() - prevAt.getTime() : null
    prevAt = at
    const breaks = day !== null || pause !== null
    const last = out[out.length - 1]

    if (WORK_KINDS.has(m.kind)) {
      if (last?.type === 'work' && last.authorId === m.authorId && !breaks) {
        last.msgs.push(m)
        last.at = at
      } else {
        out.push({ type: 'work', key: `w-${keyOf(m)}`, authorId: m.authorId, msgs: [m], day, pause, at })
      }
      continue
    }
    if (LINE_KINDS.has(m.kind)) {
      out.push({ type: 'line', key: keyOf(m), msg: m, day, pause, at })
      continue
    }
    if (isAnswer(m)) {
      out.push({ type: 'answer', key: keyOf(m), msg: m, day, pause, at })
      continue
    }

    const sameSender = last?.type === 'msg' && last.msg.authorId === m.authorId && !breaks
    const joins = sameSender
      && m.kind !== 'poll' && last.msg.kind !== 'poll'
      && at.getTime() - last.at.getTime() < GROUP_GAP_MS
    if (joins && last.type === 'msg') last.pos = last.pos === 'single' ? 'first' : 'middle'
    const min = Math.floor(at.getTime() / 60_000)
    let stamp: Stamp = 'hidden'
    if (!sameSender || min - shownMin >= STAMP_GAP_MIN) {
      stamp = sameSender ? 'slot' : 'turn'
      shownMin = min
    }
    out.push({ type: 'msg', key: keyOf(m), msg: m, mine: m.authorId === meId, pos: joins ? 'last' : 'single', stamp, day, pause, at })
  }
  return out
}

/** A mounted day chip's pill, as the floating day under the header sees it. Days
 *  are local midnights in ms; `prev` is the day of the row before the chip (null
 *  for the first row). `passed`: the pill's top is above the floating pill's
 *  line; `near`: it is close enough below it to need the spot. Null until measured. */
export interface DayPill { day: number; prev: number | null; passed: boolean | null; near: boolean | null }

/**
 * The date the floating pill under the room header shows, for the rows at its
 * line, and whether it shows. The last pill above the line names the day there;
 * with none, the row before the first pill below it does; with no pill mounted,
 * `rangeDay`, the day of the rendered rows (null when they cross a day, whose
 * pill has not reported yet). It steps aside while a pill below the line says
 * the same date or comes up to take the spot. Null means "keep what is on
 * screen": a pill has not been measured yet.
 */
export function floatingDay(pills: Iterable<DayPill>, rangeDay: number | null): { day: number; show: boolean } | null {
  const list = [...pills]
  let above: DayPill | null = null
  let below: DayPill | null = null
  for (const p of list) {
    if (p.passed === null || p.near === null) return null
    if (p.passed) { if (!above || p.day > above.day) above = p }
    else if (!below || p.day < below.day) below = p
  }
  const day = above ? above.day : below ? (below.prev ?? below.day) : rangeDay
  if (day === null) return null
  return { day, show: !list.some((p) => !p.passed && (p.near || p.day === day)) }
}
