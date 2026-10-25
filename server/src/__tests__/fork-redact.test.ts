/**
 * Text the fork sends that an agent or a person wrote must never carry a
 * credential, and redaction must not eat prose that only looks like one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preview, redact } from '../fork/redact.js'
import { MAX_FILE_BYTES } from '../fork/recorder.js'

test('redact removes credentials of every listed shape', () => {
  const cases: Array<[string, string]> = [
    ['curl -H "Authorization: Bearer abc.def.ghi123" x', 'abc.def.ghi123'],
    ['Authorization=Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['sent Bearer 9f8e7d6c5b4a39281706 upstream', '9f8e7d6c5b4a39281706'],
    ['header Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl', 'eyJzdWIiOiIxMjM0In0'],
    ['key sk-proj-AbCdEfGhIjKlMnOpQrSt', 'AbCdEfGhIjKlMnOpQrSt'],
    ['ghp_0123456789abcdefghijABCDEFGHIJ012345 pushed', '0123456789abcdefghij'],
    ['gho_0123456789abcdefghijABCD', '0123456789abcdefghij'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '11ABCDEFG0123456789'],
    ['slack xoxb-1234567890-abcdefghij', '1234567890-abcdefghij'],
    ['aws AKIAIOSFODNN7EXAMPLE done', 'AKIAIOSFODNN7EXAMPLE'],
    ['git clone https://alice:s3cretpw@github.com/x/y', 's3cretpw'],
    ['GITHUB_TOKEN=abc123 npm publish', 'abc123'],
    ['https://api.example.com/v1?api_key=zzz999&page=2', 'zzz999'],
    ['DB_PASSWORD="hunter 2" ./run', 'hunter 2'],
    ['deploy --token abc123def', 'abc123def'],
    ['deploy --api-key=xyz789', 'xyz789'],
    ['{"access_token": "tok-value-1"}', 'tok-value-1'],
    ['password: hunter2', 'hunter2'],
    // A secret word anywhere in the name, with or without spaces around '='.
    ['POSTGRES_PASSWORD: s3cr3t', 's3cr3t'],
    ['  secret_key: abcdef', 'abcdef'],
    ['api_key = "abcdef"', 'abcdef'],
    // A name that is no secret does not swallow the pair after it.
    ['deploy --verbose --token abc123def', 'abc123def'],
    ['open https://x.test/login?next=/cb?token=zzz999', 'zzz999'],
  ]
  for (const [input, secret] of cases) {
    const out = redact(input)
    assert.ok(!out.includes(secret), `${JSON.stringify(input)} still shows ${secret}: ${out}`)
    assert.ok(out.includes('[redacted]'), `${JSON.stringify(input)} was not marked: ${out}`)
  }
  assert.equal(redact('git clone https://alice:s3cretpw@github.com/x/y'), 'git clone https://[redacted]@github.com/x/y')
  assert.equal(redact('deploy --token abc123def now'), 'deploy --token [redacted] now')
})

// The fake secrets are assembled at run time: GitHub push protection rejects
// a commit whose source contains one of these shapes literally.
const cat = (...parts: string[]) => parts.join('')
const SHAPES: Array<[shape: string, input: string, expected: string]> = [
  ['a GitLab token', cat('GL glpat-', 'AbCdEfGhIjKlMnOpQrSt pushed'), 'GL [redacted] pushed'],
  ['a Google API key', cat('maps AIza', 'SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW here'), 'maps [redacted] here'],
  ['a Slack webhook URL', cat('post to https://hooks.slack.com/services/', 'T0123ABCD/', 'B0456EFGH/', 'abcdefghijklmnopqrstuvwx now'), 'post to https://hooks.slack.com/services/[redacted] now'],
  ['a Discord webhook URL', cat('https://discord.com/api/webhooks/', '123456789012345678/', 'AbCdEf-GhIjKl_MnOpQr'), 'https://discord.com/api/webhooks/[redacted]'],
  ['a Telegram bot token', cat('GET https://api.telegram.org/bot123456789:', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0/getMe'), 'GET https://api.telegram.org/bot[redacted]/getMe'],
]
for (const [shape, input, expected] of SHAPES) {
  test(`redact removes ${shape}`, () => assert.equal(redact(input), expected))
}

test('redact removes a PEM private key across its lines and keeps its markers', () => {
  const text = 'Deploy with this one:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nq2Vi8wJr==\n-----END RSA PRIVATE KEY-----\ndone'
  assert.equal(redact(text), 'Deploy with this one:\n-----BEGIN RSA PRIVATE KEY-----[redacted]-----END RSA PRIVATE KEY-----\ndone')
})

test('redact keeps prose that only resembles a credential', () => {
  for (const text of [
    'Authorization header missing',
    'Basic Information about the launch',
    'task-1234567890abcdefgh finished',
    'risk-assessment-for-the-quarter',
    'cumora board move card-abc Done',
    'Deploy at 10:30 on Fridays',
    'url: https://example.com/a',
  ]) {
    assert.equal(redact(text), text)
  }
})

test('redact takes linear time on the longest line a file can hold', () => {
  // Each line repeats a run that a pattern could restart inside of and rescan
  // to its end; a pattern that does takes seconds on a line this long.
  const cases: Array<[form: string, prefix: string, unit: string]> = [
    ['--flag value', '--', 'token'],
    ['--flag value, many flags', '', '--a'],
    ['NAME=value', '', 'token'],
    ['NAME=value, names that are no secret', '', 'a='],
    ['"name": "value"', '"', 'token'],
    ['name: value', '', 'a-'],
    ['name: value, secret names', '', 'token: '],
    ['URL credentials', '', 'a.'],
    ['JWT', '', 'eyJ-'],
    ['PEM key without an end', '', '-----BEGIN PRIVATE KEY-----\n'],
  ]
  for (const [form, prefix, unit] of cases) {
    const line = (prefix + unit.repeat(Math.ceil(MAX_FILE_BYTES / unit.length))).slice(0, MAX_FILE_BYTES)
    const start = performance.now()
    redact(line)
    const ms = performance.now() - start
    assert.ok(ms < 200, `${form}: ${ms.toFixed(0)} ms for ${MAX_FILE_BYTES} characters`)
  }
})

test('preview redacts before it cuts and keeps one line', () => {
  const key = `sk-${'a'.repeat(40)}`
  const out = preview(`${'x'.repeat(30)} ${key}`, 40)
  assert.ok(out && !out.includes('aaaa'), `a cut must not expose part of a key: ${out}`)
  assert.equal(preview('Fix the digest\n\n  and post it at 9', 100), 'Fix the digest and post it at 9')
  assert.equal(preview('  \n  ', 100), null)
  assert.equal(preview(null, 100), null)
  assert.equal(preview('abcdefghij', 5), 'abcd…')
})

test('preview with keepLines keeps the lines Markdown needs, and still redacts before it cuts', () => {
  assert.equal(preview('## Done\n\n- one\n- two  ', 100, { keepLines: true }), '## Done\n\n- one\n- two')
  const out = preview(`Line\n${'x'.repeat(25)} sk-${'a'.repeat(40)}`, 40, { keepLines: true })
  assert.ok(out && !out.includes('aaaa'), `a cut must not expose part of a key: ${out}`)
})
