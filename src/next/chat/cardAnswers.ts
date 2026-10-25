/**
 * Pure lookups over a room's cards, for the store in ./cards.ts: which
 * messages answered a card, which question a quote is about, and which
 * question the room's agents wait on. Free of imports that need a browser
 * (./cards.ts opens the socket), so tests/question-cards.test.ts runs them
 * in node.
 */
import type { Message } from '@/types'
import type { Card } from './cards'
import { createdAt, TALK_KINDS } from './model'

/** A room's answer replies, by their id and their client id: the kind of card
 *  each answered and that card's question message. */
export type Answers = ReadonlyMap<string, { kind: Card['kind']; question: string }>

export const NO_ANSWERS: Answers = new Map()

/** The room's answer replies, from its cards. `prev` comes back while it holds
 *  the same replies, so the transcript does not rebuild its rows for a card
 *  that changed nothing there. */
export function roomAnswers(cards: Iterable<Card>, room: string, prev: Answers = NO_ANSWERS): Answers {
  const ids = new Map<string, { kind: Card['kind']; question: string }>()
  for (const c of cards) {
    if (c.conversationId !== room || !c.answer) continue
    const of = { kind: c.kind, question: c.messageId }
    ids.set(c.answer.clientId, of)
    if (c.answer.messageId) ids.set(c.answer.messageId, of)
  }
  return ids.size === prev.size && [...ids].every(([id, of]) => prev.get(id)?.question === of.question) ? prev : ids
}

/** The kind of card a message answered, if it is such a reply. Its client id
 *  is known before the reply is posted, so it is found from its first frame. */
export function answerKind(answers: Answers, m: { id: string; clientId?: string }): Card['kind'] | undefined {
  return (answers.get(m.id) ?? (m.clientId === undefined ? undefined : answers.get(m.clientId)))?.kind
}

/** The question card a quote is about: the question itself, or the reply that answered it. */
export function questionOf(byMessage: Record<string, Card>, answers: Answers, quotedId: string): Card | undefined {
  const reply = answers.get(quotedId)
  const card = byMessage[quotedId] ?? (reply ? byMessage[reply.question] : undefined)
  return card?.kind === 'choice' ? card : undefined
}

/** What a person tried to send when someone else answered first: the try
 *  that lost the race (`lost`), else what they were still typing. Never my
 *  own answer: the closed card reaches me before the server answers my POST,
 *  and by then it already names me as the one who answered. */
export function unsentAnswer(answeredBy: string, me: string | null, lost: string | null, draft: string): string | null {
  if (answeredBy === me) return null
  return lost ?? (draft.trim() || null)
}

/** The question the room's agents wait for: each agent's newest question in
 *  the room is a candidate, and of those still open, the newest wins. An
 *  older question its agent asked past keeps its card but not the pill. The
 *  candidates are per agent because one agent asking says nothing about
 *  another's question. Left out are secret requests (one whose agent left the
 *  room can never be sent, so its pill would stay forever), questions a
 *  person answered with a reply quoting them instead of through the card,
 *  from the classic UI, an older app or the composer (`talk.quoted`), and
 *  questions whose agent spoke after a person wrote past them
 *  (`talk.heard`): people mostly answer in their own words or move on, and
 *  the agent went on from there. */
export function waitingQuestion(cards: Iterable<Card>, room: string, talk: RoomTalk): Card | undefined {
  const latest = new Map<string, Card>()
  for (const c of cards) {
    if (c.conversationId !== room || c.kind !== 'choice') continue
    const seen = latest.get(c.agentId)
    if (!seen || c.createdAt > seen.createdAt) latest.set(c.agentId, c)
  }
  let newest: Card | undefined
  for (const c of latest.values()) {
    if (c.answer || talk.quoted.has(c.messageId) || (talk.heard.get(c.agentId) ?? 0) > Date.parse(c.createdAt)) continue
    if (!newest || c.createdAt > newest.createdAt) newest = c
  }
  return newest
}

/** What a room's messages tell waitingQuestion (roomTalk). */
export interface RoomTalk {
  /** What people's replies quote. */
  quoted: ReadonlySet<string>
  /** Per agent, the time (ms) of the newest person's message it has spoken after. */
  heard: ReadonlyMap<string, number>
}

/** RoomTalk from a room's messages, in order. Only conversation counts
 *  (TALK_KINDS): an agent's work rows can come from the very turn it asked
 *  in, before it read anything. The agent speaking is what counts, not the
 *  person alone: in a room with several agents a person may be writing to
 *  another one. */
export function roomTalk(messages: readonly Message[], isPerson: (authorId: string) => boolean): RoomTalk {
  const quoted = new Set<string>()
  const heard = new Map<string, number>()
  let person = 0
  for (const m of messages) {
    if (!TALK_KINDS.has(m.kind)) continue
    if (isPerson(m.authorId)) {
      if (m.quotedMessageId) quoted.add(m.quotedMessageId)
      person = createdAt(m).getTime()
    } else if (person) heard.set(m.authorId, person)
  }
  return { quoted, heard }
}
