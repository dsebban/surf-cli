import { describe, it, expect } from "vitest";

const utils = require("../../native/chrome-profile-utils.cjs");

describe("chrome-profile-utils", () => {
  describe("extractProfileEmails", () => {
    it("extracts emails from account_info", () => {
      const prefs = {
        account_info: [
          { email: "Alice@Example.com" },
          { email: "bob@test.org" },
        ],
      };
      expect(utils.extractProfileEmails(prefs)).toEqual([
        "alice@example.com",
        "bob@test.org",
      ]);
    });

    it("dedupes emails", () => {
      const prefs = {
        account_info: [
          { email: "same@example.com" },
          { email: "Same@Example.com" },
        ],
      };
      expect(utils.extractProfileEmails(prefs)).toEqual(["same@example.com"]);
    });

    it("falls back to google.services.last_username", () => {
      const prefs = {
        google: { services: { last_username: "fallback@gmail.com" } },
      };
      expect(utils.extractProfileEmails(prefs)).toEqual([
        "fallback@gmail.com",
      ]);
    });

    it("ignores last_username without @", () => {
      const prefs = {
        google: { services: { last_username: "noemail" } },
      };
      expect(utils.extractProfileEmails(prefs)).toEqual([]);
    });

    it("handles empty / missing prefs gracefully", () => {
      expect(utils.extractProfileEmails({})).toEqual([]);
      expect(utils.extractProfileEmails(null)).toEqual([]);
      expect(utils.extractProfileEmails(undefined)).toEqual([]);
    });

    it("filters out non-email values from account_info", () => {
      const prefs = {
        account_info: [
          { email: "valid@test.com" },
          { email: "no-at-sign" },
          { email: "" },
          { email: null },
        ],
      };
      expect(utils.extractProfileEmails(prefs)).toEqual(["valid@test.com"]);
    });
  });

  describe("resolveChromeProfile", () => {
    const candidates = [
      {
        dirName: "Default",
        profilePath: "/chrome/Default",
        cookieDbPath: "/chrome/Default/Cookies",
        emails: ["dan@gmail.com", "bob@gmail.com"],
      },
      {
        dirName: "Profile 1",
        profilePath: "/chrome/Profile 1",
        cookieDbPath: "/chrome/Profile 1/Cookies",
        emails: ["admin@corp.com"],
      },
      {
        dirName: "Profile 2",
        profilePath: "/chrome/Profile 2",
        cookieDbPath: "/chrome/Profile 2/Cookies",
        emails: ["bob@gmail.com", "dan@gmail.com"],
      },
    ];

    it("returns Default when no email specified", () => {
      const result = utils.resolveChromeProfile(candidates);
      expect(result.profile.dirName).toBe("Default");
    });

    it("returns Default when email is undefined", () => {
      const result = utils.resolveChromeProfile(candidates, undefined);
      expect(result.profile.dirName).toBe("Default");
    });

    it("finds exact match", () => {
      const result = utils.resolveChromeProfile(candidates, "admin@corp.com");
      expect(result.profile.dirName).toBe("Profile 1");
    });

    it("matches case-insensitively", () => {
      const result = utils.resolveChromeProfile(candidates, "Admin@Corp.com");
      expect(result.profile.dirName).toBe("Profile 1");
    });

    it("prefers profile where email is primary (first)", () => {
      // bob@gmail.com is first in Profile 2, secondary in Default
      const result = utils.resolveChromeProfile(candidates, "bob@gmail.com");
      expect(result.profile.dirName).toBe("Profile 2");
    });

    it("returns error for unknown email", () => {
      const result = utils.resolveChromeProfile(
        candidates,
        "nobody@nowhere.com"
      );
      expect(result.error).toBeDefined();
      expect(result.code).toBe("profile_not_found");
    });

    it("returns error when no Default exists", () => {
      const noDefault = candidates.filter((c) => c.dirName !== "Default");
      const result = utils.resolveChromeProfile(noDefault);
      expect(result.error).toBeDefined();
      expect(result.code).toBe("profile_not_found");
    });

    it("returns ambiguous error when email is primary in multiple profiles", () => {
      const ambig = [
        { dirName: "Profile A", emails: ["dup@test.com"] },
        { dirName: "Profile B", emails: ["dup@test.com"] },
      ];
      const result = utils.resolveChromeProfile(ambig, "dup@test.com");
      expect(result.code).toBe("profile_ambiguous");
      expect(result.error).toContain("Profile A");
      expect(result.error).toContain("Profile B");
    });

    it("returns ambiguous when no primary but multiple secondary", () => {
      const ambig = [
        { dirName: "P1", emails: ["main@a.com", "shared@test.com"] },
        { dirName: "P2", emails: ["main@b.com", "shared@test.com"] },
      ];
      const result = utils.resolveChromeProfile(ambig, "shared@test.com");
      expect(result.code).toBe("profile_ambiguous");
    });

    it("picks single secondary match when no primary", () => {
      const cands = [
        { dirName: "P1", emails: ["main@a.com", "secondary@test.com"] },
        { dirName: "P2", emails: ["main@b.com"] },
      ];
      const result = utils.resolveChromeProfile(cands, "secondary@test.com");
      expect(result.profile.dirName).toBe("P1");
    });
  });

  describe("deriveChromeCookieKey", () => {
    it("derives a 16-byte key", () => {
      const key = utils.deriveChromeCookieKey("test-password");
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(16);
    });

    it("produces consistent output for same input", () => {
      const k1 = utils.deriveChromeCookieKey("pw123");
      const k2 = utils.deriveChromeCookieKey("pw123");
      expect(k1.toString("hex")).toBe(k2.toString("hex"));
    });
  });

  describe("decryptCookieValue", () => {
    it("returns null for non-v10 prefix", () => {
      expect(
        utils.decryptCookieValue(Buffer.from("v20abcd"), Buffer.alloc(16))
      ).toBeNull();
    });

    it("returns null for too-short buffer", () => {
      expect(
        utils.decryptCookieValue(Buffer.from("v1"), Buffer.alloc(16))
      ).toBeNull();
    });

    it("returns null for null/undefined", () => {
      expect(utils.decryptCookieValue(null, Buffer.alloc(16))).toBeNull();
      expect(utils.decryptCookieValue(undefined, Buffer.alloc(16))).toBeNull();
    });

    it("round-trips with known key + ciphertext", () => {
      // Encrypt a known value with v10 prefix + AES-128-CBC + space IV
      const crypto = require("crypto");
      const key = utils.deriveChromeCookieKey("test-key-for-round-trip");
      const iv = Buffer.alloc(16, 0x20);

      // Build plaintext: 32-byte binary prefix + actual value
      const prefix = crypto.randomBytes(32);
      const value = "my-session-token-12345";
      const plaintext = Buffer.concat([prefix, Buffer.from(value, "utf-8")]);

      const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
      const encrypted = Buffer.concat([
        Buffer.from("v10"),
        cipher.update(plaintext),
        cipher.final(),
      ]);

      const decrypted = utils.decryptCookieValue(encrypted, key);
      expect(decrypted).toBe(value);
    });
  });

  describe("chromeMicrosToUnixSeconds", () => {
    it("converts Chrome timestamp to Unix seconds", () => {
      // Known: Chrome epoch offset is 11644473600 seconds
      // A timestamp of 13300000000000000 microseconds from 1601
      const unixSec = utils.chromeMicrosToUnixSeconds(13300000000000000);
      expect(typeof unixSec).toBe("number");
      expect(unixSec).toBeGreaterThan(0);
    });

    it("returns undefined for 0", () => {
      expect(utils.chromeMicrosToUnixSeconds(0)).toBeUndefined();
    });

    it("returns undefined for null/undefined", () => {
      expect(utils.chromeMicrosToUnixSeconds(null)).toBeUndefined();
      expect(utils.chromeMicrosToUnixSeconds(undefined)).toBeUndefined();
    });
  });

  describe("chromeSamesiteToCdp", () => {
    it("maps -1 to None", () => {
      expect(utils.chromeSamesiteToCdp(-1)).toBe("None");
    });
    it("maps 1 to Lax", () => {
      expect(utils.chromeSamesiteToCdp(1)).toBe("Lax");
    });
    it("maps 2 to Strict", () => {
      expect(utils.chromeSamesiteToCdp(2)).toBe("Strict");
    });
    it("returns undefined for 0 (unspecified)", () => {
      expect(utils.chromeSamesiteToCdp(0)).toBeUndefined();
    });
  });

  describe("discoverChromeProfiles (live)", () => {
    it("discovers at least one profile on this machine", () => {
      // Only runs when Chrome is installed and SURF_TEST_LIVE=1 is set.
      // Skip in CI or machines without a populated Chrome profile.
      if (process.platform !== "darwin" || !process.env.SURF_TEST_LIVE) return;
      const profiles = utils.discoverChromeProfiles();
      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles[0]).toHaveProperty("dirName");
      expect(profiles[0]).toHaveProperty("cookieDbPath");
      expect(profiles[0]).toHaveProperty("emails");
    });
  });
});
