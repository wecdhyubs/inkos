import { Command } from "commander";
import { join } from "node:path";
import { NovelStore } from "@actalk/inkos-core";
import { findProjectRoot, log, logError } from "../utils.js";

function sourceDir(bookId: string): string {
  return join(findProjectRoot(), "works", bookId, "source");
}

function withStore<T>(bookId: string, work: (store: NovelStore, dir: string) => T): T {
  const dir = sourceDir(bookId);
  const store = NovelStore.open(dir);
  try {
    return work(store, dir);
  } finally {
    store.close();
  }
}

export const novelCommand = new Command("novel")
  .description("Inspect the authoritative novel database (novel.db)");

novelCommand
  .command("import")
  .description("Absorb legacy Markdown chapters, index and state JSON into novel.db")
  .argument("<book-id>")
  .action((bookId: string) => {
    try {
      const count = withStore(bookId, (store, dir) => store.importFromFiles(dir));
      log(`Imported ${count} chapter(s) into novel.db for "${bookId}".`);
    } catch (error) {
      logError(`Import failed: ${error}`);
      process.exitCode = 1;
    }
  });

novelCommand
  .command("list")
  .description("List chapters stored in the database")
  .argument("<book-id>")
  .option("--json", "Output JSON")
  .action((bookId: string, opts: { json?: boolean }) => {
    try {
      const chapters = withStore(bookId, (store) => store.listChapters());
      if (opts.json) {
        log(JSON.stringify(chapters.map(({ number, title, wordCount, checksum, updatedAt }) => ({
          number, title, wordCount, checksum, updatedAt,
        })), null, 2));
        return;
      }
      if (!chapters.length) log(`No chapters in novel.db for "${bookId}".`);
      for (const chapter of chapters) {
        log(`${chapter.number} | ${chapter.title} | ${chapter.wordCount} chars | ${chapter.filename}`);
      }
    } catch (error) {
      logError(`List failed: ${error}`);
      process.exitCode = 1;
    }
  });

novelCommand
  .command("show")
  .description("Print one chapter's prose from the database")
  .argument("<book-id>")
  .argument("<chapter>", Number.parseInt)
  .action((bookId: string, chapter: number) => {
    try {
      const row = withStore(bookId, (store) => store.getChapter(chapter));
      if (!row) {
        logError(`Chapter ${chapter} not found in novel.db for "${bookId}".`);
        process.exitCode = 1;
        return;
      }
      log(row.body);
    } catch (error) {
      logError(`Show failed: ${error}`);
      process.exitCode = 1;
    }
  });

novelCommand
  .command("search")
  .description("Full-text search across chapter prose")
  .argument("<book-id>")
  .argument("<query>")
  .option("--limit <n>", "Max results", "10")
  .action((bookId: string, query: string, opts: { limit?: string }) => {
    try {
      const limit = Number.parseInt(opts.limit ?? "10", 10);
      const hits = withStore(bookId, (store) => store.search(query, Number.isFinite(limit) ? limit : 10));
      if (!hits.length) log("No matches.");
      for (const hit of hits) log(`${hit.number} | ${hit.title} | ${hit.snippet}`);
    } catch (error) {
      logError(`Search failed: ${error}`);
      process.exitCode = 1;
    }
  });

novelCommand
  .command("rebuild")
  .description("Rebuild read-only Markdown/JSON projections from the database")
  .argument("<book-id>")
  .action((bookId: string) => {
    try {
      const count = withStore(bookId, (store, dir) => store.rebuildProjections(dir));
      log(`Rebuilt projections for ${count} chapter(s) in "${bookId}".`);
    } catch (error) {
      logError(`Rebuild failed: ${error}`);
      process.exitCode = 1;
    }
  });
