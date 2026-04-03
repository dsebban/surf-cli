/**
 * overlay.ts — Two-pane TUI overlay for browsing ChatGPT conversations
 *
 * Left pane: conversation list with search
 * Right pane: conversation detail / status
 * Follows pi-tui Component + Focusable pattern (à la pi-side-chat, pi-messenger)
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI, type Component, type Focusable } from "@mariozechner/pi-tui";
import type { ControllerState, ConversationItem, DetailRecord, SurfChatsError } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toEpochMs(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : 0;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatRelativeTime(value: unknown): string {
  const ms = toEpochMs(value);
  if (!ms) return "-";
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? text.slice(0, max) : text.slice(0, max - 1) + "…";
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay actions (returned to extension entry)
// ─────────────────────────────────────────────────────────────────────────────

export type OverlayAction =
  | { action: "inject"; conversationId: string; markdown: string; title: string }
  | { action: "export"; conversationId: string; title: string }
  | { action: "load_list" }
  | { action: "search"; query: string }
  | { action: "load_detail"; conversationId: string };

export interface OverlayCallbacks {
  onAction: (action: OverlayAction) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay Component
// ─────────────────────────────────────────────────────────────────────────────

export class SurfChatsOverlay implements Component, Focusable {
  private theme: Theme;
  private tui: TUI;
  private callbacks: OverlayCallbacks;
  private done: (result?: string) => void;
  private state: ControllerState;

  // Scroll state for detail pane
  private detailScrollOffset = 0;
  private detailTotalLines = 0;

  focused = true;

  constructor(opts: {
    tui: TUI;
    theme: Theme;
    state: ControllerState;
    done: (result?: string) => void;
    callbacks: OverlayCallbacks;
  }) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.state = opts.state;
    this.done = opts.done;
    this.callbacks = opts.callbacks;
  }

  /** Called by controller to update state and re-render */
  updateState(state: ControllerState): void {
    this.state = state;
    // Reset detail scroll when switching conversations
    if (state.loadedConversationId !== this.lastDetailId) {
      this.detailScrollOffset = 0;
      this.lastDetailId = state.loadedConversationId;
    }
    this.tui.requestRender();
  }
  private lastDetailId: string | null = null;

  // ─── Input handling ───────────────────────────────────────────────────────

  handleInput(data: string): void {
    const s = this.state;

    // Escape: exit search mode or close overlay
    if (matchesKey(data, "escape")) {
      if (s.searchEditActive) {
        this.callbacks.onAction({ action: "load_list" }); // exit search, reload recent
        return;
      }
      this.done(); // close overlay directly
      return;
    }

    // Search edit mode: handle text input
    if (s.searchEditActive) {
      if (matchesKey(data, "return")) {
        // Submit search (or reload recent if empty)
        const q = s.searchDraft.trim();
        if (q) {
          this.callbacks.onAction({ action: "search", query: q });
        } else {
          this.callbacks.onAction({ action: "load_list" });
        }
        return;
      }
      if (matchesKey(data, "backspace")) {
        s.searchDraft = s.searchDraft.slice(0, -1);
        this.tui.requestRender();
        return;
      }
      // Printable character
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        s.searchDraft += data;
        this.tui.requestRender();
        return;
      }
      return;
    }

    // Normal mode keybindings

    // / → enter search mode
    if (data === "/") {
      s.searchEditActive = true;
      s.searchDraft = s.activeQuery;
      this.tui.requestRender();
      return;
    }

    // j/k or ↑↓ → navigate list
    if (data === "j" || matchesKey(data, "down")) {
      s.selectedIndex = Math.min(s.selectedIndex + 1, s.items.length - 1);
      this.detailScrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (data === "k" || matchesKey(data, "up")) {
      s.selectedIndex = Math.max(s.selectedIndex - 1, 0);
      this.detailScrollOffset = 0;
      this.tui.requestRender();
      return;
    }

    // PgUp/PgDn → scroll detail pane
    if (matchesKey(data, "pageDown") || data === "J") {
      const maxScroll = Math.max(0, this.detailTotalLines - this.detailViewHeight());
      this.detailScrollOffset = Math.min(this.detailScrollOffset + 5, maxScroll);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp") || data === "K") {
      this.detailScrollOffset = Math.max(this.detailScrollOffset - 5, 0);
      this.tui.requestRender();
      return;
    }

    // Enter → load detail or inject if already cached
    if (matchesKey(data, "return")) {
      const selected = s.items[s.selectedIndex];
      if (!selected) return;

      const cached = s.detailCache.get(selected.id);
      if (cached) {
        // Already loaded → inject into pi context
        this.callbacks.onAction({
          action: "inject",
          conversationId: selected.id,
          markdown: cached.markdown,
          title: cached.summary.title,
        });
      } else {
        // Load detail first
        this.callbacks.onAction({ action: "load_detail", conversationId: selected.id });
      }
      return;
    }

    // e → export
    if (data === "e") {
      const selected = s.items[s.selectedIndex];
      if (!selected) return;
      this.callbacks.onAction({
        action: "export",
        conversationId: selected.id,
        title: selected.title,
      });
      return;
    }

    // r → refresh list
    if (data === "r") {
      this.callbacks.onAction({ action: "load_list" });
      return;
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(20, width - 2);
    const border = (s: string) => th.fg("borderMuted", s);

    const lines: string[] = [];

    // ── Title bar ──
    const titleText = " 🏄 Surf Chats ";
    const modeText = this.state.mode === "search"
      ? th.fg("warning", ` Search: "${this.state.activeQuery}" `)
      : th.fg("dim", " Recent ");
    const titleLen = visibleWidth(titleText) + visibleWidth(modeText);
    const titlePad = Math.max(0, innerW - titleLen);
    lines.push(
      border("┌") +
      th.fg("accent", titleText) +
      modeText +
      border("─".repeat(titlePad)) +
      border("┐")
    );

    // ── Search bar ──
    if (this.state.searchEditActive) {
      const prompt = th.fg("accent", " Search: ");
      const draft = th.fg("text", this.state.searchDraft + "▌");
      lines.push(this.frameLine(prompt + draft, innerW, border));
    }

    // ── Status line ──
    if (this.state.phase !== "idle") {
      const statusIcon = this.state.phase === "error" ? "✗" : "⟳";
      const statusColor = this.state.phase === "error" ? "error" : "warning";
      const statusLine = th.fg(statusColor, ` ${statusIcon} ${this.state.statusMessage}`);
      lines.push(this.frameLine(statusLine, innerW, border));
    }

    // ── Split area: list (left 45%) + detail (right 55%) ──
    const availableRows = this.availableRows(lines.length);
    const leftW = Math.floor(innerW * 0.42);
    const rightW = innerW - leftW - 1; // -1 for separator
    const sep = th.fg("borderMuted", "│");

    const leftLines = this.renderList(leftW);
    const rightLines = this.renderDetail(rightW);

    // Track for scroll calculations
    this.detailTotalLines = rightLines.length;

    // Slice detail for scrolling
    const detailViewH = availableRows;
    const visibleRight = rightLines.slice(this.detailScrollOffset, this.detailScrollOffset + detailViewH);

    const maxRows = Math.max(leftLines.length, visibleRight.length, availableRows);
    for (let i = 0; i < Math.min(maxRows, availableRows); i++) {
      const left = pad(leftLines[i] ?? "", leftW);
      const right = visibleRight[i] ?? "";
      lines.push(
        border("│") +
        truncateToWidth(left, leftW) +
        sep +
        truncateToWidth(pad(right, rightW), rightW) +
        border("│")
      );
    }

    // ── Footer hints ──
    const hints = this.state.searchEditActive
      ? "Enter submit • Esc cancel"
      : "j/k move • Enter open/inject • / search • e export • r refresh • Esc close";
    lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
    lines.push(this.frameLine(th.fg("dim", ` ${hints}`), innerW, border));

    // ── Export notification ──
    if (this.state.lastExportPath) {
      lines.push(this.frameLine(th.fg("success", ` ✓ Exported: ${this.state.lastExportPath}`), innerW, border));
    }

    lines.push(border("└") + border("─".repeat(innerW)) + border("┘"));

    return lines;
  }

  invalidate(): void {
    // No cached rendering state to clear
  }

  dispose(): void {
    // Cleanup on overlay close
    this.focused = false;
  }

  // ─── Private renderers ────────────────────────────────────────────────────

  private frameLine(content: string, innerW: number, border: (s: string) => string): string {
    return border("│") + truncateToWidth(pad(content, innerW), innerW) + border("│");
  }

  private availableRows(headerLines: number): number {
    const termRows = this.tui.terminal.rows || 24;
    const maxOverlay = Math.floor(termRows * 0.7);
    // Reserve: header lines already rendered + footer (3 lines) + border (1)
    return Math.max(5, maxOverlay - headerLines - 4);
  }

  private detailViewHeight(): number {
    return this.availableRows(3); // rough estimate
  }

  private renderList(width: number): string[] {
    const th = this.theme;
    const s = this.state;
    const lines: string[] = [];

    if (s.items.length === 0 && s.phase === "idle") {
      lines.push(th.fg("muted", " No conversations"));
      return lines;
    }
    if (s.items.length === 0) return lines;

    // Column widths
    const timeW = 5;
    const idW = 0; // skip ID in compact view
    const titleW = Math.max(10, width - timeW - 3);

    for (let i = 0; i < s.items.length; i++) {
      const item = s.items[i]!;
      const isSelected = i === s.selectedIndex;
      const isCached = s.detailCache.has(item.id);
      const prefix = isSelected ? th.fg("accent", "→") : " ";
      const time = formatRelativeTime(item.update_time);
      const title = truncate(item.title, titleW);
      const cachedMark = isCached ? th.fg("success", "•") : " ";

      const line = `${prefix}${cachedMark}` +
        th.fg(isSelected ? "accent" : "text", title.padEnd(titleW)) +
        th.fg("dim", time.padStart(timeW));

      lines.push(truncateToWidth(line, width));
    }

    return lines;
  }

  private renderDetail(width: number): string[] {
    const th = this.theme;
    const s = this.state;
    const lines: string[] = [];

    // Error state
    if (s.lastError) {
      lines.push(th.fg("error", ` Error: ${s.lastError.message}`));
      if (s.lastError.stderr) {
        for (const l of s.lastError.stderr.split("\n").slice(0, 5)) {
          lines.push(th.fg("dim", ` ${l}`));
        }
      }
      return lines;
    }

    // Loading detail
    if (s.phase === "loading_detail") {
      lines.push(th.fg("warning", " ⟳ Loading conversation..."));
      lines.push(th.fg("dim", " (CloakBrowser may take 10-30s)"));
      return lines;
    }

    // No selection
    const selected = s.items[s.selectedIndex];
    if (!selected) {
      lines.push(th.fg("muted", " Select a conversation"));
      return lines;
    }

    // Cached detail available
    const cached = s.detailCache.get(selected.id);
    if (cached) {
      // Header
      lines.push(th.fg("accent", ` ${cached.summary.title}`));
      const meta = [
        cached.summary.model,
        `${cached.summary.totalMessages} msgs`,
      ].filter(Boolean).join(" · ");
      lines.push(th.fg("dim", ` ${meta}`));
      lines.push(th.fg("borderMuted", " " + "─".repeat(width - 2)));

      // Messages
      for (const msg of cached.summary.messages) {
        const who = msg.role === "user" ? th.fg("accent", "You") : th.fg("text", "ChatGPT");
        lines.push("");
        lines.push(` ${who}`);

        // Wrap message text
        const maxTextW = width - 2;
        const textLines = msg.text.split("\n");
        for (const tl of textLines) {
          if (tl.length <= maxTextW) {
            lines.push(th.fg("dim", ` ${tl}`));
          } else {
            // Simple word wrap
            for (let pos = 0; pos < tl.length; pos += maxTextW) {
              lines.push(th.fg("dim", ` ${tl.slice(pos, pos + maxTextW)}`));
            }
          }
        }
      }

      lines.push("");
      lines.push(th.fg("success", " Enter → inject into context"));
      return lines;
    }

    // Not loaded yet
    lines.push(th.fg("text", ` ${selected.title}`));
    lines.push(th.fg("dim", ` ID: ${selected.id}`));
    lines.push(th.fg("dim", ` Updated: ${formatRelativeTime(selected.update_time)}`));
    lines.push("");
    lines.push(th.fg("muted", " Press Enter to load conversation"));

    return lines;
  }
}
