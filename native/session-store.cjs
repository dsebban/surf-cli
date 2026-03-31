/**
 * surf-cli session store — inspired by steipete/oracle
 *
 * Layout:
 *   ~/.surf/sessions/<tool>-<slug>_<YYYYMMDD-HHMMSS>/
 *     meta.json   – tool, args, status, timestamps, result, error
 *     output.log  – chronological step-by-step log (stderr progress + final)
 *
 * Public API:
 *   createSession(tool, args, env)  → Session
 *   session.step(msg)
 *   session.finish(result)
 *   session.fail(err)
 *   listSessions({ hours, all, limit })
 *   loadSession(idOrPrefix)
 *   deleteSessions({ hours, all })
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ============================================================================
// Constants
// ============================================================================

const VERSION = (() => {
  try { return require("../package.json").version; } catch { return "unknown"; }
})();

const SESSIONS_DIR = process.env.SURF_SESSIONS_DIR
  || path.join(os.homedir(), ".surf", "sessions");

const DEFAULT_TTL_HOURS = 72;
const MAX_SESSIONS      = 500;

// ============================================================================
// Slug helpers (Oracle-style: prompt words → kebab)
// ============================================================================

function slugify(text, maxWords = 5) {
  if (!text) return "run";
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.slice(0, maxWords).join("-") || "run";
}

function makeSessionId(tool, args) {
  // Derive slug from prompt/query or first meaningful arg
  const promptSource =
    args.query || args.prompt || args.url ||
    (Array.isArray(args._) ? args._.join(" ") : "") || tool;
  const slug = slugify(promptSource, 5);
  // ms precision + pid suffix to prevent collisions on same-second concurrent runs
  const now  = new Date();
  const ts   = now.toISOString()
    .replace(/T/, "_").replace(/:/g, "").replace(/\.(\d{3}).+/, ".$1");  // YYYYMMDD_HHmmss.mmm
  const pid  = (process.pid % 9999).toString().padStart(4, "0");
  return `${tool}-${slug}_${ts}_${pid}`;
}

// ============================================================================
// Arg sanitiser — strip secrets before writing to disk
// ============================================================================

const REDACT_KEYS = new Set(["password", "token", "secret", "key", "auth"]);

function sanitizeArgs(args) {
  if (!args || typeof args !== "object") return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "[redacted]";
    } else if (k === "query" || k === "prompt") {
      // Truncate long prompts in meta (full text is in output.log)
      out[k] = String(v).slice(0, 200) + (String(v).length > 200 ? "…" : "");
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ============================================================================
// Session class
// ============================================================================

class Session {
  constructor(id, dir, meta) {
    this.id  = id;
    this.dir = dir;
    this._meta = meta;
    this._logPath = path.join(dir, "output.log");
  }

  get logPath() { return this._logPath; }

  // Append a line to output.log (structured for replay)
  step(msg) {
    const line = `${msg}\n`;
    try { fs.appendFileSync(this._logPath, line); } catch {}
  }

  // Mark completed
  finish(result = {}) {
    const now = Date.now();
    this._meta.status      = "completed";
    this._meta.completedAt = new Date().toISOString();
    this._meta.elapsedMs   = now - this._meta._startMs;
    delete this._meta._startMs;

    if (result.model)         this._meta.result = { ok: true, model: result.model };
    if (result.tookMs)        this._meta.elapsedMs = result.tookMs;
    if (result.imagePath)     this._meta.result = { ...(this._meta.result||{}), imagePath: result.imagePath };
    if (result.responsePreview) this._meta.result = { ...(this._meta.result||{}), responsePreview: String(result.responsePreview).slice(0, 160) };

    this._writeMeta();
    this.step(`[session] ✓ completed in ${(this._meta.elapsedMs/1000).toFixed(1)}s`);
  }

  // Mark failed
  fail(err) {
    const now = Date.now();
    this._meta.status      = "error";
    this._meta.completedAt = new Date().toISOString();
    this._meta.elapsedMs   = now - (this._meta._startMs || now);
    delete this._meta._startMs;
    this._meta.error = {
      message: err?.message || String(err),
      code:    err?.code    || undefined,
    };
    this._writeMeta();
    this.step(`[session] ✗ error: ${err?.message || err}`);
  }

  _writeMeta() {
    try {
      fs.writeFileSync(
        path.join(this.dir, "meta.json"),
        JSON.stringify(this._meta, null, 2),
      );
    } catch {}
  }
}

// ============================================================================
// createSession
// ============================================================================

function createSession(tool, args = {}, env = {}) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  } catch {}

  const id  = makeSessionId(tool, args);
  const dir = path.join(SESSIONS_DIR, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  // Capture relevant env flags
  const envFlags = {};
  for (const key of ["SURF_USE_BUN_GEMINI","SURF_USE_BUN_CHATGPT","SURF_USE_CLOAK_CHATGPT"]) {
    if (env[key]) envFlags[key] = env[key];
  }

  const meta = {
    id,
    version:   VERSION,
    tool,
    args:      sanitizeArgs(args),
    env:       envFlags,
    status:    "running",
    createdAt: new Date().toISOString(),
    _startMs:  Date.now(),
  };

  const session = new Session(id, dir, meta);
  session._writeMeta();

  // Write header to output.log
  const cmdPreview = [
    Object.entries(envFlags).map(([k]) => `${k}=1`).join(" "),
    `surf ${tool}`,
    args.query ? `"${String(args.query).slice(0, 80)}"` : "",
    args.file  ? `--file ${args.file}` : "",
    args.model ? `--model ${args.model}` : "",
  ].filter(Boolean).join(" ");

  session.step(`[session] ${new Date().toISOString()}`);
  session.step(`[session] ${cmdPreview}`);
  session.step(`[session] id: ${id}`);
  session.step("");

  return session;
}

// ============================================================================
// listSessions
// ============================================================================

function listSessions({ hours = DEFAULT_TTL_HOURS, all = false, limit = 50 } = {}) {
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }

  const cutoff = all ? 0 : Date.now() - hours * 3600 * 1000;

  const sessions = [];
  for (const name of entries) {
    const metaPath = path.join(SESSIONS_DIR, name, "meta.json");
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const ts   = new Date(meta.createdAt).getTime();
      if (!all && ts < cutoff) continue;
      sessions.push(meta);
    } catch {}
  }

  // Sort newest first
  sessions.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return sessions.slice(0, limit);
}

// ============================================================================
// loadSession
// ============================================================================

function loadSession(idOrPrefix) {
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

  // Exact match first
  const exactDir = path.join(SESSIONS_DIR, idOrPrefix);
  if (fs.existsSync(exactDir)) {
    const metaPath = path.join(exactDir, "meta.json");
    const logPath  = path.join(exactDir, "output.log");
    try {
      return {
        meta: JSON.parse(fs.readFileSync(metaPath, "utf8")),
        log:  fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
      };
    } catch {}
  }

  // Prefix search
  let entries;
  try { entries = fs.readdirSync(SESSIONS_DIR); } catch { return null; }

  const matches = entries.filter(e => e.startsWith(idOrPrefix));
  if (matches.length === 0) return null;

  // Sort by createdAt descending (parse each meta.json, fall back to dir name sort)
  const candidates = [];
  for (const name of matches) {
    const mp = path.join(SESSIONS_DIR, name, "meta.json");
    try {
      const m = JSON.parse(fs.readFileSync(mp, "utf8"));
      candidates.push({ name, createdAt: m.createdAt || "" });
    } catch {
      candidates.push({ name, createdAt: "" });
    }
  }
  candidates.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

  const dir      = path.join(SESSIONS_DIR, candidates[0].name);
  const metaPath = path.join(dir, "meta.json");
  const logPath  = path.join(dir, "output.log");
  try {
    return {
      meta: JSON.parse(fs.readFileSync(metaPath, "utf8")),
      log:  fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
    };
  } catch { return null; }
}

// ============================================================================
// deleteSessions
// ============================================================================

function deleteSessions({ hours, all = false } = {}) {
  let entries;
  try { entries = fs.readdirSync(SESSIONS_DIR); } catch { return { deleted: 0, remaining: 0 }; }

  // Validate hours: must be a finite positive number; reject NaN/0/negative.
  // If hours is provided but invalid, refuse to run — do NOT silently delete-all.
  const validHours = (typeof hours === "number" && Number.isFinite(hours) && hours > 0) ? hours : null;
  if (hours !== undefined && hours !== null && validHours === null) {
    throw new Error(`deleteSessions: invalid hours value (${hours}) — must be a positive number`);
  }
  const cutoff = all
    ? Infinity
    : validHours !== null
      ? Date.now() - validHours * 3600 * 1000
      : Infinity;  // no hours + no all — treat as delete-all (explicit opt-in path)

  let deleted = 0;
  for (const name of entries) {
    const dir      = path.join(SESSIONS_DIR, name);
    const metaPath = path.join(dir, "meta.json");
    try {
      if (all) {
        fs.rmSync(dir, { recursive: true, force: true });
        deleted++;
      } else {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (new Date(meta.createdAt).getTime() < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
          deleted++;
        }
      }
    } catch {}
  }

  let remaining = 0;
  try { remaining = fs.readdirSync(SESSIONS_DIR).length; } catch {}
  return { deleted, remaining };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  createSession,
  listSessions,
  loadSession,
  deleteSessions,
  SESSIONS_DIR,
};
