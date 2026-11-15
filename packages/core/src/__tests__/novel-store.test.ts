import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOVEL_DB_FILENAME, NovelStore } from "../state/novel-store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "inkos-novel-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function chapter(number: number, title: string, body: string) {
  return {
    number,
    title,
    body,
    document: `# 第${number}章 ${title}\n\n${body}`,
    filename: `${String(number).padStart(4, "0")}_${title}.md`,
  };
}

describe("NovelStore", () => {
  it("stores chapter, index and runtime state as the authority", () => {
    const store = NovelStore.open(root);
    try {
      store.saveChapter({
        ...chapter(1, "起风", "风从北面来，他把门闩上。"),
        chapterIndex: [{ number: 1, title: "起风" }],
        state: { manifest: { schemaVersion: 2 }, hooks: { hooks: [] } },
      });
      store.saveChapter(chapter(2, "旧书店", "她把借阅登记拍了下来。"));
      expect(existsSync(join(root, NOVEL_DB_FILENAME))).toBe(true);
      expect(store.chapterCount()).toBe(2);
      expect(store.getChapter(2)?.title).toBe("旧书店");
      expect(store.getChapter(2)?.body).toBe("她把借阅登记拍了下来。");
      expect(store.loadIndex()).toHaveLength(1);
      expect(store.getState<{ schemaVersion: number }>("manifest")?.schemaVersion).toBe(2);
    } finally {
      store.close();
    }
  });

  it("upserts the same chapter number instead of duplicating", () => {
    const store = NovelStore.open(root);
    try {
      store.saveChapter(chapter(3, "初稿", "第一版。"));
      store.saveChapter(chapter(3, "定稿", "第二版。"));
      expect(store.chapterCount()).toBe(1);
      expect(store.getChapter(3)?.title).toBe("定稿");
      expect(store.getChapter(3)?.body).toBe("第二版。");
    } finally {
      store.close();
    }
  });

  it("finds CJK prose that FTS5 default tokenization cannot split", () => {
    const store = NovelStore.open(root);
    try {
      store.saveChapter(chapter(1, "旧书店", "她把借阅登记拍了下来，没声张。"));
      const hits = store.search("借阅");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.number).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rebuilds read-only projections from database rows", () => {
    const store = NovelStore.open(root);
    try {
      store.saveChapter({
        ...chapter(1, "起风", "风从北面来。"),
        chapterIndex: [{ number: 1, title: "起风" }],
        state: { manifest: { schemaVersion: 2 } },
      });
      expect(store.rebuildProjections(root)).toBe(1);
      const projection = readFileSync(join(root, "chapters", "0001_起风.md"), "utf-8");
      expect(projection).toBe("# 第1章 起风\n\n风从北面来。");
      expect(JSON.parse(readFileSync(join(root, "chapters", "index.json"), "utf-8"))).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(root, "story", "state", "manifest.json"), "utf-8"))).toEqual({ schemaVersion: 2 });
    } finally {
      store.close();
    }
  });

  it("imports legacy Markdown chapters into a fresh database", () => {
    const sourceRoot = join(root, "legacy");
    mkdirSync(join(sourceRoot, "chapters"), { recursive: true });
    mkdirSync(join(sourceRoot, "story", "state"), { recursive: true });
    writeFileSync(join(sourceRoot, "chapters", "0001_起风.md"), "# 第1章 起风\n\n风从北面来。", "utf-8");
    writeFileSync(join(sourceRoot, "chapters", "index.json"), JSON.stringify([{ number: 1, title: "起风" }]), "utf-8");
    writeFileSync(join(sourceRoot, "story", "state", "manifest.json"), JSON.stringify({ schemaVersion: 2 }), "utf-8");

    const store = NovelStore.open(sourceRoot);
    try {
      expect(store.importFromFiles(sourceRoot)).toBe(1);
      expect(store.getChapter(1)?.body.trim()).toBe("风从北面来。");
      expect(store.getState<{ schemaVersion: number }>("manifest")?.schemaVersion).toBe(2);
    } finally {
      store.close();
    }

    const copyRoot = join(root, "copy");
    mkdirSync(copyRoot, { recursive: true });
    cpSync(join(sourceRoot, "chapters"), join(copyRoot, "chapters"), { recursive: true });
    const copy = NovelStore.open(copyRoot);
    try {
      expect(copy.importFromFiles(copyRoot)).toBe(1);
      expect(copy.chapterCount()).toBe(1);
    } finally {
      copy.close();
    }
  });
});
