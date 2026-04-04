"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_DIR = path.join(os.homedir(), ".surf", "cache");
const CACHE_PATH = path.join(CACHE_DIR, "chatgpt-chats.json");
const DEFAULT_TTL_MS = 60 * 1000;

function ensureDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return { entries: {} };
  }
}

function writeStore(store) {
  ensureDir();
  // Atomic write: temp file + rename to prevent torn writes from concurrent processes
  const tmpPath = CACHE_PATH + `.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, CACHE_PATH);
}

function buildCacheKey(args = {}) {
  return JSON.stringify({
    action: args.action || "list",
    conversationId: args.conversationId || null,
    query: args.query || null,
    limit: args.limit || null,
    all: args.all === true,
    profile: args.profile || null,
  });
}

function getCachedChats(args = {}, ttlMs = DEFAULT_TTL_MS) {
  const store = readStore();
  const key = buildCacheKey(args);
  const entry = store.entries[key];
  if (!entry) return null;
  if ((Date.now() - entry.savedAt) > ttlMs) return null;
  return entry.value;
}

function setCachedChats(args = {}, value) {
  const store = readStore();
  const key = buildCacheKey(args);
  store.entries[key] = { savedAt: Date.now(), value };
  writeStore(store);
}

function invalidateCachedChats(predicate) {
  const store = readStore();
  const nextEntries = {};
  for (const [key, entry] of Object.entries(store.entries || {})) {
    let parsed = null;
    try { parsed = JSON.parse(key); } catch {}
    if (predicate && predicate(parsed, entry)) continue;
    if (!predicate) continue;
    nextEntries[key] = entry;
  }
  if (!predicate) {
    writeStore({ entries: {} });
    return;
  }
  writeStore({ entries: nextEntries });
}

module.exports = {
  CACHE_PATH,
  DEFAULT_TTL_MS,
  buildCacheKey,
  getCachedChats,
  setCachedChats,
  invalidateCachedChats,
};
