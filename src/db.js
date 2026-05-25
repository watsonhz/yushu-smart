const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', '.data', 'bot.db');

let db;

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      pid INTEGER,
      started_at TEXT,
      last_active TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_role TEXT,
      depends_on TEXT,
      result TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_role);

    CREATE TABLE IF NOT EXISTS locks (
      id TEXT PRIMARY KEY,
      resource TEXT NOT NULL UNIQUE,
      holder TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_locks_resource ON locks(resource);
  `);
  return db;
}

function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

// ── Messages ──

function insertMessage(id, chatId, role, content) {
  return getDb().prepare(
    'INSERT OR IGNORE INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)'
  ).run(id, chatId, role, content);
}

function messageExists(id) {
  return getDb().prepare('SELECT 1 FROM messages WHERE id = ?').get(id) !== undefined;
}

function getRecentMessages(chatId, limit = 20) {
  return getDb().prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(chatId, limit).reverse();
}

// ── Sessions ──

function createSession(id, chatId, agentRole) {
  return getDb().prepare(
    'INSERT OR REPLACE INTO sessions (id, chat_id, agent_role, status) VALUES (?, ?, ?, ?)'
  ).run(id, chatId, agentRole, 'starting');
}

function updateSessionStatus(id, status, pid = null) {
  const stmt = pid !== null
    ? getDb().prepare('UPDATE sessions SET status = ?, pid = ?, last_active = datetime(\'now\') WHERE id = ?')
    : getDb().prepare('UPDATE sessions SET status = ?, last_active = datetime(\'now\') WHERE id = ?');
  stmt.run(status, ...(pid !== null ? [pid, id] : [id]));
}

function getSession(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function getActiveSessions(chatId) {
  return getDb().prepare(
    'SELECT * FROM sessions WHERE chat_id = ? AND status IN (\'running\', \'idle\')'
  ).all(chatId);
}

function getIdleSessions(maxIdleMs) {
  return getDb().prepare(
    `SELECT * FROM sessions WHERE status = 'idle'
     AND datetime(last_active) < datetime('now', ? || ' seconds')`
  ).all(String(-Math.floor(maxIdleMs / 1000)));
}

function touchSession(id) {
  return getDb().prepare(
    'UPDATE sessions SET last_active = datetime(\'now\') WHERE id = ?'
  ).run(id);
}

// ── Tasks ──

function createTask(id, chatId, title, description, priority, dependsOn, createdBy) {
  return getDb().prepare(
    `INSERT OR IGNORE INTO tasks (id, chat_id, title, description, priority, depends_on, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, chatId, title, description, priority, dependsOn, createdBy);
}

function updateTaskStatus(id, status, result) {
  return getDb().prepare(
    'UPDATE tasks SET status = ?, result = COALESCE(?, result), updated_at = datetime(\'now\') WHERE id = ?'
  ).run(status, result, id);
}

function assignTask(id, role) {
  return getDb().prepare(
    'UPDATE tasks SET assigned_role = ?, status = \'in_progress\', updated_at = datetime(\'now\') WHERE id = ?'
  ).run(role, id);
}

function getTasks(chatId, status) {
  let sql = 'SELECT * FROM tasks WHERE chat_id = ?';
  const params = [chatId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at ASC';
  return getDb().prepare(sql).all(...params);
}

function getReadyTasks(chatId) {
  return getDb().prepare(
    `SELECT t.* FROM tasks t
     WHERE t.chat_id = ? AND t.status = 'pending'
     AND (t.depends_on IS NULL OR t.depends_on = ''
          OR EXISTS (SELECT 1 FROM tasks d WHERE d.id = t.depends_on AND d.status = 'completed'))`
  ).all(chatId);
}

// ── Locks ──

function acquireLock(resource, holder, ttlMs) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  try {
    getDb().prepare(
      'INSERT INTO locks (id, resource, holder, expires_at) VALUES (?, ?, ?, ?)'
    ).run(`${resource}-${Date.now()}`, resource, holder, expiresAt);
    return true;
  } catch {
    const existing = getDb().prepare('SELECT * FROM locks WHERE resource = ?').get(resource);
    if (existing && new Date(existing.expires_at) < new Date()) {
      getDb().prepare('DELETE FROM locks WHERE resource = ?').run(resource);
      return acquireLock(resource, holder, ttlMs);
    }
    return false;
  }
}

function releaseLock(resource) {
  return getDb().prepare('DELETE FROM locks WHERE resource = ?').run(resource);
}

function cleanupExpiredLocks() {
  return getDb().prepare(
    "DELETE FROM locks WHERE expires_at < datetime('now')"
  ).run();
}

module.exports = {
  init, getDb,
  insertMessage, messageExists, getRecentMessages,
  createSession, updateSessionStatus, getSession, getActiveSessions, getIdleSessions, touchSession,
  createTask, updateTaskStatus, assignTask, getTasks, getReadyTasks,
  acquireLock, releaseLock, cleanupExpiredLocks,
};
