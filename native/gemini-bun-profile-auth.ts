/**
 * Chrome profile cookie injection for Bun WebView (macOS only).
 *
 * Reads cookies from a real Chrome profile's SQLite DB, decrypts them
 * using the Chrome Safe Storage key from Keychain, and injects them
 * into the headless WebView via CDP Network.setCookies.
 *
 * Must be called BEFORE navigating to Gemini.
 */

// @ts-ignore — bun:sqlite is a Bun built-in
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const {
  REQUIRED_COOKIES,
  ALL_COOKIE_NAMES,
} = require("./gemini-common.cjs");

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "surf-gemini-cookies-"));
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

      // Build IN clause
      const placeholders = ALL_COOKIE_NAMES.map(() => "?").join(",");
      const query = `
        SELECT name, value, encrypted_value, host_key, path,
               expires_utc, is_secure, is_httponly, samesite
        FROM cookies
        WHERE name IN (${placeholders})
          AND (host_key = '.google.com' OR host_key LIKE '%.google.com')
      `;

      const rows = db.query(query).all(...ALL_COOKIE_NAMES) as any[];
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
      // Retry once
    } finally {
      if (db) { try { db.close(); } catch {} }
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (cleanupErr: any) {
          process.stderr.write(
            `[bun-gemini] Warning: failed to clean cookie snapshot ${tmpDir}: ${cleanupErr.message}\n`,
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
 *
 * @param wv  - Bun WebView instance (must support .cdp())
 * @param opts.profileEmail - email to resolve, or null/undefined for Default
 * @returns metadata about what was injected
 */
export async function loadAndInjectGeminiCookies(
  wv: WebView,
  opts: { profileEmail?: string | null },
): Promise<AuthResult> {
  const diag = (msg: string) => process.stderr.write(`[bun-gemini] ${msg}\n`);

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

  // 4. Verify required cookies present
  const cookieNames = new Set(cookies.map((c) => c.name));
  const missingRequired = (REQUIRED_COOKIES as string[]).filter(
    (n) => !cookieNames.has(n),
  );
  if (missingRequired.length > 0) {
    throw Object.assign(
      new Error(
        `Required Google cookies missing: ${missingRequired.join(", ")}. ` +
        `Please log into Gemini in Chrome profile "${profile.dirName}".`,
      ),
      { code: "login_required" },
    );
  }

  diag(`Extracted ${cookies.length} cookies (${REQUIRED_COOKIES.length} required present)`);

  // 5. Enable Network domain + inject
  await wv.cdp("Network.enable");
  await wv.cdp("Network.setCookies", { cookies });

  // 6. Verify injection
  const verification = (await wv.cdp("Network.getCookies", {
    urls: ["https://gemini.google.com/", "https://accounts.google.com/"],
  })) as { cookies: Array<{ name: string }> };

  const injectedNames = new Set(
    (verification.cookies || []).map((c: any) => c.name),
  );
  const stillMissing = (REQUIRED_COOKIES as string[]).filter(
    (n) => !injectedNames.has(n),
  );
  if (stillMissing.length > 0) {
    throw Object.assign(
      new Error(
        `Cookie injection verification failed. Missing: ${stillMissing.join(", ")}`,
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
