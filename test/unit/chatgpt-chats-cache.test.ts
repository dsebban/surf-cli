import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempHome = "";

function loadCacheModule() {
  return require("../../native/chatgpt-chats-cache.cjs");
}

describe("chatgpt-chats-cache", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "surf-chats-cache-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("stores and retrieves cached values", () => {
    const cache = loadCacheModule();
    const args = { action: "list", limit: 5 };
    const value = { action: "list", items: [{ id: "c1" }], total: 1 };

    cache.setCachedChats(args, value);
    expect(cache.getCachedChats(args)).toEqual(value);
  });

  it("expires stale entries", () => {
    const cache = loadCacheModule();
    const args = { action: "search", query: "auth" };
    cache.setCachedChats(args, { action: "search", items: [], total: 0 });

    expect(cache.getCachedChats(args, -1)).toBeNull();
  });

  it("invalidates all entries", () => {
    const cache = loadCacheModule();
    cache.setCachedChats({ action: "list" }, { action: "list", items: [], total: 0 });
    cache.invalidateCachedChats();
    expect(cache.getCachedChats({ action: "list" })).toBeNull();
  });

  it("uses atomic write (no torn files on crash)", () => {
    const cache = loadCacheModule();
    const args = { action: "list", limit: 10 };
    const value = { action: "list", items: [{ id: "c1" }], total: 1 };

    cache.setCachedChats(args, value);

    // Verify the file exists and is valid JSON (atomic rename completed)
    const raw = fs.readFileSync(cache.CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.entries).toBeDefined();

    // Verify no .tmp files left behind
    const cacheDir = path.dirname(cache.CACHE_PATH);
    const tmpFiles = fs.readdirSync(cacheDir).filter((f: string) => f.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  it("invalidates entries by predicate", () => {
    const cache = loadCacheModule();
    cache.setCachedChats({ action: "list", limit: 5 }, { action: "list", items: [], total: 0 });
    cache.setCachedChats({ action: "search", query: "auth" }, { action: "search", items: [], total: 0 });

    // Remove only search entries
    cache.invalidateCachedChats((parsed: any) => parsed?.action === "search");

    expect(cache.getCachedChats({ action: "list", limit: 5 })).toBeTruthy();
    expect(cache.getCachedChats({ action: "search", query: "auth" })).toBeNull();
  });
});
