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
