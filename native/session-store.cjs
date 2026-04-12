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
 *   appendSessionLog(id, message)
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

// Read lazily so SURF_SESSIONS_DIR overrides work in tests without module reloading
const getSessionsDir = () =>
  process.env.SURF_SESSIONS_DIR || path.join(os.homedir(), ".surf", "sessions");



const DEFAULT_TTL_HOURS = 72;
const MAX_SESSIONS      = 500;
const RESPONSE_ARTIFACT_NAME = "response.md";
const INLINE_RESPONSE_FIELD = "inlineResponse";
const INLINE_RESPONSE_TRUNCATED_FIELD = "inlineResponseTruncated";
const INLINE_RESPONSE_CHARS_FIELD = "inlineResponseChars";

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

function persistResponseArtifact(dir, response, filename = RESPONSE_ARTIFACT_NAME) {
  if (!dir || typeof response !== "string" || response.length === 0) return null;
  const responsePath = path.join(dir, filename);
  try {
    fs.writeFileSync(responsePath, response, { mode: 0o600 });
    return {
      responsePath,
      responseChars: response.length,
    };
  } catch {
    return null;
  }
}

function applyResponsePersistenceResult(result, response, responseArtifact) {
  const nextResult = result && typeof result === "object" ? result : {};
  delete nextResult[INLINE_RESPONSE_FIELD];
  delete nextResult[INLINE_RESPONSE_TRUNCATED_FIELD];
  delete nextResult[INLINE_RESPONSE_CHARS_FIELD];
  if (responseArtifact) {
    Object.assign(nextResult, responseArtifact);
    return nextResult;
  }
  if (typeof response === "string" && response.length > 0) {
    nextResult[INLINE_RESPONSE_FIELD] = response;
    nextResult[INLINE_RESPONSE_TRUNCATED_FIELD] = false;
    nextResult[INLINE_RESPONSE_CHARS_FIELD] = response.length;
  }
  return nextResult;
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

  // Merge a partial patch into meta (e.g. conversationId, baselineAssistantMessageId)
  update(patch = {}) {
    if (patch && typeof patch === "object") {
      Object.assign(this._meta, patch);
    }
    this._writeMeta();
  }

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

    const nextResult = { ...(this._meta.result || {}), ok: true };
    if (result.model) nextResult.model = result.model;
    if (result.tookMs) this._meta.elapsedMs = result.tookMs;
    if (result.imagePath) nextResult.imagePath = result.imagePath;
    if (result.responsePreview) nextResult.responsePreview = String(result.responsePreview).slice(0, 160);
    const responseArtifact = persistResponseArtifact(this.dir, result.response);
    this._meta.result = applyResponsePersistenceResult(nextResult, result.response, responseArtifact);

    this._writeMeta();
    if (responseArtifact?.responsePath) this.step(`[session] response saved: ${responseArtifact.responsePath}`);
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
      const metaPath = path.join(this.dir, "meta.json");
      fs.writeFileSync(metaPath, JSON.stringify(this._meta, null, 2), { mode: 0o600 });
    } catch {}
  }
}

// ============================================================================
// createSession
// ============================================================================

function createSession(tool, args = {}, env = {}) {
  const sessionsDir = getSessionsDir();
  try {
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  } catch {}

  const id  = makeSessionId(tool, args);
  const dir = path.join(sessionsDir, id);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}

  const meta = {
    id,
    version:   VERSION,
    tool,
    args:      sanitizeArgs(args),
    status:    "running",
    createdAt: new Date().toISOString(),
    _startMs:  Date.now(),
    pid:       process.pid,
    conversationId:             args.conversationId || null,
    baselineAssistantMessageId: null,
    lastCheckpoint:             "created",
    sentAt:                     null,
    reconcile:                  null,
  };

  const session = new Session(id, dir, meta);
  session._writeMeta();

  // Write header to output.log
  const cmdPreview = [
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
  try { fs.mkdirSync(getSessionsDir(), { recursive: true }); } catch {}

  let entries;
  try {
    entries = fs.readdirSync(getSessionsDir());
  } catch {
    return [];
  }

  const cutoff = all ? 0 : Date.now() - hours * 3600 * 1000;

  const sessions = [];
  for (const name of entries) {
    const metaPath = path.join(getSessionsDir(), name, "meta.json");
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
  try { fs.mkdirSync(getSessionsDir(), { recursive: true }); } catch {}

  // Exact match first
  const exactDir = path.join(getSessionsDir(), idOrPrefix);
  if (fs.existsSync(exactDir)) {
    const metaPath = path.join(exactDir, "meta.json");
    const logPath  = path.join(exactDir, "output.log");
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const responseInfo = resolveSessionResponse(meta, exactDir);
      return {
        meta,
        log:  fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
        ...responseInfo,
      };
    } catch {}
  }

  // Prefix search
  let entries;
  try { entries = fs.readdirSync(getSessionsDir()); } catch { return null; }

  const matches = entries.filter(e => e.startsWith(idOrPrefix));
  if (matches.length === 0) return null;

  // Sort by createdAt descending (parse each meta.json, fall back to dir name sort)
  const candidates = [];
  for (const name of matches) {
    const mp = path.join(getSessionsDir(), name, "meta.json");
    try {
      const m = JSON.parse(fs.readFileSync(mp, "utf8"));
      candidates.push({ name, createdAt: m.createdAt || "" });
    } catch {
      candidates.push({ name, createdAt: "" });
    }
  }
  candidates.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

  const dir      = path.join(getSessionsDir(), candidates[0].name);
  const metaPath = path.join(dir, "meta.json");
  const logPath  = path.join(dir, "output.log");
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const responseInfo = resolveSessionResponse(meta, dir);
    return {
      meta,
      log:  fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
      ...responseInfo,
    };
  } catch { return null; }
}

// ============================================================================
// deleteSessions
// ============================================================================

function deleteSessions({ hours, all = false } = {}) {
  let entries;
  try { entries = fs.readdirSync(getSessionsDir()); } catch { return { deleted: 0, remaining: 0 }; }

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
    const dir      = path.join(getSessionsDir(), name);
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
  try { remaining = fs.readdirSync(getSessionsDir()).length; } catch {}
  return { deleted, remaining };
}

// ============================================================================
// Exports
// ============================================================================

// ============================================================================
// updateSession — patch meta.json for an existing session by id
// ============================================================================

function updateSession(id, patch = {}) {
  const dir      = path.join(getSessionsDir(), id);
  const metaPath = path.join(dir, "meta.json");
  try {
    const meta    = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const updated = Object.assign({}, meta, patch);
    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
    return updated;
  } catch {
    return null;
  }
}

function appendSessionLog(id, message) {
  if (!id) return false;
  const dir = path.join(getSessionsDir(), id);
  const logPath = path.join(dir, "output.log");
  try {
    fs.appendFileSync(logPath, `${String(message ?? "")}\n`);
    return true;
  } catch {
    return false;
  }
}

function persistSessionResponse(id, response, filename = RESPONSE_ARTIFACT_NAME) {
  if (!id) return null;
  const dir = path.join(getSessionsDir(), id);
  return persistResponseArtifact(dir, response, filename);
}

function resolveSessionResponse(meta, dir) {
  const result = (meta && typeof meta === "object" && meta.result && typeof meta.result === "object") ? meta.result : {};
  const configuredResponsePath = typeof result.responsePath === "string" && result.responsePath.trim() ? result.responsePath : null;
  const artifactCandidates = configuredResponsePath
    ? [configuredResponsePath, path.join(dir, RESPONSE_ARTIFACT_NAME)]
    : [path.join(dir, RESPONSE_ARTIFACT_NAME)];

  for (const candidate of artifactCandidates) {
    if (!candidate) continue;
    try {
      if (!fs.existsSync(candidate)) continue;
      const response = fs.readFileSync(candidate, "utf8");
      return { response, responseSource: "artifact", responsePath: candidate };
    } catch {
      // fall through to legacy field
    }
  }

  if (typeof result[INLINE_RESPONSE_FIELD] === "string" && result[INLINE_RESPONSE_FIELD].length > 0) {
    return { response: result[INLINE_RESPONSE_FIELD], responseSource: "inline_response", responsePath: configuredResponsePath };
  }

  if (typeof result.recoveredResponse === "string" && result.recoveredResponse.length > 0) {
    return { response: result.recoveredResponse, responseSource: "legacy_recoveredResponse", responsePath: configuredResponsePath };
  }

  return { response: null, responseSource: null, responsePath: configuredResponsePath };
}

// ============================================================================
// Exports
// ============================================================================

const exports_ = {
  createSession,
  listSessions,
  loadSession,
  deleteSessions,
  updateSession,
  appendSessionLog,
  persistSessionResponse,
};
// Dynamic getter so SURF_SESSIONS_DIR env changes are reflected immediately
Object.defineProperty(exports_, "SESSIONS_DIR", {
  get: getSessionsDir,
  enumerable: true,
});
module.exports = exports_;
