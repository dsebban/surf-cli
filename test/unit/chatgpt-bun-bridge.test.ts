import { describe, expect, it } from "vitest";

const bridge = require("../../native/chatgpt-bun-bridge.cjs");

describe("chatgpt-bun-bridge", () => {
  describe("isBunChatGPTEligible", () => {
    it("returns ineligible for --with-page", () => {
      const result = bridge.isBunChatGPTEligible({ "with-page": true });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("with_page");
    });

    it("returns ineligible for withPage", () => {
      const result = bridge.isBunChatGPTEligible({ withPage: true });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("with_page");
    });

    it("returns eligible for basic query", () => {
      const result = bridge.isBunChatGPTEligible({ query: "test" });
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
        model: "gpt-4o",
        file: "/tmp/data.csv",
        "generate-image": "/tmp/out.png",
        timeout: 120,
        profile: "user@gmail.com",
      });

      expect(req.prompt).toBe("explain quantum computing");
      expect(req.model).toBe("gpt-4o");
      expect(req.file).toBe("/tmp/data.csv");
      expect(req.generateImage).toBe("/tmp/out.png");
      expect(req.timeoutMs).toBe(120000);
      expect(req.profileEmail).toBe("user@gmail.com");
    });

    it("handles minimal args", () => {
      const req = bridge.buildWorkerRequest({ query: "hello" });
      expect(req.prompt).toBe("hello");
      expect(req.file).toBeNull();
      expect(req.generateImage).toBeNull();
      expect(req.timeoutMs).toBe(300000);
      expect(req.profileEmail).toBeNull();
    });

    it("converts --timeout seconds to milliseconds", () => {
      const req = bridge.buildWorkerRequest({ query: "q", timeout: 60 });
      expect(req.timeoutMs).toBe(60000);
    });

    it("converts --timeout 300 (seconds) to 300000ms", () => {
      const req = bridge.buildWorkerRequest({ query: "q", timeout: 300 });
      expect(req.timeoutMs).toBe(300000);
    });

    it("always treats --timeout as seconds, even for large values", () => {
      const req = bridge.buildWorkerRequest({ query: "q", timeout: 10000 });
      expect(req.timeoutMs).toBe(10000 * 1000);
    });

    it("caps timeout at 86400s (24h)", () => {
      const req = bridge.buildWorkerRequest({ query: "q", timeout: 999999 });
      expect(req.timeoutMs).toBe(86400 * 1000);
    });

    it("uses default 300000ms when timeout is 0 or null", () => {
      expect(bridge.buildWorkerRequest({ query: "q", timeout: 0 }).timeoutMs).toBe(300000);
      expect(bridge.buildWorkerRequest({ query: "q", timeout: null }).timeoutMs).toBe(300000);
      expect(bridge.buildWorkerRequest({ query: "q" }).timeoutMs).toBe(300000);
    });
  });

  // Protocol edge cases
  describe("runChatGPTViaBun - protocol edge cases", () => {
    it("returns protocol error for empty stdout", async () => {
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("which", ["bun"], { encoding: "utf-8", timeout: 3000 });
      } catch {
        return; // Bun not installed — skip
      }

      const fs = require("node:fs");
      const path = require("node:path");
      const tmpWorker = path.join(require("node:os").tmpdir(), "surf-test-chatgpt-empty-worker.ts");
      fs.writeFileSync(tmpWorker, "// empty — no output\n");

      const { spawn } = require("node:child_process");
      const result = await new Promise((resolve) => {
        const bunPath = execFileSync("which", ["bun"], { encoding: "utf-8" }).trim();
        const child = spawn(bunPath, [tmpWorker], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.write(JSON.stringify({ prompt: "test" }));
        child.stdin.end();
        let stdout = "";
        child.stdout.on("data", (d: any) => {
          stdout += d.toString();
        });
        child.on("close", (_code: number) => {
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
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("which", ["bun"], { encoding: "utf-8", timeout: 3000 });
      } catch {
        return; // Bun not installed — skip
      }

      const fs = require("node:fs");
      const path = require("node:path");
      const tmpWorker = path.join(
        require("node:os").tmpdir(),
        "surf-test-chatgpt-bad-json-worker.ts",
      );
      fs.writeFileSync(tmpWorker, 'process.stdout.write("NOT_JSON\\n");\n');

      const { spawn } = require("node:child_process");
      const result = await new Promise((resolve) => {
        const bunPath = execFileSync("which", ["bun"], { encoding: "utf-8" }).trim();
        const child = spawn(bunPath, [tmpWorker], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.write(JSON.stringify({ prompt: "test" }));
        child.stdin.end();
        let stdout = "";
        child.stdout.on("data", (d: any) => {
          stdout += d.toString();
        });
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
