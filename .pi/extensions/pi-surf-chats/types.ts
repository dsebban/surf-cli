/**
 * types.ts — Shared types for pi-surf-chats extension
 */

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

/** Controller state */
export interface ControllerState {
  mode: "recent" | "search";
  searchDraft: string;
  activeQuery: string;
  items: ConversationItem[];
  selectedIndex: number;
  detailCache: Map<string, DetailRecord>;
  phase: "idle" | "loading_list" | "loading_detail" | "searching" | "exporting" | "deleting" | "confirm_delete" | "error";
  statusMessage: string;
  loadedConversationId: string | null;
  lastError: SurfChatsError | null;
  lastExportPath: string | null;
  searchEditActive: boolean;
  resolvedCliPath: string | null;
  resolvedFormatterPath: string | null;
  resolvedProfile: string | null;
  /** Conversation pending delete confirmation (id + title) */
  pendingDeleteId: string | null;
  pendingDeleteTitle: string | null;
  /** Current fetch limit; grows as user loads more */
  currentLimit: number;
  /** True when items.length === currentLimit (more may be available) */
  hasMore: boolean;
}

/** Cached list result (for instant display on re-open) */
export interface ListCacheEntry {
  mode: "recent" | "search";
  query: string;
  items: ConversationItem[];
  loadedAt: number;
}
