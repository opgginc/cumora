/**
 * Triggers in the Routines tab: routines that fire when a pull request merges
 * in a GitHub repository (server/src/fork/triggers.ts), listed under the room's
 * time routines with the same row. A trigger opens in place (`?trigger=`) with
 * Run now, which fires the repository's latest merge, its prompt, its last
 * fire and Delete. The list is this tab's own state: it is short, loads with
 * the tab and reloads after every change.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { http } from '@/api/client'
import { useParticipants } from '@/stores/participants'
import { useLocale } from '@/lib/i18n'
import type { Conversation } from '@/types'
import { dateTime } from '../format'
import { haptic } from '../haptics'
import { useNT } from '../i18n'
import { getRoute, goBack, linkClick, withRoute } from '../router'
import { Avatar } from '../ui/Avatar'
import { Dialog, Spinner, Switch } from '../ui/primitives'
import { IChevronRight } from '../ui/icons'
import { JobBar } from './JobBar'
import { errText, IPlay } from '../sections/calendar/parts'

export interface Trigger {
  id: string
  conversationId: string
  assigneeId: string
  title: string
  prompt: string
  repo: string
  profile: string
  status: 'active' | 'paused'
  fires: number
  lastFire: { at: string; label: string; error: string | null } | null
  /** Why the server's last poll of the repository failed, or null. */
  pollError: string | null
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

export function useTriggers(conversationId: string) {
  const [list, setList] = useState<Trigger[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      setList((await http<{ triggers: Trigger[] }>(`/fork/triggers?conversation=${encodeURIComponent(conversationId)}`)).triggers)
      setError(null)
    } catch (e) {
      setError(errText(e))
    }
  }, [conversationId])
  useEffect(() => {
    setList(null)
    setError(null)
    void reload()
  }, [reload])
  return { list, error, reload }
}

function LastFire({ t }: { t: Trigger }) {
  const nt = useNT()
  const locale = useLocale()
  if (t.pollError) return <p className="nx-field__error nx-trigger__note" role="alert">{nt('routines.trigger.pollError', { error: t.pollError })}</p>
  if (!t.lastFire) return <p className="nx-row__hint nx-trigger__note">{nt('routines.trigger.never')}</p>
  const last = nt('routines.trigger.last', { n: t.fires, when: dateTime(t.lastFire.at, locale), label: t.lastFire.label })
  return t.lastFire.error
    ? <p className="nx-field__error nx-trigger__note" role="alert">{last} · {nt('routines.trigger.fireError', { error: t.lastFire.error })}</p>
    : <p className="nx-row__hint nx-trigger__note">{last}</p>
}

export function TriggerRow({ t, face, onChanged }: { t: Trigger; face: boolean; onChanged: () => Promise<void> }) {
  const nt = useNT()
  const assignee = useParticipants((s) => (face ? s.byId[t.assigneeId] : undefined))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="nx-row nx-routine" data-paused={t.status !== 'active' || undefined}>
      <a className="nx-routine__open" href={withRoute(getRoute(), { params: { trigger: t.id } })} onClick={linkClick}>
        {assignee ? <Avatar p={assignee} size={24} /> : <IMerge />}
        <span className="nx-row__text">
          <span className="nx-routine__title">{t.title}</span>
          <span className="nx-row__hint">{nt('routines.trigger.when', { repo: t.repo })}</span>
        </span>
      </a>
      {busy && <Spinner />}
      <Switch
        label={nt('routines.active', { title: t.title })}
        checked={t.status === 'active'}
        disabled={busy}
        onChange={async (on) => {
          setBusy(true)
          setError(null)
          try {
            await http(`/fork/triggers/${encodeURIComponent(t.id)}`, { method: 'PATCH', ...json({ status: on ? 'active' : 'paused' }) })
            await onChanged()
          } catch (e) {
            setError(errText(e))
          } finally {
            setBusy(false)
          }
        }}
      />
      <IChevronRight aria-hidden />
      {error && <p className="nx-field__error nx-routine__error" role="alert">{error}</p>}
    </div>
  )
}

export function TriggerView({ t, onChanged }: { t: Trigger; onChanged: () => Promise<void> }) {
  const nt = useNT()
  const assignee = useParticipants((s) => s.byId[t.assigneeId])
  const [busy, setBusy] = useState<'run' | 'delete' | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (!note?.ok) return
    const timer = window.setTimeout(() => setNote(null), 2500)
    return () => window.clearTimeout(timer)
  }, [note])
  const close = () => goBack(withRoute(getRoute(), { params: { trigger: null } }))
  return (
    <div className="nx-job">
      <JobBar param="trigger" label={nt('routines.back')} title={t.title}>
        <button
          type="button"
          className="nx-btn nx-btn--outline"
          disabled={busy !== null}
          aria-busy={busy === 'run' || undefined}
          onClick={async () => {
            setBusy('run')
            setNote(null)
            try {
              const { pr } = await http<{ pr: { number: number; title: string } }>(`/fork/triggers/${encodeURIComponent(t.id)}/run-now`, { method: 'POST' })
              haptic('success')
              setNote({ ok: true, text: nt('routines.trigger.ran', { label: `#${pr.number}` }) })
            } catch (e) {
              haptic('error')
              setNote({ ok: false, text: errText(e) })
            } finally {
              setBusy(null)
              await onChanged()
            }
          }}
        >
          {busy === 'run' ? <Spinner /> : <IPlay />}
          {note?.ok ? note.text : nt('calendar.runNow')}
        </button>
        {note && !note.ok && <p className="nx-field__error" role="alert">{note.text}</p>}
      </JobBar>
      {assignee && <p className="nx-job__who"><Avatar p={assignee} size={20} presence />{assignee.name}</p>}
      <p className="nx-job__who">{nt('routines.trigger.when', { repo: t.repo })} · {nt('routines.trigger.as', { profile: t.profile })}</p>
      <LastFire t={t} />
      <h4 className="nx-group-label">{nt('calendar.prompt')}</h4>
      <p className="nx-job__prompt">{t.prompt}</p>
      <div className="nx-job__actions">
        <button
          type="button"
          className="nx-btn nx-btn--sm"
          disabled={busy !== null}
          aria-busy={busy === 'delete' || undefined}
          onClick={async () => {
            if (!window.confirm(nt('routines.trigger.deleteAsk', { title: t.title }))) return
            setBusy('delete')
            try {
              await http(`/fork/triggers/${encodeURIComponent(t.id)}`, { method: 'DELETE' })
              haptic('success')
              close()
              await onChanged()
            } catch (e) {
              haptic('error')
              setNote({ ok: false, text: errText(e) })
              setBusy(null)
            }
          }}
        >
          {busy === 'delete' && <Spinner />}{nt('routines.trigger.delete')}
        </button>
      </div>
    </div>
  )
}

/** The form for a new trigger. It waits for the server, which checks the room,
 *  the agent and the profile, and stays open with the error when it refuses. */
export function NewTriggerDialog({ c, open, onClose, onCreated }: { c: Conversation; open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const nt = useNT()
  const agents = useParticipants(useShallow((s) => c.members.map((id) => s.byId[id]).filter((p) => p?.kind === 'agent' && !p.departedAt)))
  const [profiles, setProfiles] = useState<string[] | null>(null)
  const [form, setForm] = useState({ title: '', repo: '', profile: '', assigneeId: '', prompt: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setForm({ title: '', repo: '', profile: '', assigneeId: '', prompt: '' })
    setError(null)
    setProfiles(null)
    http<{ profiles: string[] }>('/fork/triggers/profiles')
      .then(({ profiles }) => {
        setProfiles(profiles)
        setForm((f) => ({ ...f, profile: profiles[0] ?? '' }))
      })
      .catch((e) => setError(errText(e)))
  }, [open])
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }))
  // An empty pick means the room's first agent, so the form needs no effect on the agents.
  const assigneeId = form.assigneeId || agents[0]?.id || ''
  // The repository pattern and the maxLengths below mirror checkTrigger (server/src/fork/triggers.ts).
  const ready = form.title.trim() && /^[\w.-]+\/[\w.-]+$/.test(form.repo.trim()) && form.profile && assigneeId && form.prompt.trim()
  const close = () => { if (!busy) onClose() }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await http('/fork/triggers', { method: 'POST', ...json({ conversationId: c.id, ...form, assigneeId, title: form.title.trim(), repo: form.repo.trim(), prompt: form.prompt.trim() }) })
      haptic('success')
      onClose()
      await onCreated()
    } catch (err) {
      haptic('error')
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={close} title={nt('routines.trigger.new')}>
      <form className="nx-trigger-form" onSubmit={submit}>
        <p className="nx-row__hint">{nt('routines.trigger.event')}</p>
        <label className="nx-field">
          <span className="nx-field__label">{nt('routines.trigger.title')}</span>
          <input className="nx-input" autoFocus value={form.title} maxLength={120} onChange={set('title')} />
        </label>
        <label className="nx-field">
          <span className="nx-field__label">{nt('routines.trigger.repo')}</span>
          <input className="nx-input nx-mono" value={form.repo} maxLength={100} placeholder="owner/name" spellCheck={false} onChange={set('repo')} />
        </label>
        <label className="nx-field">
          <span className="nx-field__label">{nt('routines.trigger.profile')}</span>
          {profiles === null && !error ? <Spinner /> : profiles?.length === 0
            ? <span className="nx-field__error">{nt('routines.trigger.noProfiles')}</span>
            : <select className="nx-input" value={form.profile} onChange={set('profile')}>{(profiles ?? []).map((p) => <option key={p} value={p}>{p}</option>)}</select>}
        </label>
        <label className="nx-field">
          <span className="nx-field__label">{nt('routines.trigger.agent')}</span>
          <select className="nx-input" value={assigneeId} onChange={set('assigneeId')}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="nx-field">
          <span className="nx-field__label">{nt('calendar.prompt')}</span>
          <textarea className="nx-input" value={form.prompt} maxLength={4000} rows={4} onChange={set('prompt')} />
        </label>
        {error && <p className="nx-field__error" role="alert">{error}</p>}
        <div className="nx-job__actions">
          <button type="button" className="nx-btn" disabled={busy} onClick={close}>{nt('common.cancel')}</button>
          <button type="submit" className="nx-btn nx-btn--primary" disabled={!ready || busy} aria-busy={busy || undefined}>
            {busy && <Spinner />}{nt('routines.trigger.create')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** A merge glyph, for a trigger row without a face. */
const IMerge = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="12" r="2" />
    <path d="M6 7v10M6 7a5 5 0 0 0 5 5h5" />
  </svg>
)
