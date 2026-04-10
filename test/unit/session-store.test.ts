import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const sessionStore = require("../../native/session-store.cjs");

describe("session-store", () => {
  let tmpDir: string;
  const originalSessionsDir = process.env.SURF_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "surf-session-store-"));
    process.env.SURF_SESSIONS_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalSessionsDir === undefined) {
      process.env.SURF_SESSIONS_DIR = undefined;
    } else {
      process.env.SURF_SESSIONS_DIR = originalSessionsDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists successful response bodies as session artifacts", () => {
    const session = sessionStore.createSession("chatgpt", { query: "hello" }, {});
    session.finish({
      model: "gpt-5.4-pro",
      tookMs: 1234,
      response: "# Review\n\nFull durable body.",
      responsePreview: "# Review",
    });

    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, session.id, "meta.json"), "utf8"));
    expect(meta.status).toBe("completed");
    expect(meta.result.responsePath).toBe(path.join(tmpDir, session.id, "response.md"));
    expect(meta.result.responseChars).toBe(28);
    expect(meta.result.inlineResponse).toBeUndefined();
    expect(fs.readFileSync(meta.result.responsePath, "utf8")).toBe(
      "# Review\n\nFull durable body.",
    );
    expect(fs.readFileSync(path.join(tmpDir, session.id, "output.log"), "utf8")).toContain(
      "response saved:",
    );
  });

  it("stores inline response fallback when finish cannot write the artifact", () => {
    const session = sessionStore.createSession("chatgpt", { query: "hello" }, {});
    fs.mkdirSync(path.join(tmpDir, session.id, "response.md"));

    session.finish({
      model: "gpt-5.4-pro",
      tookMs: 1234,
      response: "inline durable fallback",
      responsePreview: "inline",
    });

    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, session.id, "meta.json"), "utf8"));
    expect(meta.status).toBe("completed");
    expect(meta.result.responsePath).toBeUndefined();
    expect(meta.result.responseChars).toBeUndefined();
    expect(meta.result.inlineResponse).toBe("inline durable fallback");
    expect(meta.result.inlineResponseTruncated).toBe(false);
    expect(meta.result.inlineResponseChars).toBe(23);

    const loaded = sessionStore.loadSession(session.id);
    expect(loaded.response).toBe("inline durable fallback");
    expect(loaded.responseSource).toBe("inline_response");
  });

  it("loadSession prefers response artifact over legacy recoveredResponse", () => {
    const session = sessionStore.createSession("chatgpt", { query: "hello" }, {});
    session.finish({
      model: "gpt-5.4-pro",
      tookMs: 42,
      response: "authoritative artifact body",
      responsePreview: "authoritative",
    });

    const metaPath = path.join(tmpDir, session.id, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.result.recoveredResponse = "legacy body";
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const loaded = sessionStore.loadSession(session.id);
    expect(loaded.response).toBe("authoritative artifact body");
    expect(loaded.responseSource).toBe("artifact");
  });

  it("loadSession falls back to legacy recoveredResponse when artifact is unavailable", () => {
    const session = sessionStore.createSession("chatgpt", { query: "hello" }, {});
    session.finish({
      model: "gpt-5.4-pro",
      tookMs: 42,
      response: "temp artifact body",
      responsePreview: "temp",
    });

    const metaPath = path.join(tmpDir, session.id, "meta.json");
    const responsePath = path.join(tmpDir, session.id, "response.md");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.result.recoveredResponse = "legacy fallback body";
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    fs.rmSync(responsePath, { force: true });

    const loaded = sessionStore.loadSession(session.id);
    expect(loaded.response).toBe("legacy fallback body");
    expect(loaded.responseSource).toBe("legacy_recoveredResponse");
  });
});
