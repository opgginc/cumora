import { isCalendarNotice } from '@/lib/conversationRow'
import type { Message } from '@/types'
import { failureText } from './failures'

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
  /** One agent's engine-failure notices in a row (chat/failures.ts), drawn as one line. */
  | { type: 'fail'; key: string; authorId: string; msgs: Message[]; day: Date | null; pause: number | null; at: Date }
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
 * ends the turn like any line. An agent's engine failures with nothing drawn
 * between them are one failure line, across pauses (an outage fails each
 * routine run again half an hour later) but not across days, and never into
 * a line that was drawn open: `opened` holds the first failure of each such
 * line, and each of them starts a line of its own.
 */
export function buildItems(messages: Message[], meId: string | null, isAnswer: (m: Message) => boolean, opened: ReadonlySet<string>): Item[] {
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
    if (failureText(m) !== null) {
      // Keyed by its newest failure, unlike a work run: older pages join a
      // failure line at its top (one routine fails all through an outage), and
      // a key that holds then keeps the row mounted and loadOlderUntilShown
      // from counting the join as a change above. A new failure moves the key
      // instead, so what must find the line again (the list's scroll anchor,
      // an opened line) goes by its messages (rowIndexOf). The server id, not
      // keyOf: notices posted before server/src/fork/engineNotice.ts
      // noticeDedupeKey can share a client_id.
      // An opened line lists every failure it holds, so an older page joining
      // it would grow the row the reader is in from its top, with no row added
      // above for the list to keep its anchor by: older failures stop above it.
      if (last?.type === 'fail' && last.authorId === m.authorId && day === null && !opened.has(m.id)) {
        last.msgs.push(m)
        last.key = `f-${m.id}`
        last.at = at
      } else {
        out.push({ type: 'fail', key: `f-${m.id}`, authorId: m.authorId, msgs: [m], day, pause, at })
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

/** The messages a row stands for: a work run's or a failure line's, or its one message. */
export function rowMessages(it: Item): Message[] {
  return it.type === 'work' || it.type === 'fail' ? it.msgs : [it.msg]
}

/** The row holding the message with this key (keyOf), or -1. A row that
 *  gathers messages changes its key as they join it, at its top or bottom. */
export function rowIndexOf(items: Item[], key: string): number {
  return items.findIndex((it) => rowMessages(it).some((m) => keyOf(m) === key))
}

/**
 * Loads older pages until a drawn row lands above the transcript's first row,
 * since Virtuoso asks for older rows again only when that row's index changes
 * (src/next/README.md, Routines tab). `rows` reads the room's messages, oldest
 * first, and `keysOf` gives the keys of the rows the transcript draws from
 * them; rows arriving at the bottom meanwhile count for neither check. Stops
 * when `alive` turns false (the room was left) or no older message came: the
 * history ended, the request failed, or another load was already running.
 * Resolves whether the rows above changed: a drawn row landed there, or older
 * rows joined the first row on the way.
 */
export async function loadOlderUntilShown(
  loadOlder: () => Promise<void>,
  rows: () => Message[],
  keysOf: (rows: Message[]) => string[],
  alive: () => boolean,
): Promise<boolean> {
  let changed = false
  // Only loadOlder awaits, so a run's keys are still the next run's starting keys.
  let first = keysOf(rows())[0]
  while (alive()) {
    const oldest = rows()[0]?.id
    await loadOlder()
    if (rows()[0]?.id === oldest) return changed
    const now = keysOf(rows())
    if (first === undefined ? now.length > 0 : now.indexOf(first) > 0) return true
    // Older rows joined the first row (a work chip took an older row's key):
    // the run goes on, but the rows above changed even if the history ends here.
    if (first !== undefined && now[0] !== first) changed = true
    first = now[0]
  }
  return changed
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
