/**
 * Pure helpers for ChatGPT Bun worker — model mapping + text stabilization.
 * No Bun/WebView dependency; safe to import in Vitest.
 */

// ============================================================================
// Model → mode mapping
// ============================================================================

export type ChatGptPickerMode = "instant" | "thinking" | "pro" | "raw";

export interface ChatGptModelSelectionSpec {
  requestedModel: string;
  normalizedModel: string;
  mode: ChatGptPickerMode;
  preferredTestIdFragments: string[];
  preferredTextFragments: string[];
  fallbackRawFragments: string[];
}

interface ModeEntry {
  mode: ChatGptPickerMode;
  aliases: string[];
  testIdFragments: string[];
  textFragments: string[];
}

// Model mapping based on OpenAI's March 2026 ChatGPT model lineup:
// - GPT-5.3 Instant: fast everyday (replaced GPT-4o, GPT-4.1, GPT-4.1 mini)
// - GPT-5.4 Thinking: complex reasoning (replaced o3, o4-mini)
// - GPT-5.4 Pro: research-grade (replaced o1-pro)
// See: https://help.openai.com/en/articles/20001051-retiring-gpt-4o-and-other-chatgpt-models
const MODE_TABLE: ModeEntry[] = [
  {
    mode: "instant",
    aliases: [
      "instant", "gpt-5.3", "gpt-5-3", "gpt5.3",
      // Retired models that map to Instant
      "gpt-4o", "gpt4o", "gpt-4o-mini", "gpt4omini",
      "gpt-4.1", "gpt-4.1-mini", "gpt4.1", "gpt4.1mini",
      "gpt-5-instant", "gpt-5.1-instant",
    ],
    testIdFragments: ["model-switcher-gpt-5-3", "gpt-5-3"],
    textFragments: ["instant", "gpt-5.3", "gpt 5.3"],
  },
  {
    mode: "thinking",
    aliases: [
      "thinking", "gpt-5.4-thinking", "gpt-5-4-thinking",
      // Retired models that map to Thinking
      "o3", "o4-mini", "o4mini",
      "gpt-5-thinking", "gpt-5.1-thinking",
    ],
    testIdFragments: ["model-switcher-gpt-5-4-thinking", "gpt-5-4-thinking"],
    textFragments: ["thinking"],
  },
  {
    mode: "pro",
    aliases: [
      "pro", "gpt-5.4-pro", "gpt-5-4-pro",
      // Retired models that map to Pro
      "o1-pro", "o1pro", "chatgpt-pro", "chatgptpro",
      "gpt-5-pro", "gpt-5.1-pro",
    ],
    testIdFragments: ["model-switcher-gpt-5-4-pro", "gpt-5-4-pro"],
    textFragments: ["pro", "research-grade"],
  },
];

export function buildChatGptModelSelectionSpec(model: string): ChatGptModelSelectionSpec {
  const raw = (model || "").trim();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9.-]/g, "");

  for (const entry of MODE_TABLE) {
    for (const alias of entry.aliases) {
      if (normalized === alias || normalized === alias.replace(/-/g, "")) {
        return {
          requestedModel: raw,
          normalizedModel: normalized,
          mode: entry.mode,
          preferredTestIdFragments: entry.testIdFragments,
          preferredTextFragments: entry.textFragments,
          fallbackRawFragments: normalized ? [normalized] : [],
        };
      }
    }
  }

  return {
    requestedModel: raw,
    normalizedModel: normalized,
    mode: "raw",
    preferredTestIdFragments: [],
    preferredTextFragments: [],
    fallbackRawFragments: normalized ? [normalized] : [],
  };
}

// ============================================================================
// Stream state + delta v1 parser
// ============================================================================

export interface ChatGptStreamState {
  parts: string[];
  text: string;
  done: boolean;
  messageId: string | null;
  model: string | null;
}

export function createEmptyChatGptStreamState(): ChatGptStreamState {
  return { parts: [], text: "", done: false, messageId: null, model: null };
}

/**
 * Apply one raw payloadData chunk (may contain multiple lines) to stream state.
 * Handles:
 *   - legacy full-message: {message: {content: {parts: [...]}}}
 *   - nested v.message:    {v: {message: {content: {parts: [...]}}}}
 *   - delta v1 single op:  {o: "append", p: "/message/content/parts/0", v: "chunk"}
 *   - delta v1 batch ops:  {v: [{o, p, v}, ...]}
 *   - data: prefix lines (SSE format)
 *   - sentinel: [DONE], message_stream_complete
 * Returns new state (immutable pattern for testability).
 */
export function applyChatGptFramePayload(
  state: ChatGptStreamState,
  payloadData: string,
): ChatGptStreamState {
  const next: ChatGptStreamState = {
    parts: [...state.parts],
    text: state.text,
    done: state.done,
    messageId: state.messageId,
    model: state.model,
  };

  const lines = payloadData.split("\n");
  for (let rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    // Strip "event: ..." lines
    if (line.startsWith("event:")) continue;

    // Strip SSE data: prefix
    if (line.startsWith("data: ")) line = line.slice(6).trim();

    // Sentinels
    if (line === "[DONE]") { next.done = true; continue; }
    if (line === "message_stream_complete") { next.done = true; continue; }
    if (line[0] !== "{") continue;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    // Check for message_stream_complete type
    if (obj.type === "message_stream_complete") { next.done = true; continue; }

    // --- Legacy / nested message format ---
    const msg = (obj.v && obj.v.message) || obj.message;
    if (msg && msg.author?.role === "assistant" && msg.content?.parts) {
      const text = msg.content.parts.join("");
      if (text) {
        next.parts = [...msg.content.parts];
        next.text = text;
      }
      if (msg.id) next.messageId = msg.id;
      if (msg.metadata?.model_slug) next.model = msg.metadata.model_slug;
      if (msg.status === "finished_successfully") next.done = true;
      continue;
    }

    // --- Delta v1 single op: {o, p, v} ---
    if (typeof obj.o === "string" && typeof obj.p === "string") {
      applyDeltaOp(next, obj);
      continue;
    }

    // --- Delta v1 batch ops: {v: [{o, p, v}, ...]} ---
    if (Array.isArray(obj.v)) {
      for (const op of obj.v) {
        if (typeof op.o === "string" && typeof op.p === "string") {
          applyDeltaOp(next, op);
        }
      }
      continue;
    }
  }

  return next;
}

function applyDeltaOp(
  state: ChatGptStreamState,
  op: { o: string; p: string; v: unknown },
): void {
  const partMatch = op.p.match(/^\/message\/content\/parts\/(\d+)$/);
  if (partMatch) {
    const idx = parseInt(partMatch[1], 10);
    // Ensure parts array is large enough
    while (state.parts.length <= idx) state.parts.push("");
    if (op.o === "append" && typeof op.v === "string") {
      state.parts[idx] += op.v;
    } else if (op.o === "replace") {
      state.parts[idx] = typeof op.v === "string" ? op.v : JSON.stringify(op.v);
    }
    state.text = state.parts.join("");
    return;
  }

  if (op.p === "/message/status" && op.o === "replace" && op.v === "finished_successfully") {
    state.done = true;
    return;
  }
  if (op.p === "/message/id" && op.o === "replace" && typeof op.v === "string") {
    state.messageId = op.v;
    return;
  }
  if (op.p === "/message/metadata/model_slug" && op.o === "replace" && typeof op.v === "string") {
    state.model = op.v;
    return;
  }
}

// ============================================================================
// DOM text sanitizer
// ============================================================================

/** UI-chrome lines to strip from DOM-extracted text (exact line match, case-insensitive). */
const UI_NOISE_LINES = new Set([
  "give feedback",
  "copy",
  "good response",
  "bad response",
  "chatgpt said:",
  "assistant said:",
  "you said:",
  "chatgpt",
  "chatgpt instruments",
  "read aloud",
  "share",
  "regenerate",
  "edit",
  "retry",
  "is this conversation helpful so far?",
  "thinking",
  "thinking…",
  "thinking...",
]);

/**
 * Strip known UI chrome from DOM-extracted assistant text.
 * Removes exact-line matches only; preserves legitimate prose.
 */
export function sanitizeChatGptAssistantText(raw: string): string {
  if (!raw) return "";
  return raw
    .split("\n")
    .filter(line => {
      const trimmed = line.trim().toLowerCase();
      return trimmed.length > 0 && !UI_NOISE_LINES.has(trimmed);
    })
    .join("\n")
    .trim();
}

// ============================================================================
// Stream vs DOM text arbitration
// ============================================================================

/**
 * Choose the best text source between stream capture and DOM extraction.
 * Stream wins during streaming; DOM wins after render completes (more reliable).
 */
export function chooseBestText(args: {
  streamText: string;
  domText: string;
  streamDone: boolean;
  domFinished: boolean;
}): string {
  const { streamText, domText, streamDone, domFinished } = args;

  // If DOM is finished and has content, prefer it (most reliable after render)
  if (domFinished && domText.length > 0) {
    return domText;
  }

  // If stream has content, prefer it
  if (streamText.length > 0) {
    return streamText;
  }

  // Fallback to whatever is available
  return domText || streamText;
}

// ============================================================================
// Text stability tracker
// ============================================================================

export interface TextStabilityInput {
  text: string;
  previousText: string;
  isStreaming: boolean;
  finished: boolean;
  stableCycles: number;
  lastChangeAtMs: number;
  nowMs: number;
  requiredStableCycles: number;
  minStableMs: number;
}

export interface TextStabilityResult {
  stableCycles: number;
  lastChangeAtMs: number;
  shouldComplete: boolean;
}

export function advanceTextStability(input: TextStabilityInput): TextStabilityResult {
  const {
    text, previousText, isStreaming, finished,
    stableCycles, lastChangeAtMs, nowMs,
    requiredStableCycles, minStableMs,
  } = input;

  // Text changed → reset
  if (text !== previousText) {
    return { stableCycles: 0, lastChangeAtMs: nowMs, shouldComplete: false };
  }

  // Finished signal with content → immediate complete
  if (finished && text.length > 0) {
    return { stableCycles: stableCycles + 1, lastChangeAtMs, shouldComplete: true };
  }

  // Not streaming + stable for N cycles + min time → complete
  const newStable = stableCycles + 1;
  const stableMs = nowMs - lastChangeAtMs;
  if (!isStreaming && text.length > 0 && newStable >= requiredStableCycles && stableMs >= minStableMs) {
    return { stableCycles: newStable, lastChangeAtMs, shouldComplete: true };
  }

  return { stableCycles: newStable, lastChangeAtMs, shouldComplete: false };
}
