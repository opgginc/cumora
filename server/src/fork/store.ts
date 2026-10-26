/**
 * The fork's own SQLite database, for data upstream cumora does not have.
 * Upstream's Postgres schema and migrations stay untouched, so merging
 * upstream never conflicts with fork-only tables.
 *
 * sql.js (SQLite compiled to WebAssembly) because the server image runs
 * Node 20, which has no node:sqlite, and a native module would also have to
 * be rebuilt for the Electron app that shares package.json.
 */
import initSqlJs from 'sql.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface RoomCategory { id: string; name: string; position: number; hidden: boolean }

/** An agent's bloub look: catalogue ids of the client's bloub engine. An owner
 *  picks the shape, the colour and any number of accessories; the expression is
 *  the face of the agent's latest message (./mood.ts). */
export interface BloubLook { shape: string; color: string; expression: string; accessories: string[] }

/** One user's chat-list layout inside one company. */
export interface RoomLayout {
  /** Ordered by position. */
  categories: RoomCategory[]
  /** conversationId -> categoryId; rooms without an entry sit in no category. */
  rooms: Record<string, string>
  /** Collapsed group keys: category ids or the client's built-in section key. */
  collapsed: string[]
  /** Pinned rooms in the order this user arranged their tiles. Pinning itself is
   *  upstream's shared conversations.pinned column; only the order is personal. */
  pinOrder: string[]
}

/** A routine that fires when something happens instead of at a time: a pull
 *  request merging in `repo`, read as the gh profile `profile` (./triggers.ts). */
export interface Trigger {
  id: string
  companyId: string
  createdBy: string
  conversationId: string
  assigneeId: string
  title: string
  prompt: string
  repo: string
  profile: string
  status: 'active' | 'paused'
  /** ISO time the trigger was made; only pull requests merged after it fire. */
  since: string
  fires: number
  lastFire: { at: string; label: string; error: string | null } | null
}

export type NewTrigger = Pick<Trigger, 'companyId' | 'createdBy' | 'conversationId' | 'assigneeId' | 'title' | 'prompt' | 'repo' | 'profile'>

/** A T3 Code thread an agent launched, as the poller last read it from T3
 *  (./coding.ts). T3 holds the record; these rows are a copy. */
export interface CodingThread {
  /** The MCP server name of the T3 instance it runs on (compose's t3code config). */
  server: string
  threadId: string
  companyId: string
  agentId: string
  /** The room of the turn that launched it, found when its agent is first woken
   *  (./coding.ts launchRoom); null until then, or when that turn had no one room. */
  conversationId: string | null
  /** Without the agent's `[@…] ` mark (./coding.ts parseMark). */
  title: string
  /** T3's thread status (running, completed, failed...), or 'question' while
   *  the thread waits for the answer to `requestId`. */
  status: string
  runId: string | null
  /** The question the thread waits for (T3's t3_pending_request_list), or null. */
  requestId: string | null
  /** `state` is null until T3 has read the pull request's host. */
  pullRequests: Array<{ number: number; url: string; state: string | null }>
  createdAt: string
  /** T3's time of the last change to the status, title, run or pull requests. */
  updatedAt: string
  /** When the thread was settled in T3, marked as dealt with; null while it is not. */
  settledAt: string | null
}

/** A thread as the poller hands it over. `woken` applies to a new row only: a
 *  thread first seen long after it came to rest arrives already woken. */
export type NewCodingThread = CodingThread & { woken: string | null }

/** What the agent of a thread was woken for: once per run and resting status,
 *  and once per question, so a second question in the same run wakes it again. */
export const codingWakeKey = (t: Pick<CodingThread, 'runId' | 'status' | 'requestId'>): string =>
  `${t.runId ?? ''}:${t.status}:${t.requestId ?? ''}`

/** What an agent asked a person under its message (./cards.ts): to pick one of
 *  some options, or to send a secret. Keyed by that message. */
export interface Card {
  messageId: string
  conversationId: string
  /** The agent that asked: the message's author. */
  agentId: string
  kind: 'choice' | 'secret'
  question: string
  /** A choice's options in order; empty for a secret. */
  options: string[]
  createdAt: string
  /** The first answer, which closes the card. */
  answer: CardAnswer | null
  /** When the agent took the secret. */
  takenAt: string | null
  /** When a secret that was sent but not taken is dropped. */
  expiresAt: string | null
  /** Bumped by every change, so a client keeps the newest copy it was sent. */
  rev: number
}

export interface CardAnswer {
  /** The person who answered. */
  by: string
  at: string
  /** The option's index; null for a secret or an answer in the person's own words. */
  option: number | null
  /** What the person typed instead of picking an option; null otherwise. */
  text: string | null
  /** The answer's message: its client id is chosen before it is posted, so
   *  clients recognise it from its first frame, and its id is known once it is. */
  clientId: string
  messageId: string | null
}

export type NewCard = Pick<Card, 'messageId' | 'conversationId' | 'agentId' | 'kind' | 'question' | 'options'> & { companyId: string }

/** An answer whose reply is not posted yet, with its card's company. */
export interface PendingAnswer { companyId: string; card: Card }

/** A secret that was sent but not taken is dropped this long after it was sent. */
export const SECRET_TTL_MS = 24 * 60 * 60_000

// Same convention as UPLOAD_DIR in storage.ts: relative to the server's cwd
// (/app in the image), where compose mounts a volume so the file survives
// rebuilds.
export const FORK_DB_FILE = resolve(process.cwd(), 'server/data/fork.sqlite')

// Every write rewrites the whole file on the API process (see save below), so
// one user must not be able to grow it without bound.
export const MAX_CATEGORIES = 100
export const MAX_ROOM_ASSIGNMENTS = 5000
export const MAX_TRIGGERS = 100
export const MAX_PIN_ORDER = 500
// ponytail: each file keeps its newest 200 versions, pruned as versions
// arrive, and the oldest one left becomes its baseline. A file rewritten on
// every poll keeps about 17 minutes of history (200 × 5 s), and one at the
// recorder's 256 KB cap can take 50 MB. Store diffs between versions, or
// prune by age, if the Handbook needs a longer reach.
export const MAX_FILE_VERSIONS = 200
// The client's built-in section (OTHER_GROUP in src/next/chat/roomLayout.ts);
// every other collapsed key is a category id.
const BUILT_IN_GROUPS = ['other']

/** A write would take a user past MAX_CATEGORIES or MAX_ROOM_ASSIGNMENTS. */
export class ForkLimitError extends Error {}

// MIGRATIONS[n] upgrades the schema from version n to n + 1, and
// PRAGMA user_version records how many have run. Add later fork tables as new
// entries; never edit one that has shipped.
const MIGRATIONS = [
  `CREATE TABLE room_categories (
     id TEXT PRIMARY KEY,
     company_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL,
     -- REAL so a client can later insert between two neighbours without renumbering.
     position REAL NOT NULL
   );
   CREATE INDEX room_categories_owner ON room_categories (company_id, user_id);
   CREATE TABLE room_assignments (
     company_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     category_id TEXT NOT NULL,
     PRIMARY KEY (company_id, user_id, conversation_id)
   );
   CREATE TABLE collapsed_groups (
     company_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     group_key TEXT NOT NULL,
     PRIMARY KEY (company_id, user_id, group_key)
   );`,

  // The client dropped its 'former' section; its collapsed rows would stay
  // behind as keys nothing reads.
  `DELETE FROM collapsed_groups WHERE group_key = 'former';`,

  // Categories the user put out of sight, and the order of their pinned tiles.
  `ALTER TABLE room_categories ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE pin_order (
     company_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     PRIMARY KEY (company_id, user_id, conversation_id)
   );`,

  // Versions of the computer's standing files, for the Handbook (./recorder.ts).
  // Rows are scoped by the agent whose home holds the file, not by company:
  // agent ids are unique across workspaces (participants_agent_id_unique), and
  // the handbook route checks the agent is the viewer's and skips versions
  // from before it joined the viewer's workspace, since a hard-deleted
  // workspace frees its agents' ids. Scope '' is the computer's shared skills
  // folder, read by every agent on it.
  `CREATE TABLE computer_file_versions (
     id INTEGER PRIMARY KEY,
     scope TEXT NOT NULL,
     -- Relative to the agent's home, or to the shared skills folder.
     path TEXT NOT NULL,
     -- ISO time of the change: the file's mtime, or when a deletion was seen.
     at TEXT NOT NULL,
     -- NULL: the file was deleted.
     content TEXT,
     -- 1 for the first version seen of a file that was there before its home
     -- was watched: what it held then, not a change.
     baseline INTEGER NOT NULL
   );
   CREATE INDEX computer_file_versions_file ON computer_file_versions (scope, path, at);`,

  // The animated bloub avatar an owner or admin picked for an agent. It is the
  // agent's look for the whole workspace, so rows are per company, not per user.
  // The ids are catalogue keys of the client's bloub engine (src/next/bloub).
  `CREATE TABLE bloub_avatars (
     company_id TEXT NOT NULL,
     participant_id TEXT NOT NULL,
     shape TEXT NOT NULL,
     color TEXT NOT NULL,
     expression TEXT NOT NULL,
     PRIMARY KEY (company_id, participant_id)
   );`,

  // The expression stopped being picked by people: it is now the face of the
  // agent's latest message, so the faces picked before start from rest.
  `UPDATE bloub_avatars SET expression = 'neutre';`,

  // Triggers (./triggers.ts): routines that fire on an event, per company like
  // calendar events. A fire row claims the event before its message is posted,
  // so a merge fires once however often the repository is polled.
  // ponytail: fires are never pruned; a row is a few hundred bytes per merged
  // pull request. Prune by age if a repository merges thousands.
  `CREATE TABLE triggers (
     id TEXT PRIMARY KEY,
     company_id TEXT NOT NULL,
     created_by TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     assignee_id TEXT NOT NULL,
     title TEXT NOT NULL,
     prompt TEXT NOT NULL,
     -- GitHub owner/name, and the gh profile on the computer that reads it.
     repo TEXT NOT NULL,
     profile TEXT NOT NULL,
     -- 'active' | 'paused'
     status TEXT NOT NULL,
     -- ISO time the trigger was made; only pull requests merged after it fire.
     since TEXT NOT NULL
   );
   CREATE INDEX triggers_room ON triggers (company_id, conversation_id);
   CREATE TABLE trigger_fires (
     trigger_id TEXT NOT NULL,
     -- 'pr:<number>', or 'manual:<ms>' for Run now.
     event_key TEXT NOT NULL,
     at TEXT NOT NULL,
     -- What fired, for the Routines tab: '#<number> <pull request title>'.
     label TEXT NOT NULL,
     -- The system message posted, or NULL with the error when posting failed.
     message_id TEXT,
     error TEXT,
     PRIMARY KEY (trigger_id, event_key)
   );`,

  // Agents deleted for good (./purge.ts). purged_agents is kept forever: an
  // agent id is never given out again (agents/create.ts), so nothing that
  // still names the old id can reach a new agent. computer_purges holds those
  // whose files are still on their computer, until its daemon removes the
  // agent's home and engine sessions (./computer-purge.ts).
  `CREATE TABLE purged_agents (
     agent_id TEXT PRIMARY KEY,
     at TEXT NOT NULL
   );
   CREATE TABLE computer_purges (
     agent_id TEXT PRIMARY KEY,
     computer_id TEXT NOT NULL,
     at TEXT NOT NULL
   );`,

  // Coding (./coding.ts): the T3 Code threads agents launched, copied from T3
  // by its poller. `status` is T3's, or 'question' while the thread waits for
  // the answer to `request_id`. `woken` holds the codingWakeKey the agent was
  // last woken for, and `wake_error` why that wake could not be posted.
  // ponytail: rows are never pruned, one per launched thread. Prune by age if
  // agents launch thousands.
  `CREATE TABLE coding_threads (
     server TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     company_id TEXT NOT NULL,
     agent_id TEXT NOT NULL,
     conversation_id TEXT,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     run_id TEXT,
     request_id TEXT,
     -- JSON: [{ number, url, state }]
     pull_requests TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     woken TEXT,
     wake_error TEXT,
     PRIMARY KEY (server, thread_id)
   );
   CREATE INDEX coding_threads_agent ON coding_threads (company_id, agent_id, updated_at);`,

  // Questions agents ask people under their messages (./cards.ts).
  // ponytail: never pruned; a card is under a KB and agents ask a few a day.
  // Prune answered ones by age if the file grows.
  `CREATE TABLE cards (
     message_id TEXT PRIMARY KEY,
     company_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     agent_id TEXT NOT NULL,
     -- 'choice' | 'secret'
     kind TEXT NOT NULL,
     question TEXT NOT NULL,
     -- JSON array of the options' text; '[]' for a secret.
     options TEXT NOT NULL,
     created_at TEXT NOT NULL,
     -- The first answer. NULL while the card is open.
     answered_by TEXT,
     answered_at TEXT,
     answer_option INTEGER,
     answer_client_id TEXT,
     answer_message_id TEXT,
     -- A sent secret, sealed by ./cards.ts, until the agent takes it or it expires.
     secret TEXT,
     taken_at TEXT,
     -- Bumped by every change of the card (Card.rev).
     rev INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX cards_room ON cards (company_id, conversation_id);`,

  // What an owner puts on a bloub, any number at once (cat ears, whiskers): a
  // JSON array of the client's catalogue ids (src/next/bloub/accessories.ts).
  `ALTER TABLE bloub_avatars ADD COLUMN accessories TEXT NOT NULL DEFAULT '[]';`,

  // What a person typed into a question card instead of picking one of its
  // options (./cards.ts). NULL for a pick or a secret.
  `ALTER TABLE cards ADD COLUMN answer_text TEXT;`,

  // When a Coding thread was settled in T3 (./coding.ts), NULL while it is
  // not: the Coding tab lists every unsettled thread but only recent settled
  // ones. `unlisted` is 1 while the last whole read of its T3 server did not
  // list it; the row stays, so it keeps the wake its agent already had.
  `ALTER TABLE coding_threads ADD COLUMN settled_at TEXT;
   ALTER TABLE coding_threads ADD COLUMN unlisted INTEGER NOT NULL DEFAULT 0;`,
]

export interface FileVersion {
  id: number
  scope: string
  path: string
  at: string
  content: string | null
  baseline: boolean
}

export type NewFileVersion = Omit<FileVersion, 'id'>

export async function openForkStore(file: string) {
  const SQL = await initSqlJs()
  mkdirSync(dirname(file), { recursive: true })
  // What the file holds right now: a failed save puts memory back to this.
  let saved: Uint8Array | undefined = existsSync(file) ? readFileSync(file) : undefined
  let db = new SQL.Database(saved)

  const rows = (sql: string, params: initSqlJs.BindParams): initSqlJs.SqlValue[][] =>
    db.exec(sql, params)[0]?.values ?? []

  // sql.js keeps the database in memory, so every change is written out as a
  // whole new file and renamed over the old one: a crash mid-write leaves the
  // previous file intact instead of a half-written one.
  // ponytail: rewrites the whole file per change. Fine while it stays at a few
  // MB: layout rows plus the Handbook's file versions, which start at the
  // computer's standing files (under 1 MB) and keep up to MAX_FILE_VERSIONS
  // versions of each file in full. Switch to node:sqlite once the image runs
  // Node 22+ before the file outgrows that.
  // When the write fails, the change is undone in memory too, so a later read
  // (the client resyncs after a failed write) never serves a state the file
  // does not have, and the next save does not persist it by accident.
  const save = () => {
    const bytes = db.export()
    try {
      writeFileSync(`${file}.tmp`, bytes)
      renameSync(`${file}.tmp`, file)
    } catch (err) {
      db = new SQL.Database(saved)
      throw err
    }
    saved = bytes
  }

  const ownsCategory = (companyId: string, userId: string, id: string) =>
    rows('SELECT 1 FROM room_categories WHERE id = ? AND company_id = ? AND user_id = ?', [id, companyId, userId]).length > 0

  const VERSION_COLUMNS = 'id, scope, path, at, content, baseline'
  const toVersion = ([id, scope, path, at, content, baseline]: initSqlJs.SqlValue[]): FileVersion => ({
    id: Number(id), scope: String(scope), path: String(path), at: String(at),
    content: content === null ? null : String(content), baseline: Number(baseline) === 1,
  })
  // The version a file had at a time: its newest one at or before it. Versions
  // of one file never go back in time (the recorder clamps them), so `at`
  // orders them, and the id breaks a tie.
  const VERSION_AT = `SELECT w.id FROM computer_file_versions w
                       WHERE w.scope = v.scope AND w.path = v.path AND w.at <= ?
                       ORDER BY w.at DESC, w.id DESC LIMIT 1`

  // A secret leaves the store when the agent takes it or SECRET_TTL_MS after it
  // was sent. secure_delete zeroes the freed bytes in the file as well; the
  // pragma is set before each such write because export() resets it.
  const forgetSecrets = (where: string, params: initSqlJs.SqlValue[]): boolean => {
    db.run('PRAGMA secure_delete = ON')
    db.run(`UPDATE cards SET secret = NULL WHERE secret IS NOT NULL AND ${where}`, params)
    return db.getRowsModified() > 0
  }
  const expireSecrets = (now: Date) => {
    if (forgetSecrets('answered_at < ?', [new Date(now.getTime() - SECRET_TTL_MS).toISOString()])) save()
  }
  const readCard = (companyId: string, messageId: string): Card | null =>
    rows(`SELECT ${CARD_COLUMNS} FROM cards WHERE company_id = ? AND message_id = ?`, [companyId, messageId]).map(toCard)[0] ?? null

  const version = Number(rows('PRAGMA user_version', null)[0]?.[0] ?? 0)
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec(`BEGIN; ${MIGRATIONS[v]} PRAGMA user_version = ${v + 1}; COMMIT;`)
  }
  if (version < MIGRATIONS.length) save()

  // Foreign keys are not used: db.export() closes and reopens the database,
  // which resets PRAGMA foreign_keys, so related rows are removed explicitly.
  return {
    layout(companyId: string, userId: string): RoomLayout {
      const owner = [companyId, userId]
      return {
        categories: rows(
          `SELECT id, name, position, hidden FROM room_categories
            WHERE company_id = ? AND user_id = ? ORDER BY position, id`,
          owner,
        ).map(([id, name, position, hidden]) => ({ id: String(id), name: String(name), position: Number(position), hidden: Number(hidden) === 1 })),
        rooms: Object.fromEntries(
          rows('SELECT conversation_id, category_id FROM room_assignments WHERE company_id = ? AND user_id = ?', owner)
            .map(([conversationId, categoryId]) => [String(conversationId), String(categoryId)]),
        ),
        collapsed: rows('SELECT group_key FROM collapsed_groups WHERE company_id = ? AND user_id = ?', owner)
          .map(([key]) => String(key)),
        pinOrder: rows('SELECT conversation_id FROM pin_order WHERE company_id = ? AND user_id = ? ORDER BY position', owner)
          .map(([id]) => String(id)),
      }
    },

    createCategory(companyId: string, userId: string, name: string): RoomCategory {
      const count = Number(rows(
        'SELECT COUNT(*) FROM room_categories WHERE company_id = ? AND user_id = ?',
        [companyId, userId],
      )[0][0])
      if (count >= MAX_CATEGORIES) throw new ForkLimitError(`at most ${MAX_CATEGORIES} categories per user`)
      const id = randomUUID()
      const position = Number(rows(
        'SELECT COALESCE(MAX(position), 0) + 1 FROM room_categories WHERE company_id = ? AND user_id = ?',
        [companyId, userId],
      )[0][0])
      db.run(
        'INSERT INTO room_categories (id, company_id, user_id, name, position) VALUES (?, ?, ?, ?, ?)',
        [id, companyId, userId, name, position],
      )
      save()
      return { id, name, position, hidden: false }
    },

    updateCategory(companyId: string, userId: string, id: string, patch: { name?: string; position?: number; hidden?: boolean }): boolean {
      db.run(
        `UPDATE room_categories
            SET name = COALESCE(?, name), position = COALESCE(?, position), hidden = COALESCE(?, hidden)
          WHERE id = ? AND company_id = ? AND user_id = ?`,
        [patch.name ?? null, patch.position ?? null, patch.hidden === undefined ? null : Number(patch.hidden), id, companyId, userId],
      )
      if (db.getRowsModified() === 0) return false
      save()
      return true
    },

    deleteCategory(companyId: string, userId: string, id: string): boolean {
      db.run('DELETE FROM room_categories WHERE id = ? AND company_id = ? AND user_id = ?', [id, companyId, userId])
      if (db.getRowsModified() === 0) return false
      db.run('DELETE FROM room_assignments WHERE category_id = ? AND company_id = ? AND user_id = ?', [id, companyId, userId])
      // A category's collapsed state is stored under its id as the group key.
      db.run('DELETE FROM collapsed_groups WHERE group_key = ? AND company_id = ? AND user_id = ?', [id, companyId, userId])
      save()
      return true
    },

    /** null takes the room out of its category. False when the category is not this user's. */
    setRoomCategory(companyId: string, userId: string, conversationId: string, categoryId: string | null): boolean {
      if (categoryId === null) {
        db.run(
          'DELETE FROM room_assignments WHERE company_id = ? AND user_id = ? AND conversation_id = ?',
          [companyId, userId, conversationId],
        )
      } else {
        if (!ownsCategory(companyId, userId, categoryId)) return false
        // Moving a room that already has a category does not add a row.
        const others = Number(rows(
          'SELECT COUNT(*) FROM room_assignments WHERE company_id = ? AND user_id = ? AND conversation_id <> ?',
          [companyId, userId, conversationId],
        )[0][0])
        if (others >= MAX_ROOM_ASSIGNMENTS) {
          throw new ForkLimitError(`at most ${MAX_ROOM_ASSIGNMENTS} rooms can be in categories`)
        }
        db.run(
          `INSERT OR REPLACE INTO room_assignments (company_id, user_id, conversation_id, category_id)
           VALUES (?, ?, ?, ?)`,
          [companyId, userId, conversationId, categoryId],
        )
      }
      save()
      return true
    },

    /** Replaces this user's tile order. Ids of rooms that are not pinned do no
     *  harm (the client only sorts pinned rooms by it), so they are not checked. */
    setPinOrder(companyId: string, userId: string, conversationIds: string[]): void {
      if (conversationIds.length > MAX_PIN_ORDER) throw new ForkLimitError(`at most ${MAX_PIN_ORDER} pinned rooms can be ordered`)
      db.run('DELETE FROM pin_order WHERE company_id = ? AND user_id = ?', [companyId, userId])
      conversationIds.forEach((id, position) => {
        db.run('INSERT INTO pin_order (company_id, user_id, conversation_id, position) VALUES (?, ?, ?, ?)', [companyId, userId, id, position])
      })
      save()
    },

    /** False when the key is neither the built-in section nor one of this user's categories. */
    setCollapsed(companyId: string, userId: string, groupKey: string, collapsed: boolean): boolean {
      if (!BUILT_IN_GROUPS.includes(groupKey) && !ownsCategory(companyId, userId, groupKey)) return false
      db.run(
        collapsed
          ? 'INSERT OR IGNORE INTO collapsed_groups (company_id, user_id, group_key) VALUES (?, ?, ?)'
          : 'DELETE FROM collapsed_groups WHERE company_id = ? AND user_id = ? AND group_key = ?',
        [companyId, userId, groupKey],
      )
      save()
      return true
    },

    /** The newest version of every file ever recorded, tombstones included. */
    latestFileVersions(): FileVersion[] {
      return rows(
        `SELECT ${VERSION_COLUMNS} FROM computer_file_versions v
          WHERE id = (SELECT w.id FROM computer_file_versions w
                       WHERE w.scope = v.scope AND w.path = v.path
                       ORDER BY w.at DESC, w.id DESC LIMIT 1)`,
        null,
      ).map(toVersion)
    },

    /** Adds the versions in one write: the recorder hands over one poll's worth.
     *  Each file they touch drops what it holds past MAX_FILE_VERSIONS. */
    recordFileVersions(versions: NewFileVersion[]): void {
      if (versions.length === 0) return
      db.run('BEGIN')
      try {
        for (const v of versions) {
          db.run(
            'INSERT INTO computer_file_versions (scope, path, at, content, baseline) VALUES (?, ?, ?, ?, ?)',
            [v.scope, v.path, v.at, v.content, v.baseline ? 1 : 0],
          )
        }
        for (const { scope, path } of versions) {
          db.run(
            `DELETE FROM computer_file_versions WHERE id IN (
               SELECT id FROM computer_file_versions WHERE scope = ? AND path = ?
                ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)`,
            [scope, path, MAX_FILE_VERSIONS],
          )
          if (db.getRowsModified() === 0) continue
          // The oldest version left is now the oldest text known, which is
          // what a baseline is; as a change it would read as the file's creation.
          db.run(
            `UPDATE computer_file_versions SET baseline = 1 WHERE id = (
               SELECT id FROM computer_file_versions WHERE scope = ? AND path = ? ORDER BY at, id LIMIT 1)`,
            [scope, path],
          )
        }
        db.run('COMMIT')
      } catch (err) {
        db.run('ROLLBACK')
        throw err
      }
      save()
    },

    /** Every file of these scopes from the version it had at `since` on, or its
     *  whole history when `since` is null. Ordered by file, then time. */
    fileVersions(scopes: string[], since: string | null): FileVersion[] {
      if (scopes.length === 0) return []
      const inScopes = `scope IN (${scopes.map(() => '?').join(', ')})`
      return rows(
        since === null
          ? `SELECT ${VERSION_COLUMNS} FROM computer_file_versions WHERE ${inScopes} ORDER BY scope, path, at, id`
          : `SELECT ${VERSION_COLUMNS} FROM computer_file_versions v
              WHERE ${inScopes} AND (at > ? OR id = (${VERSION_AT}))
              ORDER BY scope, path, at, id`,
        since === null ? scopes : [...scopes, since, since],
      ).map(toVersion)
    },

    /** Agents whose home has had a recorded file: the ones on this computer. */
    fileScopes(): string[] {
      return rows("SELECT DISTINCT scope FROM computer_file_versions WHERE scope <> '' ORDER BY scope", null)
        .map(([scope]) => String(scope))
    },

    /** Every agent in the company that has a bloub look, by participant id. */
    bloubAvatars(companyId: string): Record<string, BloubLook> {
      return Object.fromEntries(
        rows('SELECT participant_id, shape, color, expression, accessories FROM bloub_avatars WHERE company_id = ?', [companyId])
          .map(([id, shape, color, expression, accessories]) => [
            String(id),
            { shape: String(shape), color: String(color), expression: String(expression), accessories: JSON.parse(String(accessories)) as string[] },
          ]),
      )
    },

    /** A new look starts with the resting face; a changed one keeps the agent's
     *  current face. A pick without accessories keeps the ones the agent wears:
     *  an app built before them sends only the shape and colour. */
    setBloubAvatar(companyId: string, participantId: string, look: Pick<BloubLook, 'shape' | 'color'> & { accessories?: string[] }): void {
      const accessories = look.accessories === undefined ? null : JSON.stringify(look.accessories)
      db.run(
        `INSERT INTO bloub_avatars (company_id, participant_id, shape, color, expression, accessories)
         VALUES (?, ?, ?, ?, 'neutre', COALESCE(?, '[]'))
         ON CONFLICT (company_id, participant_id) DO UPDATE SET shape = excluded.shape, color = excluded.color,
           accessories = COALESCE(?, accessories)`,
        [companyId, participantId, look.shape, look.color, accessories, accessories],
      )
      save()
    },

    /** The face of the agent's latest message. False when the agent wears no bloub. */
    setBloubExpression(companyId: string, participantId: string, expression: string): boolean {
      db.run('UPDATE bloub_avatars SET expression = ? WHERE company_id = ? AND participant_id = ?', [expression, companyId, participantId])
      if (db.getRowsModified() === 0) return false
      save()
      return true
    },

    /** Back to the agent's portrait or initial. */
    clearBloubAvatar(companyId: string, participantId: string): void {
      db.run('DELETE FROM bloub_avatars WHERE company_id = ? AND participant_id = ?', [companyId, participantId])
      if (db.getRowsModified() > 0) save()
    },

    /** Drops what the fork kept of an agent deleted for good: its look, its
     *  triggers, its T3 threads, its cards, the Handbook's versions of its home,
     *  and every user's layout rows and the cards of its deleted 1:1 rooms. With
     *  a computer, queues the removal of its files there. */
    purgeAgent(companyId: string, agentId: string, deletedRooms: string[], computerId: string | null): void {
      db.run('DELETE FROM bloub_avatars WHERE company_id = ? AND participant_id = ?', [companyId, agentId])
      db.run('DELETE FROM coding_threads WHERE company_id = ? AND agent_id = ?', [companyId, agentId])
      db.run(
        'DELETE FROM trigger_fires WHERE trigger_id IN (SELECT id FROM triggers WHERE company_id = ? AND assignee_id = ?)',
        [companyId, agentId],
      )
      db.run('DELETE FROM triggers WHERE company_id = ? AND assignee_id = ?', [companyId, agentId])
      db.run('DELETE FROM computer_file_versions WHERE scope = ?', [agentId])
      forgetSecrets('company_id = ? AND agent_id = ?', [companyId, agentId])
      db.run('DELETE FROM cards WHERE company_id = ? AND agent_id = ?', [companyId, agentId])
      for (const room of deletedRooms) {
        db.run('DELETE FROM room_assignments WHERE company_id = ? AND conversation_id = ?', [companyId, room])
        db.run('DELETE FROM pin_order WHERE company_id = ? AND conversation_id = ?', [companyId, room])
        db.run('DELETE FROM cards WHERE company_id = ? AND conversation_id = ?', [companyId, room])
      }
      const at = new Date().toISOString()
      db.run('INSERT OR IGNORE INTO purged_agents (agent_id, at) VALUES (?, ?)', [agentId, at])
      if (computerId) {
        db.run('INSERT OR REPLACE INTO computer_purges (agent_id, computer_id, at) VALUES (?, ?, ?)', [agentId, computerId, at])
      }
      save()
    },

    /** Deleted agents whose files are still on this computer. */
    computerPurges(computerId: string): string[] {
      return rows('SELECT agent_id FROM computer_purges WHERE computer_id = ? ORDER BY at', [computerId]).map(([id]) => String(id))
    },

    /** Every agent deleted for good. Their ids are never given out again. */
    purgedAgents(): Set<string> {
      return new Set(rows('SELECT agent_id FROM purged_agents', null).map(([id]) => String(id)))
    },

    /** The computer removed the agent's files. */
    clearComputerPurge(computerId: string, agentId: string): void {
      db.run('DELETE FROM computer_purges WHERE computer_id = ? AND agent_id = ?', [computerId, agentId])
      if (db.getRowsModified() > 0) save()
    },

    /** A room's triggers, newest first. */
    triggers(companyId: string, conversationId: string): Trigger[] {
      return rows(
        `SELECT ${TRIGGER_COLUMNS} ${TRIGGER_FROM} WHERE t.company_id = ? AND t.conversation_id = ? ORDER BY t.since DESC`,
        [companyId, conversationId],
      ).map(toTrigger)
    },

    trigger(companyId: string, id: string): Trigger | null {
      return rows(`SELECT ${TRIGGER_COLUMNS} ${TRIGGER_FROM} WHERE t.id = ? AND t.company_id = ?`, [id, companyId]).map(toTrigger)[0] ?? null
    },

    /** Every active trigger of every company: what the poller watches, grouped
     *  by what it reads so one request serves every trigger on a repository. */
    activeTriggers(): Trigger[] {
      return rows(`SELECT ${TRIGGER_COLUMNS} ${TRIGGER_FROM} WHERE t.status = 'active' ORDER BY t.profile, t.repo, t.since`, null).map(toTrigger)
    },

    createTrigger(input: NewTrigger): Trigger {
      const count = Number(rows('SELECT COUNT(*) FROM triggers WHERE company_id = ?', [input.companyId])[0][0])
      if (count >= MAX_TRIGGERS) throw new ForkLimitError(`at most ${MAX_TRIGGERS} triggers per workspace`)
      const trigger: Trigger = { ...input, id: randomUUID(), status: 'active', since: new Date().toISOString(), fires: 0, lastFire: null }
      db.run(
        `INSERT INTO triggers (id, company_id, created_by, conversation_id, assignee_id, title, prompt, repo, profile, status, since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [trigger.id, trigger.companyId, trigger.createdBy, trigger.conversationId, trigger.assigneeId, trigger.title, trigger.prompt, trigger.repo, trigger.profile, trigger.status, trigger.since],
      )
      save()
      return trigger
    },

    updateTrigger(companyId: string, id: string, patch: { status?: Trigger['status']; title?: string; prompt?: string }): boolean {
      db.run(
        `UPDATE triggers SET status = COALESCE(?, status), title = COALESCE(?, title), prompt = COALESCE(?, prompt)
          WHERE id = ? AND company_id = ?`,
        [patch.status ?? null, patch.title ?? null, patch.prompt ?? null, id, companyId],
      )
      if (db.getRowsModified() === 0) return false
      save()
      return true
    },

    deleteTrigger(companyId: string, id: string): boolean {
      db.run('DELETE FROM triggers WHERE id = ? AND company_id = ?', [id, companyId])
      if (db.getRowsModified() === 0) return false
      db.run('DELETE FROM trigger_fires WHERE trigger_id = ?', [id])
      save()
      return true
    },

    /** Claims an event for a trigger before its message is posted. False when
     *  the event fired before, so a poll never posts the same merge twice. */
    claimFire(triggerId: string, eventKey: string, at: string, label: string): boolean {
      db.run('INSERT OR IGNORE INTO trigger_fires (trigger_id, event_key, at, label) VALUES (?, ?, ?, ?)', [triggerId, eventKey, at, label])
      if (db.getRowsModified() === 0) return false
      save()
      return true
    },

    /** How a claimed fire went: the message it posted, or why it could not. */
    settleFire(triggerId: string, eventKey: string, result: { messageId: string } | { error: string }): void {
      db.run(
        'UPDATE trigger_fires SET message_id = ?, error = ? WHERE trigger_id = ? AND event_key = ?',
        ['messageId' in result ? result.messageId : null, 'error' in result ? result.error : null, triggerId, eventKey],
      )
      save()
    },

    /** An agent's threads on `servers` that T3 still lists, the most recently
     *  changed first: every one not settled in T3 or in one of the `open`
     *  statuses, and of the other settled ones the `settledLimit` most recently
     *  settled at or after `settledSince`. The poller stores settled_at as
     *  toISOString() does, so the two compare as text. */
    codingThreads(companyId: string, agentId: string, list: {
      servers: readonly string[]
      open: readonly string[]
      settledSince: string
      settledLimit: number
    }): CodingThread[] {
      const these = `company_id = ? AND agent_id = ? AND unlisted = 0 AND server IN (${list.servers.map(() => '?').join(', ')})`
      const open = `status IN (${list.open.map(() => '?').join(', ')})`
      return rows(
        `SELECT ${CODING_COLUMNS} FROM coding_threads WHERE ${these} AND (settled_at IS NULL OR ${open})
         UNION ALL
         SELECT * FROM (SELECT ${CODING_COLUMNS} FROM coding_threads WHERE ${these} AND settled_at >= ? AND NOT ${open}
                        ORDER BY settled_at DESC LIMIT ?)
         ORDER BY updated_at DESC`,
        [companyId, agentId, ...list.servers, ...list.open, companyId, agentId, ...list.servers, list.settledSince, ...list.open, list.settledLimit],
      ).map(toCodingThread)
    },

    /** One thread of the workspace's copy, or null. */
    codingThread(companyId: string, server: string, threadId: string): CodingThread | null {
      const [row] = rows(
        `SELECT ${CODING_COLUMNS} FROM coding_threads WHERE company_id = ? AND server = ? AND thread_id = ?`,
        [companyId, server, threadId],
      )
      return row ? toCodingThread(row) : null
    },

    /** '<server> <thread id>' of every thread copied so far. */
    codingThreadKeys(): Set<string> {
      return new Set(rows("SELECT server || ' ' || thread_id FROM coding_threads", null).map(([key]) => String(key)))
    },

    /** Copies one poll of T3 in one write. The poller hands over every thread on
     *  every poll, so nothing is written when no status, title, run, question,
     *  pull request or settling changed and T3 listed the thread before too. A
     *  row keeps the agent of its first copy, the room its first wake found and
     *  the wake it had. Returns the workspaces whose rows changed. */
    saveCodingThreads(threads: NewCodingThread[]): Set<string> {
      const changed = new Set<string>()
      db.run('BEGIN')
      try {
        for (const t of threads) {
          // RETURNING answers only for a row that was written, with its own workspace.
          for (const [companyId] of rows(
            `INSERT INTO coding_threads (server, thread_id, company_id, agent_id, conversation_id, title, status, run_id, request_id, pull_requests, created_at, updated_at, settled_at, woken)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (server, thread_id) DO UPDATE SET
               title = excluded.title, status = excluded.status, run_id = excluded.run_id, request_id = excluded.request_id,
               pull_requests = excluded.pull_requests, updated_at = excluded.updated_at, settled_at = excluded.settled_at, unlisted = 0
             WHERE title IS NOT excluded.title OR status IS NOT excluded.status OR run_id IS NOT excluded.run_id
                OR request_id IS NOT excluded.request_id OR pull_requests IS NOT excluded.pull_requests
                OR settled_at IS NOT excluded.settled_at OR unlisted <> 0
             RETURNING company_id`,
            [t.server, t.threadId, t.companyId, t.agentId, t.conversationId, t.title, t.status, t.runId, t.requestId,
              JSON.stringify(t.pullRequests), t.createdAt, t.updatedAt, t.settledAt, t.woken],
          )) changed.add(String(companyId))
        }
        db.run('COMMIT')
      } catch (err) {
        db.run('ROLLBACK')
        throw err
      }
      if (changed.size > 0) save()
      return changed
    },

    /** Takes the threads copied from `server` other than `threadIds`, the
     *  marked threads a whole read of it found, out of the list: T3 no longer
     *  lists them, so they were archived, deleted or renamed without the mark
     *  there. Their rows stay, so a thread T3 lists again is not new, and does
     *  not wake its agent again for a rest it was woken for. Returns the
     *  workspaces whose list lost a thread. */
    unlistCodingThreads(server: string, threadIds: string[]): Set<string> {
      // SQLite takes an empty IN list, so a read that found nothing unlists every thread of the server.
      const gone = rows(
        `UPDATE coding_threads SET unlisted = 1
          WHERE server = ? AND unlisted = 0 AND thread_id NOT IN (${threadIds.map(() => '?').join(', ')}) RETURNING company_id`,
        [server, ...threadIds],
      )
      if (gone.length > 0) save()
      return new Set(gone.map(([companyId]) => String(companyId)))
    },

    /** Whether a thread copied from `server` that T3 still lists is in one of
     *  `statuses`; one T3 stopped listing while it ran would keep it hot for good. */
    codingThreadIn(server: string, statuses: readonly string[]): boolean {
      return rows(
        `SELECT 1 FROM coding_threads WHERE server = ? AND unlisted = 0 AND status IN (${statuses.map(() => '?').join(', ')}) LIMIT 1`,
        [server, ...statuses],
      ).length > 0
    },

    /** Threads from `server` resting in one of `statuses` that their agent was not woken for yet. */
    codingWakesDue(server: string, statuses: readonly string[]): CodingThread[] {
      return rows(
        `SELECT ${CODING_COLUMNS}, woken FROM coding_threads WHERE server = ? AND status IN (${statuses.map(() => '?').join(', ')})`,
        [server, ...statuses],
      ).filter((r) => r[r.length - 1] !== codingWakeKey(toCodingThread(r))).map(toCodingThread)
    },

    /** Records the wake a thread's agent got, or why it could not be posted;
     *  either way the poller does not try that wake again. A room the wake went
     *  to is kept for the thread's later wakes. */
    markCodingWoken(server: string, threadId: string, key: string, error: string | null, conversationId: string | null = null): void {
      db.run(
        'UPDATE coding_threads SET woken = ?, wake_error = ?, conversation_id = coalesce(conversation_id, ?) WHERE server = ? AND thread_id = ?',
        [key, error, conversationId, server, threadId],
      )
      save()
    },

    createCard(card: NewCard): Card {
      db.run(
        `INSERT INTO cards (message_id, company_id, conversation_id, agent_id, kind, question, options, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [card.messageId, card.companyId, card.conversationId, card.agentId, card.kind, card.question, JSON.stringify(card.options), new Date().toISOString()],
      )
      save()
      return readCard(card.companyId, card.messageId) as Card
    },

    card(companyId: string, messageId: string): Card | null {
      return readCard(companyId, messageId)
    },

    /** Drops the sent secrets nobody took within SECRET_TTL_MS (./cards.ts
     *  runs this every minute). */
    dropExpiredSecrets(now = new Date()): void {
      expireSecrets(now)
    },

    /** A room's cards, oldest first, after dropping the secrets past their time. */
    cards(companyId: string, conversationId: string, now = new Date()): Card[] {
      expireSecrets(now)
      return rows(
        `SELECT ${CARD_COLUMNS} FROM cards WHERE company_id = ? AND conversation_id = ? ORDER BY created_at, message_id`,
        [companyId, conversationId],
      ).map(toCard)
    },

    /** Closes an open card with its first answer, and keeps a secret's sealed
     *  value with it. False when someone answered first. */
    claimAnswer(companyId: string, messageId: string, answer: Omit<CardAnswer, 'messageId'>, sealed: string | null = null): boolean {
      db.run(
        `UPDATE cards SET answered_by = ?, answered_at = ?, answer_option = ?, answer_text = ?, answer_client_id = ?, secret = ?, rev = rev + 1
          WHERE company_id = ? AND message_id = ? AND answered_at IS NULL`,
        [answer.by, answer.at, answer.option, answer.text, answer.clientId, sealed, companyId, messageId],
      )
      if (db.getRowsModified() === 0) return false
      save()
      return true
    },

    /** Opens a card again when its answer could not be posted. */
    releaseAnswer(companyId: string, messageId: string, clientId: string): void {
      const where = 'company_id = ? AND message_id = ? AND answer_client_id = ? AND answer_message_id IS NULL'
      forgetSecrets(where, [companyId, messageId, clientId])
      db.run(
        `UPDATE cards SET answered_by = NULL, answered_at = NULL, answer_option = NULL, answer_text = NULL, answer_client_id = NULL, rev = rev + 1 WHERE ${where}`,
        [companyId, messageId, clientId],
      )
      if (db.getRowsModified() > 0) save()
    },

    /** The answer's message was posted. Settling it again changes nothing. */
    settleAnswer(companyId: string, messageId: string, clientId: string, answerMessageId: string): void {
      db.run(
        `UPDATE cards SET answer_message_id = ?, rev = rev + 1
          WHERE company_id = ? AND message_id = ? AND answer_client_id = ? AND answer_message_id IS NULL`,
        [answerMessageId, companyId, messageId, clientId],
      )
      if (db.getRowsModified() > 0) save()
    },

    /** Every answer whose reply is not posted yet, in every room. */
    pendingAnswers(): PendingAnswer[] {
      return rows(`SELECT company_id, ${CARD_COLUMNS} FROM cards WHERE answered_at IS NOT NULL AND answer_message_id IS NULL`, null)
        .map(([companyId, ...card]) => ({ companyId: String(companyId), card: toCard(card) }))
    },

    /** Hands a sent secret to the agent that asked for it, once, and forgets
     *  it. Otherwise why not: no such card of this agent's, nobody sent it
     *  yet (or its reply is not posted yet, so the card may still open again),
     *  the agent took it before, or it expired. */
    takeSecret(companyId: string, messageId: string, agentId: string, now = new Date()): { sealed: string } | 'missing' | 'waiting' | 'taken' | 'expired' {
      expireSecrets(now)
      const row = rows(
        "SELECT answer_message_id, secret, taken_at FROM cards WHERE company_id = ? AND message_id = ? AND agent_id = ? AND kind = 'secret'",
        [companyId, messageId, agentId],
      )[0]
      if (!row) return 'missing'
      const [answerMessageId, sealed, takenAt] = row
      if (takenAt !== null) return 'taken'
      if (answerMessageId === null) return 'waiting'
      if (sealed === null) return 'expired'
      forgetSecrets('company_id = ? AND message_id = ?', [companyId, messageId])
      db.run('UPDATE cards SET taken_at = ?, rev = rev + 1 WHERE company_id = ? AND message_id = ?', [now.toISOString(), companyId, messageId])
      save()
      return { sealed: String(sealed) }
    },
  }
}

const CODING_COLUMNS = 'server, thread_id, company_id, agent_id, conversation_id, title, status, run_id, request_id, pull_requests, created_at, updated_at, settled_at'
const toCodingThread = ([server, threadId, companyId, agentId, conversationId, title, status, runId, requestId, pullRequests, createdAt, updatedAt, settledAt]: initSqlJs.SqlValue[]): CodingThread => ({
  server: String(server), threadId: String(threadId), companyId: String(companyId), agentId: String(agentId),
  conversationId: conversationId === null ? null : String(conversationId), title: String(title), status: String(status),
  runId: runId === null ? null : String(runId), requestId: requestId === null ? null : String(requestId),
  pullRequests: JSON.parse(String(pullRequests)), createdAt: String(createdAt), updatedAt: String(updatedAt),
  settledAt: settledAt === null ? null : String(settledAt),
})

const CARD_COLUMNS = `message_id, conversation_id, agent_id, kind, question, options, created_at,
  answered_by, answered_at, answer_option, answer_text, answer_client_id, answer_message_id, taken_at, rev`
const toCard = ([messageId, conversationId, agentId, kind, question, options, createdAt, by, at, option, text, clientId, answerMessageId, takenAt, rev]: initSqlJs.SqlValue[]): Card => ({
  messageId: String(messageId), conversationId: String(conversationId), agentId: String(agentId),
  kind: kind === 'secret' ? 'secret' : 'choice', question: String(question), options: JSON.parse(String(options)) as string[],
  createdAt: String(createdAt),
  answer: at === null ? null : {
    by: String(by), at: String(at), option: option === null ? null : Number(option), text: text === null ? null : String(text),
    clientId: String(clientId), messageId: answerMessageId === null ? null : String(answerMessageId),
  },
  takenAt: takenAt === null ? null : String(takenAt),
  expiresAt: kind === 'secret' && at !== null && takenAt === null ? new Date(Date.parse(String(at)) + SECRET_TTL_MS).toISOString() : null,
  rev: Number(rev),
})

const TRIGGER_COLUMNS = `t.id, t.company_id, t.created_by, t.conversation_id, t.assignee_id, t.title, t.prompt, t.repo, t.profile, t.status, t.since,
  (SELECT COUNT(*) FROM trigger_fires WHERE trigger_id = t.id), f.at, f.label, f.error`
// The newest fire of each trigger, by its time and then by its row.
const TRIGGER_FROM = `FROM triggers t LEFT JOIN trigger_fires f ON f.rowid = (
  SELECT rowid FROM trigger_fires WHERE trigger_id = t.id ORDER BY at DESC, rowid DESC LIMIT 1)`
const toTrigger = ([id, companyId, createdBy, conversationId, assigneeId, title, prompt, repo, profile, status, since, fires, at, label, error]: initSqlJs.SqlValue[]): Trigger => ({
  id: String(id), companyId: String(companyId), createdBy: String(createdBy), conversationId: String(conversationId), assigneeId: String(assigneeId),
  title: String(title), prompt: String(prompt), repo: String(repo), profile: String(profile),
  status: status === 'paused' ? 'paused' : 'active', since: String(since), fires: Number(fires),
  lastFire: at === null ? null : { at: String(at), label: String(label), error: error === null ? null : String(error) },
})

export type ForkStore = Awaited<ReturnType<typeof openForkStore>>

let shared: Promise<ForkStore> | undefined

/** The server's store at FORK_DB_FILE, opened on first use. A failed open is
 *  logged and not cached, so the next request tries again instead of every
 *  /api/fork call failing until a restart. `file` is for tests. */
export function getForkStore(file = FORK_DB_FILE): Promise<ForkStore> {
  return (shared ??= openForkStore(file).catch((err: unknown) => {
    shared = undefined
    console.error(`[fork] cannot open ${file}; /api/fork fails until it opens:`, err)
    throw err
  }))
}
