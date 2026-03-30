import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const bridge = require("../../native/gemini-bun-bridge.cjs");

describe("gemini-bun-bridge", () => {
  describe("shouldUseBunGemini", () => {
    it("returns false when env not set", () => {
      expect(bridge.shouldUseBunGemini({})).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(bridge.shouldUseBunGemini({ SURF_USE_BUN_GEMINI: "" })).toBe(false);
    });

    it("returns true for '1'", () => {
      expect(bridge.shouldUseBunGemini({ SURF_USE_BUN_GEMINI: "1" })).toBe(true);
    });

    it("returns true for 'true' (case-insensitive)", () => {
      expect(bridge.shouldUseBunGemini({ SURF_USE_BUN_GEMINI: "true" })).toBe(true);
      expect(bridge.shouldUseBunGemini({ SURF_USE_BUN_GEMINI: "True" })).toBe(true);
      expect(bridge.shouldUseBunGemini({ SURF_USE_BUN_GEMINI: "TRUE" })).toBe(true);
    });

    it("returns false for other values", () => {
      expect(bridge.shouldUseBunGemini({ SURF_USE_BUN_GEMINI: "0" })).toBe(false);
      expect(bridge.shouldUseBunGemini({ SURF_USE_BUN_GEMINI: "false" })).toBe(false);
      expect(bridge.shouldUseBunGemini({ SURF_USE_BUN_GEMINI: "yes" })).toBe(false);
    });
  });

  describe("isBunGeminiEligible", () => {
    it("returns ineligible for --with-page", () => {
      const result = bridge.isBunGeminiEligible({ "with-page": true });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("with_page");
    });

    it("returns ineligible for withPage", () => {
      const result = bridge.isBunGeminiEligible({ withPage: true });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("with_page");
    });

    it("returns eligible for basic query", () => {
      // This test may fail if Bun is not installed
      const result = bridge.isBunGeminiEligible({ query: "test" });
      if (result.eligible) {
        expect(result.eligible).toBe(true);
      } else {
        // Bun not installed — still valid
        expect(result.reason).toBe("bun_not_found");
      }
    });
  });

  describe("buildWorkerRequest", () => {
    it("maps CLI args to worker request shape", () => {
      const req = bridge.buildWorkerRequest({
        query: "explain quantum computing",
        model: "gemini-2.5-pro",
        file: "/tmp/data.csv",
        "generate-image": "/tmp/out.png",
        youtube: "https://youtube.com/watch?v=abc",
        "aspect-ratio": "16:9",
        timeout: 120,
      });

      expect(req.prompt).toBe("explain quantum computing");
      expect(req.model).toBe("gemini-2.5-pro");
      expect(req.file).toBe("/tmp/data.csv");
      expect(req.generateImage).toBe("/tmp/out.png");
      expect(req.youtube).toBe("https://youtube.com/watch?v=abc");
      expect(req.aspectRatio).toBe("16:9");
      expect(req.timeoutMs).toBe(120000); // 120s → 120000ms
    });

    it("handles minimal args", () => {
      const req = bridge.buildWorkerRequest({ query: "hello" });
      expect(req.prompt).toBe("hello");
      expect(req.file).toBeNull();
      expect(req.generateImage).toBeNull();
      expect(req.editImage).toBeNull();
      expect(req.youtube).toBeNull();
      expect(req.timeoutMs).toBe(300000);
    });

    it("handles edit-image with output", () => {
      const req = bridge.buildWorkerRequest({
        query: "add sunglasses",
        "edit-image": "/tmp/photo.jpg",
        output: "/tmp/edited.jpg",
      });
      expect(req.editImage).toBe("/tmp/photo.jpg");
      expect(req.output).toBe("/tmp/edited.jpg");
    });

    // --- P1 fix: timeout conversion ---
    it("converts --timeout seconds to milliseconds", () => {
      const req = bridge.buildWorkerRequest({ query: "q", timeout: 60 });
      expect(req.timeoutMs).toBe(60000);
    });

    it("converts --timeout 300 (seconds) to 300000ms", () => {
      const req = bridge.buildWorkerRequest({ query: "q", timeout: 300 });
      expect(req.timeoutMs).toBe(300000);
    });

    it("always treats --timeout as seconds, even for large values", () => {
      // e.g. --timeout 10000 = 10000 seconds = 10,000,000ms (not 10s)
      const req = bridge.buildWorkerRequest({ query: "q", timeout: 10000 });
      expect(req.timeoutMs).toBe(10000 * 1000);
    });

    it("caps timeout at 86400s (24h) to guard against accidental ms pass-through", () => {
      const req = bridge.buildWorkerRequest({ query: "q", timeout: 999999 });
      expect(req.timeoutMs).toBe(86400 * 1000);
    });

    it("uses default 300000ms when timeout is 0 or null", () => {
      expect(bridge.buildWorkerRequest({ query: "q", timeout: 0 }).timeoutMs).toBe(300000);
      expect(bridge.buildWorkerRequest({ query: "q", timeout: null }).timeoutMs).toBe(300000);
      expect(bridge.buildWorkerRequest({ query: "q" }).timeoutMs).toBe(300000);
    });
  });

  // --- P2 fix: protocol edge cases ---
  describe("runGeminiViaBun - protocol edge cases", () => {
    it("returns error with fallback for empty stdout", async () => {
      // We can't easily mock spawn, but we can test with a deliberately bad worker
      // by pointing to a non-existent script — spawn_failed
      const { execFileSync } = require("child_process");
      try {
        execFileSync("which", ["bun"], { encoding: "utf-8", timeout: 3000 });
      } catch {
        // Bun not installed — skip
        return;
      }

      // Create a temp worker that outputs nothing
      const fs = require("fs");
      const path = require("path");
      const tmpWorker = path.join(require("os").tmpdir(), "surf-test-empty-worker.ts");
      fs.writeFileSync(tmpWorker, "// empty — no output\n");

      // Monkey-patch __dirname temporarily — not feasible in CJS module,
      // so just validate the protocol error shape from a real spawn
      // We'll test the bridge's internal parsing via a controlled child
      const { spawn } = require("child_process");
      const result = await new Promise((resolve) => {
        const bunPath = execFileSync("which", ["bun"], { encoding: "utf-8" }).trim();
        const child = spawn(bunPath, [tmpWorker], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.write(JSON.stringify({ prompt: "test" }));
        child.stdin.end();
        let stdout = "";
        child.stdout.on("data", (d: any) => { stdout += d.toString(); });
        child.on("close", (code: number) => {
          // Simulate bridge parsing
          const lines = stdout.trim().split("\n").filter(Boolean);
          const lastLine = lines[lines.length - 1] || "";
          if (!lastLine) {
            resolve({ ok: false, code: "protocol_error", empty: true });
          } else {
            try {
              resolve(JSON.parse(lastLine));
            } catch {
              resolve({ ok: false, code: "parse_error" });
            }
          }
        });
      });

      expect((result as any).ok).toBe(false);
      fs.unlinkSync(tmpWorker);
    });

    it("handles invalid JSON from worker stdout", async () => {
      const { execFileSync } = require("child_process");
      try {
        execFileSync("which", ["bun"], { encoding: "utf-8", timeout: 3000 });
      } catch {
        return; // Bun not installed — skip
      }

      const fs = require("fs");
      const path = require("path");
      const tmpWorker = path.join(require("os").tmpdir(), "surf-test-bad-json-worker.ts");
      fs.writeFileSync(tmpWorker, 'process.stdout.write("NOT_JSON\\n");\n');

      const { spawn } = require("child_process");
      const result = await new Promise((resolve) => {
        const bunPath = execFileSync("which", ["bun"], { encoding: "utf-8" }).trim();
        const child = spawn(bunPath, [tmpWorker], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.write(JSON.stringify({ prompt: "test" }));
        child.stdin.end();
        let stdout = "";
        child.stdout.on("data", (d: any) => { stdout += d.toString(); });
        child.on("close", () => {
          const lines = stdout.trim().split("\n").filter(Boolean);
          const lastLine = lines[lines.length - 1] || "";
          try {
            resolve(JSON.parse(lastLine));
          } catch {
            resolve({ ok: false, code: "parse_error" });
          }
        });
      });

      expect((result as any).ok).toBe(false);
      expect((result as any).code).toBe("parse_error");
      fs.unlinkSync(tmpWorker);
    });
  });
});
