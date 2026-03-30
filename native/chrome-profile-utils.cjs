/**
 * Chrome profile discovery, cookie extraction and decryption (macOS only).
 *
 * Pure helpers — no Bun or WebView dependency.
 * Used by the Bun Gemini auth module to inject cookies via CDP.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ============================================================================
// Constants
// ============================================================================

const CHROME_ROOT =
  process.env.SURF_CHROME_ROOT ||
  path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");

const KEYCHAIN_SERVICE = "Chrome Safe Storage";
const PBKDF2_SALT = "saltysalt";
const PBKDF2_ITERATIONS = 1003;
const PBKDF2_KEY_LEN = 16;
const AES_IV = Buffer.alloc(16, " "); // 16 space chars

// ============================================================================
// Profile Discovery
// ============================================================================

/**
 * Discover Chrome profiles under the given root directory.
 *
 * @param {string} [chromeRoot] - defaults to ~/Library/Application Support/Google/Chrome
 * @returns {Array<{ dirName: string, profilePath: string, cookieDbPath: string, emails: string[] }>}
 */
function discoverChromeProfiles(chromeRoot) {
  const root = chromeRoot || CHROME_ROOT;
  if (!fs.existsSync(root)) return [];

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    // Only Default and Profile N dirs
    if (name !== "Default" && !/^Profile \d+$/.test(name)) continue;

    const profilePath = path.join(root, name);
    const prefsPath = path.join(profilePath, "Preferences");
    if (!fs.existsSync(prefsPath)) continue;

    // Cookie DB: prefer <profile>/Cookies, fallback <profile>/Network/Cookies
    let cookieDbPath = path.join(profilePath, "Cookies");
    if (!fs.existsSync(cookieDbPath)) {
      const alt = path.join(profilePath, "Network", "Cookies");
      if (fs.existsSync(alt)) {
        cookieDbPath = alt;
      } else {
        continue; // no cookie db found
      }
    }

    // Extract emails from Preferences
    let emails = [];
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      emails = extractProfileEmails(prefs);
    } catch {
      // unreadable prefs → skip
      continue;
    }

    candidates.push({ dirName: name, profilePath, cookieDbPath, emails });
  }

  return candidates;
}

/**
 * Extract email addresses from a Chrome Preferences object.
 *
 * @param {object} prefs - Parsed Preferences JSON
 * @returns {string[]}   - Lowercase, deduped emails
 */
function extractProfileEmails(prefs) {
  const seen = new Set();
  const out = [];

  // Primary source: account_info[*].email
  const accounts = prefs?.account_info;
  if (Array.isArray(accounts)) {
    for (const acct of accounts) {
      const email = (acct?.email || "").trim().toLowerCase();
      if (email && email.includes("@") && !seen.has(email)) {
        seen.add(email);
        out.push(email);
      }
    }
  }

  // Fallback: google.services.last_username
  const lastUser = (prefs?.google?.services?.last_username || "").trim().toLowerCase();
  if (lastUser && lastUser.includes("@") && !seen.has(lastUser)) {
    seen.add(lastUser);
    out.push(lastUser);
  }

  return out;
}

/**
 * Resolve a Chrome profile by email address.
 *
 * @param {Array} candidates - from discoverChromeProfiles()
 * @param {string} [requestedEmail] - if omitted, returns "Default" profile
 * @returns {{ profile: object } | { error: string, code: string }}
 */
function resolveChromeProfile(candidates, requestedEmail) {
  if (!requestedEmail) {
    const def = candidates.find((c) => c.dirName === "Default");
    if (def) return { profile: def };
    return { error: "No Default Chrome profile found", code: "profile_not_found" };
  }

  const needle = requestedEmail.trim().toLowerCase();
  const matches = candidates.filter((c) =>
    c.emails.some((e) => e === needle)
  );

  if (matches.length === 0) {
    const allEmails = [...new Set(candidates.flatMap((c) => c.emails))];
    return {
      error: `No Chrome profile found for "${requestedEmail}". Available: ${allEmails.join(", ") || "none"}`,
      code: "profile_not_found",
    };
  }

  // Prefer the profile where the email is the *primary* (first) account.
  const primaries = matches.filter((c) => c.emails[0] === needle);
  if (primaries.length === 1) return { profile: primaries[0] };
  if (primaries.length > 1) {
    return {
      error: `Multiple profiles have "${requestedEmail}" as primary: ${primaries.map((m) => m.dirName).join(", ")}`,
      code: "profile_ambiguous",
    };
  }

  // No primary match — if exactly one secondary match, use it
  if (matches.length === 1) return { profile: matches[0] };
  return {
    error: `Multiple profiles contain "${requestedEmail}" (none as primary): ${matches.map((m) => m.dirName).join(", ")}. Use a profile where this email is the main account.`,
    code: "profile_ambiguous",
  };
}

// ============================================================================
// Keychain
// ============================================================================

/**
 * Read Chrome Safe Storage password from macOS Keychain.
 *
 * @returns {string} - raw password string
 * @throws {Error} if keychain access fails
 */
function readChromeKeychainPassword() {
  const { execFileSync } = require("child_process");
  try {
    const pw = execFileSync("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ], { encoding: "utf-8", timeout: 10000 }).trim();
    if (!pw) throw new Error("Empty password returned");
    return pw;
  } catch (err) {
    throw new Error(
      `Failed to read Chrome Safe Storage from Keychain: ${err.message}. ` +
      `You may need to allow access in Keychain Access.app.`
    );
  }
}

// ============================================================================
// Cookie Decryption
// ============================================================================

/**
 * Derive the AES-128-CBC key from the Chrome Safe Storage password.
 *
 * @param {string} password - from Keychain
 * @returns {Buffer} 16-byte key
 */
function deriveChromeCookieKey(password) {
  return crypto.pbkdf2Sync(
    password,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LEN,
    "sha1"
  );
}

/**
 * Decrypt a single Chrome cookie encrypted_value.
 *
 * Chrome macOS v10 format:
 *   'v10' prefix (3 bytes) + AES-128-CBC(plaintext)
 *
 * Modern Chrome (≈130+) prepends a 32-byte opaque prefix to the plaintext
 * before encrypting. After decryption, we strip those 32 bytes to get the
 * actual cookie value. Older cookies without the prefix are detected by
 * checking whether the first 32 bytes contain only printable ASCII.
 *
 * @param {Buffer} encryptedValue - raw encrypted_value blob from SQLite
 * @param {Buffer} key            - from deriveChromeCookieKey()
 * @returns {string|null}         - decrypted value or null on failure
 */
function decryptCookieValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length < 4) return null;

  // Chrome v10 format: 'v10' prefix (3 bytes) + AES-128-CBC ciphertext
  const prefix = encryptedValue.slice(0, 3).toString("utf-8");
  if (prefix !== "v10") return null;

  const ciphertext = encryptedValue.slice(3);
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, AES_IV);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // Modern Chrome adds a 32-byte binary prefix to the plaintext.
    // Detect: if first 32 bytes contain non-printable chars, strip them.
    if (decrypted.length > 32) {
      const head = decrypted.slice(0, 32);
      const hasBinary = head.some((b) => b < 0x20 || b > 0x7e);
      if (hasBinary) {
        return decrypted.slice(32).toString("utf-8");
      }
    }

    // Legacy: entire decrypted buffer is the cookie value
    return decrypted.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Convert Chrome's microsecond-based expires_utc to Unix epoch seconds.
 * Chrome epoch: Jan 1, 1601 (Windows FILETIME).
 *
 * @param {number} expiresUtc - Chrome microsecond timestamp
 * @returns {number|undefined}
 */
function chromeMicrosToUnixSeconds(expiresUtc) {
  if (!expiresUtc || expiresUtc === 0) return undefined;
  // Chrome epoch offset: 11644473600 seconds between 1601-01-01 and 1970-01-01
  const unixSec = Math.floor(expiresUtc / 1000000) - 11644473600;
  return unixSec > 0 ? unixSec : undefined;
}

/**
 * Map Chrome samesite integer to CDP string.
 *
 * @param {number} samesite - 0=unspecified, 1=lax, 2=strict, -1=none
 * @returns {string|undefined}
 */
function chromeSamesiteToCdp(samesite) {
  switch (samesite) {
    case -1: return "None";
    case 1:  return "Lax";
    case 2:  return "Strict";
    default: return undefined;
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  CHROME_ROOT,
  discoverChromeProfiles,
  extractProfileEmails,
  resolveChromeProfile,
  readChromeKeychainPassword,
  deriveChromeCookieKey,
  decryptCookieValue,
  chromeMicrosToUnixSeconds,
  chromeSamesiteToCdp,
};
