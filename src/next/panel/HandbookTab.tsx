/**
 * The Handbook: one agent's standing files (instructions, memory, skills) as
 * one document, with what changed since a time marked like tracked changes.
 * Each change has a numbered badge and, under it, a note naming the person
 * whose message caused it; the scrubber shows the document as of any change.
 * The room panel shows it for the room's agents (HandbookTab), the agent
 * profile for one agent (Handbook). The data comes from ./handbook.ts.
 *
 * A skill the range did not change folds to its name: skills are reference
 * material, and the shared ones would bury the agent's own files. An opened
 * skill or a long memory file still runs to thousands of lines, so it renders
 * through react-virtuoso against the page's own scroller, as rows that keep
 * their identity while a file does not change.
 *
 * Even so the agent's own instructions alone outrun a phone screen and buried
 * the changes, so the full text starts folded. Above it sit a map of the whole
 * document and an excerpt of every change (./handbookMap.ts); a press on
 * either opens the full text at that row.
 */
import { createContext, forwardRef, Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type ListProps, type VirtuosoHandle } from 'react-virtuoso'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { Conversation } from '@/types'
import { useNT } from '../i18n'
import { dateTime } from '../format'
import { useNearestScroller } from '../hooks'
import { getRoute, href, navigate, useRoute, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { Menu, Spinner, useMenu } from '../ui/primitives'
import { ICheck, IChevronDown, IChevronRight, IDoc, ILibrary, ISpark } from '../ui/icons'
import { useRoomAgents } from '../chat/ChatView'
import { AgentChips, usePickedAgent } from './AgentChips'
import {
  parseSince, SINCES, sinceTime, useHandbook,
  type ChangedLine, type HandbookChange, type HandbookFile, type ReadyHandbook, type SectionKey, type Seg, type Since,
} from './handbook'
import { excerptsOf, mapOf, type Excerpt, type MapColumn } from './handbookMap'

/* ── Rows ───────────────────────────────────────────────────────────── */

type LineStyle = 'text' | 'h1' | 'h2' | 'h3' | 'li' | 'quote' | 'code' | 'meta'

type Row =
  | { kind: 'section'; key: string; section: SectionKey }
  | { kind: 'file'; key: string; file: HandbookFile; fold?: 'open' | 'closed' }
  | { kind: 'same'; key: string; lines: string[]; styles: LineStyle[] }
  | { kind: 'change'; key: string; n: number; lines: ChangedLine[]; styles: LineStyle[] }
  | { kind: 'end'; key: string }

// Unchanged text goes in rows of this many lines: far fewer rows to measure
// than one per line, and each still small enough to render as it scrolls in.
const CHUNK = 24
const LIST_MARK = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/
const SECTION_ICON = { instructions: IDoc, memory: ILibrary, skills: ISpark }
const SECTION_ROWS: Record<SectionKey, Row> = {
  instructions: { kind: 'section', key: 's:instructions', section: 'instructions' },
  memory: { kind: 'section', key: 's:memory', section: 'memory' },
  skills: { kind: 'section', key: 's:skills', section: 'skills' },
}
const END_ROW: Row = { kind: 'end', key: 'end' }

/** Light markdown, line by line: headings, list items, quotes, fenced code
 *  and a leading front-matter block (SKILL.md opens with one). Each call
 *  reads the next line of one text, since fences and front matter span lines. */
function styler() {
  let fence = false
  let meta: 'first' | 'in' | 'done' = 'first'
  return (text: string): LineStyle => {
    if (meta === 'first') {
      meta = text === '---' ? 'in' : 'done'
      if (meta === 'in') return 'meta'
    } else if (meta === 'in') {
      if (text === '---') meta = 'done'
      return 'meta'
    }
    if (/^\s*(```|~~~)/.test(text)) {
      fence = !fence
      return 'code'
    }
    if (fence) return 'code'
    const heading = /^(#{1,6})\s/.exec(text)
    if (heading) return heading[1].length === 1 ? 'h1' : heading[1].length === 2 ? 'h2' : 'h3'
    if (LIST_MARK.test(text)) return 'li'
    if (/^\s*>/.test(text)) return 'quote'
    return 'text'
  }
}

const sideText = (line: Extract<ChangedLine, { op: 'edit' }>, drop: '-' | '+') =>
  line.segs.filter(([op]) => op !== drop).map(([, s]) => s).join('')
const newText = (line: ChangedLine) => (line.op === 'edit' ? sideText(line, '-') : line.text)

// A file the poll handed back unchanged keeps its rows, so they skip rendering.
const fileRows = new WeakMap<HandbookFile, Row[]>()

function rowsOfFile(file: HandbookFile): Row[] {
  const cached = fileRows.get(file)
  if (cached) return cached
  // The old text and the new one are styled apart: a removed fence closes a
  // block only in the old text.
  const before = styler()
  const after = styler()
  const rows: Row[] = [{ kind: 'file', key: `f:${file.key}`, file }]
  file.parts.forEach((part, p) => {
    if ('same' in part) {
      for (let i = 0; i < part.same.length; i += CHUNK) {
        const lines = part.same.slice(i, i + CHUNK)
        rows.push({ kind: 'same', key: `l:${file.key}:${p}:${i}`, lines, styles: lines.map((t) => { before(t); return after(t) }) })
      }
    } else {
      const styles = part.lines.map((l) => {
        if (l.op === 'del') return before(l.text)
        if (l.op === 'edit') before(sideText(l, '+'))
        return after(newText(l))
      })
      rows.push({ kind: 'change', key: `c:${file.key}:${p}`, n: part.change, lines: part.lines, styles })
    }
  })
  fileRows.set(file, rows)
  return rows
}

// One header object per fold state, so opening a skill re-renders only its rows.
const foldRows = { open: new WeakMap<HandbookFile, Row>(), closed: new WeakMap<HandbookFile, Row>() }
function foldRow(file: HandbookFile, fold: 'open' | 'closed'): Row {
  let row = foldRows[fold].get(file)
  if (!row) foldRows[fold].set(file, (row = { kind: 'file', key: `f:${file.key}`, file, fold }))
  return row
}

function rowsOf(data: ReadyHandbook, open: ReadonlySet<string>): Row[] {
  if (data.sections.length === 0) return []
  return [
    ...data.sections.flatMap((s) => [SECTION_ROWS[s.key], ...s.files.flatMap((f) => {
      if (s.key !== 'skills' || f.parts.some((p) => !('same' in p))) return rowsOfFile(f)
      return open.has(f.key) ? [foldRow(f, 'open'), ...rowsOfFile(f).slice(1)] : [foldRow(f, 'closed')]
    })]),
    END_ROW,
  ]
}

/** Opens or folds an unchanged skill; stable, so rows never re-render for it. */
const FoldContext = createContext<(fileKey: string) => void>(() => {})

/** How many changes the document as of `at` (null: now) shows. */
function stepOf(changes: HandbookChange[], at: string | null): number {
  if (at === null) return changes.length
  let k = 0
  while (k < changes.length && changes[k].at <= at) k++
  return k
}

/* ── Document ───────────────────────────────────────────────────────── */

const DocContext = createContext<{ changes: Map<number, HandbookChange>; agentId: string; docked: boolean } | null>(null)

/** A docked panel sits beside the chat, so its room only scrolls; otherwise
 *  the panel or the profile covers the chat, so this goes to the room. */
function openMessage(conversationId: string, messageId: string, docked: boolean): void {
  const r = getRoute()
  if (!(docked && r.section === 'chats' && r.id === conversationId)) navigate(href({ section: 'chats', id: conversationId }))
  // ChatView consumes this once the transcript is mounted.
  useApp.getState().jumpToMessage(messageId)
}

function Note({ n }: { n: number }) {
  const nt = useNT()
  const locale = useLocale()
  const me = useMe()
  const ctx = useContext(DocContext)
  const change = ctx?.changes.get(n)
  const ask = change?.instruction ?? null
  const author = useParticipants((s) => (ask ? s.byId[ask.authorId] : undefined))
  const agent = useParticipants((s) => (change?.agentId ? s.byId[change.agentId] : undefined))
  if (!ctx || !change) return null

  // Who: the person who asked, or the agent that did it unasked.
  const face = ask ? author : agent
  const asker = ask ? (ask.authorId === me ? nt('handbook.you') : author?.name ?? nt('msg.someone')) : null
  // A shared skill can change in another agent's run; say whose.
  const via = change.agentId !== null && change.agentId !== ctx.agentId ? agent?.name ?? nt('msg.someone') : null
  const who = asker && via ? nt('handbook.toAgent', { author: asker, agent: via }) : asker ?? agent?.name ?? null
  const what = ask ? (ask.visible ? ask.text ?? '' : nt('handbook.otherRoom')) : change.agentId ? nt('handbook.onItsOwn') : nt('handbook.noRun')
  const body = (
    <>
      <span className="nx-hb-note__n nx-mono">{n}</span>
      {face && <Avatar p={face} size={16} />}
      <span className="nx-hb-note__text">
        {who && <b>{who}</b>}
        {who && ' · '}
        <time className="nx-mono" dateTime={ask?.at ?? change.at}>{dateTime(ask?.at ?? change.at, locale)}</time>
        {what && ` · ${what}`}
      </span>
    </>
  )
  const target = ask?.visible && ask.conversationId && ask.messageId ? { room: ask.conversationId, message: ask.messageId } : null
  return target ? (
    <button type="button" className="nx-hb-note" onClick={() => openMessage(target.room, target.message, ctx.docked)} title={nt('handbook.openMessage')}>
      {body}
    </button>
  ) : <div className="nx-hb-note">{body}</div>
}

/** One line; a list item hangs its wrapped text after the marker. A whole
 *  line removed or added is marked as one. */
function Line({ text, s, op }: { text: string; s: LineStyle; op?: 'del' | 'ins' }) {
  const Mark = op === 'del' ? 'del' : op === 'ins' ? 'ins' : 'span'
  const mark = s === 'li' ? LIST_MARK.exec(text) : null
  if (mark) {
    return (
      <div className="nx-hb-line nx-hb-line--li" data-s={s} data-op={op}>
        <Mark className="nx-hb-line__mark">{mark[1]}</Mark>
        <Mark>{mark[2]}</Mark>
      </div>
    )
  }
  return <div className="nx-hb-line" data-s={s} data-op={op}>{op ? <Mark>{text}</Mark> : text}</div>
}

const segsView = (segs: Seg[]) =>
  segs.map(([op, text], i) => (op === '=' ? <span key={i}>{text}</span> : op === '-' ? <del key={i}>{text}</del> : <ins key={i}>{text}</ins>))

function Changed({ line, s }: { line: ChangedLine; s: LineStyle }) {
  if (line.op !== 'edit') return <Line text={line.text} s={s} op={line.op} />
  // A list item whose marker the edit left alone hangs like an unchanged one.
  const mark = s === 'li' ? LIST_MARK.exec(newText(line)) : null
  const [first, ...more] = line.segs
  if (mark && first?.[0] === '=' && first[1].startsWith(mark[1])) {
    return (
      <div className="nx-hb-line nx-hb-line--li" data-s={s} data-op="edit">
        <span className="nx-hb-line__mark">{mark[1]}</span>
        <span>{segsView([['=', first[1].slice(mark[1].length)], ...more])}</span>
      </div>
    )
  }
  return <div className="nx-hb-line" data-s={s} data-op="edit">{segsView(line.segs)}</div>
}

const RowView = memo(function RowView({ row }: { row: Row }) {
  const nt = useNT()
  const toggle = useContext(FoldContext)
  if (row.kind === 'section') {
    const Icon = SECTION_ICON[row.section]
    return <h3 className="nx-hb-section"><Icon aria-hidden />{nt(`handbook.section.${row.section}`)}</h3>
  }
  if (row.kind === 'file' && row.fold) {
    const f = row.file
    return (
      <button
        type="button"
        className="nx-hb-file nx-hb-file--fold"
        aria-expanded={row.fold === 'open'}
        onClick={() => toggle(f.key)}
      >
        <IChevronDown aria-hidden />
        {/* SKILL.md sits in a folder named after the skill. */}
        <span className="nx-hb-file__name">{f.path.split('/').at(-2) ?? f.path}</span>
        {f.shared && <span className="nx-chip">{nt('handbook.shared')}</span>}
      </button>
    )
  }
  if (row.kind === 'file') {
    const f = row.file
    return (
      <div className="nx-hb-file">
        <span className="nx-hb-file__path nx-mono">{f.path}</span>
        {f.shared && <span className="nx-chip">{nt('handbook.shared')}</span>}
        {f.state === 'created' && <span className="nx-chip" data-tone="ins">{nt('handbook.created')}</span>}
        {f.state === 'deleted' && <span className="nx-chip" data-tone="del">{nt('handbook.deleted')}</span>}
      </div>
    )
  }
  if (row.kind === 'same') return <div className="nx-hb-lines">{row.lines.map((t, i) => <Line key={i} text={t} s={row.styles[i]} />)}</div>
  if (row.kind === 'change') {
    return (
      <div className="nx-hb-lines nx-hb-change">
        <span className="nx-hb-badge nx-mono">{row.n}</span>
        {row.lines.map((l, i) => <Changed key={i} line={l} s={row.styles[i]} />)}
        <Note n={row.n} />
      </div>
    )
  }
  return <div className="nx-hb-end" />
})

/** The document card is the list itself, so its surface spans every row,
 *  rendered or not. */
const DocList = forwardRef<HTMLDivElement, ListProps>(function DocList({ style, children, 'data-testid': testId }, ref) {
  return <div ref={ref} style={style} data-testid={testId} className="nx-hb-doc">{children}</div>
})
const COMPONENTS = { List: DocList }

/* ── Map and excerpts ───────────────────────────────────────────────── */

// An excerpt shows this many lines; the full text has the rest.
const EXCERPT_LINES = 6
// ponytail: only the newest excerpts render, as plain DOM; virtualize them
// if the older ones ever need reading here rather than in the full text.
const EXCERPTS = 20

/** A press on a column reads from the line under the pointer; a keyboard
 *  press, which has no pointer position, from the top. */
const HandbookMap = memo(function HandbookMap({ columns, onPick }: { columns: MapColumn[]; onPick: (row: number) => void }) {
  const nt = useNT()
  return (
    <div className="nx-hb-map">
      <div className="nx-hb-map__cols">
        {columns.map((c) => {
          const name = nt(`handbook.section.${c.section}`)
          return (
            <button
              key={c.section}
              type="button"
              className="nx-hb-map__col"
              aria-label={nt('handbook.readSection', { section: name })}
              onClick={(e) => {
                const box = e.detail ? e.currentTarget.lastElementChild?.getBoundingClientRect() : undefined
                const i = box ? Math.min(Math.max(Math.floor(((e.clientY - box.top) / box.height) * c.bars.length), 0), c.bars.length - 1) : -1
                onPick(c.bars[i]?.row ?? c.row)
              }}
            >
              <span className="nx-hb-map__label">
                <span className="nx-hb-map__name">{name}</span>
                {c.changes.slice(0, 2).map((n) => <span key={n} className="nx-hb-badge nx-mono">{n}</span>)}
                {c.changes.length > 2 && <span className="nx-mono">+{c.changes.length - 2}</span>}
              </span>
              <span className="nx-hb-map__bars" aria-hidden>
                {c.bars.map((b, i) => <i key={i} data-mark={b.mark ?? undefined} style={{ width: `${b.width}%` }} />)}
              </span>
            </button>
          )
        })}
      </div>
      <p className="nx-hb-map__hint">{nt('handbook.mapHint')}</p>
    </div>
  )
})

type ChangeRow = Extract<Row, { kind: 'change' }>

/** A change as it reads in the full text, cut to its first lines. */
const ExcerptView = memo(function ExcerptView({ ex, rows, onOpen }: { ex: Excerpt; rows: Row[]; onOpen: (row: number) => void }) {
  const nt = useNT()
  // `gap`: the same change also touched another place in the file.
  const lines = ex.rows.flatMap((r, i) => {
    const h = rows[r] as ChangeRow
    return h.lines.map((line, j) => ({ line, s: h.styles[j], gap: i > 0 && j === 0 }))
  })
  const open = () => onOpen(ex.rows[0])
  return (
    <div className="nx-hb-ex__item">
      <button type="button" className="nx-hb-file nx-hb-ex__head" onClick={open} title={nt('handbook.showInText')}>
        <span className="nx-hb-badge nx-mono">{ex.n}</span>
        <span className="nx-hb-file__path nx-mono">{ex.file.path}</span>
        <span className="nx-hb-ex__at nx-mono">{nt('handbook.atLine', { n: ex.line })}</span>
        <IChevronRight aria-hidden />
      </button>
      <div className="nx-hb-lines">
        {lines.slice(0, EXCERPT_LINES).map((x, k) => (
          <Fragment key={k}>
            {x.gap && <div className="nx-hb-ex__gap" aria-hidden>⋯</div>}
            <Changed line={x.line} s={x.s} />
          </Fragment>
        ))}
      </div>
      {lines.length > EXCERPT_LINES && (
        <button type="button" className="nx-hb-ex__more" onClick={open}>{nt('handbook.allLines', { n: lines.length })}</button>
      )}
      <Note n={ex.n} />
    </div>
  )
})

/* ── Toolbar ────────────────────────────────────────────────────────── */

function SinceMenu({ since }: { since: Since }) {
  const nt = useNT()
  const menu = useMenu()
  return (
    <>
      <button
        type="button"
        className="nx-btn nx-btn--sm nx-btn--outline nx-hb-since"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={(e) => menu.toggleFrom(e.currentTarget)}
      >
        {nt(`handbook.since.${since}`)}
        <IChevronDown />
      </button>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[
          { label: nt('handbook.since') },
          ...SINCES.map((k) => ({
            key: k,
            label: nt(`handbook.since.${k}`),
            // An empty icon keeps the labels in line with the checked one.
            icon: k === since ? <ICheck /> : <svg aria-hidden />,
            onSelect: () => navigate(withRoute(getRoute(), { params: { since: k === 'today' ? null : k, at: null } }), { replace: true }),
          })),
        ]}
      />
    </>
  )
}

/** One stop per change; the far right is now, which keeps following new
 *  changes. Dragging moves the thumb at once and asks for the document once
 *  the finger rests. */
function Scrubber({ changes, at }: { changes: HandbookChange[]; at: string | null }) {
  const nt = useNT()
  const locale = useLocale()
  const n = changes.length
  const [draft, setDraft] = useState<number | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const input = useRef<HTMLInputElement>(null)
  // The URL caught up with the drag.
  useEffect(() => setDraft(null), [at])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // On the phone the panel's swipe-back layer claims any sideways touch from
  // its own native listener; a drag that starts on the scrubber is the scrubber's.
  useEffect(() => {
    const el = input.current
    if (!el) return
    const keep = (e: TouchEvent) => e.stopPropagation()
    el.addEventListener('touchstart', keep, { passive: true })
    return () => el.removeEventListener('touchstart', keep)
  }, [])
  const value = Math.min(draft ?? stepOf(changes, at), n)
  const label = value >= n ? nt('handbook.now')
    : value === 0 ? nt('handbook.beforeFirst')
      : nt('handbook.stepAt', { time: dateTime(changes[value - 1].at, locale), n: value })
  const commit = (step: number) => {
    // Step 0 is the document just before the first change.
    const iso = step >= n ? null : step === 0 ? new Date(Date.parse(changes[0].at) - 1).toISOString() : changes[step - 1].at
    navigate(withRoute(getRoute(), { params: { at: iso } }), { replace: true })
    // A drag that ends where it started leaves the URL as it was, so `at` never
    // changes to clear the draft; clear it here.
    setDraft(null)
  }
  return (
    <div className="nx-hb-scrub">
      <div className="nx-hb-scrub__track">
        <div className="nx-hb-scrub__rail" aria-hidden>
          <span className="nx-hb-scrub__fill" style={{ transform: `scaleX(${n ? value / n : 1})` }} />
          {changes.map((c, i) => <i key={c.n} style={{ left: `${((i + 1) / n) * 100}%` }} data-on={i < value || undefined} />)}
        </div>
        <input
          ref={input}
          type="range"
          className="nx-hb-scrub__input"
          min={0}
          max={n}
          step={1}
          value={value}
          aria-label={nt('handbook.scrubber')}
          aria-valuetext={label}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (v === value) return
            setDraft(v)
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => commit(v), 200)
          }}
        />
      </div>
      <span className="nx-hb-scrub__label">{label}</span>
    </div>
  )
}

/* ── States ─────────────────────────────────────────────────────────── */

function Skeleton() {
  return (
    <div className="nx-hb" aria-busy="true">
      <div className="nx-hb-bar">
        <span className="nx-skel" style={{ width: 168, height: 28 }} />
      </div>
      <div className="nx-hb-doc nx-hb-doc--skel">
        {[40, 88, 72, 0, 32, 80, 64, 56].map((w, i) => (w ? <span key={i} className="nx-skel" style={{ width: `${w}%`, height: 12 }} /> : <span key={i} style={{ height: 12 }} />))}
      </div>
    </div>
  )
}

/* ── Handbook ───────────────────────────────────────────────────────── */

function Document({ data, agentId, since, at, stale, failed, retry, docked }: {
  data: ReadyHandbook
  agentId: string
  since: Since
  at: string | null
  stale: boolean
  failed: boolean
  retry: () => void
  docked: boolean
}) {
  const nt = useNT()
  const name = useParticipants((s) => s.byId[agentId]?.name ?? '')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((fileKey: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (!next.delete(fileKey)) next.add(fileKey)
    return next
  }), [])
  const rows = useMemo(() => rowsOf(data, open), [data, open])
  const changes = useMemo(() => new Map(data.changes.map((c) => [c.n, c])), [data.changes])
  const ctx = useMemo(() => ({ changes, agentId, docked }), [changes, agentId, docked])
  const shown = stepOf(data.changes, at)
  // The page's scroller holds the document, so it scrolls as one surface.
  const [scroller, root] = useNearestScroller()
  const map = useMemo(() => mapOf(rows), [rows])
  const excerpts = useMemo(() => excerptsOf(rows), [rows])
  const [full, setFull] = useState(false)
  const [target, setTarget] = useState<{ row: number; top: number } | null>(null)
  const list = useRef<VirtuosoHandle>(null)
  const bar = useRef<HTMLDivElement>(null)
  const show = useCallback((row: number) => {
    setFull(true)
    // The sticky bar covers the top of the scroller, so the row lands under
    // it. A new object each time, so pressing the same spot scrolls again.
    setTarget({ row, top: bar.current?.offsetHeight ?? 0 })
  }, [])
  // Runs after the commit that mounts the list when the full text was folded.
  useEffect(() => {
    if (target) list.current?.scrollToIndex({ index: target.row, align: 'start', offset: -target.top })
  }, [target])

  // An agent with no files on the computer has nothing to compare either.
  if (rows.length === 0 && data.changes.length === 0) return <div className="nx-empty">{nt('handbook.empty', { name })}</div>
  return (
    <div ref={root} className="nx-hb" data-stale={stale || undefined}>
      <div ref={bar} className="nx-hb-bar">
        <div className="nx-hb-bar__top">
          <span className="nx-hb-bar__label">{nt('handbook.since')}</span>
          <SinceMenu since={since} />
          <span className="nx-hb-bar__count" aria-live="polite">
            {stale && <Spinner label={nt('handbook.loading')} />}
            {shown === 0 ? nt('handbook.noChanges') : shown === 1 ? nt('handbook.oneChange') : nt('handbook.changes', { n: shown })}
          </span>
        </div>
        {data.changes.length > 0 && <Scrubber changes={data.changes} at={at} />}
        {failed && <button type="button" className="nx-hb-retry" onClick={retry}>{nt('handbook.refreshFailed')}</button>}
      </div>
      {rows.length === 0 ? (
        <div className="nx-empty">{nt('handbook.empty', { name })}</div>
      ) : scroller && (
        <DocContext.Provider value={ctx}>
          <HandbookMap columns={map} onPick={show} />
          {excerpts.length > 0 && (
            <div className="nx-hb-ex">
              {excerpts.slice(0, EXCERPTS).map((ex) => <ExcerptView key={ex.n} ex={ex} rows={rows} onOpen={show} />)}
              {excerpts.length > EXCERPTS && <p className="nx-hb-ex__older">{nt('handbook.olderChanges', { n: excerpts.length - EXCERPTS })}</p>}
            </div>
          )}
          <button type="button" className="nx-hb-file nx-hb-file--fold" aria-expanded={full} onClick={() => setFull((f) => !f)}>
            <IChevronDown aria-hidden />
            <span className="nx-hb-file__name">{nt('handbook.fullText')}</span>
          </button>
          {full && <FoldContext.Provider value={toggle}>
            <Virtuoso
              ref={list}
              customScrollParent={scroller}
              data={rows}
              computeItemKey={(_, r) => r.key}
              itemContent={(_, r) => <RowView row={r} />}
              components={COMPONENTS}
              increaseViewportBy={{ top: 400, bottom: 800 }}
            />
          </FoldContext.Provider>}
        </DocContext.Provider>
      )}
    </div>
  )
}

/** One agent's handbook. `docked`: the chat stays in view beside it. */
export const Handbook = memo(function Handbook({ agentId, docked = false }: { agentId: string; docked?: boolean }) {
  const nt = useNT()
  const route = useRoute()
  const since = parseSince(route.search.get('since'))
  const rawAt = route.search.get('at')
  const at = rawAt && Number.isFinite(Date.parse(rawAt)) ? new Date(rawAt).toISOString() : null
  const { data, current, error, retry } = useHandbook(agentId, sinceTime(since), at)

  if (error === 'locked') {
    return <div className="nx-empty"><b>{nt('handbook.locked')}</b>{nt('handbook.lockedBody')}</div>
  }
  if (!data) {
    if (!error) return <Skeleton />
    return (
      <div className="nx-empty" role="alert">
        <b>{nt('handbook.loadFailed')}</b>
        <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" onClick={retry}>{nt('handbook.retry')}</button>
      </div>
    )
  }
  if (!data.available) {
    return <div className="nx-empty"><b>{nt('handbook.unavailable')}</b>{nt('handbook.unavailableBody')}</div>
  }
  return (
    <Document data={data} agentId={agentId} since={since} at={at} stale={!current} failed={error === 'failed'} retry={retry} docked={docked} />
  )
})

/** The room panel's tab: the handbook of one of the room's agents, picked
 *  with chips (`?agent=`) when there are several. */
export function HandbookTab({ c, docked }: { c: Conversation; docked: boolean }) {
  const nt = useNT()
  const { agents } = useRoomAgents(c)
  const agent = usePickedAgent(agents)
  if (!agent) return <div className="nx-empty">{nt('panel.noAgents')}</div>
  return (
    <>
      <AgentChips agents={agents} picked={agent} />
      <Handbook key={agent.id} agentId={agent.id} docked={docked} />
    </>
  )
}
