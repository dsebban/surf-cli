/**
 * Chrome profile cookie injection for ChatGPT Bun WebView (macOS only).
 *
 * Reads cookies from a real Chrome profile's SQLite DB for chatgpt.com
 * and openai.com domains, decrypts them using the Chrome Safe Storage
 * key from Keychain, and injects them into the headless WebView via
 * CDP Network.setCookies.
 *
 * Must be called BEFORE navigating to ChatGPT.
 */

// @ts-ignore — bun:sqlite is a Bun built-in
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const {
  discoverChromeProfiles,
  resolveChromeProfile,
  readChromeKeychainPassword,
  deriveChromeCookieKey,
  decryptCookieValue,
  chromeMicrosToUnixSeconds,
  chromeSamesiteToCdp,
} = require("./chrome-profile-utils.cjs");

// ============================================================================
// Constants
// ============================================================================

const CHATGPT_COOKIE_DOMAINS = [
  ".chatgpt.com",
  ".openai.com",
  ".auth0.openai.com",
];

// The main session cookie that must be present after injection
const REQUIRED_SESSION_COOKIE = "__Secure-next-auth.session-token";

// ============================================================================
// Types
// ============================================================================

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: string;
}

interface AuthResult {
  resolvedProfileDir: string;
  resolvedEmails: string[];
  injectedCount: number;
}

interface WebView {
  cdp(method: string, params?: any): Promise<any>;
}

// ============================================================================
// Cookie extraction
// ============================================================================

function snapshotCookieDb(cookieDbPath: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "surf-chatgpt-cookies-"));
  fs.copyFileSync(cookieDbPath, path.join(tmpDir, "Cookies"));
  for (const ext of ["-wal", "-shm"]) {
    const src = cookieDbPath + ext;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(tmpDir, "Cookies" + ext));
    }
  }
  return tmpDir;
}

function extractCookies(
  cookieDbPath: string,
  aesKey: Buffer,
): CdpCookie[] {
  let tmpDir: string | null = null;
  let db: InstanceType<typeof Database> | null = null;
  let lastErr: Error | null = null;

  // Try twice — snapshot may be inconsistent if Chrome is writing
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      tmpDir = snapshotCookieDb(cookieDbPath);
      db = new Database(path.join(tmpDir, "Cookies"), { readonly: true });

      // Query ALL cookies for ChatGPT/OpenAI domains (inject-by-domain strategy)
      const query = `
        SELECT name, value, encrypted_value, host_key, path,
               expires_utc, is_secure, is_httponly, samesite
        FROM cookies
        WHERE host_key IN (?, ?, ?)
           OR host_key LIKE '%.chatgpt.com'
           OR host_key LIKE '%.openai.com'
           OR host_key LIKE '%.auth0.openai.com'
      `;

      const rows = db.query(query).all(...CHATGPT_COOKIE_DOMAINS) as any[];
      db.close();
      db = null;

      // Decrypt + dedupe
      const seen = new Set<string>();
      const cookies: CdpCookie[] = [];

      for (const row of rows) {
        const dedupeKey = `${row.name}|${row.host_key}|${row.path}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        let value = row.value;
        if (!value && row.encrypted_value) {
          value = decryptCookieValue(
            Buffer.from(row.encrypted_value),
            aesKey,
          );
        }
        if (!value) continue;

        // Skip expired (unless session cookie with expires_utc = 0)
        const expiresUnix = chromeMicrosToUnixSeconds(row.expires_utc);
        if (expiresUnix && expiresUnix < Date.now() / 1000) continue;

        const cookie: CdpCookie = {
          name: row.name,
          value,
          domain: row.host_key,
          path: row.path || "/",
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
        };
        if (expiresUnix) cookie.expires = expiresUnix;
        const sameSite = chromeSamesiteToCdp(row.samesite);
        if (sameSite) cookie.sameSite = sameSite;

        cookies.push(cookie);
      }

      return cookies;
    } catch (err: any) {
      lastErr = err;
    } finally {
      if (db) { try { db.close(); } catch {} }
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (cleanupErr: any) {
          process.stderr.write(
            `[bun-chatgpt] Warning: failed to clean cookie snapshot ${tmpDir}: ${cleanupErr.message}\n`,
          );
        }
      }
      tmpDir = null;
    }
  }

  throw new Error(
    `Failed to read cookie DB after 2 attempts: ${lastErr?.message}. ` +
    `Try closing Chrome and retrying.`,
  );
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Load cookies from a Chrome profile and inject into the WebView via CDP.
 */
export async function loadAndInjectChatgptCookies(
  wv: WebView,
  opts: { profileEmail?: string | null },
): Promise<AuthResult> {
  const diag = (msg: string) => process.stderr.write(`[bun-chatgpt] ${msg}\n`);

  // 1. Resolve profile
  const profiles = discoverChromeProfiles();
  const resolution = resolveChromeProfile(profiles, opts.profileEmail ?? undefined);
  if ("error" in resolution) {
    throw Object.assign(new Error(resolution.error), { code: resolution.code });
  }
  const profile = resolution.profile;
  diag(`Profile: ${profile.dirName} (${profile.emails[0] || "no email"})`);

  // 2. Read keychain
  let password: string;
  try {
    password = readChromeKeychainPassword();
  } catch (err: any) {
    throw Object.assign(
      new Error(`Keychain access failed: ${err.message}`),
      { code: "keychain_access_failed" },
    );
  }

  // 3. Derive key + extract cookies
  const aesKey = deriveChromeCookieKey(password);
  let cookies: CdpCookie[];
  try {
    cookies = extractCookies(profile.cookieDbPath, aesKey);
  } catch (err: any) {
    throw Object.assign(
      new Error(`Cookie DB error: ${err.message}`),
      { code: "cookie_db_unavailable" },
    );
  }

  // 4. Verify required session cookie present
  const hasSession = cookies.some((c) => c.name === REQUIRED_SESSION_COOKIE);
  if (!hasSession) {
    throw Object.assign(
      new Error(
        `Required ChatGPT session cookie missing (${REQUIRED_SESSION_COOKIE}). ` +
        `Please log into ChatGPT in Chrome profile "${profile.dirName}".`,
      ),
      { code: "login_required" },
    );
  }

  diag(`Extracted ${cookies.length} cookies (session token present)`);

  // 5. Enable Network domain + inject
  await wv.cdp("Network.enable");
  await wv.cdp("Network.setCookies", { cookies });

  // 6. Verify injection
  const verification = (await wv.cdp("Network.getCookies", {
    urls: ["https://chatgpt.com/", "https://openai.com/", "https://auth0.openai.com/"],
  })) as { cookies: Array<{ name: string }> };

  const injectedNames = new Set(
    (verification.cookies || []).map((c: any) => c.name),
  );
  if (!injectedNames.has(REQUIRED_SESSION_COOKIE)) {
    throw Object.assign(
      new Error(
        `Cookie injection verification failed. Missing: ${REQUIRED_SESSION_COOKIE}`,
      ),
      { code: "cookie_injection_failed" },
    );
  }

  diag(`Injected ${cookies.length} cookies, verification OK`);

  return {
    resolvedProfileDir: profile.dirName,
    resolvedEmails: profile.emails,
    injectedCount: cookies.length,
  };
}
