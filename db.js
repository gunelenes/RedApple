'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { JOBS } = require('./constants');

// Railway'de volume eklendiğinde RAILWAY_VOLUME_MOUNT_PATH otomatik tanımlanır.
const dataDir =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, 'data');

fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'redapple.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    job        TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    event_at   TEXT,
    drop_item  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Drop anında orada olan üyeler. İsim/job kopyalanır ki üye silinse bile
  -- geçmiş drop kayıtlarında kimin olduğu kaybolmasın.
  CREATE TABLE IF NOT EXISTS drop_attendees (
    announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    member_id       INTEGER REFERENCES members(id) ON DELETE SET NULL,
    member_name     TEXT NOT NULL,
    member_job      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_drop_attendees_ann ON drop_attendees(announcement_id);
`);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const collator = new Intl.Collator('tr', { sensitivity: 'base' });
const jobRank = (job) => {
  const i = JOBS.indexOf(job);
  return i === -1 ? JOBS.length : i;
};
const byJobThenName = (a, b) =>
  jobRank(a.job) - jobRank(b.job) || collator.compare(a.name, b.name);

/* ---------- Üyeler ---------- */

function listMembers() {
  return db.prepare('SELECT id, name, job FROM members').all().sort(byJobThenName);
}

function addMember(name, job) {
  db.prepare('INSERT INTO members (name, job) VALUES (?, ?)').run(name, job);
}

function updateMember(id, name, job) {
  tx(() => {
    db.prepare('UPDATE members SET name = ?, job = ? WHERE id = ?').run(name, job, id);
    db.prepare('UPDATE drop_attendees SET member_name = ?, member_job = ? WHERE member_id = ?').run(name, job, id);
  });
}

function deleteMember(id) {
  db.prepare('DELETE FROM members WHERE id = ?').run(id);
}

/* ---------- Duyurular ---------- */

function attachAttendees(rows) {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const attendees = db
    .prepare(
      `SELECT announcement_id, member_id, member_name AS name, member_job AS job
       FROM drop_attendees WHERE announcement_id IN (${placeholders})`
    )
    .all(...ids);
  const map = new Map(rows.map((r) => [r.id, []]));
  for (const a of attendees) map.get(a.announcement_id).push(a);
  for (const r of rows) r.attendees = map.get(r.id).sort(byJobThenName);
  return rows;
}

function listAnnouncements(type) {
  const sql = `SELECT * FROM announcements ${type ? 'WHERE type = ?' : ''} ORDER BY created_at DESC, id DESC`;
  const rows = type ? db.prepare(sql).all(type) : db.prepare(sql).all();
  return attachAttendees(rows);
}

function countAnnouncementsByType() {
  const counts = { all: 0 };
  for (const r of db.prepare('SELECT type, COUNT(*) AS n FROM announcements GROUP BY type').all()) {
    counts[r.type] = r.n;
    counts.all += r.n;
  }
  return counts;
}

function getAnnouncement(id) {
  const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  return row ? attachAttendees([row])[0] : null;
}

function setAttendees(announcementId, memberIds) {
  db.prepare('DELETE FROM drop_attendees WHERE announcement_id = ?').run(announcementId);
  const getMember = db.prepare('SELECT id, name, job FROM members WHERE id = ?');
  const insert = db.prepare(
    'INSERT INTO drop_attendees (announcement_id, member_id, member_name, member_job) VALUES (?, ?, ?, ?)'
  );
  for (const id of new Set(memberIds)) {
    const m = getMember.get(id);
    if (m) insert.run(announcementId, m.id, m.name, m.job);
  }
}

function createAnnouncement(a) {
  return tx(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO announcements (type, title, content, event_at, drop_item) VALUES (?, ?, ?, ?, ?)')
      .run(a.type, a.title, a.content, a.event_at, a.drop_item);
    if (a.type === 'drop') setAttendees(Number(lastInsertRowid), a.memberIds);
    return Number(lastInsertRowid);
  });
}

function updateAnnouncement(id, a) {
  tx(() => {
    db.prepare(
      'UPDATE announcements SET type = ?, title = ?, content = ?, event_at = ?, drop_item = ? WHERE id = ?'
    ).run(a.type, a.title, a.content, a.event_at, a.drop_item, id);
    if (a.type === 'drop') {
      // Silinmiş üyeler (member_id NULL) formda görünmediği için korunur.
      const orphans = db
        .prepare('SELECT member_name, member_job FROM drop_attendees WHERE announcement_id = ? AND member_id IS NULL')
        .all(id);
      setAttendees(id, a.memberIds);
      const ins = db.prepare(
        'INSERT INTO drop_attendees (announcement_id, member_id, member_name, member_job) VALUES (?, NULL, ?, ?)'
      );
      for (const o of orphans) ins.run(id, o.member_name, o.member_job);
    } else {
      db.prepare('DELETE FROM drop_attendees WHERE announcement_id = ?').run(id);
    }
  });
}

function deleteAnnouncement(id) {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
}

/* ---------- Yedekleme ---------- */

const safetyDir = path.join(dataDir, 'backups');
const SAFETY_KEEP = 5;
const SAFETY_RE = /^onceki-[\d_-]+\.db$/;

const sqlString = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function userError(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

// Veritabanının tutarlı bir kopyasını verilen dosyaya yazar
function exportTo(file) {
  db.exec(`VACUUM INTO ${sqlString(file)}`);
}

function stats() {
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return { members: n('members'), announcements: n('announcements') };
}

// Geri yüklemeden önce mevcut verinin kopyası (son 5 tanesi saklanır)
function createSafetyBackup(stamp) {
  fs.mkdirSync(safetyDir, { recursive: true });
  const file = path.join(safetyDir, `onceki-${stamp}.db`);
  fs.rmSync(file, { force: true });
  exportTo(file);
  const old = listSafetyBackups().slice(SAFETY_KEEP);
  for (const b of old) fs.rmSync(path.join(safetyDir, b.name), { force: true });
}

function listSafetyBackups() {
  if (!fs.existsSync(safetyDir)) return [];
  return fs
    .readdirSync(safetyDir)
    .filter((f) => SAFETY_RE.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(safetyDir, name));
      return { name, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function safetyBackupPath(name) {
  if (!SAFETY_RE.test(name)) return null;
  const file = path.join(safetyDir, name);
  return fs.existsSync(file) ? file : null;
}

const REQUIRED_COLUMNS = {
  members: ['id', 'name', 'job', 'created_at'],
  announcements: ['id', 'type', 'title', 'content', 'event_at', 'drop_item', 'created_at'],
  drop_attendees: ['announcement_id', 'member_id', 'member_name', 'member_job'],
};

function validateBackup(file) {
  let src;
  try {
    src = new DatabaseSync(file, { readOnly: true });
    const check = src.prepare('PRAGMA integrity_check').get();
    if (Object.values(check)[0] !== 'ok') throw userError('Yedek dosyası bozuk.');
    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
      const have = src.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.every((c) => have.includes(c))) throw userError('Bu dosya bir RedApple yedeği değil.');
    }
  } catch (err) {
    if (err.userMessage) throw err;
    throw userError('Dosya geçerli bir veritabanı yedeği değil.');
  } finally {
    if (src && src.isOpen) src.close();
  }
}

// Yedekteki tüm veriyi mevcut verinin yerine koyar
function restoreFrom(file) {
  validateBackup(file);
  db.prepare('ATTACH DATABASE ? AS up').run(file);
  try {
    tx(() => {
      db.exec(`
        DELETE FROM drop_attendees;
        DELETE FROM announcements;
        DELETE FROM members;
        INSERT INTO members (id, name, job, created_at)
          SELECT id, name, job, created_at FROM up.members;
        INSERT INTO announcements (id, type, title, content, event_at, drop_item, created_at)
          SELECT id, type, title, content, event_at, drop_item, created_at FROM up.announcements;
        INSERT INTO drop_attendees (announcement_id, member_id, member_name, member_job)
          SELECT announcement_id, member_id, member_name, member_job FROM up.drop_attendees;
      `);
    });
  } finally {
    db.exec('DETACH DATABASE up');
  }
  return stats();
}

// Excel dışa aktarımı için ham veri
function exportData() {
  const members = db.prepare('SELECT id, name, job, created_at FROM members').all().sort(byJobThenName);
  const announcements = attachAttendees(
    db.prepare('SELECT * FROM announcements ORDER BY created_at DESC, id DESC').all()
  );
  return { members, announcements };
}

module.exports = {
  dbPath,
  exportData,
  exportTo,
  stats,
  createSafetyBackup,
  listSafetyBackups,
  safetyBackupPath,
  restoreFrom,
  listMembers,
  addMember,
  updateMember,
  deleteMember,
  listAnnouncements,
  countAnnouncementsByType,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
};
