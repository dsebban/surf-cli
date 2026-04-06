import { describe, expect, it, vi } from "vitest";

const {
  enterPromptWithVerification,
  __private,
} = require("../../native/chatgpt-cloak-prompt-entry.cjs");

type HarnessOptions = {
  execTransform?: (text: string, callIndex: number, state: HarnessState) => string;
  fallbackTransform?: (text: string, state: HarnessState) => string;
  fillTransform?: (text: string, state: HarnessState) => string;
  sendEnabledFunc?: (state: HarnessState) => boolean;
  sendThreshold?: number;
  typeTransform?: (text: string, state: HarnessState) => string;
};

type HarnessState = {
  composerText: string;
  execCalls: number;
  fallbackCalls: number;
  sendEnabled: boolean;
};

function createSleepMock() {
  return vi.fn(async () => undefined);
}

function updateSendEnabled(state: HarnessState, options: HarnessOptions) {
  if (typeof options.sendEnabledFunc === "function") {
    state.sendEnabled = !!options.sendEnabledFunc(state);
    return;
  }
  state.sendEnabled = state.composerText.length >= (options.sendThreshold ?? 1);
}

function readState(state: HarnessState, options: HarnessOptions) {
  updateSendEnabled(state, options);
  return {
    actualText: state.composerText,
    actualChars: state.composerText.length,
    rawLengths: {
      value: 0,
      textContent: state.composerText.length,
      innerText: state.composerText.length,
    },
    sendEnabled: state.sendEnabled,
  };
}

function clearState(state: HarnessState) {
  state.composerText = "";
  state.sendEnabled = false;
  return true;
}

function applyExec(state: HarnessState, options: HarnessOptions, arg?: { text?: string } | string) {
  state.execCalls += 1;
  const text = typeof arg === "string" ? arg : (arg?.text ?? "");
  const inserted = options.execTransform
    ? options.execTransform(text, state.execCalls, state)
    : text;
  state.composerText += inserted;
  updateSendEnabled(state, options);
  return true;
}

function applyFallback(
  state: HarnessState,
  options: HarnessOptions,
  arg?: { text?: string } | string,
) {
  state.fallbackCalls += 1;
  const text = typeof arg === "string" ? arg : (arg?.text ?? "");
  state.composerText = options.fallbackTransform ? options.fallbackTransform(text, state) : text;
  updateSendEnabled(state, options);
  return true;
}

function handleEvaluate(
  source: string,
  state: HarnessState,
  options: HarnessOptions,
  arg?: { text?: string } | string,
) {
  if (source.includes("rawValue") && source.includes("sendEnabled")) {
    return readState(state, options);
  }

  if (
    source.includes("deleteContentBackward") ||
    source.includes('document.execCommand("selectAll"')
  ) {
    return clearState(state);
  }

  if (source.includes('document.execCommand("insertText"')) {
    return applyExec(state, options, arg);
  }

  if (source.includes("insertFromPaste") && source.includes("el.value = text")) {
    return applyFallback(state, options, arg);
  }

  throw new Error(`Unhandled evaluate call: ${source.slice(0, 120)}`);
}

function createHarness(options: HarnessOptions = {}) {
  const state: HarnessState = {
    composerText: "",
    execCalls: 0,
    fallbackCalls: 0,
    sendEnabled: false,
  };

  const textarea = {
    type: vi.fn(async (text: string) => {
      state.composerText += options.typeTransform ? options.typeTransform(text, state) : text;
      updateSendEnabled(state, options);
    }),
    fill: vi.fn(async (text: string) => {
      state.composerText = options.fillTransform ? options.fillTransform(text, state) : text;
      updateSendEnabled(state, options);
    }),
  };

  const page = {
    evaluate: vi.fn(async (fn: unknown, arg?: { text?: string } | string) => {
      const source = typeof fn === "function" ? fn.toString() : String(fn);
      return handleEvaluate(source, state, options, arg);
    }),
  };

  return { page, textarea, state };
}

describe("chatgpt-cloak-prompt-entry", () => {
  it("selects strategy by prompt bytes", () => {
    expect(__private.selectPromptInsertionStrategy(4 * 1024)).toBe("type");
    expect(__private.selectPromptInsertionStrategy(20 * 1024)).toBe("exec");
    expect(__private.selectPromptInsertionStrategy(60 * 1024)).toBe("chunked_exec");
  });

  it("splits UTF-8 chunks without breaking content", () => {
    const text = "abc😀".repeat(5000);
    const chunks = __private.splitUtf8Chunks(text, 1024);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk: { bytes: number }) => chunk.bytes <= 1024)).toBe(true);
    expect(chunks.map((chunk: { text: string }) => chunk.text).join("")).toBe(text);
  });

  it("falls back when execCommand truncates medium prompts", async () => {
    const harness = createHarness({
      execTransform: (text) => text.slice(0, Math.floor(text.length * 0.6)),
    });
    const log = vi.fn();
    const sleep = createSleepMock();
    const prompt = "x".repeat(20 * 1024);

    const result = await enterPromptWithVerification({
      page: harness.page,
      textarea: harness.textarea,
      prompt,
      log,
      sleep,
      promptSelector: "#prompt-textarea",
      sendButtonSelectors: ["button[data-testid='send-button']"],
    });

    expect(result.method).toBe("fill_fallback");
    expect(result.usedFallback).toBe(true);
    expect(result.actualChars).toBe(result.expectedChars);
    expect(harness.textarea.fill).toHaveBeenCalledTimes(1);
  });

  it("uses chunked exec for very large prompts without fallback when chunks verify", async () => {
    const harness = createHarness();
    const log = vi.fn();
    const sleep = createSleepMock();
    const prompt = "abcd".repeat(20 * 1024);

    const result = await enterPromptWithVerification({
      page: harness.page,
      textarea: harness.textarea,
      prompt,
      log,
      sleep,
      promptSelector: "#prompt-textarea",
      sendButtonSelectors: ["button[data-testid='send-button']"],
    });

    expect(result.method).toBe("chunked_exec");
    expect(result.usedFallback).toBe(false);
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(harness.textarea.fill).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("Prompt insert chunk"));
  });

  it("falls back when send button is not ready after exact insertion", async () => {
    const harness = createHarness({
      sendEnabledFunc: (state) => state.fallbackCalls > 0,
    });
    const sleep = createSleepMock();

    const result = await enterPromptWithVerification({
      page: harness.page,
      textarea: harness.textarea,
      prompt: "x".repeat(16 * 1024),
      log: vi.fn(),
      sleep,
      promptSelector: "#prompt-textarea",
      sendButtonSelectors: ["button[data-testid='send-button']"],
    });

    expect(result.method).toBe("fill_fallback");
    expect(result.sendEnabled).toBe(true);
    expect(harness.textarea.fill).toHaveBeenCalledTimes(1);
  });

  it("throws with details when fallback still cannot insert full prompt", async () => {
    const harness = createHarness({
      execTransform: (text) => text.slice(0, Math.floor(text.length * 0.4)),
      fillTransform: (text) => text.slice(0, Math.floor(text.length * 0.5)),
      fallbackTransform: (text) => text.slice(0, Math.floor(text.length * 0.5)),
    });
    const sleep = createSleepMock();

    await expect(
      enterPromptWithVerification({
        page: harness.page,
        textarea: harness.textarea,
        prompt: "x".repeat(20 * 1024),
        log: vi.fn(),
        sleep,
        promptSelector: "#prompt-textarea",
        sendButtonSelectors: ["button[data-testid='send-button']"],
      }),
    ).rejects.toMatchObject({
      code: "prompt_insertion_failed",
      details: expect.objectContaining({
        ratio: expect.any(Number),
        usedFallback: true,
      }),
    });
  });
});
