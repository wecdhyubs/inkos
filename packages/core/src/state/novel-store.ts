import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Authoritative novel storage.
 *
 * Chapters, the chapter index and runtime-state JSON live in novel.db inside
 * the Work's source directory. Markdown / JSON files under chapters/ and
 * story/ are read-only projections rebuilt from this database after every
 * write; they are kept so export, Studio and existing callers keep working.
 *
 * source-sync already treats .sqlite/.db files as revisioned artifacts
 * (including WAL hashing and backup-based snapshots), so placing the database
 * under source/ makes it part of the normal Work revision ledger.
 */
export const NOVEL_DB_FILENAME = "novel.db";
export const NOVEL_STORE_SCHEMA_VERSION = "1";

type SqlRow = Record<string, unknown>;

export interface NovelChapter {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly document: string;
  readonly filename: string;
  readonly wordCount: number;
  readonly checksum: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveNovelChapterInput {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly document: string;
  readonly filename: string;
  readonly chapterIndex?: ReadonlyArray<unknown>;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly versionId?: string;
}

function text(row: SqlRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function integer(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(String(value ?? "0"));
}

function rows(result: unknown): SqlRow[] {
  return (Array.isArray(result) ? result : []) as SqlRow[];
}

export class NovelStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(bookDir: string) {
    mkdirSync(bookDir, { recursive: true });
    this.path = join(bookDir, NOVEL_DB_FILENAME);
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initializeSchema();
  }

  static open(bookDir: string): NovelStore {
    return new NovelStore(bookDir);
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS novel_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS novel_chapters (
        number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        document TEXT NOT NULL,
        filename TEXT NOT NULL,
        word_count INTEGER NOT NULL DEFAULT 0,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS novel_chapter_index (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS novel_runtime_state (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS novel_chapter_versions (
        chapter INTEGER NOT NULL,
        version_id TEXT NOT NULL,
        document TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chapter, version_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS novel_chapters_fts USING fts5(
        number UNINDEXED, title, body
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO novel_meta (key, value) VALUES ('schema_version', ?)")
      .run(NOVEL_STORE_SCHEMA_VERSION);
  }

  private tx(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Single transaction: chapter + index + runtime state + version + FTS. */
  saveChapter(input: SaveNovelChapterInput): void {
    const now = new Date().toISOString();
    const checksum = createHash("sha256").update(input.document).digest("hex");
    const wordCount = Array.from(input.body.replace(/\s/gu, "")).length;
    this.tx(() => {
      this.db.prepare(`
        INSERT INTO novel_chapters
          (number, title, body, document, filename, word_count, checksum, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(number) DO UPDATE SET
          title = excluded.title,
          body = excluded.body,
          document = excluded.document,
          filename = excluded.filename,
          word_count = excluded.word_count,
          checksum = excluded.checksum,
          updated_at = excluded.updated_at
      `).run(input.number, input.title, input.body, input.document, input.filename,
        wordCount, checksum, now, now);

      this.db.prepare("DELETE FROM novel_chapters_fts WHERE number = ?").run(String(input.number));
      this.db.prepare("INSERT INTO novel_chapters_fts (number, title, body) VALUES (?, ?, ?)")
        .run(String(input.number), input.title, input.body);

      if (input.chapterIndex) {
        const payload = JSON.stringify(input.chapterIndex, null, 2);
        this.db.prepare(`
          INSERT INTO novel_chapter_index (id, payload, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
        `).run(payload, now);
      }
      for (const [key, value] of Object.entries(input.state ?? {})) {
        this.db.prepare(`
          INSERT INTO novel_runtime_state (key, payload, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
        `).run(key, JSON.stringify(value, null, 2), now);
      }
      if (input.versionId) {
        this.db.prepare(`
          INSERT OR REPLACE INTO novel_chapter_versions (chapter, version_id, document, created_at)
          VALUES (?, ?, ?, ?)
        `).run(input.number, input.versionId, input.document, now);
      }
    });
  }

  private toChapter(row: SqlRow): NovelChapter {
    return {
      number: integer(row, "number"),
      title: text(row, "title"),
      body: text(row, "body"),
      document: text(row, "document"),
      filename: text(row, "filename"),
      wordCount: integer(row, "word_count"),
      checksum: text(row, "checksum"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }

  getChapter(number: number): NovelChapter | null {
    const result = rows(this.db.prepare("SELECT * FROM novel_chapters WHERE number = ?").all(number));
    return result.length ? this.toChapter(result[0]!) : null;
  }

  listChapters(): NovelChapter[] {
    return rows(this.db.prepare("SELECT * FROM novel_chapters ORDER BY number").all())
      .map((row) => this.toChapter(row));
  }

  chapterCount(): number {
    const result = rows(this.db.prepare("SELECT COUNT(*) AS count FROM novel_chapters").all());
    return result.length ? integer(result[0]!, "count") : 0;
  }

  loadIndex(): unknown[] | null {
    const result = rows(this.db.prepare("SELECT payload FROM novel_chapter_index WHERE id = 1").all());
    if (!result.length) return null;
    try {
      const parsed: unknown = JSON.parse(text(result[0]!, "payload"));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  saveIndex(index: ReadonlyArray<unknown>): void {
    const payload = JSON.stringify(index, null, 2);
    const now = new Date().toISOString();
    this.tx(() => {
      this.db.prepare(`
        INSERT INTO novel_chapter_index (id, payload, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `).run(payload, now);
    });
  }

  getState<T = unknown>(key: string): T | null {
    const result = rows(this.db.prepare("SELECT payload FROM novel_runtime_state WHERE key = ?").all(key));
    if (!result.length) return null;
    try {
      return JSON.parse(text(result[0]!, "payload")) as T;
    } catch {
      return null;
    }
  }

  setState(key: string, value: unknown): void {
    const payload = JSON.stringify(value, null, 2);
    const now = new Date().toISOString();
    this.tx(() => {
      this.db.prepare(`
        INSERT INTO novel_runtime_state (key, payload, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `).run(key, payload, now);
    });
  }

  search(query: string, limit = 10): ReadonlyArray<{ number: number; title: string; snippet: string }> {
    const needle = query.trim();
    if (!needle) return [];
    let ftsRows: SqlRow[] = [];
    try {
      ftsRows = rows(this.db.prepare(`
        SELECT number, title, snippet(novel_chapters_fts, 2, '', '', '…', 24) AS snippet
        FROM novel_chapters_fts WHERE novel_chapters_fts MATCH ? ORDER BY bm25(novel_chapters_fts) LIMIT ?
      `).all(needle, limit));
    } catch {
      // FTS5 query syntax (quotes, operators) may reject a raw search string.
    }
    if (ftsRows.length) {
      return ftsRows.map((row) => ({
        number: integer(row, "number"),
        title: text(row, "title"),
        snippet: text(row, "snippet"),
      }));
    }
    // The default unicode61 tokenizer does not split CJK; substring matching
    // keeps Chinese queries usable while BM25 still ranks spaced languages.
    const pattern = `%${needle}%`;
    return rows(this.db.prepare(`
      SELECT number, title, body FROM novel_chapters
      WHERE title LIKE ? OR body LIKE ? ORDER BY number LIMIT ?
    `).all(pattern, pattern, limit)).map((row) => ({
      number: integer(row, "number"),
      title: text(row, "title"),
      snippet: text(row, "body").slice(0, 80),
    }));
  }

  /** One-time migration: absorb legacy Markdown/JSON files into the database. */
  importFromFiles(bookDir: string): number {
    const chaptersDir = join(bookDir, "chapters");
    let imported = 0;
    if (existsSync(chaptersDir)) {
      for (const file of readdirSync(chaptersDir)) {
        const match = file.match(/^(\d+)_.*\.md$/u);
        if (!match) continue;
        const number = Number(match[1]);
        const document = readFileSync(join(chaptersDir, file), "utf-8");
        const lines = document.split("\n");
        const heading = lines[0] ?? "";
        const title = heading.replace(/^#\s*(?:Chapter\s*\d+\s*:\s*|第\s*\d+\s*章\s*)/u, "").trim()
          || file.replace(/^\d+_/u, "").replace(/\.md$/u, "");
        const body = lines.slice(1).join("\n").replace(/^\s*\n/u, "");
        this.saveChapter({ number, title, body, document, filename: file });
        imported += 1;
      }
    }
    const indexPath = join(chaptersDir, "index.json");
    if (existsSync(indexPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(indexPath, "utf-8"));
        if (Array.isArray(parsed)) this.saveIndex(parsed);
      } catch {
        // A broken legacy index is not authority; chapter rows still import.
      }
    }
    const stateDir = join(bookDir, "story", "state");
    if (existsSync(stateDir)) {
      for (const file of readdirSync(stateDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(stateDir, file), "utf-8"));
          this.setState(file.replace(/\.json$/u, ""), parsed);
        } catch {
          // Ignore malformed legacy state files.
        }
      }
    }
    return imported;
  }

  /** Rebuild read-only Markdown/JSON projections from the authoritative rows. */
  rebuildProjections(bookDir: string): number {
    const chaptersDir = join(bookDir, "chapters");
    mkdirSync(chaptersDir, { recursive: true });
    const chapters = this.listChapters();
    const wanted = new Set(chapters.map((chapter) => chapter.filename));
    for (const file of readdirSync(chaptersDir)) {
      if (/^\d+_.*\.md$/u.test(file) && !wanted.has(file)) rmSync(join(chaptersDir, file));
    }
    for (const chapter of chapters) {
      writeFileSync(join(chaptersDir, chapter.filename), chapter.document, "utf-8");
    }
    const index = this.loadIndex();
    if (index) writeFileSync(join(chaptersDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf-8");
    const stateDir = join(bookDir, "story", "state");
    mkdirSync(stateDir, { recursive: true });
    const stateRows = rows(this.db.prepare("SELECT key, payload FROM novel_runtime_state").all());
    for (const row of stateRows) {
      writeFileSync(join(stateDir, `${text(row, "key")}.json`), text(row, "payload"), "utf-8");
    }
    return chapters.length;
  }
}
