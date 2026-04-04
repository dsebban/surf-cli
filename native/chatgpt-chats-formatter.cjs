"use strict";

function toEpochMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function formatListTimestamp(value) {
  const ms = toEpochMs(value);
  if (!ms) return "-";
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${min}`;
}

function formatMessageTimestamp(value) {
  const ms = toEpochMs(value);
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatHeaderDate(value) {
  const ms = toEpochMs(value);
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function truncate(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function normalizeConversationItems(raw) {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.conversations)
        ? raw.conversations
        : [];

  return source
    .filter(Boolean)
    .map((item) => {
      const updatedAt = item.update_time ?? item.updateTime ?? item.create_time ?? item.createTime ?? null;
      const createdAt = item.create_time ?? item.createTime ?? updatedAt ?? null;
      return {
        ...item,
        id: item.id ?? item.conversation_id ?? item.conversationId ?? "",
        title: item.title || "(untitled)",
        create_time: createdAt,
        update_time: updatedAt,
      };
    })
    .filter((item) => item.id)
    .sort((a, b) => (toEpochMs(b.update_time) || 0) - (toEpochMs(a.update_time) || 0));
}

function extractMessageText(message) {
  const content = message?.content;
  if (!content) return "";

  if (Array.isArray(content.parts)) {
    return content.parts
      .flatMap((part) => {
        if (typeof part === "string") return [part];
        if (part && typeof part.text === "string") return [part.text];
        return [];
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  if (typeof content.text === "string") return content.text.trim();
  return "";
}

function getRootNodeIds(mapping) {
  return Object.values(mapping)
    .filter((node) => node && (!node.parent || !mapping[node.parent]))
    .map((node) => node.id)
    .filter(Boolean)
    .sort();
}

/**
 * Build the active linear path from root → current_node.
 * Returns null if current_node is missing or can't be traced to a root.
 */
function buildActivePathIds(mapping, currentNode) {
  if (!currentNode || !mapping[currentNode]) return null;
  const chain = [];
  let nodeId = currentNode;
  while (nodeId && mapping[nodeId]) {
    chain.push(nodeId);
    nodeId = mapping[nodeId].parent;
  }
  chain.reverse(); // root → leaf
  return chain;
}

/**
 * Extract a message record from a mapping node, or null if not renderable.
 */
function nodeToMessage(node) {
  if (!node) return null;
  const msg = node.message;
  const role = msg?.author?.role;
  const text = extractMessageText(msg);
  if (!role || role === "system" || msg?.metadata?.is_hidden || !text) return null;
  return {
    id: node.id,
    role,
    text,
    time: msg.create_time ?? node.create_time ?? null,
    model: msg.metadata?.model_slug || null,
    parent: node.parent || null,
    children: Array.isArray(node.children) ? node.children.slice() : [],
  };
}

/**
 * Walk the conversation tree.
 *
 * Default (mode="active"): follows the linear path root → current_node,
 * producing a clean transcript without abandoned/regenerated branches.
 *
 * mode="full": DFS over all branches (legacy behavior).
 *
 * Falls back to "full" when current_node is absent or unreachable.
 */
function walkConversationMessages(conversation, options = {}) {
  const mapping = conversation?.mapping || {};
  const mode = options.mode || "active";
  const currentNode = conversation?.current_node;

  // Active-path walk: linear, no branches
  if (mode === "active") {
    const activePath = buildActivePathIds(mapping, currentNode);
    if (activePath) {
      const messages = [];
      for (const nodeId of activePath) {
        const msg = nodeToMessage(mapping[nodeId]);
        if (msg) messages.push(msg);
      }
      return messages;
    }
    // current_node missing / unreachable → fall through to full DFS
  }

  // Full DFS walk (all branches, sorted by id)
  const seen = new Set();
  const messages = [];

  const visit = (nodeId) => {
    if (!nodeId || seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!node) return;

    const msg = nodeToMessage(node);
    if (msg) messages.push(msg);

    const children = Array.isArray(node.children) ? node.children.slice().sort() : [];
    for (const childId of children) visit(childId);
  };

  for (const rootId of getRootNodeIds(mapping)) visit(rootId);
  return messages;
}

function summarizeConversation(conversation, options = {}) {
  const messageLimit = Number.isFinite(Number(options.messageLimit))
    ? Math.max(1, Math.trunc(Number(options.messageLimit)))
    : null;
  const messages = walkConversationMessages(conversation);
  const visibleMessages = messageLimit ? messages.slice(-messageLimit) : messages;
  const lastAssistant = [...visibleMessages].reverse().find((m) => m.role === "assistant");

  return {
    title: conversation?.title || "(untitled)",
    create_time: conversation?.create_time ?? visibleMessages[0]?.time ?? null,
    current_node: conversation?.current_node ?? null,
    messages: visibleMessages,
    totalMessages: messages.length,
    model: lastAssistant?.model || null,
  };
}

function formatConversationList({ items, total, label } = {}) {
  const normalized = normalizeConversationItems(items);
  if (normalized.length === 0) return "No conversations found.";

  const shown = normalized.length;
  const totalCount = Number.isFinite(Number(total)) ? Number(total) : shown;
  const heading = label || "ChatGPT Conversations";
  const lines = [`${heading} (${shown} of ${totalCount})`, "", `  ${"UPDATED".padEnd(16)} ${"TITLE".padEnd(40)} ID`, `  ${"─".repeat(16)} ${"─".repeat(40)} ${"─".repeat(18)}`];

  for (const item of normalized) {
    const updated = formatListTimestamp(item.update_time);
    const title = truncate(item.title || "(untitled)", 40);
    const id = truncate(item.id, 18);
    lines.push(`  ${updated.padEnd(16)} ${title.padEnd(40)} ${id}`);
  }

  return lines.join("\n");
}

function formatConversationMarkdown({ conversation, messageLimit } = {}) {
  const summary = summarizeConversation(conversation, { messageLimit });
  const meta = [formatHeaderDate(summary.create_time), summary.model, `${summary.totalMessages} messages`].filter(Boolean);
  const lines = [`# ${summary.title}`];
  if (meta.length > 0) lines.push(`_${meta.join(" | ")}_`);
  lines.push("", "---", "");

  for (const message of summary.messages) {
    const who = message.role === "user" ? "You" : message.role === "assistant" ? "ChatGPT" : message.role;
    const ts = formatMessageTimestamp(message.time);
    lines.push(`### ${who}${ts ? ` · ${ts}` : ""}`, "", message.text, "", "---", "");
  }

  if (summary.messages.length === 0) {
    lines.push("_No visible messages found._", "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function inferExportFormat({ exportPath, explicitFormat } = {}) {
  const fmt = explicitFormat ? String(explicitFormat).toLowerCase() : "";
  if (fmt === "md") return "markdown";
  if (fmt === "markdown" || fmt === "json") return fmt;
  if (exportPath && String(exportPath).toLowerCase().endsWith(".json")) return "json";
  return "markdown";
}

module.exports = {
  extractMessageText,
  formatConversationList,
  formatConversationMarkdown,
  inferExportFormat,
  normalizeConversationItems,
  summarizeConversation,
  walkConversationMessages,
};
