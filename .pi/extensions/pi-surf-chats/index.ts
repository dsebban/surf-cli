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
import type { ControllerState, DetailRecord, ListCacheEntry, SurfChatsError } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level persistent cache (survives overlay close/reopen within pi session)
// ─────────────────────────────────────────────────────────────────────────────

const persistentDetailCache = new Map<string, DetailRecord>();
let persistentListCache: ListCacheEntry | null = null;

const LIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min before a stale list triggers visible refresh

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

const INITIAL_LIMIT = 30;
const PAGE_SIZE = 30;

function createInitialState(): ControllerState {
  // Hydrate from persistent caches for instant display
  const cachedItems = persistentListCache?.mode === "recent" ? persistentListCache.items : [];
  const hasCache = cachedItems.length > 0;

  return {
    mode: "recent",
    searchDraft: "",
    activeQuery: "",
    items: cachedItems,
    selectedIndex: 0,
    detailCache: persistentDetailCache, // shared reference — survives across sessions
    phase: hasCache ? "idle" : "loading_list",
    statusMessage: hasCache ? "" : "Loading recent conversations…",
    loadedConversationId: null,
    lastError: null,
    lastExportPath: null,
    searchEditActive: false,
    resolvedCliPath: null,
    resolvedFormatterPath: null,
    resolvedProfile: null,
    markedIds: new Set(),
    pendingDeleteId: null,
    pendingDeleteTitle: null,
    currentLimit: INITIAL_LIMIT,
    hasMore: cachedItems.length >= INITIAL_LIMIT,
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
    const resolved = client.getResolvedPaths();
    state.resolvedCliPath = resolved.cliPath;
    state.resolvedFormatterPath = resolved.formatterPath;
    state.resolvedProfile = resolved.profile;

    // Initial load (background if we already have cached items, visible otherwise)

    let overlay: SurfChatsOverlay | null = null;
    let requestId = 0;
    let closed = false;
    let activeAbort: AbortController | null = null;

    // Action handler — bridges overlay events to async operations
    async function handleAction(action: OverlayAction, done: (result?: string) => void): Promise<void> {
      if (closed) return;
      activeAbort?.abort();
      const abort = new AbortController();
      activeAbort = abort;
      const myRequestId = ++requestId;
      const isStale = () => closed || requestId !== myRequestId || abort.signal.aborted;

      switch (action.action) {
        case "load_list": {
          const hasCachedItems = state.items.length > 0;
          const cacheAge = persistentListCache ? Date.now() - persistentListCache.loadedAt : Infinity;
          const silentRefresh = hasCachedItems && cacheAge < LIST_CACHE_TTL_MS;

          if (!silentRefresh) {
            state.phase = "loading_list";
            state.statusMessage = "Loading recent conversations…";
          } else {
            state.statusMessage = "Refreshing…";
          }
          state.searchEditActive = false;
          state.mode = "recent";
          state.activeQuery = "";
          state.lastError = null;
          state.currentLimit = INITIAL_LIMIT;
          overlay?.updateState(state);

          try {
            const result = await client.listRecent({ limit: INITIAL_LIMIT, signal: abort.signal });
            if (isStale()) return;
            state.items = result.items;
            state.selectedIndex = 0;
            state.phase = "idle";
            state.statusMessage = "";
            state.hasMore = result.items.length >= INITIAL_LIMIT;
            persistentListCache = { mode: "recent", query: "", items: result.items, loadedAt: Date.now() };
          } catch (err) {
            if (isStale()) return;
            // Keep existing items visible on background-refresh failure
            if (hasCachedItems) {
              state.phase = "idle";
              state.statusMessage = "";
            } else {
              state.phase = "error";
              state.lastError = err as SurfChatsError;
              state.statusMessage = (err as SurfChatsError).message ?? "Failed to load conversations";
            }
          }
          if (!closed) overlay?.updateState(state);
          break;
        }

        case "search": {
          state.phase = "searching";
          state.statusMessage = `Searching "${action.query}"…`;
          state.mode = "search";
          state.activeQuery = action.query;
          state.searchEditActive = false;
          state.lastError = null;
          state.currentLimit = INITIAL_LIMIT;
          overlay?.updateState(state);

          try {
            const result = await client.search({ query: action.query, limit: INITIAL_LIMIT, signal: abort.signal });
            if (isStale()) return;
            state.items = result.items;
            state.selectedIndex = 0;
            state.phase = "idle";
            state.statusMessage = result.partial ? `Partial results (${result.fallbackScanned}/${result.fallbackTotal} scanned)` : "";
            state.hasMore = result.items.length >= INITIAL_LIMIT;
          } catch (err) {
            if (isStale()) return;
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Search failed";
          }
          if (!closed) overlay?.updateState(state);
          break;
        }

        case "load_more": {
          if (state.mode === "search") break; // no pagination for search results
          const prevItems = state.items;
          const newLimit = state.currentLimit + PAGE_SIZE;
          state.phase = "loading_list";
          state.statusMessage = `Loading more… (${newLimit} total)`;
          overlay?.updateState(state);

          try {
            const result = await client.listRecent({ limit: newLimit, signal: abort.signal });
            if (isStale()) return;
            const prevLen = prevItems.length;
            state.items = result.items;
            state.currentLimit = newLimit;
            state.hasMore = result.items.length >= newLimit;
            // Advance cursor to first new item
            if (result.items.length > prevLen) {
              state.selectedIndex = prevLen;
            }
            state.phase = "idle";
            state.statusMessage = "";
            persistentListCache = { mode: "recent", query: "", items: result.items, loadedAt: Date.now() };
          } catch (err) {
            if (isStale()) return;
            state.items = prevItems; // restore on failure
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Failed to load more";
          }
          if (!closed) overlay?.updateState(state);
          break;
        }

        case "load_detail": {
          state.phase = "loading_detail";
          state.statusMessage = "Loading conversation…";
          state.lastError = null;
          state.loadedConversationId = action.conversationId;
          overlay?.updateState(state);

          try {
            const detail = await client.getConversation(action.conversationId, abort.signal);
            if (isStale()) return;
            state.detailCache.set(action.conversationId, detail);
            // persistentDetailCache is the same Map reference — already updated
            state.phase = "idle";
            state.statusMessage = "";
          } catch (err) {
            if (isStale()) return;
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Failed to load conversation";
            state.loadedConversationId = null;
          }
          if (!closed) overlay?.updateState(state);
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
          closed = true;
          requestId += 1;
          activeAbort?.abort();
          activeAbort = null;
          overlay = null;
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
              const result = await client.exportConversation(action.conversationId, exportPath, abort.signal);
              if (isStale()) return;
              state.lastExportPath = result;
            }

            state.phase = "idle";
            state.statusMessage = "";
          } catch (err) {
            if (isStale()) return;
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Export failed";
          }
          if (!closed) overlay?.updateState(state);
          break;
        }

        case "toggle_mark": {
          if (state.markedIds.has(action.conversationId)) {
            state.markedIds.delete(action.conversationId);
          } else {
            state.markedIds.add(action.conversationId);
          }
          overlay?.updateState(state);
          break;
        }

        case "delete": {
          // Enter confirmation mode — don't delete yet
          state.phase = "confirm_delete";
          state.pendingDeleteId = action.conversationIds.join(",");
          state.pendingDeleteTitle = action.titles[0] ?? "(untitled)";
          state.lastError = null;
          state.statusMessage = "";
          overlay?.updateState(state);
          break;
        }

        case "cancel_delete": {
          state.phase = "idle";
          state.pendingDeleteId = null;
          state.pendingDeleteTitle = null;
          state.statusMessage = "";
          overlay?.updateState(state);
          break;
        }

        case "confirm_delete": {
          const ids = action.conversationIds;
          const count = ids.length;
          state.phase = "deleting";
          state.statusMessage = count > 1 ? `Deleting ${count} conversations…` : `Deleting "${action.titles[0]}"…`;
          state.pendingDeleteId = null;
          state.pendingDeleteTitle = null;
          state.lastError = null;
          overlay?.updateState(state);

          try {
            await client.bulkDeleteConversations(ids, abort.signal);
            if (isStale()) return;

            // Remove from list + caches
            const deleteSet = new Set(ids);
            state.items = state.items.filter((item) => !deleteSet.has(item.id));
            for (const id of ids) {
              state.detailCache.delete(id);
              state.markedIds.delete(id);
            }
            if (persistentListCache) {
              persistentListCache.items = persistentListCache.items.filter((item) => !deleteSet.has(item.id));
            }
            // Clamp selection
            if (state.selectedIndex >= state.items.length) {
              state.selectedIndex = Math.max(0, state.items.length - 1);
            }
            state.phase = "idle";
            state.statusMessage = "";

            if (ctx.hasUI) {
              const label = count > 1 ? `${count} conversations` : action.titles[0] ?? "conversation";
              ctx.ui.notify(`Deleted: ${label}`, "info");
            }
          } catch (err) {
            if (isStale()) return;
            state.phase = "error";
            state.lastError = err as SurfChatsError;
            state.statusMessage = (err as SurfChatsError).message ?? "Delete failed";
          }
          if (!closed) overlay?.updateState(state);
          break;
        }
      }
    }

    // Open the overlay
    await ctx.ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        const closeOverlay = () => {
          closed = true;
          requestId += 1;
          activeAbort?.abort();
          activeAbort = null;
          overlay = null;
        };

        const handleError = (err: unknown) => {
          if (closed) return;
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
            onClose: closeOverlay,
          },
        });

        // Trigger initial list load (silent if cached, visible if first open)
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
