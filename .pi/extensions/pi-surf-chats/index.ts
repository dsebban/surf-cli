/**
 * pi-surf-chats — Pi extension for browsing ChatGPT conversations via surf-cli
 *
 * Provides:
 * - /surf-chats command to open conversation browser overlay
 * - Ctrl+Shift+G shortcut
 * - Two-pane TUI: list/search ↔ detail viewer
 * - Inject conversation into pi context
 * - Export to markdown
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SurfChatsClient } from "./surf-client.js";
import { SurfChatsOverlay, type OverlayAction } from "./overlay.js";
import type { ControllerState, SurfChatsError } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Export path helpers
// ─────────────────────────────────────────────────────────────────────────────

function slugify(text: string, maxLen = 48): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen) || "chatgpt-chat";
}

function buildExportPath(title: string, conversationId: string): string {
  const dir = path.join(os.homedir(), "Downloads", "surf-chatgpt");
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  const slug = slugify(title);
  const shortId = conversationId.slice(0, 8);
  let candidate = path.join(dir, `${ts}-${slug}-${shortId}.md`);

  // Collision avoidance
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${ts}-${slug}-${shortId}-${i}.md`);
    i++;
  }

  return candidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

function createInitialState(): ControllerState {
  return {
    mode: "recent",
    searchDraft: "",
    activeQuery: "",
    items: [],
    selectedIndex: 0,
    detailCache: new Map(),
    phase: "idle",
    statusMessage: "",
    loadedConversationId: null,
    lastError: null,
    lastExportPath: null,
    searchEditActive: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension
// ─────────────────────────────────────────────────────────────────────────────

export default function piSurfChatsExtension(pi: ExtensionAPI): void {

  async function openOverlay(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }

    const client = new SurfChatsClient(pi, ctx.cwd);
    const state = createInitialState();

    // Kick off initial load
    state.phase = "loading_list";
    state.statusMessage = "Loading recent conversations…";

    let overlay: SurfChatsOverlay | null = null;
    let requestId = 0;

    // Action handler — bridges overlay events to async operations
    async function handleAction(action: OverlayAction, done: (result?: string) => void): Promise<void> {
      const myRequestId = ++requestId;

      switch (action.action) {
        case "load_list":
          state.phase = "loading_list";
          state.statusMessage = "Loading recent conversations…";
          state.searchEditActive = false;
          state.mode = "recent";
          state.activeQuery = "";
          state.lastError = null;
          overlay?.updateState(state);

          try {
            const result = await client.listRecent({ limit: 30 });
            if (requestId !== myRequestId) return; // stale
            state.items = result.items;
            state.selectedIndex = 0;
            state.phase = "idle";
            state.statusMessage = "";
          } catch (err) {
            if (requestId !== myRequestId) return;
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Failed to load conversations";
          }
          overlay?.updateState(state);
          break;

        case "search":
          state.phase = "searching";
          state.statusMessage = `Searching "${action.query}"…`;
          state.mode = "search";
          state.activeQuery = action.query;
          state.searchEditActive = false;
          state.lastError = null;
          overlay?.updateState(state);

          try {
            const result = await client.search({ query: action.query, limit: 30 });
            if (requestId !== myRequestId) return;
            state.items = result.items;
            state.selectedIndex = 0;
            state.phase = "idle";
            state.statusMessage = result.partial ? `Partial results (${result.fallbackScanned}/${result.fallbackTotal} scanned)` : "";
          } catch (err) {
            if (requestId !== myRequestId) return;
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Search failed";
          }
          overlay?.updateState(state);
          break;

        case "load_detail": {
          state.phase = "loading_detail";
          state.statusMessage = "Loading conversation…";
          state.lastError = null;
          state.loadedConversationId = action.conversationId;
          overlay?.updateState(state);

          try {
            const detail = await client.getConversation(action.conversationId);
            if (requestId !== myRequestId) return;
            state.detailCache.set(action.conversationId, detail);
            state.phase = "idle";
            state.statusMessage = "";
          } catch (err) {
            if (requestId !== myRequestId) return;
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Failed to load conversation";
            state.loadedConversationId = null;
          }
          overlay?.updateState(state);
          break;
        }

        case "inject": {
          const content = [
            `Imported ChatGPT conversation via surf-cli.`,
            "",
            `**Conversation ID:** ${action.conversationId}`,
            `**Title:** ${action.title}`,
            "",
            action.markdown,
          ].join("\n");

          pi.sendMessage({
            customType: "surf-chatgpt-import",
            content,
            display: true,
          }, { triggerTurn: false });

          if (ctx.hasUI) {
            ctx.ui.notify(`Injected: ${action.title}`, "info");
          }
          done("injected");
          break;
        }

        case "export": {
          state.phase = "exporting";
          state.statusMessage = "Exporting…";
          state.lastError = null;
          state.lastExportPath = null;
          overlay?.updateState(state);

          try {
            // If we have cached detail, use the formatter markdown
            const cached = state.detailCache.get(action.conversationId);
            const exportPath = buildExportPath(action.title, action.conversationId);

            if (cached) {
              // Write markdown directly from cache (faster, no CloakBrowser needed)
              fs.writeFileSync(exportPath, cached.markdown, "utf8");
              state.lastExportPath = exportPath;
            } else {
              // Use surf CLI to export
              const result = await client.exportConversation(action.conversationId, exportPath);
              if (requestId !== myRequestId) return;
              state.lastExportPath = result;
            }

            state.phase = "idle";
            state.statusMessage = "";
          } catch (err) {
            if (requestId !== myRequestId) return;
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Export failed";
          }
          overlay?.updateState(state);
          break;
        }
      }
    }

    // Open the overlay
    await ctx.ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        const handleError = (err: unknown) => {
          state.phase = "error";
          state.lastError = {
            code: "command_failed",
            message: String((err as Error)?.message ?? err),
          };
          state.statusMessage = state.lastError.message;
          overlay?.updateState(state);
        };

        overlay = new SurfChatsOverlay({
          tui,
          theme,
          state,
          done,
          callbacks: {
            onAction: (action) => {
              handleAction(action, done).catch(handleError);
            },
          },
        });

        // Trigger initial load after overlay is constructed
        handleAction({ action: "load_list" }, done).catch(handleError);

        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          maxHeight: "70%",
          anchor: "center",
          margin: 1,
        },
      },
    );
  }

  // ─── Registration ───────────────────────────────────────────────────────

  pi.registerCommand("surf-chats", {
    description: "Browse and search ChatGPT conversations via surf-cli",
    handler: async (_args, ctx) => {
      await openOverlay(ctx);
    },
  });

  pi.registerShortcut(Key.ctrlShift("g"), {
    description: "Open ChatGPT conversation browser (surf-chats)",
    handler: async (ctx) => {
      await openOverlay(ctx);
    },
  });
}
