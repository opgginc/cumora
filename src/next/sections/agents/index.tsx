/**
 * Agents section: the roster beside one agent's page on wide windows; on
 * narrow windows the page is pushed over the roster (swipe back). Everything
 * open is in the URL: `/next/agents/:id`, `?filter=`, `?view=`, and the dialogs
 * `?new=1`, `?edit=1`, `?offboard=1`, `?purge=1`, so Back closes whatever was
 * opened last.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useTransform } from 'framer-motion'
import { api, http } from '@/api/client'
import { useParticipants } from '@/stores/participants'
import { useSwipeBackProps } from '@/mobile/useSwipeBack'
import type { SectionProps } from '../types'
import { haptic } from '../../haptics'
import { useNT } from '../../i18n'
import { getRoute, goBack, linkClick, navigate, withRoute, type Route } from '../../router'
import { Dialog, IconButton, SPRING_SHEET, Spinner, T_FAST } from '../../ui/primitives'
import { IAgents, IChevronLeft, IPlus } from '../../ui/icons'
import { DIALOG_PARAMS, dialogHref, errorText, listHref, NO_DIALOG, refreshRoster, useRoster } from './shared'
import { AgentList } from './List'
import { AgentProfile } from './Profile'
import { LookEditor } from './LookStudio'

/** Closes a URL-opened dialog exactly once. Esc reaches both `Dialog` and the
 *  classic AgentEditor's own key listener; a second goBack in the same tick
 *  would pop the profile too. */
function useCloseDialog(route: Route): () => void {
  const closing = useRef(false)
  const key = route.search.toString()
  useEffect(() => { closing.current = false }, [key])
  return useCallback(() => {
    const r = getRoute()
    if (closing.current || !DIALOG_PARAMS.some((k) => r.search.has(k))) return
    closing.current = true
    goBack(withRoute(r, { params: NO_DIALOG }))
  }, [])
}

/** Create (`?new=1`) and edit (`?edit=1` on a profile) reuse the classic
 *  editor inside the redesign's Dialog, with the Look Studio as its avatar
 *  fields; agents.css folds its own modal frame. */
function EditorDialog({ route, onSaved }: { route: Route; onSaved: () => void }) {
  const nt = useNT()
  const close = useCloseDialog(route)
  const creating = route.search.has('new')
  const editId = !creating && route.search.has('edit') ? route.id : null
  const agent = useParticipants((s) => (editId ? s.byId[editId] : undefined))
  const editing = agent?.kind === 'agent' && !agent.departedAt ? agent : null
  return (
    <Dialog
      open={creating || editing !== null}
      onClose={close}
      title={editing ? nt('agents.editAgent', { name: editing.name }) : nt('agents.newAgent')}
    >
      <div className="nx-agents-editor">
        <LookEditor key={editing?.id ?? 'new'} agent={editing} onClose={close} onSaved={onSaved} />
      </div>
    </Dialog>
  )
}

function OffboardDialog({ route, onDone }: { route: Route; onDone: () => Promise<void> }) {
  const nt = useNT()
  const close = useCloseDialog(route)
  const id = route.search.has('offboard') ? route.id : null
  const agent = useParticipants((s) => (id ? s.byId[id] : undefined))
  const target = agent?.kind === 'agent' && !agent.departedAt ? agent : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [id])
  const submit = async () => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await api.offboardAgent(target.id)
      await onDone()
      haptic('success')
      close()
    } catch (e) {
      haptic('error')
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={target !== null} onClose={close} title={nt('agents.offboardTitle', { name: target?.name ?? '' })}>
      <p className="nx-agents-dialog-text">{nt('agents.offboardBody1', { name: target?.name ?? '' })}</p>
      <p className="nx-agents-dialog-text nx-agents-dialog-text--muted">{nt('agents.offboardBody2')}</p>
      {error && <p className="nx-agents-error" role="alert">{error}</p>}
      <div className="nx-agents-dialog-actions">
        <button type="button" className="nx-btn nx-btn--outline" disabled={busy} onClick={close}>{nt('agents.cancel')}</button>
        <button type="button" className="nx-btn nx-agents-destroy" disabled={busy} onClick={() => void submit()}>
          {busy && <Spinner />}
          {nt('agents.offboard', { name: target?.name ?? '' })}
        </button>
      </div>
    </Dialog>
  )
}

/** Deleting an off-boarded agent for good (server/src/fork/purge.ts). The
 *  profile it was opened from is gone afterwards, so it lands on the list. */
function PurgeDialog({ route, onDone }: { route: Route; onDone: () => Promise<void> }) {
  const nt = useNT()
  const close = useCloseDialog(route)
  const id = route.search.has('purge') ? route.id : null
  const agent = useParticipants((s) => (id ? s.byId[id] : undefined))
  const target = agent?.kind === 'agent' && agent.departedAt ? agent : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [id])
  const submit = async () => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await http(`/fork/agents/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
      haptic('success')
      navigate(listHref(route), { replace: true })
      await onDone()
    } catch (e) {
      haptic('error')
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={target !== null} onClose={close} title={nt('agents.purgeTitle', { name: target?.name ?? '' })}>
      <p className="nx-agents-dialog-text">{nt('agents.purgeBody1', { name: target?.name ?? '' })}</p>
      <p className="nx-agents-dialog-text nx-agents-dialog-text--muted">{nt('agents.purgeBody2')}</p>
      {error && <p className="nx-agents-error" role="alert">{error}</p>}
      <div className="nx-agents-dialog-actions">
        <button type="button" className="nx-btn nx-btn--outline" disabled={busy} onClick={close}>{nt('agents.cancel')}</button>
        <button type="button" className="nx-btn nx-agents-destroy" disabled={busy} onClick={() => void submit()}>
          {busy && <Spinner />}
          {nt('agents.purge', { name: target?.name ?? '' })}
        </button>
      </div>
    </Dialog>
  )
}

/** Android's back key: close the dialog or the open agent first. NextApp's
 *  own handler would jump straight to Chats from any section. Capture phase:
 *  on the target itself capture listeners run first, so this wins the event
 *  however the two effects happened to register. */
function useHardwareBack(route: Route, covered: boolean): void {
  useEffect(() => {
    const dialog = DIALOG_PARAMS.some((k) => route.search.has(k))
    if (!dialog && !(covered && route.id)) return
    const onBack = (e: Event) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      goBack(dialog ? withRoute(route, { params: NO_DIALOG }) : listHref(route))
    }
    window.addEventListener('cumora:hardware-back', onBack, true)
    return () => window.removeEventListener('cumora:hardware-back', onBack, true)
  }, [route, covered])
}

/** The open agent's page; `bar` adds the back bar when it covers the roster. */
function Detail({ route, bar, children }: { route: Route; bar: boolean; children: ReactNode }) {
  const nt = useNT()
  const name = useParticipants((s) => (route.id ? s.byId[route.id]?.name : undefined))
  return (
    <section className="nx-agents-detail">
      {bar && (
        <header className="nx-agents-bar">
          <IconButton label={nt('agents.back')} onClick={() => goBack(listHref(route))}><IChevronLeft /></IconButton>
          <span className="nx-agents-bar__title">{name}</span>
        </header>
      )}
      <div className="nx-agents-detail__scroll nx-scroll">{children}</div>
    </section>
  )
}

function PickAgent({ route }: { route: Route }) {
  const nt = useNT()
  return (
    <div className="nx-empty nx-agents-fill">
      <IAgents className="nx-agents-pick-icon" />
      <b>{nt('agents.pickTitle')}</b>
      {nt('agents.pickBody')}
      <a className="nx-btn nx-btn--outline nx-btn--sm" href={dialogHref(route, 'new')} onClick={linkClick}>
        <IPlus />
        {nt('agents.hire')}
      </a>
    </div>
  )
}

/** Narrow windows: the agent's page slides over the roster, follows a
 *  swipe from anywhere, and what is under it peeks back with parallax (as in
 *  chat/ChatsSection). */
function StackAgents({ route, list, profile }: { route: Route; list: ReactNode; profile: ReactNode }) {
  const w = window.innerWidth
  const open = route.id !== null
  const swipe = useSwipeBackProps(() => goBack(listHref(route)))
  const baseX = useTransform(swipe.x, (v) => -w * 0.3 + (Math.min(v, w) / w) * w * 0.3)
  return (
    <div className="nx-stackview">
      <motion.div className="nx-stackview__base" style={{ x: open ? baseX : 0 }} {...(open ? { inert: '' } : {})}>
        {list}
      </motion.div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="profile" className="nx-pushed" initial={{ x: w }} animate={{ x: 0 }} exit={{ x: w }} transition={SPRING_SHEET} {...swipe.props}>
            <Detail route={route} bar>{profile}</Detail>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function AgentsSection({ route, layout, stack }: SectionProps) {
  const roster = useRoster()
  const [refreshing, setRefreshing] = useState(false)
  // Hiring, editing, off-boarding and deleting change the roster and the DM list.
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refreshRoster()
    } finally {
      setRefreshing(false)
    }
  }, [])
  useHardwareBack(route, stack)

  const list = <AgentList route={route} roster={roster} refreshing={refreshing} />
  const profile = route.id
    ? <AgentProfile key={route.id} id={route.id} route={route} roster={roster} onRefresh={refresh} />
    : null
  const opened = route.id && (
    <motion.div key={route.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={T_FAST}>
      {profile}
    </motion.div>
  )

  return (
    <>
      {stack ? (
        <StackAgents route={route} list={list} profile={profile} />
      ) : (
        <div className="nx-agents" data-layout={layout}>
          {list}
          <Detail route={route} bar={false}>{opened || <PickAgent route={route} />}</Detail>
        </div>
      )}
      <EditorDialog route={route} onSaved={() => void refresh()} />
      <OffboardDialog route={route} onDone={refresh} />
      <PurgeDialog route={route} onDone={refresh} />
    </>
  )
}
