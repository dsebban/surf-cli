/**
 * Chrome profile cookie injection for CloakBrowser ChatGPT (macOS, Node.js).
 *
 * Mirrors chatgpt-bun-profile-auth.ts but uses node:sqlite instead of bun:sqlite.
 * Extracts ChatGPT/OpenAI cookies from a Chrome profile's encrypted SQLite DB,
 * decrypts them, and injects into a CloakBrowser Playwright BrowserContext.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  discoverChromeProfiles,
  resolveChromeProfile,
  readChromeKeychainPassword,
  deriveChromeCookieKey,
  decryptCookieValue,
  chromeMicrosToUnixSeconds,
  chromeSamesiteToCdp,
} = require('./chrome-profile-utils.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHATGPT_COOKIE_DOMAINS = [
  '.chatgpt.com',
  '.openai.com',
  '.auth0.openai.com',
];

const REQUIRED_SESSION_COOKIE = '__Secure-next-auth.session-token';
const SESSION_COOKIE_CHUNKED_RE = /^__Secure-next-auth\.session-token(\.\d+)?$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot Chrome cookie DB (+ WAL/SHM) to a temp dir for safe reading.
 * Chrome holds a write lock on the original.
 */
function snapshotCookieDb(cookieDbPath) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'surf-cloak-cookies-'));
  const dest = join(tmpDir, 'Cookies');
  copyFileSync(cookieDbPath, dest);
  for (const ext of ['-wal', '-shm']) {
    const src = cookieDbPath + ext;
    if (existsSync(src)) copyFileSync(src, join(tmpDir, 'Cookies' + ext));
  }
  return { tmpDir, dbPath: dest };
}

/**
 * Extract and decrypt ChatGPT cookies from a Chrome cookie DB.
 */
function extractCookies(cookieDbPath, aesKey) {
  let snapshot = null;
  let lastErr = null;

  // Try twice — WAL may be inconsistent if Chrome is writing
  for (let attempt = 0; attempt < 2; attempt++) {
    let db = null;
    try {
      snapshot = snapshotCookieDb(cookieDbPath);
      db = new DatabaseSync(snapshot.dbPath, { readOnly: true });

      // CAST expires_utc to TEXT — node:sqlite throws on large integers
      // that exceed Number.MAX_SAFE_INTEGER (Chrome uses microsecond timestamps)
      const query = `
        SELECT name, value, encrypted_value, host_key, path,
               CAST(expires_utc AS TEXT) as expires_utc,
               is_secure, is_httponly, samesite
        FROM cookies
        WHERE host_key IN (?, ?, ?)
           OR host_key LIKE '%.chatgpt.com'
           OR host_key LIKE '%.openai.com'
           OR host_key LIKE '%.auth0.openai.com'
      `;

      const stmt = db.prepare(query);
      const rows = stmt.all(...CHATGPT_COOKIE_DOMAINS);
      db.close();
      db = null;

      // Decrypt + dedupe
      const seen = new Set();
      const cookies = [];

      for (const row of rows) {
        const dedupeKey = `${row.name}|${row.host_key}|${row.path}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        let value = row.value;
        if (!value && row.encrypted_value) {
          value = decryptCookieValue(Buffer.from(row.encrypted_value), aesKey);
        }
        if (!value) continue;

        // Skip expired (session cookies have expires_utc = 0)
        const expiresUnix = chromeMicrosToUnixSeconds(Number(row.expires_utc));
        if (expiresUnix && expiresUnix < Date.now() / 1000) continue;

        const cookie = {
          name: row.name,
          value,
          domain: row.host_key,
          path: row.path || '/',
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
        };
        if (expiresUnix) cookie.expires = expiresUnix;
        const sameSite = chromeSamesiteToCdp(row.samesite);
        if (sameSite) cookie.sameSite = sameSite;

        cookies.push(cookie);
      }

      return cookies;

    } catch (err) {
      lastErr = err;
    } finally {
      if (db) try { db.close(); } catch {}
      if (snapshot?.tmpDir) {
        try { rmSync(snapshot.tmpDir, { recursive: true, force: true }); } catch {}
      }
      snapshot = null;
    }
  }

  throw new Error(
    `Failed to read cookie DB after 2 attempts: ${lastErr?.message}. ` +
    `Try closing Chrome and retrying.`
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Load cookies from a Chrome profile and inject into a CloakBrowser context.
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {{ profileEmail?: string|null, log?: (msg:string) => void }} opts
 * @returns {Promise<{ resolvedProfileDir: string, resolvedEmails: string[], injectedCount: number }>}
 */
export async function loadAndInjectChatgptCookies(context, opts = {}) {
  const diag = opts.log || ((msg) => process.stderr.write(`[cloak-auth] ${msg}\n`));

  // 1. Resolve profile
  const profiles = discoverChromeProfiles();
  const resolution = resolveChromeProfile(profiles, opts.profileEmail ?? undefined);
  if ('error' in resolution) {
    throw Object.assign(new Error(resolution.error), { code: resolution.code });
  }
  const profile = resolution.profile;
  diag(`Profile: ${profile.dirName} (${profile.emails[0] || 'no email'})`);

  // 2. Read keychain password
  let password;
  try {
    password = readChromeKeychainPassword();
  } catch (err) {
    throw Object.assign(
      new Error(`Keychain access failed: ${err.message}`),
      { code: 'keychain_access_failed' }
    );
  }

  // 3. Derive key + extract cookies
  const aesKey = deriveChromeCookieKey(password);
  let cookies;
  try {
    cookies = extractCookies(profile.cookieDbPath, aesKey);
  } catch (err) {
    throw Object.assign(
      new Error(`Cookie DB error: ${err.message}`),
      { code: 'cookie_db_unavailable' }
    );
  }

  // 4. Verify required session cookie present
  const hasSession = cookies.some(c => SESSION_COOKIE_CHUNKED_RE.test(c.name));
  if (!hasSession) {
    throw Object.assign(
      new Error(
        `Required ChatGPT session cookie missing (${REQUIRED_SESSION_COOKIE}). ` +
        `Please log into ChatGPT in Chrome profile "${profile.dirName}".`
      ),
      { code: 'login_required' }
    );
  }

  diag(`Extracted ${cookies.length} cookies (session token present)`);

  // 5. Inject cookies into Playwright context
  await context.addCookies(cookies);

  // 6. Verify injection
  const injected = await context.cookies([
    'https://chatgpt.com/',
    'https://openai.com/',
    'https://auth0.openai.com/',
  ]);
  const injectedNames = new Set(injected.map(c => c.name));
  const hasInjectedSession = injected.some(c => SESSION_COOKIE_CHUNKED_RE.test(c.name));
  if (!hasInjectedSession) {
    throw Object.assign(
      new Error(`Cookie injection verification failed. Missing: ${REQUIRED_SESSION_COOKIE} (or chunked variant)`),
      { code: 'cookie_injection_failed' }
    );
  }

  diag(`Injected ${cookies.length} cookies, verification OK`);

  return {
    resolvedProfileDir: profile.dirName,
    resolvedEmails: profile.emails,
    injectedCount: cookies.length,
  };
}
