import { describe, expect, it } from "vitest";
import {
  buildChatGptModelSelectionSpec,
  advanceTextStability,
} from "../../native/chatgpt-bun-worker-logic";

describe("chatgpt-bun-worker-logic", () => {
  describe("buildChatGptModelSelectionSpec", () => {
    it("maps gpt-4o to instant mode", () => {
      const spec = buildChatGptModelSelectionSpec("gpt-4o");
      expect(spec.mode).toBe("instant");
      expect(spec.preferredTestIdFragments).toContain("model-switcher-gpt-5-3");
      expect(spec.preferredTextFragments).toContain("instant");
    });

    it("maps gpt-4o-mini to instant mode", () => {
      const spec = buildChatGptModelSelectionSpec("gpt-4o-mini");
      expect(spec.mode).toBe("instant");
    });

    it("maps o3 to thinking mode", () => {
      const spec = buildChatGptModelSelectionSpec("o3");
      expect(spec.mode).toBe("thinking");
      expect(spec.preferredTestIdFragments).toContain("model-switcher-gpt-5-4-thinking");
      expect(spec.preferredTextFragments).toContain("thinking");
    });

    it("maps o4-mini to thinking mode", () => {
      const spec = buildChatGptModelSelectionSpec("o4-mini");
      expect(spec.mode).toBe("thinking");
    });

    it("maps o1-pro to pro mode", () => {
      const spec = buildChatGptModelSelectionSpec("o1-pro");
      expect(spec.mode).toBe("pro");
      expect(spec.preferredTestIdFragments).toContain("model-switcher-gpt-5-4-pro");
    });

    it("maps chatgpt-pro to pro mode", () => {
      const spec = buildChatGptModelSelectionSpec("chatgpt-pro");
      expect(spec.mode).toBe("pro");
    });

    it("maps direct mode names", () => {
      expect(buildChatGptModelSelectionSpec("instant").mode).toBe("instant");
      expect(buildChatGptModelSelectionSpec("thinking").mode).toBe("thinking");
      expect(buildChatGptModelSelectionSpec("pro").mode).toBe("pro");
    });

    it("returns raw for unknown model", () => {
      const spec = buildChatGptModelSelectionSpec("some-future-model");
      expect(spec.mode).toBe("raw");
      expect(spec.preferredTestIdFragments).toEqual([]);
      expect(spec.preferredTextFragments).toEqual([]);
      expect(spec.fallbackRawFragments).toContain("some-future-model");
    });

    it("handles empty model string", () => {
      const spec = buildChatGptModelSelectionSpec("");
      expect(spec.mode).toBe("raw");
      expect(spec.fallbackRawFragments).toEqual([]);
    });

    it("preserves raw fallback even for mapped modes", () => {
      const spec = buildChatGptModelSelectionSpec("gpt-4o");
      expect(spec.fallbackRawFragments).toContain("gpt-4o");
    });
  });

  describe("advanceTextStability", () => {
    const base = {
      requiredStableCycles: 2,
      minStableMs: 1200,
    };

    it("resets on text change", () => {
      const result = advanceTextStability({
        ...base,
        text: "new text",
        previousText: "old text",
        isStreaming: false,
        finished: false,
        stableCycles: 5,
        lastChangeAtMs: 1000,
        nowMs: 5000,
      });
      expect(result.stableCycles).toBe(0);
      expect(result.lastChangeAtMs).toBe(5000);
      expect(result.shouldComplete).toBe(false);
    });

    it("completes immediately when finished with content", () => {
      const result = advanceTextStability({
        ...base,
        text: "4",
        previousText: "4",
        isStreaming: false,
        finished: true,
        stableCycles: 0,
        lastChangeAtMs: 1000,
        nowMs: 1500,
      });
      expect(result.shouldComplete).toBe(true);
    });

    it("completes after stable cycles and min time", () => {
      const result = advanceTextStability({
        ...base,
        text: "answer",
        previousText: "answer",
        isStreaming: false,
        finished: false,
        stableCycles: 1, // will become 2
        lastChangeAtMs: 1000,
        nowMs: 2500, // 1500ms > 1200ms
      });
      expect(result.shouldComplete).toBe(true);
      expect(result.stableCycles).toBe(2);
    });

    it("does not complete during streaming", () => {
      const result = advanceTextStability({
        ...base,
        text: "partial",
        previousText: "partial",
        isStreaming: true,
        finished: false,
        stableCycles: 5,
        lastChangeAtMs: 1000,
        nowMs: 5000,
      });
      expect(result.shouldComplete).toBe(false);
    });

    it("does not complete with empty text", () => {
      const result = advanceTextStability({
        ...base,
        text: "",
        previousText: "",
        isStreaming: false,
        finished: false,
        stableCycles: 10,
        lastChangeAtMs: 0,
        nowMs: 99999,
      });
      expect(result.shouldComplete).toBe(false);
    });

    it("does not complete before minStableMs", () => {
      const result = advanceTextStability({
        ...base,
        text: "answer",
        previousText: "answer",
        isStreaming: false,
        finished: false,
        stableCycles: 1, // will become 2
        lastChangeAtMs: 1000,
        nowMs: 1500, // only 500ms < 1200ms
      });
      expect(result.shouldComplete).toBe(false);
    });
  });
});
