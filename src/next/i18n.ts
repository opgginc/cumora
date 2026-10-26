/**
 * Strings for the Next redesign. They live in their own catalogue so the
 * redesign never edits the upstream `src/locales` files (every edit there is
 * a merge conflict waiting for the next upstream pull). The active locale is
 * still the app-wide one from `@/lib/i18n`, so the language picker drives
 * both UIs.
 */
import { useCallback } from 'react'
import { useLocaleStore, type Locale } from '@/lib/i18n'
import { en } from './locales/en'
import { zhCN } from './locales/zh-CN'
import { ko } from './locales/ko'

export type NKey = keyof typeof en
export type NT = (key: NKey, vars?: Record<string, string | number>) => string

const DICTS: Record<Locale, Partial<Record<NKey, string>>> = { en, 'zh-CN': zhCN, ko }

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (vars[name] === undefined ? whole : String(vars[name])))
}

export function ntFor(locale: Locale): NT {
  return (key, vars) => interpolate(DICTS[locale][key] ?? en[key] ?? key, vars)
}

export function useNT(): NT {
  const locale = useLocaleStore((s) => s.locale)
  return useCallback<NT>((key, vars) => interpolate(DICTS[locale][key] ?? en[key] ?? key, vars), [locale])
}
