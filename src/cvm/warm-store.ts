// Warm memory — persistent cache in .pi/cvm/cvm.db via node:sqlite.
//
// Survives sessions: symbol index, file fingerprints, HTTP validators, and a
// generic KV space (summaries, search results). WAL mode + transactions.
// If node:sqlite is unavailable (older Node), a Map-backed fallback keeps
// every caller working — the CVM degrades to per-session caching instead of
// crashing the extension.

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

// node:sqlite is loaded lazily via require so the extension still loads (with
// the memory fallback) on Nodes that don't ship it.
const require = createRequire(import.meta.url);

export interface FileRecord {
  path: string;
  fp: string;
  mtimeMs: number;
  size: number;
  lang: string;
  indexedAt: number;
}

export interface SymbolRecord {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number;
  signature: string;
}

export interface RefRecord {
  symbolName: string;
  file: string;
  line: number;
  kind: string; // "call" | "import" | "reference"
}

export interface HttpRecord {
  url: string;
  etag: string | null;
  lastModified: string | null;
  fp: string; // body fingerprint → cold store
  fetchedAt: number;
  ttlAt: number;
  status: number;
  contentType: string;
}

export interface WarmStore {
  readonly backend: "sqlite" | "memory";
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string, ttlMs?: number): void;
  kvDelete(key: string): void;

  fileGet(p: string): FileRecord | undefined;
  fileUpsert(rec: FileRecord): void;
  fileList(): FileRecord[];
  fileDelete(p: string): void;

  symbolsReplaceForFile(file: string, symbols: SymbolRecord[], refs: RefRecord[]): void;
  symbolsByName(name: string): SymbolRecord[];
  symbolsInFile(file: string): SymbolRecord[];
  refsToSymbol(name: string, limit?: number): RefRecord[];
  symbolCount(): number;

  httpGet(url: string): HttpRecord | undefined;
  httpUpsert(rec: HttpRecord): void;

  transaction<T>(fn: () => T): T;
  close(): void;
}

// ── sqlite backend ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, ttl_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, fp TEXT NOT NULL, mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL, lang TEXT NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  file TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  signature TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE TABLE IF NOT EXISTS refs (
  symbol_name TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(symbol_name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file);
CREATE TABLE IF NOT EXISTS http (
  url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, fp TEXT NOT NULL,
  fetched_at INTEGER NOT NULL, ttl_at INTEGER NOT NULL,
  status INTEGER NOT NULL, content_type TEXT NOT NULL
);
`;

class SqliteWarmStore implements WarmStore {
  readonly backend = "sqlite" as const;
  private db: import("node:sqlite").DatabaseSync;
  private stmts = new Map<string, import("node:sqlite").StatementSync>();

  constructor(dbPath: string) {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /** Prepared statements are cached — re-parsing SQL per call is waste. */
  private stmt(sql: string): import("node:sqlite").StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  kvGet(key: string): string | undefined {
    const row = this.stmt("SELECT value, ttl_at FROM kv WHERE key = ?")
      .get(key) as { value: string; ttl_at: number } | undefined;
    if (!row) return undefined;
    if (row.ttl_at !== 0 && row.ttl_at < Date.now()) {
      this.kvDelete(key);
      return undefined;
    }
    return row.value;
  }

  kvSet(key: string, value: string, ttlMs?: number): void {
    const ttlAt = ttlMs ? Date.now() + ttlMs : 0;
    this.stmt("INSERT OR REPLACE INTO kv (key, value, ttl_at) VALUES (?, ?, ?)")
      .run(key, value, ttlAt);
  }

  kvDelete(key: string): void {
    this.stmt("DELETE FROM kv WHERE key = ?").run(key);
  }

  fileGet(p: string): FileRecord | undefined {
    const row = this.stmt("SELECT * FROM files WHERE path = ?").get(p) as
      | { path: string; fp: string; mtime_ms: number; size: number; lang: string; indexed_at: number }
      | undefined;
    if (!row) return undefined;
    return { path: row.path, fp: row.fp, mtimeMs: row.mtime_ms, size: row.size, lang: row.lang, indexedAt: row.indexed_at };
  }

  fileUpsert(rec: FileRecord): void {
    this.stmt(
      "INSERT OR REPLACE INTO files (path, fp, mtime_ms, size, lang, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(rec.path, rec.fp, rec.mtimeMs, rec.size, rec.lang, rec.indexedAt);
  }

  fileList(): FileRecord[] {
    const rows = this.stmt("SELECT * FROM files").all() as Array<{
      path: string; fp: string; mtime_ms: number; size: number; lang: string; indexed_at: number;
    }>;
    return rows.map((r) => ({ path: r.path, fp: r.fp, mtimeMs: r.mtime_ms, size: r.size, lang: r.lang, indexedAt: r.indexed_at }));
  }

  fileDelete(p: string): void {
    this.transaction(() => {
      this.stmt("DELETE FROM files WHERE path = ?").run(p);
      this.stmt("DELETE FROM symbols WHERE file = ?").run(p);
      this.stmt("DELETE FROM refs WHERE file = ?").run(p);
    });
  }

  symbolsReplaceForFile(file: string, symbols: SymbolRecord[], refs: RefRecord[]): void {
    this.transaction(() => {
      this.stmt("DELETE FROM symbols WHERE file = ?").run(file);
      this.stmt("DELETE FROM refs WHERE file = ?").run(file);
      const insSym = this.stmt(
        "INSERT OR REPLACE INTO symbols (id, name, kind, file, line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const s of symbols) insSym.run(s.id, s.name, s.kind, s.file, s.line, s.endLine, s.signature);
      const insRef = this.stmt(
        "INSERT INTO refs (symbol_name, file, line, kind) VALUES (?, ?, ?, ?)",
      );
      for (const r of refs) insRef.run(r.symbolName, r.file, r.line, r.kind);
    });
  }

  symbolsByName(name: string): SymbolRecord[] {
    const rows = this.stmt("SELECT * FROM symbols WHERE name = ?").all(name) as Array<{
      id: string; name: string; kind: string; file: string; line: number; end_line: number; signature: string;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, file: r.file, line: r.line, endLine: r.end_line, signature: r.signature }));
  }

  symbolsInFile(file: string): SymbolRecord[] {
    const rows = this.stmt("SELECT * FROM symbols WHERE file = ? ORDER BY line").all(file) as Array<{
      id: string; name: string; kind: string; file: string; line: number; end_line: number; signature: string;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, file: r.file, line: r.line, endLine: r.end_line, signature: r.signature }));
  }

  refsToSymbol(name: string, limit = 100): RefRecord[] {
    const rows = this.stmt("SELECT * FROM refs WHERE symbol_name = ? LIMIT ?")
      .all(name, limit) as Array<{ symbol_name: string; file: string; line: number; kind: string }>;
    return rows.map((r) => ({ symbolName: r.symbol_name, file: r.file, line: r.line, kind: r.kind }));
  }

  symbolCount(): number {
    const row = this.stmt("SELECT COUNT(*) AS n FROM symbols").get() as { n: number };
    return row.n;
  }

  httpGet(url: string): HttpRecord | undefined {
    const row = this.stmt("SELECT * FROM http WHERE url = ?").get(url) as
      | { url: string; etag: string | null; last_modified: string | null; fp: string; fetched_at: number; ttl_at: number; status: number; content_type: string }
      | undefined;
    if (!row) return undefined;
    return {
      url: row.url, etag: row.etag, lastModified: row.last_modified, fp: row.fp,
      fetchedAt: row.fetched_at, ttlAt: row.ttl_at, status: row.status, contentType: row.content_type,
    };
  }

  httpUpsert(rec: HttpRecord): void {
    this.stmt(
      "INSERT OR REPLACE INTO http (url, etag, last_modified, fp, fetched_at, ttl_at, status, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(rec.url, rec.etag, rec.lastModified, rec.fp, rec.fetchedAt, rec.ttlAt, rec.status, rec.contentType);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

// ── in-memory fallback ──────────────────────────────────────────────────────

class MemoryWarmStore implements WarmStore {
  readonly backend = "memory" as const;
  private kv = new Map<string, { value: string; ttlAt: number }>();
  private files = new Map<string, FileRecord>();
  private symbols = new Map<string, SymbolRecord[]>(); // by file
  private refs = new Map<string, RefRecord[]>(); // by file
  private http = new Map<string, HttpRecord>();

  kvGet(key: string): string | undefined {
    const e = this.kv.get(key);
    if (!e) return undefined;
    if (e.ttlAt !== 0 && e.ttlAt < Date.now()) {
      this.kv.delete(key);
      return undefined;
    }
    return e.value;
  }
  kvSet(key: string, value: string, ttlMs?: number): void {
    this.kv.set(key, { value, ttlAt: ttlMs ? Date.now() + ttlMs : 0 });
  }
  kvDelete(key: string): void { this.kv.delete(key); }

  fileGet(p: string): FileRecord | undefined { return this.files.get(p); }
  fileUpsert(rec: FileRecord): void { this.files.set(rec.path, rec); }
  fileList(): FileRecord[] { return [...this.files.values()]; }
  fileDelete(p: string): void {
    this.files.delete(p);
    this.symbols.delete(p);
    this.refs.delete(p);
  }

  symbolsReplaceForFile(file: string, symbols: SymbolRecord[], refs: RefRecord[]): void {
    this.symbols.set(file, symbols);
    this.refs.set(file, refs);
  }
  symbolsByName(name: string): SymbolRecord[] {
    const out: SymbolRecord[] = [];
    for (const list of this.symbols.values()) for (const s of list) if (s.name === name) out.push(s);
    return out;
  }
  symbolsInFile(file: string): SymbolRecord[] { return this.symbols.get(file) ?? []; }
  refsToSymbol(name: string, limit = 100): RefRecord[] {
    const out: RefRecord[] = [];
    for (const list of this.refs.values()) {
      for (const r of list) {
        if (r.symbolName === name) {
          out.push(r);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }
  symbolCount(): number {
    let n = 0;
    for (const list of this.symbols.values()) n += list.length;
    return n;
  }

  httpGet(url: string): HttpRecord | undefined { return this.http.get(url); }
  httpUpsert(rec: HttpRecord): void { this.http.set(rec.url, rec); }

  transaction<T>(fn: () => T): T { return fn(); }
  close(): void { /* nothing to release */ }
}

// ── factory ─────────────────────────────────────────────────────────────────

export function cvmDir(cwd: string): string {
  return path.join(cwd, ".pi", "cvm");
}

const stores = new Map<string, WarmStore>();

/** One warm store per project. SQLite when available, memory otherwise. */
export function getWarmStore(cwd: string): WarmStore {
  let store = stores.get(cwd);
  if (store) return store;
  try {
    store = new SqliteWarmStore(path.join(cvmDir(cwd), "cvm.db"));
  } catch {
    store = new MemoryWarmStore();
  }
  stores.set(cwd, store);
  return store;
}

/** Test hook: drop the cached store for a cwd (closes it first). */
export function closeWarmStore(cwd: string): void {
  const store = stores.get(cwd);
  if (store) {
    store.close();
    stores.delete(cwd);
  }
}
