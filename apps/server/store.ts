import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskEvent } from '../../packages/contracts.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL);`);
    const version = this.db.prepare('SELECT version FROM schema_version').get() as { version: number };
    if (version.version !== 1) throw new Error('Unsupported database version; restore a compatible backup.');
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  list<T>(kind: string): T[] {
    return (this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind) as Array<{ value: string }>).map(row => JSON.parse(row.value) as T);
  }
  put<T>(kind: string, id: string, value: T): void {
    this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, id, JSON.stringify(value));
  }
  remove(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(taskId: string, type: string, message: string): TaskEvent {
    const at = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(task_id,at,type,message) VALUES(?,?,?,?)').run(taskId, at, type, message);
    return { sequence: Number(result.lastInsertRowid), taskId, at, type, message };
  }
  events(taskId: string, after = 0): TaskEvent[] {
    return this.db.prepare('SELECT sequence,task_id AS taskId,at,type,message FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT 1000').all(taskId, after) as unknown as TaskEvent[];
  }
  close(): void { this.db.close(); }
}
