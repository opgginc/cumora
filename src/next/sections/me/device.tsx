/**
 * Appearance, Language, Notifications & sounds, Developer tools.
 *
 * Theme, chat layout, language and sounds are per device and apply at once
 * (their stores never touch the server); the toggles in between are server
 * preferences that follow the account.
 */
import { useEffect, useState } from 'react'
import { setDevModeEnabled } from '@/api/client'
import { useChatLayoutStore } from '@/lib/chatLayout'
import { detectLocale, LOCALES, useLocaleStore } from '@/lib/i18n'
import { getPushStatus, initPushNotifications, type PushStatus } from '@/lib/push'
import { useAppearanceStore } from '@/lib/theme'
import { useDevtools } from '@/stores/devtools'
import { useSoundStore } from '@/stores/sound'
import { useNT } from '../../i18n'
import type { Route } from '../../router'
import { Spinner } from '../../ui/primitives'
import { IChevronDown, IMonitor, IMoon, ISun } from '../../ui/icons'
import {
  Block, chooseLocale, Choices, ErrorLine, errorText, localeLabel, PrefRow, Row, setParams,
  SkeletonRows, SwitchRow, useAutoLocale, usePrefsLoad,
} from './parts'

function PrefsFailure() {
  const nt = useNT()
  const prefs = usePrefsLoad()
  return prefs.failed ? <ErrorLine message={nt('me.prefsFailed')} onRetry={prefs.retry} /> : null
}

export function AppearancePage() {
  const nt = useNT()
  const appearance = useAppearanceStore((s) => s.appearance)
  const resolved = useAppearanceStore((s) => s.resolved)
  const setAppearance = useAppearanceStore((s) => s.setAppearance)
  const layout = useChatLayoutStore((s) => s.layout)
  const setLayout = useChatLayoutStore((s) => s.setLayout)
  return (
    <>
      <Block title={nt('me.appearance.theme')} hint={nt('me.deviceOnly')}>
        <Choices
          label={nt('me.appearance.theme')}
          value={appearance}
          onChange={setAppearance}
          items={[
            { key: 'system', label: nt('me.appearance.system'), hint: nt(resolved === 'dark' ? 'me.appearance.nowDark' : 'me.appearance.nowLight'), icon: <IMonitor /> },
            { key: 'light', label: nt('me.appearance.light'), icon: <ISun /> },
            { key: 'dark', label: nt('me.appearance.dark'), icon: <IMoon /> },
          ]}
        />
      </Block>
      <Block title={nt('me.appearance.layout')} hint={nt('me.appearance.layoutHint')}>
        <Choices
          label={nt('me.appearance.layout')}
          value={layout}
          onChange={setLayout}
          items={[
            { key: 'thread', label: nt('me.appearance.layoutThread') },
            { key: 'bubble', label: nt('me.appearance.layoutBubble') },
          ]}
        />
      </Block>
      <Block title={nt('me.appearance.motion')}>
        <PrefsFailure />
        <div className="nx-me-card">
          <PrefRow k="ui.reduce_motion" def={false} label={nt('me.prefs.reduceMotion')} hint={nt('me.prefs.reduceMotionHint')} />
          <PrefRow k="ui.typing_indicators" def label={nt('me.prefs.typing')} hint={nt('me.prefs.typingHint')} />
          <PrefRow k="ui.thoughts_in_main" def={false} label={nt('me.prefs.thoughts')} hint={nt('me.prefs.thoughtsHint')} />
        </div>
      </Block>
    </>
  )
}

export function LanguagePage() {
  const nt = useNT()
  const locale = useLocaleStore((s) => s.locale)
  const auto = useAutoLocale()
  return (
    <Block hint={nt('me.deviceOnly')}>
      <Choices
        label={nt('me.group.language')}
        value={auto ? 'auto' : locale}
        onChange={chooseLocale}
        items={[
          { key: 'auto', label: nt('me.language.auto'), hint: nt('me.language.autoHint', { language: localeLabel(detectLocale()) }) },
          ...LOCALES.map((l) => ({ key: l.code, label: l.label, lang: l.code, hint: l.english === l.label ? undefined : l.english })),
        ]}
      />
    </Block>
  )
}

const PERMISSION: Record<PushStatus['permission'], 'granted' | 'denied' | 'prompt' | 'unknown'> = {
  granted: 'granted',
  denied: 'denied',
  prompt: 'prompt',
  'prompt-with-rationale': 'prompt',
  unknown: 'unknown',
}

/** Why push is or is not arriving on this device, and a way to re-run it. */
function PushDiagnostics({ route }: { route: Route }) {
  const nt = useNT()
  const open = route.search.get('diag') === '1'
  const [status, setStatus] = useState<PushStatus>(getPushStatus)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    // lib/push keeps this in module state and emits nothing; a 1s poll
    // shows a re-registration landing soon enough.
    setStatus(getPushStatus())
    const id = window.setInterval(() => setStatus(getPushStatus()), 1000)
    return () => window.clearInterval(id)
  }, [open])
  const run = async (force: boolean) => {
    setBusy(true)
    try {
      await initPushNotifications({ force })
    } catch (e) {
      console.warn('[me] push registration failed', e)
    } finally {
      setBusy(false)
      setStatus(getPushStatus())
    }
  }
  const perm = PERMISSION[status.permission]
  return (
    <>
      <button type="button" className="nx-me-disclose" aria-expanded={open} onClick={() => setParams(route, { diag: open ? null : '1' })}>
        <IChevronDown />
        {nt('me.push.diagnostics')}
      </button>
      {open && (
        <div className="nx-me-card">
          <Row label={nt('me.push.pref')} hint={nt(status.prefEnabled ? 'me.push.prefOn' : 'me.push.prefOff')}>
            <span className="nx-me-status"><i className="nx-me-dot" data-s={status.prefEnabled ? 'online' : 'error'} />{nt(status.prefEnabled ? 'me.on' : 'me.off')}</span>
          </Row>
          <Row label={nt('me.push.permission')} hint={perm === 'denied' ? nt('me.push.permDenied') : undefined}>
            <span className="nx-me-status">
              <i className="nx-me-dot" data-s={perm === 'granted' ? 'online' : perm === 'denied' ? 'error' : perm === 'prompt' ? 'busy' : 'offline'} />
              {nt(`me.push.perm.${perm}`)}
            </span>
          </Row>
          <Row label={nt('me.push.token')}>
            <span className="nx-me-row__value nx-mono">{status.tokenSuffix ? nt('me.push.tokenOk', { suffix: status.tokenSuffix }) : nt('me.push.tokenNone')}</span>
          </Row>
          <Row label={nt('me.push.step')} hint={nt(`me.push.step.${status.lastStep}`)} />
          {status.lastError && <Row label={nt('me.push.lastError')} hint={status.lastError} />}
          <div className="nx-me-row">
            <div className="nx-me-actions nx-me-actions--start">
              <button type="button" className="nx-btn nx-btn--outline nx-btn--sm" disabled={busy} onClick={() => void run(false)}>
                {busy && <Spinner />}
                {nt('me.push.reregister')}
              </button>
              <button type="button" className="nx-btn nx-btn--danger nx-btn--sm" disabled={busy} onClick={() => void run(true)}>
                {nt('me.push.force')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function NotificationsPage({ route }: { route: Route }) {
  const nt = useNT()
  const muted = useSoundStore((s) => s.muted)
  const setMuted = useSoundStore((s) => s.setMuted)
  // Push exists only in the iOS/Android shells; elsewhere messages arrive live.
  const native = getPushStatus().supported
  return (
    <>
      <PrefsFailure />
      {native && (
        <Block title={nt('me.push.title')}>
          <div className="nx-me-card">
            <PrefRow k="notify.push" def label={nt('me.push.toggle')} hint={nt('me.push.toggleHint')} />
          </div>
          <PushDiagnostics route={route} />
        </Block>
      )}
      <Block title={nt('me.notify.title')} hint={native ? undefined : nt('me.push.web')}>
        <div className="nx-me-card">
          <PrefRow k="notify.group_pulled" def label={nt('me.notify.groupPulled')} />
          <PrefRow k="notify.whisper_mention" def label={nt('me.notify.whisperMention')} />
          <PrefRow k="notify.convene_called" def label={nt('me.notify.conveneCalled')} />
          <PrefRow k="notify.daily_summary" def={false} label={nt('me.notify.dailySummary')} hint={nt('me.notify.dailySummaryHint')} />
        </div>
      </Block>
      <Block title={nt('me.sounds.title')} hint={nt('me.deviceOnly')}>
        <div className="nx-me-card">
          <SwitchRow label={nt('me.sounds.skype')} hint={nt('me.sounds.skypeHint')} checked={!muted} onChange={(on) => setMuted(!on)} />
        </div>
      </Block>
    </>
  )
}

export function DeveloperPage() {
  const nt = useNT()
  const loaded = useDevtools((s) => s.loaded)
  const enabled = useDevtools((s) => s.enabled)
  const localDev = useDevtools((s) => s.localDev)
  const setDevMode = useDevtools((s) => s.setDevMode)
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!loaded) return <SkeletonRows n={1} />
  const toggle = async (next: boolean) => {
    setPending(next)
    setError(null)
    try {
      await setDevMode(next)
    } catch (e) {
      // setDevMode writes the device flag before asking the server; undo it.
      setDevModeEnabled(!next)
      setError(nt('me.saveFailed', { error: errorText(e) }))
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="nx-me-card">
      <SwitchRow
        label={nt('me.dev.mode')}
        hint={nt(localDev ? 'me.dev.local' : 'me.dev.hint')}
        checked={pending ?? enabled}
        disabled={localDev}
        busy={pending !== null}
        error={error}
        onChange={(v) => void toggle(v)}
      />
    </div>
  )
}
