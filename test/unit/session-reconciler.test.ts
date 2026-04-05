/**
 * Unit tests for native/session-reconciler.cjs
 *
 * Tests:
 *  - defaultPidIsAlive: invalid/dead/alive pids
 *  - inspectConversation: completed / no_new_assistant / in_progress / ambiguous
 *  - reconcileSessions: pid-alive skip / orphan local / recovered (network) / unresolved / poll_failed
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── helpers ──────────────────────────────────────────────────────────────────

type Reconciler = {
  defaultPidIsAlive: (pid: unknown) => boolean;
  isChatGptCloakSession: (meta: unknown) => boolean;
  resolveConversationId: (meta: unknown) => string | null;
  inspectConversation: (
    conv: unknown,
    meta?: unknown,
  ) => { outcome: string; nodeId: string | null };
  reconcileSessions: (opts?: Record<string, unknown>) => Promise<{
    reconciled: number;
    sessions: Array<{ meta: unknown; action: string; conversationId?: string }>;
  }>;
  MAX_RUNNING_AGE_MS: number;
};

// Load once; all functions read SURF_SESSIONS_DIR lazily so env changes are picked up per call
const reconciler = require("../../native/session-reconciler.cjs") as Reconciler;
function loadReconciler(): Reconciler {
  return reconciler;
}

function makeTmpSessionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "surf-test-sessions-"));
}

function writeSessionMeta(dir: string, meta: Record<string, unknown>) {
  const sessionDir = path.join(dir, meta.id as string);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2));
}

function readSessionMeta(dir: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, id, "meta.json"), "utf8"));
}

// ── defaultPidIsAlive ────────────────────────────────────────────────────────

describe("defaultPidIsAlive", () => {
  it("returns false for null", () => {
    const { defaultPidIsAlive } = loadReconciler();
    expect(defaultPidIsAlive(null)).toBe(false);
  });

  it("returns false for 0", () => {
    const { defaultPidIsAlive } = loadReconciler();
    expect(defaultPidIsAlive(0)).toBe(false);
  });

  it("returns false for negative", () => {
    const { defaultPidIsAlive } = loadReconciler();
    expect(defaultPidIsAlive(-1)).toBe(false);
  });

  it("returns false for string", () => {
    const { defaultPidIsAlive } = loadReconciler();
    expect(defaultPidIsAlive("1234")).toBe(false);
  });

  it("returns false for dead PID (999999999)", () => {
    const { defaultPidIsAlive } = loadReconciler();
    expect(defaultPidIsAlive(999999999)).toBe(false);
  });

  it("returns true for current process PID", () => {
    const { defaultPidIsAlive } = loadReconciler();
    expect(defaultPidIsAlive(process.pid)).toBe(true);
  });
});

// ── inspectConversation ───────────────────────────────────────────────────────

describe("inspectConversation", () => {
  const { inspectConversation } = loadReconciler();

  it("returns ambiguous for null", () => {
    expect(inspectConversation(null)).toEqual({ outcome: "ambiguous", nodeId: null });
  });

  it("returns ambiguous when mapping missing", () => {
    expect(inspectConversation({ current_node: "n1" })).toEqual({
      outcome: "ambiguous",
      nodeId: null,
    });
  });

  it("returns ambiguous when current_node missing", () => {
    expect(inspectConversation({ mapping: { n1: {} } })).toEqual({
      outcome: "ambiguous",
      nodeId: null,
    });
  });

  // Regression: baseline comes from DOM data-message-id, not data-testid
  // Realistic test where DOM baseline (msg-abc) differs from API current_node (msg-xyz)
  it("returns completed when current_node differs from baseline (real-world scenario)", () => {
    const conv = {
      current_node: "msg-new-response",
      mapping: {
        "msg-old-assistant": {
          message: {
            status: "finished_successfully",
            author: { role: "assistant" },
            create_time: 1000,
          },
        },
        "msg-new-response": {
          message: {
            status: "finished_successfully",
            author: { role: "assistant" },
            create_time: 2000,
          },
        },
      },
    };
    // Baseline is the OLD assistant message from DOM
    const result = inspectConversation(conv, { baselineAssistantMessageId: "msg-old-assistant" });
    expect(result.outcome).toBe("completed"); // new response is completed
    expect(result.nodeId).toBe("msg-new-response");
  });

  it("returns completed when last node is finished_successfully assistant", () => {
    const conv = {
      current_node: "n1",
      mapping: {
        n1: {
          message: {
            status: "finished_successfully",
            author: { role: "assistant" },
          },
        },
      },
    };
    const result = inspectConversation(conv);
    expect(result.outcome).toBe("completed");
    expect(result.nodeId).toBe("n1");
  });

  it("returns no_new_assistant when node is same as baseline", () => {
    const conv = {
      current_node: "n1",
      mapping: {
        n1: {
          message: {
            status: "finished_successfully",
            author: { role: "assistant" },
          },
        },
      },
    };
    const result = inspectConversation(conv, { baselineAssistantMessageId: "n1" });
    expect(result.outcome).toBe("no_new_assistant");
  });

  it("returns no_new_assistant when last node is user role", () => {
    const conv = {
      current_node: "n1",
      mapping: {
        n1: {
          message: { status: "finished_successfully", author: { role: "user" } },
        },
      },
    };
    expect(inspectConversation(conv).outcome).toBe("no_new_assistant");
  });

  it("returns in_progress when status is in_progress", () => {
    const conv = {
      current_node: "n1",
      mapping: {
        n1: {
          message: { status: "in_progress", author: { role: "assistant" } },
        },
      },
    };
    expect(inspectConversation(conv).outcome).toBe("in_progress");
  });

  it("returns ambiguous for unknown status", () => {
    const conv = {
      current_node: "n1",
      mapping: {
        n1: { message: { status: "unknown_status", author: { role: "assistant" } } },
      },
    };
    expect(inspectConversation(conv).outcome).toBe("ambiguous");
  });
});

// ── reconcileSessions ─────────────────────────────────────────────────────────

describe("reconcileSessions", () => {
  let tmpDir: string;
  const origEnv = process.env.SURF_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = makeTmpSessionDir();
    process.env.SURF_SESSIONS_DIR = tmpDir;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      process.env.SURF_SESSIONS_DIR = undefined as unknown as string;
    } else {
      process.env.SURF_SESSIONS_DIR = origEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns reconciled=0 when no running sessions", async () => {
    const r = loadReconciler();
    writeSessionMeta(tmpDir, {
      id: "chatgpt-done",
      tool: "chatgpt",
      status: "completed",
      createdAt: new Date().toISOString(),
      pid: process.pid,
    });

    const { reconciled } = await r.reconcileSessions({ all: true });
    expect(reconciled).toBe(0);
  });

  it("skips session whose pid is alive and not too old", async () => {
    const r = loadReconciler();
    writeSessionMeta(tmpDir, {
      id: "chatgpt-alive",
      tool: "chatgpt",
      status: "running",
      createdAt: new Date().toISOString(), // recent
      pid: process.pid, // alive
    });

    const { reconciled, sessions } = await r.reconcileSessions({ all: true });
    expect(reconciled).toBe(0);
    expect(sessions[0].action).toBe("none");

    // meta.json unchanged
    const meta = readSessionMeta(tmpDir, "chatgpt-alive");
    expect(meta.status).toBe("running");
  });

  it("marks orphaned when pid is dead", async () => {
    const r = loadReconciler();
    writeSessionMeta(tmpDir, {
      id: "chatgpt-dead",
      tool: "chatgpt",
      status: "running",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      pid: 999999999, // dead
    });

    const { reconciled, sessions } = await r.reconcileSessions({ all: true });
    expect(reconciled).toBe(1);
    expect(sessions[0].action).toBe("orphaned");

    const meta = readSessionMeta(tmpDir, "chatgpt-dead") as any;
    expect(meta.status).toBe("error");
    expect(meta.error.code).toBe("session_orphaned");
    expect(meta.reconcile.pidAlive).toBe(false);
    expect(meta.reconcile.state).toBe("orphaned");
  });

  it("annotates as stale when session is old but pid still alive (never orphans)", async () => {
    const r = loadReconciler();
    const oldDate = new Date(Date.now() - r.MAX_RUNNING_AGE_MS - 60_000).toISOString();
    writeSessionMeta(tmpDir, {
      id: "chatgpt-old",
      tool: "chatgpt",
      status: "running",
      createdAt: oldDate,
      pid: process.pid, // alive but too old
    });

    const { reconciled, sessions } = await r.reconcileSessions({ all: true });
    expect(reconciled).toBe(1); // stale is counted as reconciled
    expect(sessions[0].action).toBe("stale");

    const meta = readSessionMeta(tmpDir, "chatgpt-old") as any;
    expect(meta.status).toBe("running"); // NOT changed to error
    expect(meta.reconcile.state).toBe("stale");
    expect(meta.reconcile.pidAlive).toBe(true);
  });

  it("recovers session via network poll when conversation completed", async () => {
    const r = loadReconciler();
    writeSessionMeta(tmpDir, {
      id: "chatgpt-recoverable",
      tool: "chatgpt",
      status: "running",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      pid: 999999999,
      conversationId: "conv-abc123",
      baselineAssistantMessageId: null,
    });

    const completedConv = {
      current_node: "new-node",
      mapping: {
        "new-node": {
          message: {
            status: "finished_successfully",
            author: { role: "assistant" },
          },
        },
      },
    };

    const mockManageChats = vi.fn().mockResolvedValue({ conversation: completedConv });

    const { reconciled, sessions } = await r.reconcileSessions({
      all: true,
      pollNetwork: true,
      manageChats: mockManageChats,
    });

    expect(reconciled).toBe(1);
    expect(sessions[0].action).toBe("recovered");
    expect(sessions[0].conversationId).toBe("conv-abc123");

    const meta = readSessionMeta(tmpDir, "chatgpt-recoverable") as any;
    expect(meta.status).toBe("completed");
    expect(meta.reconcile.state).toBe("recovered");
    expect(meta.result.reconciled).toBe(true);
    expect(mockManageChats).toHaveBeenCalledWith(
      expect.objectContaining({ action: "get", conversationId: "conv-abc123" }),
    );
  });

  it("marks unresolved when conversation still in_progress", async () => {
    const r = loadReconciler();
    writeSessionMeta(tmpDir, {
      id: "chatgpt-inprogress",
      tool: "chatgpt",
      status: "running",
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      pid: 999999999,
      conversationId: "conv-inprog",
    });

    const inProgressConv = {
      current_node: "n1",
      mapping: {
        n1: { message: { status: "in_progress", author: { role: "assistant" } } },
      },
    };

    const mockManageChats = vi.fn().mockResolvedValue({ conversation: inProgressConv });

    const { sessions } = await r.reconcileSessions({
      all: true,
      pollNetwork: true,
      manageChats: mockManageChats,
    });

    expect(sessions[0].action).toBe("unresolved");
    const meta = readSessionMeta(tmpDir, "chatgpt-inprogress") as any;
    expect(meta.status).toBe("running"); // not changed
    expect(meta.reconcile.state).toBe("unresolved");
  });

  it("handles poll failure gracefully — marks orphaned", async () => {
    const r = loadReconciler();
    writeSessionMeta(tmpDir, {
      id: "chatgpt-pollfail",
      tool: "chatgpt",
      status: "running",
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      pid: 999999999,
      conversationId: "conv-pollfail",
    });

    const mockManageChats = vi.fn().mockRejectedValue(new Error("login_required"));

    const { sessions } = await r.reconcileSessions({
      all: true,
      pollNetwork: true,
      manageChats: mockManageChats,
    });

    expect(sessions[0].action).toBe("orphaned");
    const meta = readSessionMeta(tmpDir, "chatgpt-pollfail") as any;
    expect(meta.status).toBe("error");
    expect(meta.reconcile.remote.outcome).toBe("poll_failed");
    expect(meta.reconcile.remote.error).toBe("login_required");
  });

  it("skips network poll when no conversationId", async () => {
    const r = loadReconciler();
    writeSessionMeta(tmpDir, {
      id: "chatgpt-noconv",
      tool: "chatgpt",
      status: "running",
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      pid: 999999999,
      conversationId: null,
    });

    const mockManageChats = vi.fn();

    const { sessions } = await r.reconcileSessions({
      all: true,
      pollNetwork: true,
      manageChats: mockManageChats,
    });

    expect(sessions[0].action).toBe("orphaned");
    expect(mockManageChats).not.toHaveBeenCalled();
  });
});
