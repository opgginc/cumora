/**
 * The chat list and the room panel a mouse can resize (ChatsSection). These
 * numbers are the only copy: ChatsSection passes them to `.nx-chats` as custom
 * properties, and shell.css sizes the grid from those.
 */
import type { NKey } from '../i18n'

export interface Edge {
  key: string
  /** Custom properties on `.nx-chats`: the chosen width and the floor. */
  prop: string
  minProp: string
  min: number
  max: number
  /** 1: the column grows as its handle moves right (the chat list); -1: the room panel. */
  dir: 1 | -1
  label: NKey
}

export const LIST: Edge = { key: 'nx.listWidth', prop: '--nx-list-w', minProp: '--nx-list-min', min: 220, max: 480, dir: 1, label: 'chats.resize' }
export const PANEL: Edge = { key: 'nx.panelWidth', prop: '--nx-panel-w', minProp: '--nx-panel-min', min: 320, max: 720, dir: -1, label: 'panel.resize' }
/** The chat column never gets narrower: a drag stops there, and a narrow window squeezes the side columns instead. */
export const CHAT_MIN = 400

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** A stored width as a whole number of pixels inside the column's range, or
 *  null (use the default) for a missing or unreadable value. */
export function parseWidth(raw: string | null, edge: Edge): number | null {
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? clamp(Math.round(n), edge.min, edge.max) : null
}

/** Storage can throw (blocked by the browser); the column then keeps its default. */
export function readWidth(edge: Edge): number | null {
  try {
    return parseWidth(localStorage.getItem(edge.key), edge)
  } catch (e) {
    console.warn('[chats] could not read the column width', e)
    return null
  }
}
