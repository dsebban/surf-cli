/**
 * types.ts — Shared types for pi-surf-chats extension
 *
 * State is modeled with per-lane state objects so concurrent operations
 * (e.g. list refresh + detail load + delete) don't clobber each other.
 */

// ─── Domain types ────────────────────────────────────────────────────────────

/** Normalized conversation list item (matches chatgpt-chats-formatter.cjs normalizeConversationItems) */
export interface ConversationItem {
  id: string;
  title: string;
  create_time: string | number | null;
  update_time: string | number | null;
}

/** List/search result from `surf chatgpt.chats --json` */
export interface ListResult {
  action: "list" | "search";
  items: ConversationItem[];
  total: number;
  partial?: boolean;
  fallbackScanned?: number;
  fallbackTotal?: number;
}

/** Single message extracted from conversation mapping */
export interface ConversationMessage {
  id: string;
  role: string;
  text: string;
  time: number | null;
  model: string | null;
  parent: string | null;
  children: string[];
}

/** Summarized conversation (from summarizeConversation) */
export interface ConversationSummary {
  title: string;
  create_time: number | null;
  current_node: string | null;
  messages: ConversationMessage[];
  totalMessages: number;
  model: string | null;
}

/** Cached detail record */
export interface DetailRecord {
  conversationId: string;
  summary: ConversationSummary;
  markdown: string;
  loadedAt: number;
  /** Conversation update_time from list item (for disk cache staleness) */
  updateTime?: string | number | null;
}

/** Progress event parsed from stderr */
export interface ProgressEvent {
  step: number | null;
  total: number | null;
  message: string;
}

/** User-facing error */
export interface SurfChatsError {
  code: "surf_missing" | "setup" | "auth" | "timeout" | "parse" | "command_failed" | "aborted";
  message: string;
  stderr?: string;
}

// ─── Lane state types ────────────────────────────────────────────────────────

/** Derived single-line status for the overlay status bar */
export interface StatusBarState {
  level: "progress" | "error" | "info";
  message: string;
}

/** Delete confirmation prompt (typed — no string-encoding hacks) */
export interface DeletePromptState {
  conversationIds: string[];
  titles: string[];
}

/** LIST lane: load_list / search / load_more — mutually exclusive, last wins */
export interface ListLaneState {
  activeAction: "load_list" | "search" | "load_more" | null;
  isRunning: boolean;
  /** null = silent refresh (cached items visible) */
  progressMessage: string | null;
  error: SurfChatsError | null;
  /** e.g. partial search notice */
  infoMessage: string | null;
}

/** BACKGROUND: detail loader — per-conversation status */
export interface DetailLaneState {
  activeConversationId: string | null;
  queuedConversationIds: string[];
  errorsByConversationId: Map<string, SurfChatsError>;
}

/** BACKGROUND: export runner */
export interface ExportLaneState {
  activeConversationId: string | null;
  queuedConversationIds: string[];
  error: SurfChatsError | null;
  lastExportPath: string | null;
}

/** Typed delete request */
export interface DeleteRequest {
  conversationIds: string[];
  titles: string[];
}

/** BACKGROUND: delete runner */
export interface DeleteLaneState {
  activeRequest: DeleteRequest | null;
  queuedRequests: DeleteRequest[];
  error: SurfChatsError | null;
}

// ─── Controller state ────────────────────────────────────────────────────────

export interface ControllerState {
  // ── List / navigation ──
  mode: "recent" | "search";
  searchDraft: string;
  activeQuery: string;
  items: ConversationItem[];
  selectedIndex: number;
  searchEditActive: boolean;
  currentLimit: number;
  hasMore: boolean;

  // ── Caches ──
  detailCache: Map<string, DetailRecord>;
  loadedConversationId: string | null;

  // ── UI-only ──
  markedIds: Set<string>;
  deletePrompt: DeletePromptState | null;
  statusBar: StatusBarState | null;

  // ── Lane states ──
  listLane: ListLaneState;
  detailLane: DetailLaneState;
  exportLane: ExportLaneState;
  deleteLane: DeleteLaneState;

  // ── Resolved paths (set once) ──
  resolvedCliPath: string | null;
  resolvedFormatterPath: string | null;
  resolvedProfile: string | null;
}

/** Cached list result (for instant display on re-open) */
export interface ListCacheEntry {
  mode: "recent" | "search";
  query: string;
  items: ConversationItem[];
  loadedAt: number;
}
