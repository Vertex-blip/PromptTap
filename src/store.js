import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, language TEXT NOT NULL DEFAULT 'kk', lastQuery TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS searches (id TEXT PRIMARY KEY, userId TEXT NOT NULL, query TEXT NOT NULL, results TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS favorites (userId TEXT NOT NULL, promptId TEXT NOT NULL, PRIMARY KEY(userId, promptId));
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    `);
  }
  getUser(id) {
    return this.db.prepare('SELECT language, lastQuery FROM users WHERE id = ?').get(String(id)) ?? { language: 'kk', lastQuery: '' };
  }
  setUser(id, patch) {
    const user = { ...this.getUser(id), ...patch };
    this.db.prepare('INSERT INTO users(id, language, lastQuery) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET language=excluded.language,lastQuery=excluded.lastQuery')
      .run(String(id), user.language, user.lastQuery);
  }
  saveSearch(userId, query, results) {
    const id = randomBytes(8).toString('hex');
    this.db.prepare('DELETE FROM searches WHERE created < ?').run(Date.now() - 7 * 86400000);
    this.db.prepare('INSERT INTO searches VALUES (?, ?, ?, ?, ?)').run(id, String(userId), query, JSON.stringify(results), Date.now());
    return id;
  }
  getSearch(id, userId) {
    const row = this.db.prepare('SELECT query,results FROM searches WHERE id=? AND userId=? AND created>?').get(id, String(userId), Date.now() - 7 * 86400000);
    return row ? { query: row.query, results: JSON.parse(row.results) } : null;
  }
  toggleFavorite(userId, promptId) {
    const removed = this.db.prepare('DELETE FROM favorites WHERE userId=? AND promptId=?').run(String(userId), promptId);
    if (removed.changes) return false;
    this.db.prepare('INSERT INTO favorites VALUES (?, ?)').run(String(userId), promptId);
    return true;
  }
  listFavorites(userId) {
    return this.db.prepare('SELECT promptId FROM favorites WHERE userId=? ORDER BY rowid DESC LIMIT 100').all(String(userId)).map(row => row.promptId);
  }
  consume(key, maximum, windowMs) {
    const now = Date.now();
    this.db.prepare('DELETE FROM limits WHERE expires <= ?').run(now);
    const result = this.db.prepare(`INSERT INTO limits(key,count,expires) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count`).get(key, now + windowMs, maximum);
    return Boolean(result);
  }
  allowRequest(userId) { return this.consume(`request:${userId}`, 12, 60000); }
  close() { this.db.close(); }
}
