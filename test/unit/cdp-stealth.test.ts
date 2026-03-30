import { describe, expect, it, vi } from "vitest";

const stealth = require("../../native/cdp-stealth.cjs");

describe("cdp-stealth", () => {
  describe("stripHeadlessFromUserAgent", () => {
    it("replaces HeadlessChrome with Chrome", () => {
      const ua =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/146.0.0.0 Safari/537.36";
      const result = stealth.stripHeadlessFromUserAgent(ua);
      expect(result).not.toContain("HeadlessChrome");
      expect(result).toContain("Chrome/146.0.0.0");
    });

    it("leaves normal Chrome UA untouched", () => {
      const ua =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
      expect(stealth.stripHeadlessFromUserAgent(ua)).toBe(ua);
    });

    it("handles null/undefined gracefully", () => {
      expect(stealth.stripHeadlessFromUserAgent(null)).toBeNull();
      expect(stealth.stripHeadlessFromUserAgent(undefined)).toBeUndefined();
    });
  });

  describe("resolveStealthLocale", () => {
    it("resolves locale with region", () => {
      const result = stealth.resolveStealthLocale("en-US");
      expect(result.languages).toContain("en-US");
      expect(result.languages).toContain("en");
      expect(result.acceptLanguage).toBe("en-US,en");
    });

    it("resolves locale without region", () => {
      const result = stealth.resolveStealthLocale("en");
      expect(result.languages[0]).toBe("en");
      expect(result.acceptLanguage).toContain("en");
    });

    it("normalizes underscore to dash", () => {
      const result = stealth.resolveStealthLocale("he_IL");
      expect(result.languages[0]).toBe("he-IL");
      expect(result.languages).toContain("he");
    });

    it("falls back to en-US for empty input", () => {
      const result = stealth.resolveStealthLocale("");
      expect(result.languages[0]).toBe("en-US");
    });

    it("includes en fallback when locale is non-English", () => {
      const result = stealth.resolveStealthLocale("fr-FR");
      expect(result.languages).toContain("fr-FR");
      expect(result.languages).toContain("fr");
      expect(result.languages).toContain("en-US");
      expect(result.languages).toContain("en");
    });
  });

  describe("resolveNavigatorPlatform", () => {
    it("maps darwin to MacIntel", () => {
      expect(stealth.resolveNavigatorPlatform("darwin")).toBe("MacIntel");
    });

    it("maps linux to Linux x86_64", () => {
      expect(stealth.resolveNavigatorPlatform("linux")).toBe("Linux x86_64");
    });

    it("maps win32 to Win32", () => {
      expect(stealth.resolveNavigatorPlatform("win32")).toBe("Win32");
    });

    it("defaults to Linux x86_64 for unknown", () => {
      expect(stealth.resolveNavigatorPlatform("freebsd")).toBe("Linux x86_64");
    });
  });

  describe("buildStealthInitScript", () => {
    it("returns a string containing all expected patches", () => {
      const script = stealth.buildStealthInitScript({
        languages: ["en-US", "en"],
        platform: "MacIntel",
      });

      expect(script).toContain("navigator");
      expect(script).toContain("webdriver");
      expect(script).toContain("languages");
      expect(script).toContain("platform");
      expect(script).toContain("plugins");
      expect(script).toContain("chrome");
      expect(script).toContain("Permissions");
      expect(script).toContain("MacIntel");
      expect(script).toContain("en-US");
    });

    it("embeds provided languages array", () => {
      const script = stealth.buildStealthInitScript({
        languages: ["he-IL", "he", "en-US", "en"],
        platform: "MacIntel",
      });
      expect(script).toContain("he-IL");
      expect(script).toContain('"he"');
    });
  });

  describe("applyCdpStealth", () => {
    it("calls CDP methods in correct order", async () => {
      const calls: string[] = [];
      const mockWv = {
        cdp: vi.fn(async (method: string, _params?: any) => {
          calls.push(method);
          if (method === "Browser.getVersion") {
            return {
              userAgent:
                "Mozilla/5.0 HeadlessChrome/146.0.0.0 Safari/537.36",
            };
          }
          return {};
        }),
      };

      const result = await stealth.applyCdpStealth(mockWv);

      expect(calls).toEqual([
        "Page.enable",
        "Browser.getVersion",
        "Emulation.setUserAgentOverride",
        "Page.addScriptToEvaluateOnNewDocument",
      ]);
      expect(result.uaOverrideApplied).toBe(true);
      expect(result.initScriptApplied).toBe(true);
      expect(result.userAgent).toContain("Chrome/146.0.0.0");
      expect(result.userAgent).not.toContain("HeadlessChrome");
    });

    it("skips UA override when Browser.getVersion fails", async () => {
      const calls: string[] = [];
      const mockWv = {
        cdp: vi.fn(async (method: string) => {
          calls.push(method);
          if (method === "Browser.getVersion") {
            throw new Error("not supported");
          }
          return {};
        }),
      };

      const result = await stealth.applyCdpStealth(mockWv);

      expect(calls).toEqual([
        "Page.enable",
        "Browser.getVersion",
        "Page.addScriptToEvaluateOnNewDocument",
      ]);
      expect(result.uaOverrideApplied).toBe(false);
      expect(result.initScriptApplied).toBe(true);
      expect(result.userAgent).toBeNull();
    });

    it("throws if Page.addScriptToEvaluateOnNewDocument fails", async () => {
      const mockWv = {
        cdp: vi.fn(async (method: string) => {
          if (method === "Browser.getVersion") {
            return { userAgent: "HeadlessChrome/100" };
          }
          if (method === "Page.addScriptToEvaluateOnNewDocument") {
            throw new Error("CDP unsupported");
          }
          return {};
        }),
      };

      await expect(stealth.applyCdpStealth(mockWv)).rejects.toThrow(
        "CDP unsupported",
      );
    });

    it("returns correct metadata", async () => {
      const mockWv = {
        cdp: vi.fn(async (method: string) => {
          if (method === "Browser.getVersion") {
            return { userAgent: "HeadlessChrome/146.0.0.0" };
          }
          return {};
        }),
      };

      const result = await stealth.applyCdpStealth(mockWv, {
        locale: "fr-FR",
      });

      expect(result.languages).toContain("fr-FR");
      expect(result.languages).toContain("fr");
      expect(result.platform).toBe("MacIntel"); // running on macOS
      expect(result.acceptLanguage).toContain("fr-FR");
    });
  });
});
