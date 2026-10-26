/**
 * Building blocks shared by the You screens: the group list, rows, choice
 * lists, copyable commands, and the URL helpers that keep dialogs and
 * disclosures in query params so Back closes them.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore,
  type ReactNode, type SVGProps,
} from 'react'
import { Virtuoso } from 'react-virtuoso'
import { api } from '@/api/client'
import { copyText } from '@/lib/clipboard'
import { detectLocale, LOCALES, useLocaleStore, type Locale } from '@/lib/i18n'
import { useAuth } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { usePrefs } from '@/stores/preferences'
import type { Participant } from '@/types'
import { haptic } from '../../haptics'
import { useNT, type NKey, type NT } from '../../i18n'
import { getRoute, goBack, navigate, withRoute, type Route } from '../../router'
import { Spinner, Switch } from '../../ui/primitives'
import { IActivity, IBell, ICheck, IComputer, ICopy, IFolder, IInfo, IUsers } from '../../ui/icons'

/* ── Icons the shared set lacks (same 24px grid, 1.5 stroke) ─────────── */
type P = SVGProps<SVGSVGElement>
const base: P = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
  'aria-hidden': true,
}
const IUserCircle = (p: P) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.2 18.4a6.5 6.5 0 0 1 11.6 0" /></svg>
const IKey = (p: P) => <svg {...base} {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M14 9l2 2" /></svg>
const IGlobe = (p: P) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
const IContrast = (p: P) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor" /></svg>
const IShield = (p: P) => <svg {...base} {...p}><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6Z" /><path d="m9 12 2 2 4-4" /></svg>
const ICode = (p: P) => <svg {...base} {...p}><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></svg>
export const ISwap = (p: P) => <svg {...base} {...p}><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" /></svg>
export const ICloud = (p: P) => <svg {...base} {...p}><path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.3 9.1 4.5 4.5 0 0 0 7 18Z" /></svg>
export const IServer = (p: P) => <svg {...base} {...p}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>

/* ── Groups ─────────────────────────────────────────────────────────── */
export type GroupKey =
  | 'profile' | 'account' | 'appearance' | 'language' | 'notifications'
  | 'workspace' | 'computers' | 'trust' | 'projects' | 'usage' | 'developer' | 'about'

/** Overview order. The clusters are only spacing; they carry no heading. */
export const CLUSTERS: GroupKey[][] = [
  ['profile', 'account'],
  ['appearance', 'language', 'notifications'],
  ['workspace', 'computers', 'trust', 'projects', 'usage'],
  ['developer', 'about'],
]

const GROUP_SET = new Set<string>(CLUSTERS.flat())

export function isGroup(id: string): id is GroupKey {
  return GROUP_SET.has(id)
}

export const GROUP_ICON: Record<GroupKey, ReactNode> = {
  profile: <IUserCircle />,
  account: <IKey />,
  appearance: <IContrast />,
  language: <IGlobe />,
  notifications: <IBell />,
  workspace: <IUsers />,
  computers: <IComputer />,
  trust: <IShield />,
  projects: <IFolder />,
  usage: <IActivity />,
  developer: <ICode />,
  about: <IInfo />,
}

export function roleKey(role: string): NKey {
  return role === 'owner' ? 'me.role.owner' : role === 'admin' ? 'me.role.admin' : 'me.role.member'
}

/** English needs a singular form; the other locales reuse the plural key. */
export function count(nt: NT, n: number, one: NKey, other: NKey): string {
  return n === 1 ? nt(one) : nt(other, { n })
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/* ── URL state ──────────────────────────────────────────────────────── */
const SHEET_PARAMS = { sheet: null, of: null, engine: null, via: null }

/** Open a dialog. It is a history entry, so Back closes it. */
export function openSheet(route: Route, sheet: string, extra: Record<string, string> = {}): void {
  navigate(withRoute(route, { params: { sheet, ...extra } }))
}

/** Close dialog `sheet` if it is still the one in the URL: a slow request
 *  must not pop whatever the user opened in the meantime. */
export function closeSheet(sheet: string): void {
  const r = getRoute()
  if (r.search.get('sheet') !== sheet) return
  goBack(withRoute(r, { params: SHEET_PARAMS }))
}

/** Leave the dialog without a Back step, for actions that remount the app
 *  (switching workspace): the remounted screen must not reopen it. */
export function dropSheet(): void {
  navigate(withRoute(getRoute(), { params: SHEET_PARAMS }), { replace: true })
}

/** Filters and disclosures change in place, without a history entry. */
export function setParams(route: Route, params: Record<string, string | null>): void {
  navigate(withRoute(route, { params }), { replace: true })
}

/* ── People ─────────────────────────────────────────────────────────── */
/** Someone who has no participant row yet still gets an initial avatar. */
export function personOf(id: string, name: string, avatarUrl?: string | null): Participant {
  return {
    id,
    kind: 'human',
    name,
    initial: (name.trim().charAt(0) || '?').toUpperCase(),
    avatarBg: 'var(--primary)',
    avatarUrl: avatarUrl ?? null,
    status: 'resting',
  }
}

/** The signed-in user as a participant; the participant cache can lag the
 *  auth user, so fall back to the auth record. */
export function useMePerson(): Participant | null {
  const user = useAuth((s) => s.user)
  const stored = useParticipants((s) => (user ? s.byId[user.id] : undefined))
  return useMemo(() => (user ? stored ?? personOf(user.id, user.name) : null), [user, stored])
}

/* ── Locale: lib/i18n stores an explicit pick; no entry = follow the browser ── */
const LOCALE_KEY = 'cumora.locale'
const autoListeners = new Set<() => void>()

function readAuto(): boolean {
  try {
    return localStorage.getItem(LOCALE_KEY) === null
  } catch {
    return false
  }
}

function subscribeAuto(cb: () => void): () => void {
  autoListeners.add(cb)
  const off = useLocaleStore.subscribe(cb)
  return () => {
    autoListeners.delete(cb)
    off()
  }
}

export function useAutoLocale(): boolean {
  return useSyncExternalStore(subscribeAuto, readAuto)
}

export function localeLabel(code: Locale): string {
  return LOCALES.find((l) => l.code === code)?.label ?? code
}

export function chooseLocale(choice: Locale | 'auto'): void {
  const { setLocale } = useLocaleStore.getState()
  if (choice !== 'auto') {
    setLocale(choice)
  } else {
    setLocale(detectLocale())
    // setLocale persisted the pick; removing it is what makes the next start detect again.
    try { localStorage.removeItem(LOCALE_KEY) } catch (e) { console.warn('[me] could not clear the stored locale', e) }
  }
  for (const l of autoListeners) l()
}

/* ── Server preferences ─────────────────────────────────────────────── */
/** usePrefs.setPref swallows failures; a toggle here must roll back. */
export async function savePref(key: string, value: unknown): Promise<void> {
  const before = usePrefs.getState().prefs[key]
  usePrefs.setState((s) => ({ prefs: { ...s.prefs, [key]: value } }))
  try {
    await api.putPreferences(usePrefs.getState().prefs)
  } catch (e) {
    usePrefs.setState((s) => ({ prefs: { ...s.prefs, [key]: before } }))
    throw e
  }
}

/** Same for the autonomy threshold (usePrefs.setAutonomy only logs). */
export async function saveAutonomy(agentId: string, threshold: number): Promise<void> {
  const before = usePrefs.getState().autonomy[agentId]
  const userId = useAuth.getState().user?.id ?? ''
  usePrefs.setState((s) => ({
    autonomy: {
      ...s.autonomy,
      [agentId]: { ...(before ?? { userId, agentId, pulled: 0, led: 0, dissolved: 0 }), threshold },
    },
  }))
  try {
    await api.putAutonomy(agentId, threshold)
  } catch (e) {
    usePrefs.setState((s) => {
      const autonomy = { ...s.autonomy }
      if (before) autonomy[agentId] = before
      else delete autonomy[agentId]
      return { autonomy }
    })
    throw e
  }
}

/** App.tsx loads preferences at boot. A page that needs them retries a boot
 *  load that has not landed and says so when that fails too; the store
 *  swallows errors, so success is read back from `loaded`. Saving before
 *  the load would PUT a partial map over the server's. */
export function usePrefsLoad(): { loaded: boolean; failed: boolean; retry: () => void } {
  const loaded = usePrefs((s) => s.loaded)
  const [failed, setFailed] = useState(false)
  const retry = useCallback(() => {
    setFailed(false)
    void usePrefs.getState().load().then(() => setFailed(!usePrefs.getState().loaded))
  }, [])
  useEffect(() => {
    if (!usePrefs.getState().loaded) retry()
  }, [retry])
  return { loaded, failed: failed && !loaded, retry }
}

/* ── Layout pieces ──────────────────────────────────────────────────── */
export function Block({ title, hint, children }: { title?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="nx-me-block">
      {(title || hint) && (
        <header className="nx-me-block__head">
          {title && <h2>{title}</h2>}
          {hint && <p>{hint}</p>}
        </header>
      )}
      {children}
    </section>
  )
}

/** `sep` draws the divider for rows a virtualized list renders, which are
 *  not siblings in the DOM. */
export function Row({ label, hint, children, sep }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; sep?: boolean }) {
  return (
    <div className="nx-me-row" data-sep={sep || undefined}>
      <span className="nx-me-row__text">
        <span className="nx-me-row__label">{label}</span>
        {hint && <span className="nx-me-row__hint">{hint}</span>}
      </span>
      {children}
    </div>
  )
}

/** The label wraps the switch, so a click on the text toggles it too. */
export function SwitchRow({ label, hint, checked, onChange, disabled, busy, error }: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  busy?: boolean
  error?: string | null
}) {
  return (
    <div className="nx-me-switch">
      <label className="nx-me-row" data-disabled={disabled || undefined}>
        <span className="nx-me-row__text">
          <span className="nx-me-row__label">{label}</span>
          {hint && <span className="nx-me-row__hint">{hint}</span>}
        </span>
        {busy && <Spinner />}
        <Switch label={label} checked={checked} onChange={onChange} disabled={disabled || busy} />
      </label>
      {error && <p className="nx-me-row__error" role="alert">{error}</p>}
    </div>
  )
}

/** A boolean server preference: flips at once, rolls back if the save fails. */
export function PrefRow({ k, def, label, hint }: { k: string; def: boolean; label: string; hint?: string }) {
  const nt = useNT()
  const loaded = usePrefs((s) => s.loaded)
  const stored = usePrefs((s) => s.prefs[k])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const on = stored === undefined ? def : Boolean(stored)
  return (
    <SwitchRow
      label={label}
      hint={hint}
      checked={on}
      disabled={!loaded}
      busy={busy}
      error={error}
      onChange={async (v) => {
        setBusy(true)
        setError(null)
        try {
          await savePref(k, v)
        } catch (e) {
          setError(nt('me.saveFailed', { error: errorText(e) }))
        } finally {
          setBusy(false)
        }
      }}
    />
  )
}

interface ChoiceItem<K extends string> {
  key: K
  label: string
  hint?: string
  icon?: ReactNode
  /** Language of the label, for names written in their own language. */
  lang?: string
}

export function Choices<K extends string>({ label, items, value, onChange }: {
  label: string
  items: Array<ChoiceItem<K>>
  value: K
  onChange: (k: K) => void
}) {
  return (
    <div className="nx-me-card" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="radio"
          aria-checked={it.key === value}
          className="nx-me-row nx-me-choice"
          onClick={() => onChange(it.key)}
        >
          {it.icon && <span className="nx-me-choice__icon">{it.icon}</span>}
          <span className="nx-me-row__text">
            <span className="nx-me-row__label" lang={it.lang}>{it.label}</span>
            {it.hint && <span className="nx-me-row__hint">{it.hint}</span>}
          </span>
          <ICheck className="nx-me-choice__check" />
        </button>
      ))}
    </div>
  )
}

export function ErrorLine({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const nt = useNT()
  return (
    <div className="nx-me-error" role="alert">
      <span>{message}</span>
      {onRetry && <button type="button" className="nx-btn nx-btn--sm nx-btn--outline" onClick={onRetry}>{nt('me.retry')}</button>}
    </div>
  )
}

export function Pending({ children }: { children: ReactNode }) {
  return <p className="nx-me-pending" aria-live="polite"><Spinner />{children}</p>
}

export function SkeletonRows({ n = 3 }: { n?: number }) {
  return (
    <div className="nx-me-card" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="nx-me-row">
          <span className="nx-me-row__text">
            <span className="nx-skel" style={{ width: '40%', height: 12 }} />
            <span className="nx-skel" style={{ width: '70%', height: 10 }} />
          </span>
        </div>
      ))}
    </div>
  )
}

/** A command or link to copy. Copying can fail (no focus, no permission),
 *  so the text stays selectable and the failure is said out loud. */
export function CopyCode({ value }: { value: string }) {
  const nt = useNT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => setState('idle'), [value])
  useEffect(() => {
    if (state !== 'copied') return
    const id = window.setTimeout(() => setState('idle'), 1600)
    return () => window.clearTimeout(id)
  }, [state])
  return (
    <div className="nx-me-copy">
      <pre className="nx-me-code">{value}</pre>
      <button
        type="button"
        className="nx-btn nx-btn--outline nx-btn--sm"
        aria-live="polite"
        onClick={() => {
          copyText(value).then(
            () => setState('copied'),
            () => { haptic('error'); setState('failed') },
          )
        }}
      >
        {state === 'copied' ? <ICheck /> : <ICopy />}
        {state === 'copied' ? nt('me.copied') : nt('me.copy')}
      </button>
      {state === 'failed' && <p className="nx-me-row__error" role="alert">{nt('me.copyFailed')}</p>}
    </div>
  )
}

/* ── Long lists ─────────────────────────────────────────────────────── */
const ScrollParent = createContext<HTMLElement | null>(null)
export const ScrollParentProvider = ScrollParent.Provider

/** Virtualized against the page's own scroller, so a long list (members,
 *  invitations, projects) scrolls with the page as one surface. */
export function LongList<T>({ items, itemKey, children }: {
  items: T[]
  itemKey: (item: T) => string
  children: (item: T, index: number) => ReactNode
}) {
  const parent = useContext(ScrollParent)
  if (!parent) return null
  return (
    <Virtuoso
      customScrollParent={parent}
      data={items}
      computeItemKey={(_, item) => itemKey(item)}
      itemContent={(i, item) => children(item, i)}
    />
  )
}
