/**
 * Question cards in the redesign's transcript (src/next/chat/cardAnswers.ts).
 * The mistakes worth catching: a reply known only by its client id drawn as a
 * bubble for a frame, the transcript rebuilding its rows for a card that
 * changed nothing there, a quote of the question or of its reply missing the
 * question, and the waiting pill showing for a secret request, for a
 * question a person already answered by quoting it or its agent asked past,
 * for one a person answered in their own words that its agent went on from
 * (work rows and system lines are nobody talking),
 * or for a question older than another agent's open one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/types.ts'
import type { Card, CardAnswer } from '../src/next/chat/cards.ts'
import { answerKind, questionOf, roomAnswers, roomTalk, unsentAnswer, waitingQuestion, type RoomTalk } from '../src/next/chat/cardAnswers.ts'

/** The minute in `createdAt` is the id's last digit, so a higher digit is newer. */
const card = (messageId: string, over: Partial<Card> = {}): Card => ({
  messageId, conversationId: 'room', agentId: 'bot', kind: 'choice', question: `${messageId}?`, options: ['A', 'B'],
  createdAt: `2026-10-23T13:0${messageId.slice(-1)}:00.000Z`, answer: null, takenAt: null, expiresAt: null, rev: 0, ...over,
})
const answer = (clientId: string, messageId: string | null = null): CardAnswer =>
  ({ by: 'u1', at: '2026-10-23T13:10:00.000Z', option: 0, text: null, clientId, messageId })
/** What people said: the messages they quoted, and no agent spoke after them. */
const talk = (...quoted: string[]): RoomTalk => ({ quoted: new Set(quoted), heard: new Map() })

test('a reply is known by its client id before it is posted, and the index stays while nothing changes', () => {
  const claimed = card('m-q1', { answer: answer('card-1') })
  const first = roomAnswers([claimed, card('m-q2')], 'room')
  assert.equal(answerKind(first, { id: 'local-1', clientId: 'card-1' }), 'choice')
  const settled = { ...claimed, answer: answer('card-1', 'm-a1'), rev: 2 }
  const second = roomAnswers([settled], 'room', first)
  assert.notEqual(second, first, 'the posted id joins the index')
  assert.equal(answerKind(second, { id: 'm-a1' }), 'choice')
  assert.equal(roomAnswers([{ ...settled, rev: 3 }], 'room', second), second, 'a change that keeps the replies keeps the index')
  assert.equal(answerKind(second, { id: 'm-other' }), undefined)
})

test('a quote of the question or of its reply finds the question, never a secret request', () => {
  const question = card('m-q1', { answer: answer('card-1', 'm-a1') })
  const secret = card('m-s2', { kind: 'secret', options: [], answer: answer('card-2', 'm-a2') })
  const byMessage = { [question.messageId]: question, [secret.messageId]: secret }
  const answers = roomAnswers([question, secret], 'room')
  assert.equal(questionOf(byMessage, answers, 'm-q1'), question)
  assert.equal(questionOf(byMessage, answers, 'm-a1'), question)
  assert.equal(questionOf(byMessage, answers, 'm-s2'), undefined)
  assert.equal(questionOf(byMessage, answers, 'm-a2'), undefined)
})

test('the room waits on its newest open question, not on a secret or a question answered by a quoting reply', () => {
  const older = card('m-q1')
  const newer = card('m-q2')
  const others = [card('m-s3', { kind: 'secret', options: [] }), card('m-q4', { conversationId: 'elsewhere' })]
  assert.equal(waitingQuestion([older, newer, ...others], 'room', talk()), newer)
  // The store lists cards in the order it first heard of them, which need not be by time.
  const theirs = card('m-q5', { agentId: 'other' })
  assert.equal(waitingQuestion([newer, theirs], 'room', talk()), theirs, 'of two agents waiting, the newer question holds the pill')
  assert.equal(waitingQuestion([theirs, newer], 'room', talk()), theirs)
  assert.equal(waitingQuestion([newer], 'room', talk('m-q2')), undefined, 'a person quoted it')
  assert.equal(waitingQuestion([older, card('m-q2', { answer: answer('card-1') })], 'room', talk('m-q1')), undefined)
})

test('an agent that asked again is past its older open question, which another agent asking does not change', () => {
  const skipped = card('m-q1')
  const asked = card('m-q2', { answer: answer('card-2') })
  assert.equal(waitingQuestion([skipped, asked], 'room', talk()), undefined, 'the room talked past m-q1')
  assert.equal(waitingQuestion([skipped, card('m-q2')], 'room', talk('m-q2')), undefined, 'a person quoted the newer one')
  assert.equal(waitingQuestion([skipped, { ...asked, agentId: 'other' }], 'room', talk()), skipped, 'another agent asked m-q2')
})

test('an agent that spoke after a person wrote past its question no longer waits on it', () => {
  const asked = card('m-q2')
  // u1 is the person; the minute is the message's time, so the bot asks m-q2 at minute 2.
  const said = (authorId: string, minute: number, over: Partial<Message> = {}) =>
    ({ id: `m-${authorId}-${minute}`, conversationId: 'room', authorId, kind: 'text', body: '', at: '', createdAt: `2026-10-23T13:0${minute}:00.000Z`, ...over }) as Message
  const waits = (...room: Message[]) => waitingQuestion([asked], 'room', roomTalk(room, (id) => id === 'u1'))
  assert.equal(waits(said('u1', 1), said('bot', 2), said('u1', 3), said('bot', 4)), undefined, 'answered in their own words, and the bot went on')
  assert.equal(waits(said('bot', 2), said('u1', 3, { quotedMessageId: 'm-q2' })), undefined, 'a person quoted it')
  assert.equal(waits(said('u1', 1), said('bot', 2), said('u1', 3)), asked, 'the bot has not spoken since')
  assert.equal(waits(said('u1', 1), said('bot', 2), said('bot', 3)), asked, 'the bot spoke again with no one writing')
  assert.equal(waits(said('bot', 2), said('u1', 3), said('other', 4)), asked, 'another agent answered the person')
  assert.equal(waits(said('bot', 2), said('u1', 3), said('bot', 4, { kind: 'tool' })), asked, 'a work row of the turn that asked')
  assert.equal(waits(said('bot', 2), said('u1', 3), said('bot', 4, { kind: 'system' })), asked, 'a runtime notice under the bot')
  assert.equal(waits(said('bot', 2), said('u1', 3, { kind: 'system' }), said('bot', 4)), asked, 'a membership line under the person')
})

test('someone else answering first keeps what I tried or typed, and my own answer never counts as unsent', () => {
  assert.equal(unsentAnswer('me', 'me', 'A', 'still typing'), null, 'the closed card already names me while my POST is out')
  assert.equal(unsentAnswer('maya', 'me', 'A', 'still typing'), 'A', 'the try that lost the race')
  assert.equal(unsentAnswer('maya', 'me', null, '  half a thought \n'), 'half a thought')
  assert.equal(unsentAnswer('maya', 'me', null, ' '), null)
})
