import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
export function openDb(file){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,settings TEXT NOT NULL DEFAULT '{}',rev INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(user_id TEXT NOT NULL,org_id TEXT NOT NULL,role TEXT NOT NULL,seller_id TEXT,PRIMARY KEY(user_id,org_id));
    CREATE TABLE IF NOT EXISTS entities(org_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,pos INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,PRIMARY KEY(org_id,kind,id));
    CREATE TABLE IF NOT EXISTS records(org_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,pos INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,PRIMARY KEY(org_id,kind,id));
    CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,org_id TEXT NOT NULL,user_id TEXT,ts INTEGER NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(org_id,kind,pos);
    CREATE INDEX IF NOT EXISTS idx_records_kind ON records(org_id,kind,pos);
    CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id,id DESC);
  `);
  return db;
}
export function tx(db,fn){const f=db.transaction(fn);return f();}
