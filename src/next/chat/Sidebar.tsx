import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react'
import { motion } from 'framer-motion'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { api } from '@/api/client'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { isMuted, useConversations } from '@/stores/conversations'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { useLocale, useT } from '@/lib/i18n'
import { PreviewText } from '@/components/PreviewText'
import { GroupCreator } from '@/components/GroupCreator'
import type { Conversation, Participant } from '@/types'
import { useNT } from '../i18n'
import { href, linkClick, navigate } from '../router'
import { listStamp } from '../format'
import { haptic } from '../haptics'
import { openPalette, useHold } from '../hooks'
import { Avatar, AvatarStack } from '../ui/Avatar'
import { Dialog, IconButton, INERT, Menu, MOD, Spinner, T_FAST, useCoarse, useMenu, type MenuAnchor, type MenuEntry } from '../ui/primitives'
import {
  IAgents, IArrowDown, IArrowLeft, IArrowRight, IArrowUp, IBellOff, IChecks, IChevronDown, ICompose, IEye, IEyeOff, IFolder, IHash, IMail,
  IPencil, IPin, IPlus, ISearch, ITrash, IUsers, IExit,
} from '../ui/icons'
import { OTHER_GROUP, useRoomLayout, type Category } from './roomLayout'

/** Our own drag payloads, so files or text dragged over the list are ignored,
 *  and a dragged category header never lands where a room would. */
const ROOM_MIME = 'application/x-nx-room'
const CATEGORY_MIME = 'application/x-nx-category'
const carriesRoom = (e: DragEvent) => e.dataTransfer.types.includes(ROOM_MIME)
const carriesCategory = (e: DragEvent) => e.dataTransfer.types.includes(CATEGORY_MIME)

type Side = 'before' | 'after'
/** Where a dragged tile or category header would land: before or after the
 *  hovered one. A tiny store, so only the hovered item re-renders its line. */
const useTileDrop = create<{ id: string | null; side: Side | null }>(() => ({ id: null, side: null }))
const useCategoryDrop = create<{ key: string | null; side: Side | null }>(() => ({ key: null, side: null }))
/** Left or right half of a tile, top or bottom half of a header. Read in a
 *  dragover handler, never in a render or an animation frame. */
const sideOf = (e: DragEvent, axis: 'x' | 'y'): Side => {
  const r = e.currentTarget.getBoundingClientRect()
  return axis === 'x' ? (e.clientX < r.left + r.width / 2 ? 'before' : 'after') : (e.clientY < r.top + r.height / 2 ? 'before' : 'after')
}

/** Rooms the chat list shows: no whispers, and no 1:1 room whose other
 *  member has left. Deleting an agent off-boards it, and a removed member
 *  leaves too; their rooms keep their history on the server, and re-hiring
 *  the agent clears departedAt, which brings its room back. */
function listed(c: Conversation, gone: (participantId: string) => boolean): boolean {
  return c.kind !== 'whisper' && !(c.kind === 'direct' && c.members.some(gone))
}

/** Pinned rooms in tile order: the person's own order first, then pins it does
 *  not know yet (pinned on another device, or by another member, since a pin
 *  is shared) in the list's own order. */
function byTileOrder(pinned: Conversation[], order: string[]): Conversation[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return pinned
    .map((c, i) => ({ c, rank: rank.get(c.id) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.c)
}

/** The tiles' ids as they are on screen right now. */
function tileIds(): string[] {
  const byId = useParticipants.getState().byId
  const pinned = useConversations.getState().list.filter((c) => c.pinned && listed(c, (m) => Boolean(byId[m]?.departedAt)))
  return byTileOrder(pinned, useRoomLayout.getState().pinOrder).map((c) => c.id)
}

/** Move a category to `index` among the visible categories, counted without
 *  it. Positions are REAL on the server, so the move writes one row: the
 *  midpoint of its new neighbours. */
function moveCategoryTo(id: string, index: number): void {
  const rest = useRoomLayout.getState().categories.filter((c) => !c.hidden && c.id !== id)
  const before = rest[index - 1]?.position
  const after = rest[index]?.position
  // ponytail: each midpoint halves a gap, so about 50 moves into the same gap
  // exhaust a double's precision; renumber every position if anyone gets there.
  const position = before === undefined
    ? (after === undefined ? 1 : after - 1)
    : (after === undefined ? before + 1 : (before + after) / 2)
  useRoomLayout.getState().moveCategory(id, position)
}

/** Clear the unread badge of every listed room, locally first, like opening each. */
function markAllRead(ids: string[]): void {
  const s = useConversations.getState()
  for (const id of ids) {
    if (!s.list.find((c) => c.id === id)?.unread) continue
    s.markLocallyRead(id)
    void api.markRead(id).catch((e) => console.warn('[next] mark read failed', e))
  }
}

/** The room's face wherever a room is listed: the peer for a 1:1, the
 *  agents for a group, a glyph otherwise. */
export function RoomGlyph({ c, size = 36 }: { c: Conversation; size?: number }) {
  const me = useMe()
  const peerId = c.kind === 'direct' ? c.members.find((m) => m !== me) ?? c.members[0] : null
  const peer = useParticipants((s) => (peerId ? s.byId[peerId] : undefined))
  const faces = useParticipants(useShallow((s) => (c.kind === 'group'
    ? c.members.map((id) => s.byId[id]).filter((p): p is Participant => Boolean(p) && p.kind === 'agent').slice(0, 2)
    : [])))
  if (c.kind === 'direct' && peer) return <Avatar p={peer} size={size} presence />
  if (c.kind === 'email') return <span className="nx-room-glyph"><IMail /></span>
  if (faces.length >= 2) return <span className="nx-room-glyph nx-room-glyph--faces"><AvatarStack ps={faces} size={Math.round((size * 2) / 3)} max={2} /></span>
  return <span className="nx-room-glyph"><IHash /></span>
}

/** Next-morning / next-Monday mute presets, same as the classic sidebar. */
function muteUntil(kind: 'hour' | 'tomorrow' | 'week'): Date {
  const d = new Date()
  if (kind === 'hour') return new Date(d.getTime() + 3600_000)
  if (kind === 'tomorrow') {
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d
  }
  d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7))
  d.setHours(9, 0, 0, 0)
  return d
}

/** Start loading a room's messages when a pointer heads for it, so the
 *  click lands on a warm cache and the transcript paints without a skeleton.
 *  Loading is not reading: App.tsx marks a room read only once it is shown. */
function prefetch(id: string): void {
  const s = useMessages.getState()
  if (!s.loaded.has(id) && !s.loading.has(id)) void s.loadConversation(id)
}

/** Pin state is a conversation column on the server; flip it locally first so
 *  a drop lands instantly, then let the reload confirm it. */
function flipPin(id: string, pinned: boolean): void {
  useConversations.setState((s) => ({ list: s.list.map((c) => (c.id === id ? { ...c, pinned } : c)) }))
  void api.togglePin(id, pinned)
    .catch((e) => console.warn('[next] pin failed', e))
    .finally(() => void useConversations.getState().reload())
}

/** Put a room at `index` among the tiles (counted without it), pinning it
 *  first when it is not pinned yet. */
function placeTile(id: string, index: number): void {
  const order = tileIds().filter((x) => x !== id)
  order.splice(index, 0, id)
  useRoomLayout.getState().setPinOrder(order)
  if (!useConversations.getState().list.find((c) => c.id === id)?.pinned) flipPin(id, true)
}

/** A new pin lands at the end of the tiles; an unpinned room leaves the order. */
function setPinned(id: string, pinned: boolean): void {
  const order = tileIds().filter((x) => x !== id)
  if (pinned) {
    placeTile(id, order.length)
    return
  }
  useRoomLayout.getState().setPinOrder(order)
  flipPin(id, false)
}

/** File a room under a category (null for Other), out of the pinned row. */
function fileRoom(id: string, categoryId: string | null): void {
  if (useConversations.getState().list.find((c) => c.id === id)?.pinned) setPinned(id, false)
  useRoomLayout.getState().moveRoom(id, categoryId)
}

/** The list's one menu and the dialogs it opens. They render once in the
 *  sidebar rather than in the row, so an action that moves or removes the row
 *  that opened them (Move to, Pin, Delete category) leaves them to animate
 *  out instead of unmounting them with it. */
interface ListMenuState {
  /** What the menu and dialogs act on. It outlives the menu, so a dialog the
   *  menu opened still knows its room or category. A group (a category, or
   *  Other) carries its rooms and their unread total from when it was opened. */
  target: { room: string } | { group: string; rooms: string[]; unread: number } | null
  anchor: MenuAnchor | null
  dialog: 'group' | 'category' | 'rename' | null
}
const useListMenu = create<ListMenuState>(() => ({ target: null, anchor: null, dialog: null }))
const openListMenu = (target: NonNullable<ListMenuState['target']>, x: number, y: number) => useListMenu.setState({ target, anchor: { x, y } })

/** The frame that marks a drag as started; dragend cancels it if it comes first. */
let dragFrame = 0

/** Drag source props for rooms and tiles. Touch has no mouse drag; it moves
 *  rooms from the hold menu instead, which keeps long-press free for that. */
function useDragSource(id: string) {
  const coarse = useCoarse()
  const dragging = useRoomLayout((s) => s.dragging === id)
  if (coarse) return {}
  return {
    draggable: true,
    'data-dragging': dragging || undefined,
    onDragStart: (e: DragEvent) => {
      // Drop the link's own URL payload, or the composer would accept the
      // drop as text; and drag the row itself, not Chrome's URL chip.
      e.dataTransfer.clearData()
      e.dataTransfer.setData(ROOM_MIME, id)
      const r = e.currentTarget.getBoundingClientRect()
      e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
      e.dataTransfer.effectAllowed = 'move'
      // The browser takes the drag image right after this handler returns. A
      // commit before that would fade the ghost and grow drop zones under the
      // pointer, so the drag state lands on the next frame.
      dragFrame = requestAnimationFrame(() => useRoomLayout.getState().setDragging(id))
    },
    onDragEnd: () => {
      cancelAnimationFrame(dragFrame)
      useTileDrop.setState({ id: null, side: null })
      useRoomLayout.getState().setDragging(null)
    },
  }
}

const endCategoryDrag = () => {
  cancelAnimationFrame(dragFrame)
  useCategoryDrop.setState({ key: null, side: null })
  useRoomLayout.getState().setDraggingCategory(null)
}

/** Drag source props for a category header. Mouse only, like rooms: touch
 *  moves a category from its header's long-press menu. */
function useCategoryDragSource(id: string | null) {
  const coarse = useCoarse()
  const dragging = useRoomLayout((s) => id !== null && s.draggingCategory === id)
  if (coarse || id === null) return {}
  return {
    draggable: true,
    'data-dragging': dragging || undefined,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.clearData()
      e.dataTransfer.setData(CATEGORY_MIME, id)
      const r = e.currentTarget.getBoundingClientRect()
      e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top)
      e.dataTransfer.effectAllowed = 'move'
      // Every group folds to its header while one moves, so the whole order
      // fits on screen. The fold waits a frame for the same reason a room drag
      // does: the browser takes the drag image right after this handler.
      dragFrame = requestAnimationFrame(() => useRoomLayout.getState().setDraggingCategory(id))
    },
    onDragEnd: endCategoryDrag,
  }
}

/** Drop target props; `over` lights the target while a room hovers it. */
function useDropTarget(onDrop: (e: DragEvent) => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carriesRoom(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        setOver(false)
        // A dropped row often moves to another list and unmounts, so its own
        // dragend never fires; the drop ends the drag instead.
        useRoomLayout.getState().setDragging(null)
        onDrop(e)
      },
    },
  }
}

/** `onSubmit` returns a promise when the server has to answer first: the
 *  dialog stays open and busy until then, and keeps the name on failure. */
function CategoryDialog({ open, initial = '', title, action, onClose, onSubmit }: {
  open: boolean
  initial?: string
  title: string
  action: string
  onClose: () => void
  onSubmit: (name: string) => Promise<boolean> | undefined
}) {
  const nt = useNT()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open) return
    setName(initial)
    setFailed(false)
  }, [open, initial])
  const value = name.trim()
  // Closing mid-request would leave its outcome nowhere to show.
  const close = () => { if (!busy) onClose() }
  return (
    <Dialog open={open} onClose={close} title={title}>
      <form
        className="nx-category-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!value || busy) return
          const pending = onSubmit(value)
          if (!pending) {
            onClose()
            return
          }
          setBusy(true)
          setFailed(false)
          void pending.then((ok) => {
            haptic(ok ? 'success' : 'error')
            setBusy(false)
            if (ok) onClose()
            else setFailed(true)
          })
        }}
      >
        <input
          className="nx-input"
          autoFocus
          value={name}
          maxLength={60}
          placeholder={nt('chats.categoryName')}
          aria-label={nt('chats.categoryName')}
          onChange={(e) => setName(e.target.value)}
        />
        {failed && <p className="nx-category-form__error" role="alert">{nt('chats.createCategoryFailed')}</p>}
        <div className="nx-category-form__actions">
          <button type="button" className="nx-btn" disabled={busy} onClick={close}>{nt('common.cancel')}</button>
          <button type="submit" className="nx-btn nx-btn--primary" disabled={!value || busy} aria-busy={busy || undefined}>
            {busy && <Spinner />}{action}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** Menu entries that move a tile one place along the tile row. */
function tileMoves(id: string, nt: ReturnType<typeof useNT>): MenuEntry[] {
  const order = tileIds()
  const at = order.indexOf(id)
  if (at < 0) return []
  return [
    ...(at > 0 ? [{ key: 'left', label: nt('chats.moveLeft'), icon: <IArrowLeft />, onSelect: () => placeTile(id, at - 1) }] : []),
    ...(at < order.length - 1 ? [{ key: 'right', label: nt('chats.moveRight'), icon: <IArrowRight />, onSelect: () => placeTile(id, at + 1) }] : []),
  ]
}

/** The shared host for room and category menus (see `useListMenu`). */
function ListMenu() {
  const nt = useNT()
  const t = useT()
  const me = useMe()
  const { target, anchor, dialog } = useListMenu()
  const roomId = target && 'room' in target ? target.room : null
  const group = target && 'group' in target ? target : null
  const room = useConversations((s) => (roomId ? s.list.find((c) => c.id === roomId) : undefined))
  const category = useRoomLayout((s) => (group ? s.categories.find((k) => k.id === group.group) : undefined))
  const categories = useRoomLayout((s) => s.categories)
  const current = useRoomLayout((s) => (roomId ? s.rooms[roomId] ?? null : null))
  const close = useCallback(() => useListMenu.setState({ anchor: null }), [])
  const closeDialog = useCallback(() => useListMenu.setState({ dialog: null }), [])
  const run = (fn: () => Promise<unknown>) => () => {
    void fn().then(() => useConversations.getState().reload()).catch((e) => console.warn('[next] room action failed', e))
  }

  let entries: MenuEntry[] = []
  if (room) {
    const c = room
    entries = [
      { key: 'pin', label: c.pinned ? t('convo.unpin') : t('convo.pin'), icon: <IPin />, onSelect: () => setPinned(c.id, !c.pinned) },
      // Touch has no tile drag, so a tile moves from its long-press menu.
      ...(c.pinned ? tileMoves(c.id, nt) : []),
      ...(isMuted(c)
        ? [{ key: 'unmute', label: t('convo.unmute'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, false, null)) }]
        : [
            { key: 'm1', label: nt('chats.muteHour'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, muteUntil('hour').toISOString())) },
            { key: 'm2', label: nt('chats.muteTomorrow'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, muteUntil('tomorrow').toISOString())) },
            { key: 'm3', label: nt('chats.muteForever'), icon: <IBellOff />, onSelect: run(() => api.setMute(c.id, true, null)) },
          ]),
      ...(c.pinned
        ? []
        : [
            'sep' as const,
            { label: nt('chats.moveTo') },
            ...categories.filter((k) => k.id !== current).map((k) => ({ key: `cat-${k.id}`, label: k.name, icon: k.hidden ? <IEyeOff /> : <IFolder />, onSelect: () => fileRoom(c.id, k.id) })),
            ...(current ? [{ key: 'cat-other', label: nt('chats.other'), icon: <IFolder />, onSelect: () => fileRoom(c.id, null) }] : []),
            { key: 'cat-new', label: nt('chats.newCategory'), icon: <IPlus />, onSelect: () => useListMenu.setState({ dialog: 'category' }) },
          ]),
      ...(c.kind === 'direct'
        ? ['sep' as const, { key: 'group', label: nt('chats.newGroupWith'), icon: <IUsers />, onSelect: () => useListMenu.setState({ dialog: 'group' }) }]
        : []),
      ...(c.kind === 'group'
        ? ['sep' as const, { key: 'leave', label: t('convo.leaveGroup'), icon: <IExit />, danger: true, onSelect: () => {
            if (window.confirm(nt('chats.leaveConfirm', { name: c.title }))) void run(() => api.leaveConversation(c.id))()
          } }]
        : []),
    ]
  } else if (group) {
    const k = category
    const visible = categories.filter((x) => !x.hidden)
    const at = k ? visible.findIndex((x) => x.id === k.id) : -1
    const read: MenuEntry[] = group.unread > 0
      ? [{ key: 'read', label: nt('chats.markAllRead'), icon: <IChecks />, onSelect: () => markAllRead(group.rooms) }]
      : []
    // Other has no name to change and always sits last, so it only gets Mark all as read.
    entries = k
      ? [
          { key: 'rename', label: nt('chats.renameCategory'), icon: <IPencil />, onSelect: () => useListMenu.setState({ dialog: 'rename' }) },
          ...(at > 0 ? [{ key: 'up', label: nt('chats.moveUp'), icon: <IArrowUp />, onSelect: () => moveCategoryTo(k.id, at - 1) }] : []),
          ...(at >= 0 && at < visible.length - 1 ? [{ key: 'down', label: nt('chats.moveDown'), icon: <IArrowDown />, onSelect: () => moveCategoryTo(k.id, at + 1) }] : []),
          ...read,
          'sep',
          k.hidden
            ? { key: 'show', label: nt('chats.showCategory'), icon: <IEye />, onSelect: () => useRoomLayout.getState().setHidden(k.id, false) }
            : { key: 'hide', label: nt('chats.hideCategory'), icon: <IEyeOff />, onSelect: () => useRoomLayout.getState().setHidden(k.id, true) },
          'sep',
          { key: 'delete', label: nt('chats.deleteCategory'), icon: <ITrash />, danger: true, onSelect: () => {
            if (window.confirm(nt('chats.deleteCategoryConfirm', { name: k.name }))) useRoomLayout.getState().deleteCategory(k.id)
          } },
        ]
      : read
  }

  const renaming = dialog === 'rename'
  return (
    <>
      <Menu open={anchor !== null} anchor={anchor} onClose={close} entries={entries} />
      {dialog === 'group' && room && <GroupCreator onClose={closeDialog} initialPicked={room.members.filter((m) => m !== me)} />}
      <CategoryDialog
        open={dialog === 'category' || renaming}
        initial={renaming ? category?.name : ''}
        title={nt(renaming ? 'chats.renameCategory' : 'chats.newCategory')}
        action={nt(renaming ? 'chats.save' : 'chats.create')}
        onClose={closeDialog}
        onSubmit={(name) => {
          if (renaming) {
            if (category) useRoomLayout.getState().renameCategory(category.id, name)
            return undefined
          }
          // A new category files the room it was asked for from, if any.
          return useRoomLayout.getState().createCategory(name).then((cat) => {
            if (cat && roomId) fileRoom(roomId, cat.id)
            return cat !== null
          })
        }}
      />
    </>
  )
}

/** A tile is a drop target too: a dragged room or tile lands before or after
 *  it, which pins the room there or moves the tile. */
function useTileTarget(id: string) {
  const coarse = useCoarse()
  const dragging = useRoomLayout((s) => s.dragging !== null)
  const side = useTileDrop((s) => (s.id === id ? s.side : null))
  if (coarse) return { side: null, props: {} }
  return {
    side: dragging ? side : null,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carriesRoom(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        const next = useRoomLayout.getState().dragging === id ? null : sideOf(e, 'x')
        const now = useTileDrop.getState()
        if (now.id !== id || now.side !== next) useTileDrop.setState({ id, side: next })
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && useTileDrop.getState().id === id) useTileDrop.setState({ id: null, side: null })
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const moved = e.dataTransfer.getData(ROOM_MIME)
        const after = useTileDrop.getState().side === 'after' ? 1 : 0
        useTileDrop.setState({ id: null, side: null })
        // The moved tile remounts in its new place, so its own dragend may not fire.
        useRoomLayout.getState().setDragging(null)
        if (moved && moved !== id) placeTile(moved, tileIds().filter((x) => x !== moved).indexOf(id) + after)
      },
    },
  }
}

const RoomTile = memo(function RoomTile({ c, active }: { c: Conversation; active: boolean }) {
  const hold = useHold((x, y) => openListMenu({ room: c.id }, x, y))
  const drag = useDragSource(c.id)
  const target = useTileTarget(c.id)
  const unread = c.unread ?? 0
  const muted = isMuted(c)
  return (
    <a
      href={href({ section: 'chats', id: c.id })}
      onClick={(e) => linkClick(e, { replace: active })}
      className="nx-tile"
      title={c.title}
      data-haptic
      aria-current={active ? 'page' : undefined}
      data-drop-side={target.side ?? undefined}
      {...hold}
      {...drag}
      {...target.props}
      onPointerEnter={() => prefetch(c.id)}
      onTouchStart={(e) => { prefetch(c.id); hold.onTouchStart(e) }}
    >
      <span className="nx-tile__face">
        <RoomGlyph c={c} size={40} />
        {unread > 0 && <span className={muted ? 'nx-badge nx-badge--muted nx-tile__badge' : 'nx-badge nx-tile__badge'}>{unread > 99 ? '99+' : unread}</span>}
      </span>
      <span className="nx-tile__name">{c.title}</span>
    </a>
  )
})

/** A room or tile dropped on the tile row itself (not on one tile) goes to the end. */
function dropOnTiles(e: DragEvent): void {
  const id = e.dataTransfer.getData(ROOM_MIME)
  if (id) placeTile(id, tileIds().filter((x) => x !== id).length)
}

/** The pin target that floats over the top of the list while a room is
 *  dragged, either alone (nothing pinned yet) or under a tile row whose last
 *  line is full. Its anchor is sticky and zero-height, so no row moves. */
function PinDropZone() {
  const nt = useNT()
  const drop = useDropTarget(dropOnTiles)
  return (
    <div className="nx-pin-drop">
      <div className="nx-pin-drop__zone" data-drop={drop.over || undefined} {...drop.props}>{nt('chats.dropToPin')}</div>
    </div>
  )
}

/** How many tiles fit on a line, from the grid's computed tracks. Measured
 *  when the row resizes, never during a drag. */
function useGridColumns(ref: RefObject<HTMLElement>): number {
  const [cols, setCols] = useState(4)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').length)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return cols
}

/** Pinned rooms sit on top as tiles and wrap onto new lines as they grow.
 *  While a room is dragged, the row shows where a drop pins it: a Pin slot in
 *  the last line's free space, or the floating zone when that line is full. */
function PinnedTiles({ rooms, activeId }: { rooms: Conversation[]; activeId: string | null }) {
  const dragging = useRoomLayout((s) => s.dragging !== null)
  if (rooms.length === 0) return dragging ? <PinDropZone /> : null
  return <TileRow rooms={rooms} activeId={activeId} dragging={dragging} />
}

function TileRow({ rooms, activeId, dragging }: { rooms: Conversation[]; activeId: string | null; dragging: boolean }) {
  const nt = useNT()
  const ref = useRef<HTMLElement>(null)
  const cols = useGridColumns(ref)
  const drop = useDropTarget(dropOnTiles)
  const slot = rooms.length % cols !== 0
  return (
    <>
      <section ref={ref} className="nx-tiles" aria-label={nt('chats.pinned')} data-drop={drop.over || undefined} {...drop.props}>
        {rooms.map((c) => <RoomTile key={c.id} c={c} active={c.id === activeId} />)}
        {dragging && slot && (
          <span className="nx-tile nx-tile--slot" aria-hidden="true">
            <span className="nx-tile__face"><IPin /></span>
            <span className="nx-tile__name">{nt('chats.pinSlot')}</span>
          </span>
        )}
      </section>
      {dragging && !slot && <PinDropZone />}
    </>
  )
}

const RoomRow = memo(function RoomRow({ c, active }: { c: Conversation; active: boolean }) {
  const nt = useNT()
  const t = useT()
  const locale = useLocale()
  const typingIds = useMessages((s) => s.typing[c.id])
  const typingName = useParticipants((s) => {
    const id = typingIds?.find((x) => s.byId[x]?.kind === 'agent')
    return id ? s.byId[id]?.name : undefined
  })
  const hold = useHold((x, y) => openListMenu({ room: c.id }, x, y))
  const drag = useDragSource(c.id)
  const muted = isMuted(c)
  const unread = c.unread ?? 0

  return (
    <a
      href={href({ section: 'chats', id: c.id })}
      onClick={(e) => linkClick(e, { replace: active })}
      className="nx-room"
      aria-current={active ? 'page' : undefined}
      data-haptic
      data-unread={unread > 0 && !muted ? '' : undefined}
      {...hold}
      {...drag}
      onPointerEnter={() => prefetch(c.id)}
      onTouchStart={(e) => { prefetch(c.id); hold.onTouchStart(e) }}
    >
      {active && <motion.span layoutId="nx-room-sel" className="nx-room__sel" transition={T_FAST} />}
      <RoomGlyph c={c} />
      <span className="nx-room__main">
        <span className="nx-room__top">
          <span className="nx-room__title">{c.title}</span>
          {muted && <IBellOff className="nx-room__muted" aria-label={t('convo.muted')} />}
          <span className="nx-room__time nx-mono">{listStamp(c.lastAtIso, locale)}</span>
        </span>
        <span className="nx-room__bottom">
          {typingName ? (
            <span className="nx-room__preview nx-shimmer">{nt('chats.isWorking', { name: typingName })}</span>
          ) : (
            <span className="nx-room__preview">{c.preview ? <PreviewText body={c.preview} emojiSize={13} /> : nt('chats.noMessages')}</span>
          )}
          {unread > 0 && <span className={muted ? 'nx-badge nx-badge--muted' : 'nx-badge'}>{unread > 99 ? '99+' : unread}</span>}
        </span>
      </span>
    </a>
  )
})

interface Group {
  key: string
  /** Null for the only group when no category exists: the list needs no header. */
  label: string | null
  rooms: Conversation[]
  category?: Category
}

/** A header is where a dragged category lands: before or after it, or, on
 *  Other's header, at the end of the categories (Other always stays last). */
function useCategoryTarget(g: Group) {
  const side = useCategoryDrop((s) => (s.key === g.key ? s.side : null))
  const accepts = g.category ? !g.category.hidden : g.key === OTHER_GROUP
  if (!accepts) return { side: null, props: {} }
  return {
    side,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!carriesCategory(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const next = !g.category ? 'before' : useRoomLayout.getState().draggingCategory === g.key ? null : sideOf(e, 'y')
        const now = useCategoryDrop.getState()
        if (now.key !== g.key || now.side !== next) useCategoryDrop.setState({ key: g.key, side: next })
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && useCategoryDrop.getState().key === g.key) useCategoryDrop.setState({ key: null, side: null })
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        const id = e.dataTransfer.getData(CATEGORY_MIME)
        const after = useCategoryDrop.getState().side === 'after' ? 1 : 0
        // Re-sorting moves the dragged header in the DOM, so its dragend may not fire.
        endCategoryDrag()
        if (!id || id === g.key) return
        const rest = useRoomLayout.getState().categories.filter((c) => !c.hidden && c.id !== id)
        moveCategoryTo(id, g.category ? rest.findIndex((c) => c.id === g.key) + after : rest.length)
      },
    },
  }
}

function GroupSection({ g, activeId }: { g: Group; activeId: string | null }) {
  const nt = useNT()
  const coarse = useCoarse()
  // While a category header is dragged every group folds to its header, so the
  // whole order fits on screen; the stored collapsed state is left alone.
  const collapsed = useRoomLayout((s) => g.label !== null && (s.draggingCategory !== null || s.collapsed.includes(g.key)))
  const unread = g.rooms.reduce((n, c) => n + (isMuted(c) ? 0 : c.unread ?? 0), 0)
  const hold = useHold((x, y) => {
    const total = g.rooms.reduce((n, c) => n + (c.unread ?? 0), 0)
    // Other's menu has nothing but Mark all as read.
    if (g.category || total > 0) openListMenu({ group: g.key, rooms: g.rooms.map((c) => c.id), unread: total }, x, y)
  })
  const drag = useCategoryDragSource(g.category && !g.category.hidden ? g.category.id : null)
  const headTarget = useCategoryTarget(g)
  const drop = useDropTarget((e) => {
    const id = e.dataTransfer.getData(ROOM_MIME)
    if (id) fileRoom(id, g.category?.id ?? null)
  })
  return (
    <section
      className="nx-group"
      aria-label={g.label ?? undefined}
      data-collapsed={collapsed || undefined}
      data-hidden={g.category?.hidden || undefined}
      data-drop={drop.over || undefined}
      {...drop.props}
    >
      {g.label !== null && (
        <h2 className="nx-group__head" data-drop-side={headTarget.side ?? undefined} {...headTarget.props}>
          <button
            type="button"
            className="nx-group__toggle"
            aria-expanded={!collapsed}
            onClick={() => useRoomLayout.getState().toggleCollapsed(g.key)}
            {...hold}
            {...drag}
          >
            <IChevronDown className="nx-group__chev" />
            <span className="nx-group__label">{g.label}</span>
            {g.category?.hidden && <IEyeOff className="nx-group__hidden" />}
            {collapsed && unread > 0 && <span className="nx-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
        </h2>
      )}
      {/* Collapsing animates grid rows 1fr → 0fr: the browser interpolates the
          height without a JS measurement (a layout pass per frame, see shell.css). */}
      <div className="nx-group__body" {...(collapsed ? INERT : {})}>
        <div className="nx-group__inner">
          {g.rooms.map((c) => <RoomRow key={c.id} c={c} active={c.id === activeId} />)}
          {/* Touch has no mouse drag; rooms move from their long-press menu. */}
          {g.rooms.length === 0 && <div className="nx-group__empty">{nt(coarse ? 'chats.holdToMove' : 'chats.dragHere')}</div>}
        </div>
      </div>
    </section>
  )
}

/** Hidden categories leave the list; this one quiet row at its foot counts
 *  them, carries their unread total and opens them below itself. */
function HiddenGroups({ groups, activeId }: { groups: Group[]; activeId: string | null }) {
  const nt = useNT()
  const [open, setOpen] = useState(false)
  if (groups.length === 0) return null
  const unread = groups.reduce((n, g) => n + g.rooms.reduce((m, c) => m + (isMuted(c) ? 0 : c.unread ?? 0), 0), 0)
  return (
    <>
      <button type="button" className="nx-hidden-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IEyeOff />
        <span className="nx-hidden-row__label">{nt('chats.hiddenCount', { n: groups.length })}</span>
        {unread > 0 && <span className="nx-badge nx-badge--muted">{unread > 99 ? '99+' : unread}</span>}
        <IChevronDown className="nx-hidden-row__chev" />
      </button>
      {open && groups.map((g) => <GroupSection key={g.key} g={g} activeId={activeId} />)}
    </>
  )
}

/** Dropping a room here asks for a name and files the room under it. */
function NewCategoryDrop() {
  const nt = useNT()
  const drop = useDropTarget((e) => {
    const id = e.dataTransfer.getData(ROOM_MIME)
    if (id) useListMenu.setState({ target: { room: id }, dialog: 'category' })
  })
  const dragging = useRoomLayout((s) => s.dragging !== null)
  if (!dragging) return null
  return (
    <div className="nx-group-new" data-drop={drop.over || undefined} {...drop.props}>
      <IPlus />{nt('chats.dropNewCategory')}
    </div>
  )
}

/** Retries the layout load, showing the wait on the button itself. */
function LayoutRetry() {
  const nt = useNT()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="nx-group-error"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        setBusy(true)
        void useRoomLayout.getState().load().finally(() => setBusy(false))
      }}
    >
      {busy && <Spinner />}{nt('chats.layoutError')}
    </button>
  )
}

function RoomList({ activeId }: { activeId: string | null }) {
  const nt = useNT()
  const list = useConversations((s) => s.list)
  const loaded = useConversations((s) => s.loaded)
  const layout = useRoomLayout(useShallow((s) => ({ status: s.status, categories: s.categories, rooms: s.rooms, pinOrder: s.pinOrder })))
  const dragging = useRoomLayout((s) => s.dragging !== null)
  const departed = useParticipants(useShallow((s) => Object.values(s.byId).filter((p) => p.departedAt).map((p) => p.id)))

  const { pinned, groups, hidden } = useMemo(() => {
    const gone = new Set(departed)
    const rooms = list.filter((c) => listed(c, (m) => gone.has(m)))
    const byCategory = new Map(layout.categories.map((k) => [k.id, [] as Conversation[]]))
    const other: Conversation[] = []
    for (const c of rooms) {
      if (c.pinned) continue
      const bucket = byCategory.get(layout.rooms[c.id] ?? '')
      if (bucket) bucket.push(c)
      else other.push(c)
    }
    const toGroup = (k: Category): Group => ({ key: k.id, label: k.name, rooms: byCategory.get(k.id) ?? [], category: k })
    const out = layout.categories.filter((k) => !k.hidden).map(toGroup)
    out.push({ key: OTHER_GROUP, label: layout.categories.length > 0 ? nt('chats.other') : null, rooms: other })
    return {
      pinned: byTileOrder(rooms.filter((c) => c.pinned), layout.pinOrder),
      groups: out,
      hidden: layout.categories.filter((k) => k.hidden).map(toGroup),
    }
  }, [list, layout, departed, nt])

  // Hold the skeleton until the layout arrives too, so rooms never jump into
  // their categories after first paint.
  if (!loaded || layout.status === 'idle') {
    return (
      <div className="nx-rooms" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="nx-room nx-room--skel">
            <span className="nx-skel" style={{ width: 36, height: 36, borderRadius: 999 }} />
            <span className="nx-room__main">
              <span className="nx-skel" style={{ width: '60%', height: 12 }} />
              <span className="nx-skel" style={{ width: '85%', height: 10 }} />
            </span>
          </div>
        ))}
      </div>
    )
  }
  if (pinned.length === 0 && groups.every((g) => g.rooms.length === 0) && layout.categories.length === 0) {
    return <div className="nx-empty"><b>{nt('chats.emptyTitle')}</b>{nt('chats.emptyBody')}</div>
  }
  return (
    <>
      <PinnedTiles rooms={pinned} activeId={activeId} />
      {layout.status === 'error' && <LayoutRetry />}
      <div className="nx-rooms">
        {groups
          // An empty Other only shows up as a drop target while dragging.
          .filter((g) => g.rooms.length > 0 || g.category || (dragging && g.key === OTHER_GROUP))
          .map((g) => <GroupSection key={g.key} g={g} activeId={activeId} />)}
        <NewCategoryDrop />
        <HiddenGroups groups={hidden} activeId={activeId} />
      </div>
    </>
  )
}

export function Sidebar({ activeId }: { activeId: string | null }) {
  const nt = useNT()
  const menu = useMenu()
  const [creating, setCreating] = useState(false)
  // The layout is per person and edited from every device, so it is fetched
  // again whenever the app comes back to the foreground.
  useEffect(() => {
    const load = () => void useRoomLayout.getState().load()
    load()
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  return (
    <aside className="nx-sidebar" aria-label={nt('chats.title')}>
      <header className="nx-sidebar__head">
        <h1>{nt('chats.title')}</h1>
        <IconButton label={nt('chats.search')} shortcut={`${MOD}K`} tipPlace="below" ring onClick={() => openPalette()}>
          <ISearch />
        </IconButton>
        <IconButton label={nt('chats.new')} tipPlace="below" ring onClick={(e) => menu.toggleFrom(e.currentTarget, 'end')}>
          <IPlus />
        </IconButton>
      </header>
      <div className="nx-sidebar__scroll nx-scroll">
        <RoomList activeId={activeId} />
      </div>
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        entries={[
          { key: 'dm', label: nt('chats.newDirect'), icon: <ICompose />, onSelect: () => openPalette('people') },
          { key: 'group', label: nt('chats.newGroup'), icon: <IUsers />, onSelect: () => setCreating(true) },
          { key: 'mail', label: nt('chats.newEmail'), icon: <IMail />, onSelect: () => useApp.getState().openComposeNew() },
          // The Agents section's hire dialog; closing it comes back here.
          { key: 'agent', label: nt('chats.newAgent'), icon: <IAgents />, onSelect: () => navigate(href({ section: 'agents', params: { new: '1' } })) },
          'sep',
          { key: 'category', label: nt('chats.newCategory'), icon: <IFolder />, onSelect: () => useListMenu.setState({ target: null, dialog: 'category' }) },
        ]}
      />
      {creating && <GroupCreator onClose={() => setCreating(false)} />}
      <ListMenu />
    </aside>
  )
}
