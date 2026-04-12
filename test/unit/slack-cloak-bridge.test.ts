import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isSlackCloakAvailable,
  __setSlackRuntimeForTests,
  __resetSlackRuntimeForTests,
} from "../../native/slack-cloak-bridge.cjs";

describe("slack-cloak-bridge", () => {
  afterEach(() => {
    __resetSlackRuntimeForTests();
  });

  describe("isSlackCloakAvailable", () => {
    it("returns false when cloakbrowser is not installed", () => {
      __setSlackRuntimeForTests({ existsSync: () => false });
      expect(isSlackCloakAvailable()).toBe(false);
    });

    it("returns true when cloakbrowser is installed", () => {
      __setSlackRuntimeForTests({
        existsSync: (p: string) => p.includes("cloakbrowser/package.json"),
      });
      expect(isSlackCloakAvailable()).toBe(true);
    });
  });
});
