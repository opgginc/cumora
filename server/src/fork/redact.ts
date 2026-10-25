/**
 * Secret redaction for text the fork shows that an agent or a person wrote
 * (an agent's memory, a message quoted as an instruction). Every route that
 * sends such text runs it through here first.
 *
 * Files of up to 256 KB pass through here line by line, synchronously, on the
 * API's event loop, so every pattern must run in time linear in the line: no
 * pattern may scan to the end of a run of characters from many starts inside
 * it and fail each time. A `\b` before a class that holds '-' or '.' does,
 * since it starts again after every '-' or '.' in the run.
 */

const R = '[redacted]'

// Base64 credentials always carry a digit, '+', '/', '=' or a capital after
// the first letter; "Basic Information" carries none, so prose survives.
function looksEncoded(token: string): boolean {
  return /[0-9+/=]/.test(token) || /[A-Z]/.test(token.slice(1))
}

/** The markers around a PEM private key, as regex source: the pattern here and
 *  ./coding.ts, which finds a key whose END a cut took away, read them alike. */
export const KEY_BEGIN = '-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----'
export const KEY_END = '-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----'

// The body stops at the first "-----", so a BEGIN without an END costs one
// scan up to the next marker.
const PRIVATE_KEY = new RegExp(`(${KEY_BEGIN})(?:(?!-----)[\\s\\S])*(${KEY_END})`, 'g')

/** Replaces the body of every PEM private key, its markers kept on one line.
 *  A key spans lines, so text that is redacted line by line (the Handbook's
 *  diff) goes through here whole first. */
export function redactKeys(text: string): string {
  return text.replace(PRIVATE_KEY, `$1${R}$2`)
}

// Order matters: whole headers and URLs go before the bare token shapes that
// would otherwise eat only part of them.
const SECRET_PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // The scheme is one word: "git+https" leaves "git+" out, which holds nothing.
  [/\b([a-z][a-z0-9]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${R}@`],
  [/\b(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[\w/-]+/g, `$1${R}`],
  [/\b(https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/)[\w/-]+/g, `$1${R}`],
  [/\b((?:proxy-)?authorization)\s*[:=]\s*(?:(?:bearer|basic|token|digest)\s+)?[^\s,;'"()[\]{}]+/gi, `$1: ${R}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`],
  [/\b(basic)\s+([A-Za-z0-9+/]{8,}={0,2})/gi, (match, scheme, token) => (looksEncoded(token) ? `${scheme} ${R}` : match)],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, R],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R],
  [/\bAIza[A-Za-z0-9_-]{35}/g, R],
  // A Telegram bot token is the bot's id, a colon and 35 characters. API URLs
  // put "bot" right before the id, so no word boundary is required there.
  [/(?<!\d)\d{5,16}:AA[A-Za-z0-9_-]{33}/g, R],
]

// A secret given by name: `--api-key value`, `GITHUB_TOKEN=value`,
// `"access_token": "value"`, `POSTGRES_PASSWORD: value`. Each pattern takes any
// name (one character class, starting only where a run of it starts, then a
// fixed separator), and redactNamed decides whether the name is a secret.
const SECRET_NAME = /token|key|secret|password|passwd/i
const NAMED: Array<[name: RegExp, value: RegExp]> = [
  [/(?<![\w-])--([\w-]+)(?:=|\s+)/g, /"[^"]*"|'[^']*'|\S+/y],
  [/(?<!\w)(\w+)\s*=\s*/g, /"[^"]*"|'[^']*'|[^\s&"']+/y],
  [/"([\w-]+)"\s*:\s*/g, /"[^"]*"/y],
  [/(?<![\w-])([\w-]+)\s*:\s*/g, /"[^"]*"|'[^']*'|[^\s,;]+/y],
]

/** The value after every secret name, redacted; a quoted value keeps its
 *  quotes. Only a secret's value is consumed, and the value of any other name
 *  is scanned again, so a name that is no secret never swallows the pair after
 *  it (`--verbose --token x`, `next=/cb?token=x`). */
function redactNamed(text: string, name: RegExp, value: RegExp): string {
  let out = ''
  let done = 0
  name.lastIndex = 0
  for (let m = name.exec(text); m; m = name.exec(text)) {
    if (!SECRET_NAME.test(m[1])) continue
    value.lastIndex = name.lastIndex
    const v = value.exec(text)
    if (!v) continue
    const quote = v[0][0] === '"' || v[0][0] === "'" ? v[0][0] : ''
    out += `${text.slice(done, name.lastIndex)}${quote}${R}${quote}`
    done = name.lastIndex = value.lastIndex
  }
  return out + text.slice(done)
}

export function redact(text: string): string {
  let out = redactKeys(text)
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement as (substring: string, ...args: string[]) => string)
  }
  for (const [name, value] of NAMED) out = redactNamed(out, name, value)
  return out
}

/** At most `max` characters, on one line unless `keepLines`. Redacts before
 *  it cuts: a cut can split a secret into a shape the patterns no longer match. */
export function preview(raw: string | null | undefined, max: number, { keepLines = false } = {}): string | null {
  if (!raw) return null
  const redacted = redact(raw)
  const flat = (keepLines ? redacted : redacted.replace(/\s+/g, ' ')).trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}
