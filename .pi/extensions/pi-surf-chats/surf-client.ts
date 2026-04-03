/**
 * surf-client.ts — Shell out to `surf chatgpt.chats` and parse results
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ConversationItem, ConversationSummary, DetailRecord, ListResult, SurfChatsError } from "./types.js";

// Formatter reuse: resolve relative to surf-cli repo root
import path from "node:path";
import { createRequire } from "node:module";

let formatter: {
  normalizeConversationItems: (raw: unknown) => ConversationItem[];
  summarizeConversation: (conv: unknown, opts?: { messageLimit?: number }) => ConversationSummary;
  formatConversationMarkdown: (opts: { conversation: unknown; messageLimit?: number }) => string;
} | null = null;

function loadFormatter(cwd: string): typeof formatter {
  if (formatter) return formatter;
  try {
    // Try loading from the surf-cli native directory
    const require = createRequire(import.meta.url);
    const formatterPath = path.resolve(cwd, "native/chatgpt-chats-formatter.cjs");
    formatter = require(formatterPath);
    return formatter;
  } catch {
    // Fallback: try global surf install
    try {
      const require = createRequire(import.meta.url);
      formatter = require("surf-cli/native/chatgpt-chats-formatter.cjs");
      return formatter;
    } catch {
      return null;
    }
  }
}

/** Fallback normalization when formatter unavailable */
function fallbackNormalize(raw: unknown): ConversationItem[] {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.items)
      ? (raw as Record<string, unknown>).items as unknown[]
      : [];

  return (source as Record<string, unknown>[])
    .filter(Boolean)
    .map((item) => ({
      id: String(item.id ?? item.conversation_id ?? ""),
      title: String(item.title || "(untitled)"),
      create_time: (item.create_time ?? item.createTime ?? null) as string | number | null,
      update_time: (item.update_time ?? item.updateTime ?? item.create_time ?? null) as string | number | null,
    }))
    .filter((item) => item.id);
}

const DEFAULT_TIMEOUT = 120_000; // 120s

function classifyError(code: number, stdout: string, stderr: string): SurfChatsError {
  const combined = `${stderr}\n${stdout}`.toLowerCase();

  if (combined.includes("command not found") || combined.includes("not found: surf") || combined.includes("enoent")) {
    return { code: "surf_missing", message: "surf CLI not found. Install: npm i -g surf-cli" };
  }
  if (combined.includes("unknown tool") || combined.includes("cloak")) {
    return { code: "setup", message: "Cloak mode required. Set SURF_USE_CLOAK_CHATGPT=1" };
  }
  if (combined.includes("login_required") || combined.includes("log in") || combined.includes("401")) {
    return { code: "auth", message: "ChatGPT login required. Run: surf chatgpt.chats --continue" };
  }
  if (combined.includes("timeout") || combined.includes("timed out")) {
    return { code: "timeout", message: "Request timed out" };
  }
  if (combined.includes("processsingleton") || combined.includes("profile directory")) {
    return { code: "setup", message: "CloakBrowser profile locked. Close other surf instances first." };
  }

  return { code: "command_failed", message: `surf exited with code ${code}`, stderr: stderr.slice(0, 500) };
}

export class SurfChatsClient {
  private execFn: ExtensionAPI["exec"];
  private cwd: string;

  constructor(pi: ExtensionAPI, cwd: string) {
    this.execFn = pi.exec.bind(pi);
    this.cwd = cwd;
    loadFormatter(cwd);
  }

  private async runSurf(args: string[]): Promise<{ stdout: string; stderr: string }> {
    // Use bash -c to pass env var since pi.exec doesn't support env option
    const cmd = `SURF_USE_CLOAK_CHATGPT=1 surf ${args.map(a => `'${a.replace(/'/g, "'\\''")}' `).join("").trim()}`;
    const result = await this.execFn("bash", ["-c", cmd], { timeout: DEFAULT_TIMEOUT });
    if (result.code !== 0) throw classifyError(result.code, result.stdout ?? "", result.stderr ?? "");
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  async listRecent(opts?: { limit?: number }): Promise<ListResult> {
    const limit = opts?.limit ?? 30;
    const { stdout } = await this.runSurf(["chatgpt.chats", "--json", "--limit", String(limit)]);

    return this.parseListResult(stdout);
  }

  async search(opts: { query: string; limit?: number }): Promise<ListResult> {
    const limit = opts.limit ?? 30;
    const { stdout } = await this.runSurf(["chatgpt.chats", "--json", "--search", opts.query, "--limit", String(limit)]);
    return this.parseListResult(stdout, "search");
  }

  async getConversation(conversationId: string): Promise<DetailRecord> {
    const { stdout } = await this.runSurf(["chatgpt.chats", conversationId, "--json"]);
    return this.parseGetResult(conversationId, stdout);
  }

  async exportConversation(conversationId: string, exportPath: string): Promise<string> {
    await this.runSurf(["chatgpt.chats", conversationId, "--export", exportPath, "--format", "markdown"]);
    return exportPath;
  }

  private parseListResult(stdout: string, action: "list" | "search" = "list"): ListResult {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw { code: "parse", message: "Failed to parse surf output as JSON" } as SurfChatsError;
    }

    const items = formatter
      ? formatter.normalizeConversationItems(parsed.items ?? parsed)
      : fallbackNormalize(parsed.items ?? parsed);

    return {
      action,
      items,
      total: typeof parsed.total === "number" ? parsed.total : items.length,
      partial: parsed.partial === true,
      fallbackScanned: typeof parsed.fallbackScanned === "number" ? parsed.fallbackScanned : undefined,
      fallbackTotal: typeof parsed.fallbackTotal === "number" ? parsed.fallbackTotal : undefined,
    };
  }

  private parseGetResult(conversationId: string, stdout: string): DetailRecord {
    let conversation: Record<string, unknown>;
    try {
      conversation = JSON.parse(stdout.trim());
    } catch {
      throw { code: "parse", message: "Failed to parse conversation JSON" } as SurfChatsError;
    }

    let summary: ConversationSummary;
    let markdown: string;

    if (formatter) {
      summary = formatter.summarizeConversation(conversation);
      markdown = formatter.formatConversationMarkdown({ conversation });
    } else {
      // Minimal fallback
      summary = {
        title: String(conversation.title || "(untitled)"),
        create_time: (conversation.create_time as number) ?? null,
        current_node: (conversation.current_node as string) ?? null,
        messages: [],
        totalMessages: 0,
        model: null,
      };
      markdown = `# ${summary.title}\n\n_Raw conversation data (formatter unavailable)_\n`;
    }

    return {
      conversationId,
      summary,
      markdown,
      loadedAt: Date.now(),
    };
  }
}
