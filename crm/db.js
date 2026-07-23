/**
 * db.js — SQLite message log for the KoolAircon CRM web interface.
 *
 * Uses sql.js (WASM) instead of better-sqlite3: better-sqlite3 needs
 * node-gyp + a C++ toolchain to install, which wasn't available on the dev
 * machine and isn't guaranteed to be available in the OVH container either.
 * sql.js keeps the database in memory and this module writes the whole
 * thing back to MESSAGES.db after every insert — fine for a single-operator,
 * low-message-volume CRM; revisit only if write volume ever makes that
 * noticeably slow.
 *
 * conversation_id is the channel-native contact id (the Telegram chat id or
 * WhatsApp E.164 number), not the CRM's KA-XXXX Contact_ID — that's the only
 * identifier available at the actual send/receive call sites without adding
 * a Sheets lookup to the hot path. The 1_Contacts sheet (already loaded by
 * the interface when a thread is opened, per the UI spec) is what maps
 * Contact_ID <-> channel id for display.
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CRM_DB_PATH || join(__dirname, 'messages.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL,
  text TEXT,
  timestamp INTEGER NOT NULL,
  sender TEXT,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);
`;

let _dbPromise = null;

async function getDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const SQL = await initSqlJs();
    const db = existsSync(DB_PATH)
      ? new SQL.Database(readFileSync(DB_PATH))
      : new SQL.Database();
    db.run(SCHEMA);
    return db;
  })();
  return _dbPromise;
}

function persist(db) {
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

/**
 * Log a message.
 * Required: conversation_id, channel ('telegram'|'whatsapp'),
 * direction ('inbound'|'outbound'), message_type ('direct'|'bot-cmd'|'draft'|'bot-resp').
 * Optional: text, sender, timestamp (defaults to now), read (defaults to
 * unread for inbound, read for outbound).
 */
export async function insert(message) {
  const {
    conversation_id,
    channel,
    direction,
    message_type,
    text = '',
    sender = '',
    timestamp = Date.now(),
    read = direction === 'inbound' ? 0 : 1,
  } = message;

  if (!conversation_id || !channel || !direction || !message_type) {
    throw new Error('[db] insert: conversation_id, channel, direction, and message_type are required');
  }

  const db = await getDb();
  db.run(
    `INSERT INTO messages (conversation_id, channel, direction, message_type, text, timestamp, sender, read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [conversation_id, channel, direction, message_type, text, timestamp, sender, read ? 1 : 0]
  );
  // last_insert_rowid() must be read before db.export() — export() resets it.
  const [result] = db.exec('SELECT last_insert_rowid() AS id');
  const insertedId = result.values[0][0];
  persist(db);

  return insertedId;
}

/**
 * Message history for a conversation, oldest first.
 */
export async function getMessagesByConversation(conversationId, { limit = 200 } = {}) {
  const db = await getDb();
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT ?'
  );
  stmt.bind([conversationId, limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/**
 * All messages logged after a given timestamp, oldest first. Backs the
 * Phase 3 long-poll endpoint (GET /api/updates?since=) — the browser passes
 * back the server-supplied "now" from its previous poll as the next "since".
 */
export async function getMessagesSince(since) {
  const db = await getDb();
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE timestamp > ? ORDER BY timestamp ASC'
  );
  stmt.bind([since]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/**
 * Count of unread inbound messages for a conversation.
 */
export async function getUnreadCount(conversationId) {
  const db = await getDb();
  const stmt = db.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND direction = 'inbound' AND read = 0"
  );
  stmt.bind([conversationId]);
  stmt.step();
  const { count } = stmt.getAsObject();
  stmt.free();
  return count;
}
