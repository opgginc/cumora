/**
 * Transcript. Rendering budget rules:
 *  - Virtuoso mounts only what is near the viewport; rows are memoized on the
 *    message object, which the store replaces only when that message changes.
 *  - Streaming replies live in the list footer and subscribe to their own
 *    slice, so a token stream re-renders one bubble, not the list. Agents
 *    still at work show over the composer (WorkingHeads), not in the list.
 *  - Entrance motion is CSS on transform/opacity/clip-path and plays once per
 *    message per session, so scrolling back never replays it.
 */
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Virtuoso, type ListRange, type ScrollerProps, type VirtuosoHandle } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useMessages, toggleReaction, retryFailedMessage, discardFailedMessage, VIRTUOSO_FIRST_INDEX_BASE } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { useLocale, type Locale } from '@/lib/i18n'
import { copyText } from '@/lib/clipboard'
import {
  RichBody, SystemRow, artifactKey, artifactRefsForMessage,
  DocumentArtifactCard, BoardArtifactCard, CardArtifactCard, CalendarArtifactCard,
} from '@/components/Message'
import { PollBubble } from '@/components/PollBubble'
import { ImageViewer } from '@/components/ImageViewer'
import type { Message, Participant } from '@/types'
import { haptic } from '../haptics'
import { useNT, type NT } from '../i18n'
import { href, navigate, getRoute, withRoute } from '../router'
import { bytes, clock, dayLabel, exactTime, fullDate, pauseLength, relative, startOfDay } from '../format'
import { HOLD_MS, useHold } from '../hooks'
import { agentRef } from '../agentRefs'
import { Avatar } from '../ui/Avatar'
import { IconButton, INERT, Menu, Spinner, useCoarse, useMenu, type MenuEntry } from '../ui/primitives'
import { IArrowDown, IArrowUp, ICheck, ICopy, IDownload, IFile, IMore, IReply, ISpark, IThread, IWhisper } from '../ui/icons'
import { buildItems, createdAt, floatingDay, type DayPill, type Item, type Pos, type Stamp } from './model'
import { authorOf } from './deletedAuthor'
import { answerKind, roomTalk } from './cardAnswers'
import { useCardAnswers, useCards, useQuestionOf, useWaitingCard } from './cards'
import { AskCard } from './AskCard'
import { openFigures, useRoomTokens, useTokens } from './tokens'
import { AgendaTurns, TokenDialog, TokenLine } from './TokenFigures'

const EMPTY: Message[] = []
const QUICK = ['👍', '❤️', '😂', '👀', '✅', '🔥']
/**
 * Copies a message's text from outside its bubble, at its end on the free
 * side: right of someone else's bubble, left of mine (chat.css). A mouse
 * reveals it with the row, like the hover toolbar; touch has no hover, so it
 * stays hidden there and the long-press sheet keeps Copy. The icon turns into
 * a check once the text is copied.
 */
function CopyText({ text }: { text: string }) {
  const nt = useNT()
  const [done, setDone] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(null), 1500)
    return () => window.clearTimeout(t)
  }, [done])
  const label = done === 'copied' ? nt('msg.copied') : done === 'failed' ? nt('msg.copyFailed') : nt('msg.copy')
  return (
    <button
      type="button"
      className="nx-copy"
      data-done={done ?? undefined}
      aria-label={label}
      title={label}
      onClick={() => copyText(text).then(() => setDone('copied'), () => { haptic('error'); setDone('failed') })}
    >
      {done === 'copied' ? <ICheck aria-hidden /> : <ICopy aria-hidden />}
    </button>
  )
}

/** When each row was first shown, per conversation. A row animates only
 *  inside its first ENTRANCE_MS, so a re-render mid-animation keeps playing
 *  and a remount after scrolling never replays it. */
const firstSeen = new Map<string, Map<string, number>>()
const ENTRANCE_MS = 700
function seenMap(convoId: string): Map<string, number> {
  let m = firstSeen.get(convoId)
  if (!m) { m = new Map(); firstSeen.set(convoId, m) }
  return m
}
/** Message ids the user already watched stream in. Their final row must not
 *  fade in again: the text was on screen the whole time. */
const streamed = new Set<string>()

function isFresh(seen: Map<string, number>, key: string): boolean {
  const t = seen.get(key)
  if (t === undefined) { seen.set(key, performance.now()); return true }
  return performance.now() - t < ENTRANCE_MS
}

/* ── Reactions ──────────────────────────────────────────────────────── */
function Reactions({ msg, mine }: { msg: Message; mine: boolean }) {
  const list = msg.reactions ?? []
  if (list.length === 0) return null
  return (
    <div className={mine ? 'nx-reacts nx-reacts--mine' : 'nx-reacts'}>
      {list.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className="nx-react"
          data-mine={r.mine || undefined}
          data-haptic
          aria-pressed={!!r.mine}
          onClick={() => void toggleReaction(msg.id, r.emoji)}
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="nx-mono">{r.count}</span>
        </button>
      ))}
    </div>
  )
}

/* ── Attachments ────────────────────────────────────────────────────── */
function Attachment({ a }: { a: NonNullable<Message['attachment']> }) {
  const [viewer, setViewer] = useState(false)
  if (a.kind === 'img' && a.url) {
    return (
      <>
        <button type="button" className="nx-att-img" onClick={() => setViewer(true)} aria-label={a.name}>
          {/* Fixed box: the server stores no dimensions, and an image that
              grows on load would shove every row below it in the list. */}
          <img src={a.url} alt={a.name} loading="lazy" decoding="async" draggable={false} />
        </button>
        {viewer && <ImageViewer src={a.url} name={a.name} onClose={() => setViewer(false)} />}
      </>
    )
  }
  const body = (
    <>
      <span className="nx-att-file__icon"><IFile /></span>
      <span className="nx-att-file__text">
        <span className="nx-att-file__name">{a.name}</span>
        <span className="nx-att-file__meta nx-mono">{[a.mime?.split('/')[1], a.size ? bytes(a.size) : null].filter(Boolean).join(' · ')}</span>
      </span>
      {a.url && <IDownload className="nx-att-file__dl" />}
    </>
  )
  return a.url
    ? <a className="nx-att-file" href={a.url} download={a.name} target="_blank" rel="noopener noreferrer">{body}</a>
    : <div className="nx-att-file">{body}</div>
}

function Artifacts({ msg }: { msg: Message }) {
  const refs = useMemo(() => artifactRefsForMessage(msg), [msg])
  if (refs.length === 0) return null
  return (
    <div className="nx-artifacts">
      {refs.map((ref) => ref.type === 'document'
        ? <DocumentArtifactCard key={artifactKey(ref)} id={ref.id} conversationId={msg.conversationId} />
        : ref.type === 'board'
          ? <BoardArtifactCard key={artifactKey(ref)} id={ref.id} />
          : ref.type === 'card'
            ? <CardArtifactCard key={artifactKey(ref)} id={ref.id} />
            : <CalendarArtifactCard key={artifactKey(ref)} id={ref.id} />)}
    </div>
  )
}

/* ── Times ──────────────────────────────────────────────────────────── */
/** One message's time. Every message renders one so that revealing more never
 *  moves a row: `data-shown` ones are visible, the rest appear on hover (mouse)
 *  or while the transcript has `data-all-times`, which a click on any time
 *  toggles (see toggleTimes). */
function TimeStamp({ at, shown, locale }: { at: Date; shown: boolean; locale: Locale }) {
  const full = `${fullDate(at, locale)} ${exactTime(at, locale)}`
  return (
    <button type="button" className="nx-stamp nx-mono" data-shown={shown || undefined} title={full} aria-label={full}>
      <time dateTime={at.toISOString()}>{clock(at, locale)}</time>
    </button>
  )
}

/** First lines of the long-press / ⋯ menu. The menu mounts it only while
 *  open, so "how long ago" is computed when the person asks, never per row. */
function WhenHeader({ at }: { at: Date }) {
  const locale = useLocale()
  return (
    <div className="nx-menu__when">
      <b>{fullDate(at, locale)}</b>
      <span><span className="nx-mono">{exactTime(at, locale)}</span> · {relative(at.toISOString(), locale)}</span>
    </div>
  )
}

function pauseText(nt: NT, ms: number): string {
  const { h, m } = pauseLength(ms)
  if (h === 0) return nt('msg.pauseMin', { m })
  return m === 0 ? nt('msg.pauseHour', { h }) : nt('msg.pauseHourMin', { h, m })
}

/** One listener for every time in the room. An attribute flip instead of
 *  state, so showing all times re-renders no row; it resets with the list,
 *  which ChatView remounts per room. */
function toggleTimes(e: MouseEvent<HTMLDivElement>) {
  if ((e.target as Element).closest('.nx-stamp')) e.currentTarget.toggleAttribute('data-all-times')
}

/* ── Swipe to reply ─────────────────────────────────────────────────── */
/** Letting go of a message swiped this far left replies to it. */
const REPLY_AT = 64
/** How far a finger moves before its direction counts. No more than
 *  useSwipeBack's own 8px: the pushed chat screen would take a leftward
 *  swipe first and wobble when it ends. */
const SWIPE_SLOP = 8

/** Whether a touch began inside something that scrolls sideways by itself,
 *  such as a wide code block, which keeps its own swipe. Reads layout once,
 *  when a swipe would start, never in a frame. */
function scrollsSideways(from: EventTarget | null, row: Element): boolean {
  for (let n = from instanceof Element ? from : null; n && n !== row; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true
  }
  return false
}

/**
 * A finger swipes the message left, and letting go past REPLY_AT replies. The
 * avatar column and the message follow it through `translate`, not
 * `transform`, which the entrance keyframes own and keep filled.
 *
 * Native listeners, not React props: the pushed chat screen's swipe-back
 * (useSwipeBack) listens on an ancestor, and React runs its handlers at the
 * root, after it. A swipe this row takes stops its moves here, so the
 * swipe-back never sees them, and neither does useHold, whose timer
 * `cancelHold` stops instead.
 */
function useSwipeReply(onReply: (() => void) | null, cancelHold: () => void) {
  // A ref object, not element state: a state update on mount would render
  // every row twice while Virtuoso mounts rows during a scroll.
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef({ onReply, cancelHold })
  latest.current = { onReply, cancelHold }
  const enabled = onReply !== null
  useEffect(() => {
    const row = ref.current
    if (!row || !enabled) return
    let start: { id: number; x: number; y: number; at: number } | null = null
    // Set once the row takes the finger at `start`. Its moves stay here until
    // it lifts, even after a second finger ends the swipe, so the swipe-back
    // never picks them up halfway and bounces the screen.
    let taken = false
    let parts: HTMLElement[] = []
    let arrow: HTMLElement | null = null
    let ready = false
    // Without data-swipe the CSS transitions glide everything back. The arrow
    // keeps data-ready while it fades, so its colour does not flip on the way out.
    const release = (reply: boolean) => {
      row.removeAttribute('data-swipe')
      for (const p of parts) p.style.translate = ''
      arrow?.style.removeProperty('opacity')
      arrow?.style.removeProperty('transform')
      parts = []
      if (reply && ready) latest.current.onReply?.()
    }
    const onStart = (e: TouchEvent) => {
      // A second finger on this row ends the swipe without replying.
      if (e.touches.length > 1) {
        if (taken) release(false)
        else start = null
        return
      }
      // The only finger on the screen begins a new touch, whatever came before.
      if (parts.length > 0) release(false)
      taken = false
      const t = e.touches[0]
      start = t ? { id: t.identifier, x: t.clientX, y: t.clientY, at: e.timeStamp } : null
    }
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!start || !t) return
      const dx = t.clientX - start.x
      if (!taken) {
        const dy = t.clientY - start.y
        if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return
        // Two fingers are no swipe, right is the swipe back and up or down a
        // scroll. A move the browser can no longer cancel belongs to a scroll
        // that already began, and a finger that rested until the menu opened
        // is holding, not swiping. A touch event keeps the target its touch
        // began on.
        if (e.touches.length > 1 || -dx <= Math.abs(dy) || !e.cancelable || e.timeStamp - start.at >= HOLD_MS || scrollsSideways(e.target, row)) {
          start = null
          return
        }
        taken = true
        parts = [...row.children].filter((c): c is HTMLElement => c.matches('.nx-msg__gutter, .nx-msg__col'))
        arrow = row.querySelector<HTMLElement>(':scope > .nx-msg__swipe')
        ready = false
        arrow?.removeAttribute('data-ready')
        row.setAttribute('data-swipe', '')
        latest.current.cancelHold()
      }
      e.stopPropagation()
      if (e.cancelable) e.preventDefault()
      // So does a second finger anywhere else: its touchstart goes to where it
      // landed, but every move of this finger lists it.
      if (e.touches.length > 1) release(false)
      if (parts.length === 0) return
      const d = Math.max(0, -dx)
      // Past REPLY_AT the message follows at a third of the finger's pace.
      const x = d <= REPLY_AT ? d : REPLY_AT + (d - REPLY_AT) / 3
      for (const p of parts) p.style.translate = `${-x}px 0`
      const k = Math.min(1, d / REPLY_AT)
      if (arrow) {
        arrow.style.opacity = String(k)
        arrow.style.transform = `scale(${0.6 + 0.4 * k})`
      }
      if (d >= REPLY_AT !== ready) {
        ready = !ready
        arrow?.toggleAttribute('data-ready', ready)
        if (ready) haptic('threshold')
      }
    }
    const onEnd = (e: TouchEvent) => {
      const s = start
      // Only the finger that began here ends the touch.
      if (!s || ![...e.changedTouches].some((c) => c.identifier === s.id)) return
      start = null
      taken = false
      // A finger that landed elsewhere after this one last moved is still down.
      if (parts.length > 0) release(e.type === 'touchend' && e.touches.length === 0)
    }
    row.addEventListener('touchstart', onStart, { passive: true })
    row.addEventListener('touchmove', onMove, { passive: false })
    row.addEventListener('touchend', onEnd, { passive: true })
    row.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      row.removeEventListener('touchstart', onStart)
      row.removeEventListener('touchmove', onMove)
      row.removeEventListener('touchend', onEnd)
      row.removeEventListener('touchcancel', onEnd)
      if (parts.length > 0) release(false)
    }
  }, [enabled])
  return ref
}

/* ── Bubble ─────────────────────────────────────────────────────────── */
interface BubbleProps {
  /** In-room search: 'match' for every hit, 'current' for the focused one. */
  hl?: 'match' | 'current'
  msg: Message
  author: Participant | undefined
  mine: boolean
  pos: Pos
  /** Where this message's time shows by default (see buildItems). */
  stamp: Stamp
  fresh: boolean
  at: Date
  /** Swipe left to reply. Only the room's transcript sets it: its composer
   *  shows the reply, which a thread's composer does not. */
  swipe?: boolean
  /** Developer token figures in an agent's reply: the room's transcript only,
   *  since they count from my message to my next one in the room. */
  tokens?: boolean
  /** Touch first (useCoarse): the long-press sheet holds Copy, since there is no hover to show its button. */
  coarse: boolean
}

export const Bubble = memo(function Bubble({ msg, author, mine, pos, stamp, fresh, at, hl, swipe, tokens, coarse }: BubbleProps) {
  const nt = useNT()
  const locale = useLocale()
  const menu = useMenu()
  const hold = useHold((x, y) => menu.openAt({ x, y }))
  const hasText = msg.body.trim().length > 0 && msg.kind !== 'poll'
  // A turn opens with the avatar and a name row carrying the time. Later
  // messages, and all of mine, keep their time beside the bubble, where CSS
  // places it: the avatar column, left of my bubble, or right of the bubble
  // in a 1:1 room, which has no avatar column.
  const turn = stamp === 'turn'
  const time = <TimeStamp at={at} shown={stamp !== 'hidden'} locale={locale} />
  const quote = msg.quoted
  const quoteAuthor = useParticipants((s) => (quote ? authorOf(s.byId, quote.authorId, nt)?.name : undefined))
  // Selects a string, so status churn on participants does not re-render the bubble.
  const quoteText = useParticipants((s) => quote?.body.replace(/@([A-Za-z][\w-]*)/g, (m, id: string) => (s.byId[id] ? `@${s.byId[id].name}` : m)))
  // A message about a question card (it quotes the question or the reply that
  // answered it) names the question above the bubble instead of quoting it.
  const about = useQuestionOf(msg.conversationId, quote?.id)

  // A card is drawn under its question. One that arrives after the message is
  // on screen fades in; a remount (scrolling back) shows it at once.
  const card = useCards((s) => s.byMessage[msg.id])
  const cardLate = useRef(card === undefined)
  // The reply that answered the card shows inside it, so it is no thread reply.
  const replies = Math.max(0, (msg.replyCount ?? 0) - (card?.answer ? 1 : 0))

  const react = (emoji: string) => { void toggleReaction(msg.id, emoji) }
  const reply = () => useApp.getState().setReplyingTo(msg.conversationId, msg.id)
  const swipeRef = useSwipeReply(swipe ? reply : null, hold.onTouchCancel)
  const thread = () => navigate(withRoute(getRoute(), { threadId: msg.id, peek: null }))
  const figures = useTokens((s) => (tokens && !mine ? s.byMessage[msg.id] : undefined))
  const entries: MenuEntry[] = [
    { key: 'reply', label: nt('msg.reply'), icon: <IReply />, onSelect: reply },
    { key: 'thread', label: nt('msg.thread'), icon: <IThread />, onSelect: thread },
    // A mouse copies from the button beside the bubble (CopyText); touch has no hover, so the sheet keeps Copy.
    ...(hasText && coarse ? [{ key: 'copy', label: nt('msg.copy'), icon: <ICopy />, onSelect: () => void copyText(msg.body) }] : []),
    // The line under the bubble is too small for a finger; the sheet opens the same details.
    ...(figures ? [{ key: 'tokens', label: nt('tokens.title'), icon: <ISpark />, onSelect: () => openFigures(nt('tokens.title'), figures) }] : []),
  ]

  return (
    <div
      ref={swipeRef}
      id={`m-${msg.id}`}
      className="nx-msg"
      data-mine={mine || undefined}
      data-pos={pos}
      data-fresh={fresh ? (mine ? 'send' : 'reveal') : undefined}
      data-pending={msg.pending || undefined}
      data-hl={hl}
    >
      {/* Before the halves that slide, so they paint over it while they move. */}
      {swipe && <span className="nx-msg__swipe" aria-hidden><IReply /></span>}
      <div className="nx-msg__gutter">
        {!mine && turn && author && <Face p={author} />}
      </div>
      <div className="nx-msg__col">
        {!mine && turn && (
          <div className="nx-msg__name">
            <span {...agentRef(author)}>{author?.name ?? nt('msg.someone')}</span>
            {time}
          </div>
        )}
        {about && (
          <button type="button" className="nx-re" onClick={() => useApp.getState().jumpToMessage(about.messageId)}>
            <IReply aria-hidden />
            <span>{nt('ask.re', { question: about.question })}</span>
          </button>
        )}
        <div className="nx-msg__row" {...hold}>
          {(mine || !turn) && time}
          <div className="nx-bubble" data-kind={msg.kind}>
            {quote && !about && (
              <button type="button" className="nx-quote" onClick={() => useApp.getState().jumpToMessage(quote.id)}>
                <span className="nx-quote__who">{quoteAuthor ?? quote.authorName ?? nt('msg.someone')}</span>
                <span className="nx-quote__text">{quoteText}</span>
              </button>
            )}
            {msg.email?.subject && <div className="nx-bubble__subject">{msg.email.subject}</div>}
            {hasText && <div className="nx-bubble__text"><RichBody body={msg.body} conversationId={msg.conversationId} /></div>}
            {msg.kind === 'poll' && <PollBubble msg={msg} />}
            {msg.attachment && <Attachment a={msg.attachment} />}
          </div>
          {hasText && <CopyText text={msg.body} />}
          <div className="nx-msg__tools" role="toolbar" aria-label={nt('msg.actions')}>
            {QUICK.slice(0, 3).map((e) => (
              <button key={e} type="button" className="nx-msg__quick" onClick={() => react(e)} aria-label={nt('msg.reactWith', { emoji: e })}>{e}</button>
            ))}
            <IconButton small label={nt('msg.reply')} onClick={reply}><IReply /></IconButton>
            <IconButton small label={nt('msg.thread')} onClick={thread}><IThread /></IconButton>
            <IconButton small label={nt('msg.more')} onClick={(e) => menu.toggleFrom(e.currentTarget, mine ? 'end' : 'start')}><IMore /></IconButton>
          </div>
        </div>
        {figures && <TokenLine figures={figures} />}
        {card && <AskCard card={card} showQuestion={!msg.body.trim().endsWith(card.question)} rise={cardLate.current} />}
        <Artifacts msg={msg} />
        <Reactions msg={msg} mine={mine} />
        {replies > 0 && (
          <button type="button" className="nx-msg__thread" onClick={thread}>
            <IThread />
            {nt(replies === 1 ? 'msg.oneReply' : 'msg.replies', { n: replies })}
          </button>
        )}
        {(msg.failed || msg.unconfirmed) && (
          <div className="nx-msg__failed">
            <span>{msg.unconfirmed ? nt('msg.unconfirmed') : nt('msg.failed')}</span>
            <button type="button" onClick={() => { haptic('sent'); void retryFailedMessage(msg.conversationId, msg.id) }}>{nt('msg.retry')}</button>
            <button type="button" onClick={() => discardFailedMessage(msg.conversationId, msg.id)}>{nt('msg.discard')}</button>
          </div>
        )}
      </div>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={entries}
        header={
          <>
            <WhenHeader at={at} />
            <div className="nx-menu__reacts">
              {QUICK.map((e) => (
                <button key={e} type="button" onClick={() => { react(e); menu.close() }} aria-label={nt('msg.reactWith', { emoji: e })}>{e}</button>
              ))}
            </div>
          </>
        }
      />
    </div>
  )
})

/* ── Work runs (tool/thought messages) ──────────────────────────────── */
function WorkChip({ item, author }: { item: Extract<Item, { type: 'work' }>; author: Participant | undefined }) {
  const nt = useNT()
  const tools = item.msgs.filter((m) => m.kind === 'tool').length
  const last = item.msgs[item.msgs.length - 1]
  const label = last.kind === 'tool' && last.tool ? last.tool.name : last.body.split('\n')[0]
  return (
    <div className="nx-msg nx-msg--work">
      <div className="nx-msg__gutter" aria-hidden />
      <div className="nx-work">
        <ISpark aria-hidden />
        <span className="nx-work__who">{author?.name ?? nt('msg.someone')}</span>
        <span className="nx-work__what">{label}</span>
        <span className="nx-work__count nx-mono">{tools > 0 ? nt('msg.toolCount', { n: tools }) : nt('msg.thoughtCount', { n: item.msgs.length })}</span>
      </div>
    </div>
  )
}

function WhisperLine({ msg }: { msg: Message }) {
  const nt = useNT()
  const names = useParticipants(useShallow((s) => (msg.whisperLink?.pair ?? []).map((id) => s.byId[id]?.name ?? '?')))
  if (!msg.whisperLink) return null
  return (
    <a
      className="nx-line nx-line--whisper"
      href={href({ section: 'whispers' })}
      onClick={(e) => { e.preventDefault(); navigate(href({ section: 'whispers' })) }}
    >
      <IWhisper aria-hidden />
      <span>{nt('msg.whisper', { a: names[0], b: names[1], n: msg.whisperLink.count })}</span>
    </a>
  )
}

/** The reply that answered a question card, as one line where it was sent:
 *  who answered with what. It opens the question, whose card keeps the answer. */
function AnswerLine({ msg, author, rise, hl }: { msg: Message; author: Participant | undefined; rise: boolean; hl?: 'match' | 'current' }) {
  const nt = useNT()
  const question = msg.quotedMessageId
  return (
    <div id={`m-${msg.id}`} className="nx-line">
      <button
        type="button"
        className="nx-answer"
        data-rise={rise || undefined}
        data-hl={hl}
        disabled={!question}
        onClick={() => { if (question) useApp.getState().jumpToMessage(question) }}
      >
        <ICheck aria-hidden />
        <span>{nt('ask.answered', { name: author?.name ?? nt('msg.someone') })}</span>
        <b>“{msg.body}”</b>
      </button>
    </div>
  )
}

/** Room header height: it covers the top of the scroller. */
const HEADER_PX = 56

/**
 * Where a row stands against the transcript's view: null while any of it
 * shows between the header and the composer, else the way to scroll to it.
 * Virtuoso renders rows past the view and drops rows further away, so an
 * observer watches the row while it is rendered, and `recheck` (called for
 * every rendered range) looks it up again. `below` places a row not rendered.
 */
function useAway(scroller: { current: HTMLElement | null }, id: string | null, below: () => boolean, inset: number) {
  const [away, setAway] = useState<'up' | 'down' | null>(null)
  const observer = useRef<IntersectionObserver | null>(null)
  // What the observer watches, so a range that keeps the same row changes nothing.
  const watched = useRef<{ row: Element; inset: number } | null>(null)
  const args = useRef({ id, below, inset })
  args.current = { id, below, inset }
  const recheck = useCallback(() => {
    const { id, below, inset } = args.current
    const root = scroller.current
    const row = id && root ? root.querySelector(`#m-${CSS.escape(id)}`) : null
    if (row && watched.current?.row === row && watched.current.inset === inset) return
    observer.current?.disconnect()
    observer.current = null
    watched.current = row ? { row, inset } : null
    if (!id || !root) setAway(null)
    else if (!row) setAway(below() ? 'down' : 'up')
    else {
      observer.current = new IntersectionObserver(([e]) => {
        if (e) setAway(e.isIntersecting ? null : e.boundingClientRect.top < (e.rootBounds?.top ?? 0) ? 'up' : 'down')
      }, { root, rootMargin: `-${HEADER_PX}px 0px -${inset}px 0px` })
      observer.current.observe(row)
    }
  }, [scroller])
  useEffect(() => {
    const raf = requestAnimationFrame(recheck)
    return () => cancelAnimationFrame(raf)
  }, [recheck, id, inset])
  useEffect(() => () => observer.current?.disconnect(), [])
  return [away, recheck] as const
}

/** A message's avatar; an agent's opens the agent menu (src/next/agentMenu.tsx). */
function Face({ p, presence = false }: { p: Participant; presence?: boolean }) {
  const ref = agentRef(p, p.name)
  const avatar = <Avatar p={p} size={28} presence={presence} />
  if (!ref) return avatar
  return (
    // The name below is the tab stop; the face opens the same menu by pointer.
    <span className="nx-msg__face" {...ref} tabIndex={-1}>{avatar}</span>
  )
}

/* ── Live footer: streaming → final message ─────────────────────────── */
function LiveBubble({ authorId, body }: { authorId: string; body: string }) {
  const p = useParticipants((s) => s.byId[authorId])
  if (!p) return null
  return (
    <div className="nx-msg nx-msg--live" data-fresh="reveal">
      <div className="nx-msg__gutter">
        <Face p={p} presence />
      </div>
      <div className="nx-msg__col">
        <div className="nx-msg__row">
          <div className="nx-bubble">
            <div className="nx-bubble__text nx-stream">{body}<span className="nx-caret" aria-hidden /></div>
          </div>
        </div>
      </div>
    </div>
  )
}

function LiveFooter({ convoId, onChange }: { convoId: string; onChange: (grew: boolean) => void }) {
  const streaming = useMessages((s) => s.streaming)
  const live = useMemo(() => Object.entries(streaming)
    .filter(([, x]) => x.conversationId === convoId)
    .map(([id, x]) => { streamed.add(id); return x }), [streaming, convoId])
  const sig = live.map((l) => `${l.authorId}:${l.body.length}`).join('|')
  const count = useRef(0)
  useEffect(() => {
    onChange(live.length !== count.current)
    count.current = live.length
  }, [sig, live.length, onChange])
  if (live.length === 0) return null
  return <>{live.map((l) => <LiveBubble key={l.authorId} authorId={l.authorId} body={l.body} />)}</>
}

/* ── Floating day ───────────────────────────────────────────────────── */
/** Top of the floating day pill in the scroller: under the room header, plus 8. */
const FLOAT_LINE = HEADER_PX + 8
/** The pill's height plus 8: an in-flow pill this close below the line gets the spot back. */
const FLOAT_NEAR = 30

/**
 * Keeps the date of the rows under the header in a pill there while their own
 * day chip is scrolled away, so a room opened partway into an older day still
 * says which day its times belong to (floatingDay in model.ts decides). Two
 * IntersectionObservers tell each in-flow pill when it passes the pill's line
 * (the floating pill takes its place) and when it comes near it (the floating
 * pill steps aside), so nothing reads layout while scrolling and no row
 * re-renders: the result is written straight into the DOM, like data-all-times.
 */
function createDayFloat() {
  const pills = new Map<Element, DayPill>()
  let observers: IntersectionObserver[] = []
  let root: HTMLElement | null = null
  let float: HTMLSpanElement | null = null
  let rangeDay: number | null = null
  let text = ''
  const watcher = (el: HTMLElement, inset: number, flag: 'passed' | 'near') => new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = pills.get(e.target)
      // The root starts `inset` px below the scroller's top: above its top edge is past that line.
      if (p && e.rootBounds) p[flag] = e.boundingClientRect.top < e.rootBounds.top
    }
    self.update()
  }, { root: el, rootMargin: `-${inset}px 0px 0px 0px`, threshold: [0, 1] })
  const self = {
    label: (_day: number) => '',
    update() {
      const next = floatingDay(pills.values(), rangeDay)
      if (!float || !next) return
      if (next.show) {
        const t = self.label(next.day)
        if (t !== text) { float.textContent = t; text = t }
      }
      float.toggleAttribute('data-show', next.show)
      // A pill past the line is under the header, where the floating pill says its date.
      for (const [el, p] of pills) el.toggleAttribute('data-passed', p.passed === true)
    },
    root(el: HTMLElement | null) {
      if (el === root) return
      for (const o of observers) o.disconnect()
      root = el
      observers = el ? [watcher(el, FLOAT_LINE, 'passed'), watcher(el, FLOAT_LINE + FLOAT_NEAR, 'near')] : []
      for (const pill of pills.keys()) for (const o of observers) o.observe(pill)
    },
    watch: (el: Element, day: number, prev: number | null) => {
      pills.set(el, { day, prev, passed: null, near: null })
      for (const o of observers) o.observe(el)
      return () => {
        pills.delete(el)
        for (const o of observers) o.unobserve(el)
        self.update()
      }
    },
    range(day: number | null) { rangeDay = day; self.update() },
    bind: (el: HTMLSpanElement | null) => { float = el; text = ''; self.update() },
  }
  return self
}
type DayFloat = ReturnType<typeof createDayFloat>

/** A day separator. Its pill reports to the floating day, which takes its place under the header. */
function DayChip({ day, prev, label, watch }: { day: number; prev: number | null; label: string; watch: DayFloat['watch'] }) {
  const pill = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = pill.current
    return el ? watch(el, day, prev) : undefined
  }, [watch, day, prev])
  return <div className="nx-day"><span ref={pill}>{label}</span></div>
}

/* ── List ───────────────────────────────────────────────────────────── */
interface ListContext {
  convoId: string
  bottomInset: number
  onLiveChange: (grew: boolean) => void
  loadingOlder: boolean
  hasMore: boolean
  empty: boolean
  beginning: string
  floatRef: (el: HTMLSpanElement | null) => void
}

// Module-level so Virtuoso never sees new component types: a fresh Footer
// function per render would remount the streaming bubbles.
const LIST_COMPONENTS = {
  // The floating day hangs from a sticky zero-height anchor inside the scroller,
  // so it centers on the same width as the in-flow chips even beside a classic scrollbar.
  Scroller: forwardRef<HTMLDivElement, ScrollerProps & { context?: ListContext }>(function Scroller({ children, context, ...props }, ref) {
    return (
      <div {...props} ref={ref}>
        <div className="nx-day-float" aria-hidden="true"><span ref={context?.floatRef} /></div>
        {children}
      </div>
    )
  }),
  Header: ({ context }: { context?: ListContext }) => (
    <div className="nx-transcript__head">
      {context?.loadingOlder ? <Spinner /> : context && !context.hasMore && !context.empty ? <span>{context.beginning}</span> : null}
    </div>
  ),
  Footer: ({ context }: { context?: ListContext }) => (
    <div style={{ paddingBottom: context?.bottomInset ?? 0 }}>
      {context && <LiveFooter convoId={context.convoId} onChange={context.onLiveChange} />}
    </div>
  ),
}
export interface Find {
  q: string
  /** 0 = newest hit; larger = older. */
  index: number
  onCount: (n: number) => void
}

export function MessageList({ convoId, bottomInset, find }: { convoId: string; bottomInset: number; find?: Find }) {
  const nt = useNT()
  const locale = useLocale()
  const me = useMe()
  const raw = useMessages((s) => s.byConvo[convoId] ?? EMPTY)
  const loaded = useMessages((s) => s.loaded.has(convoId))
  const error = useMessages((s) => s.errors[convoId])
  const hasMore = useMessages((s) => s.hasMoreOlder[convoId] ?? false)
  const loadingOlder = useMessages((s) => s.loadingOlder.has(convoId))
  const byId = useParticipants((s) => s.byId)
  const coarse = useCoarse()
  const ref = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  // The transcript waits for the room's cards on its first load (see the
  // skeleton below). The reply that answered a question shows as a note
  // (AnswerLine); a secret's reply only says that it was sent, which its
  // card already shows, so it is left out.
  const cardsReady = useCards((s) => s.ready[convoId] === true)
  useEffect(() => {
    if (!useCards.getState().loaded[convoId]) void useCards.getState().load(convoId)
  }, [convoId])
  const answers = useCardAnswers(convoId)
  const shown = useMemo(
    () => (answers.size === 0 ? raw : raw.filter((m) => answerKind(answers, m) !== 'secret')),
    [raw, answers],
  )
  const items = useMemo(() => buildItems(shown, me, (m) => answerKind(answers, m) === 'choice'), [shown, me, answers])
  useRoomTokens(convoId, items)

  // Messages present at open never animate; anything after does, once.
  const seen = seenMap(convoId)
  const firstPaint = useRef(true)
  if (firstPaint.current && items.length > 0) {
    for (const it of items) if (!seen.has(it.key)) seen.set(it.key, -Infinity)
    firstPaint.current = false
  }

  // Virtuoso keeps its scroll anchor on prepend only if firstItemIndex drops
  // by exactly the number of rows added above. Items are a filtered view of
  // the store, so anchor on the first row we ever showed and count how far
  // it has moved down.
  const anchorKey = useRef<string | null>(null)
  if (anchorKey.current === null && items.length > 0) anchorKey.current = items[0].key
  let anchorIndex = anchorKey.current ? items.findIndex((it) => it.key === anchorKey.current) : 0
  if (anchorIndex < 0) {
    anchorKey.current = items[0]?.key ?? null
    anchorIndex = 0
  }
  const firstItemIndex = VIRTUOSO_FIRST_INDEX_BASE - anchorIndex

  const [float] = useState(createDayFloat)
  float.label = (day) => dayLabel(new Date(day), locale, nt('msg.today'), nt('msg.yesterday'))
  // Virtuoso's indexes count from firstItemIndex; the callbacks below read the current rows.
  const itemsRef = useRef(items)
  itemsRef.current = items
  const firstRef = useRef(firstItemIndex)
  firstRef.current = firstItemIndex
  const scroller = useRef<HTMLElement | null>(null)

  // While the question the room's agents wait on is out of view, a pill says
  // so and goes to it. Only a loaded question gets one: a jump needs its row.
  // A person's reply quoting a question answers it too, and so does anything
  // a person writes after it once its agent has spoken since (waitingQuestion).
  const talk = useMemo(() => roomTalk(raw, (id) => byId[id]?.kind === 'human'), [raw, byId])
  const waiting = useWaitingCard(convoId, talk)
  const waitingId = waiting && items.some((it) => it.type === 'msg' && it.msg.id === waiting.messageId) ? waiting.messageId : null
  const waitingAgent = useParticipants((s) => (waiting ? authorOf(s.byId, waiting.agentId, nt)?.name : undefined))
  const range = useRef<ListRange | null>(null)
  const [away, recheckAway] = useAway(scroller, waitingId, () => {
    const index = itemsRef.current.findIndex((it) => it.type === 'msg' && it.msg.id === waitingId)
    return range.current !== null && index + firstRef.current > range.current.endIndex
  }, bottomInset)

  const onRange = useCallback((r: ListRange) => {
    const list = itemsRef.current
    const from = r.startIndex - firstRef.current
    // Rows that cross a day mount that day's chip, which reports itself.
    let day: number | null = list[from] ? startOfDay(list[from].at) : null
    for (let i = from; day !== null && i <= r.endIndex - firstRef.current; i++) if (list[i]?.day) day = null
    float.range(day)
    range.current = r
    requestAnimationFrame(recheckAway)
  }, [float, recheckAway])

  const onStartReached = useCallback(() => {
    if (hasMore && !loadingOlder) void useMessages.getState().loadOlder(convoId)
  }, [convoId, hasMore, loadingOlder])

  // Streaming bubbles grow the footer, which Virtuoso's followOutput
  // does not watch; keep the bottom pinned ourselves while the user is there.
  // A new bubble glides into view; token growth follows instantly so the
  // text never lags behind the scroll animation.
  const atBottomRef = useRef(true)
  atBottomRef.current = atBottom
  // Stable: Virtuoso re-runs its scroller effect, and with it this callback, whenever it changes.
  const onScroller = useCallback((el: HTMLElement | Window | null) => {
    scroller.current = el instanceof HTMLElement ? el : null
    float.root(scroller.current)
  }, [float])
  const onLiveChange = useCallback((grew: boolean) => {
    if (!atBottomRef.current) return
    requestAnimationFrame(() => {
      const el = scroller.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: grew ? 'smooth' : 'auto' })
    })
  }, [])

  // Quote taps, palette hits and `#N` chips all route through useApp.
  const pendingJump = useApp((s) => s.pendingJumpMessageId)
  useEffect(() => {
    if (!pendingJump) return
    let index = items.findIndex((it) => it.type !== 'work' && it.msg.id === pendingJump)
    if (index < 0) {
      // A Calendar firing has no line of its own (buildItems leaves it out),
      // so a jump to one lands on what came after it: what the run produced.
      const hidden = raw.find((m) => m.id === pendingJump)
      if (!hidden) return
      const t = createdAt(hidden).getTime()
      index = items.findIndex((it) => createdAt(it.type === 'work' ? it.msgs[0] : it.msg).getTime() >= t)
      if (index < 0) index = items.length - 1
      if (index < 0) return
    }
    const target = items[index]
    const targetId = target.type === 'work' ? target.msgs[0].id : target.msg.id
    useApp.getState().clearPendingJump()
    ref.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
    const deadline = Date.now() + 1200
    const flash = () => {
      const el = document.getElementById(`m-${targetId}`)
      if (el) {
        el.classList.add('nx-flash')
        window.setTimeout(() => el.classList.remove('nx-flash'), 1400)
      } else if (Date.now() < deadline) window.setTimeout(flash, 60)
    }
    window.setTimeout(flash, 80)
  }, [pendingJump, items, raw])

  // In-room search over the loaded transcript, newest hit first.
  const q = find?.q.trim().toLowerCase() ?? ''
  const hits = useMemo(() => {
    if (!q) return [] as string[]
    const out: string[] = []
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if ((it.type === 'msg' || it.type === 'answer') && it.msg.body.toLowerCase().includes(q)) out.push(it.key)
    }
    return out
  }, [items, q])
  const onCount = find?.onCount
  useEffect(() => { onCount?.(hits.length) }, [hits.length, onCount])
  const currentHit = hits.length > 0 ? hits[Math.min(find?.index ?? 0, hits.length - 1)] : null
  const hitSet = useMemo(() => new Set(hits), [hits])
  useEffect(() => {
    if (!currentHit) return
    const index = items.findIndex((it) => it.key === currentHit)
    if (index >= 0) ref.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
    // Keyed on the hit alone: new messages arriving must not yank the view back.
  }, [currentHit])

  const renderItem = useCallback((index: number, it: Item): ReactNode => {
    const before = it.day ? itemsRef.current[index - firstRef.current - 1] : undefined
    const sep = it.day
      ? <DayChip day={startOfDay(it.day)} prev={before ? startOfDay(before.at) : null} label={dayLabel(it.day, locale, nt('msg.today'), nt('msg.yesterday'))} watch={float.watch} />
      : it.pause !== null
        ? <div className="nx-pause"><span>{pauseText(nt, it.pause)}</span></div>
        : null
    const fresh = isFresh(seen, it.key) && !(it.type !== 'work' && streamed.has(it.msg.id))
    if (it.type === 'work') return <>{sep}<WorkChip item={it} author={authorOf(byId, it.authorId, nt)} /></>
    if (it.type === 'answer') return <>{sep}<AnswerLine msg={it.msg} author={authorOf(byId, it.msg.authorId, nt)} rise={fresh} hl={it.key === currentHit ? 'current' : hitSet.has(it.key) ? 'match' : undefined} /></>
    if (it.type === 'line') {
      return (
        <>
          {sep}
          {it.msg.kind === 'whisper-link' ? <WhisperLine msg={it.msg} /> : <div className="nx-line"><SystemRow msg={it.msg} animate={false} /></div>}
        </>
      )
    }
    return (
      <>
        {sep}
        <Bubble
          msg={it.msg}
          author={authorOf(byId, it.msg.authorId, nt)}
          mine={it.mine}
          pos={it.pos}
          stamp={it.stamp}
          fresh={fresh}
          at={it.at}
          hl={it.key === currentHit ? 'current' : hitSet.has(it.key) ? 'match' : undefined}
          swipe
          tokens
          coarse={coarse}
        />
        <AgendaTurns msgId={it.msg.id} />
      </>
    )
  }, [byId, locale, nt, seen, currentHit, hitSet, float, coarse])

  if (items.length === 0) {
    if (error) return <div className="nx-center"><div className="nx-empty"><b>{nt('msg.loadFailed')}</b><button type="button" className="nx-btn nx-btn--outline" onClick={() => void useMessages.getState().retryLoad(convoId)}>{nt('msg.retry')}</button></div></div>
    if (!loaded) return <TranscriptSkeleton />
  }
  if (!cardsReady) return <TranscriptSkeleton />


  // The floating chips (scroll-to-latest, the waiting pill) sit 8px above the composer.
  const floating = { bottom: bottomInset + 8 }

  return (
    <div className="nx-transcript" onClick={toggleTimes}>
      <Virtuoso
        ref={ref}
        scrollerRef={onScroller}
        className="nx-transcript__scroller"
        data={items}
        firstItemIndex={firstItemIndex}
        // Open at the newest message with its bottom edge in view, like every messenger.
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        alignToBottom
        followOutput={(bottom) => (bottom ? 'smooth' : false)}
        // Rows also grow after layout (a reaction, a loaded image) with nothing
        // appended, which followOutput ignores; without this the newest row
        // slides under the composer.
        totalListHeightChanged={() => onLiveChange(true)}
        atBottomThreshold={96}
        atBottomStateChange={setAtBottom}
        startReached={onStartReached}
        rangeChanged={onRange}
        increaseViewportBy={{ top: 800, bottom: 400 }}
        defaultItemHeight={64}
        computeItemKey={(_, it) => it.key}
        itemContent={renderItem}
        context={{ convoId, bottomInset, onLiveChange, loadingOlder, hasMore, empty: items.length === 0, beginning: nt('msg.beginning'), floatRef: float.bind }}
        components={LIST_COMPONENTS}
      />
      <button
        type="button"
        className="nx-to-latest"
        data-show={!atBottom || undefined}
        style={floating}
        aria-label={nt('msg.latest')}
        onClick={() => ref.current?.scrollToIndex({ index: items.length - 1, align: 'end', behavior: 'smooth' })}
      >
        <IArrowDown />
      </button>
      {waitingId && (
        <button
          type="button"
          className="nx-waiting"
          data-show={away !== null || undefined}
          {...(away === null ? INERT : {})}
          style={floating}
          onClick={() => useApp.getState().jumpToMessage(waitingId)}
        >
          {away === 'down' ? <IArrowDown aria-hidden /> : <IArrowUp aria-hidden />}
          <span>{nt('ask.waiting', { agent: waitingAgent ?? nt('msg.someone') })}</span>
        </button>
      )}
      <TokenDialog />
    </div>
  )
}

function TranscriptSkeleton() {
  return (
    <div className="nx-transcript nx-transcript--skel" aria-busy="true">
      {[62, 38, 74, 50].map((w, i) => (
        <div key={i} className="nx-msg" data-mine={i === 2 || undefined}>
          <div className="nx-msg__gutter">{i !== 2 && <span className="nx-skel" style={{ width: 28, height: 28, borderRadius: 999 }} />}</div>
          <div className="nx-msg__col"><span className="nx-skel" style={{ width: `${w}%`, height: 36, borderRadius: 18 }} /></div>
        </div>
      ))}
    </div>
  )
}
