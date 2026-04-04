import { describe, expect, it } from "vitest";
import {
  advanceTextStability,
  applyChatGptFramePayload,
  buildChatGptModelSelectionSpec,
  chooseBestText,
  createEmptyChatGptStreamState,
  sanitizeChatGptAssistantText,
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

  // ==========================================================================
  // Stream state + delta v1 parser
  // ==========================================================================

  describe("createEmptyChatGptStreamState", () => {
    it("returns clean initial state", () => {
      const s = createEmptyChatGptStreamState();
      expect(s).toEqual({ parts: [], text: "", done: false, messageId: null, model: null });
    });
  });

  describe("applyChatGptFramePayload", () => {
    it("parses legacy full-message assistant event", () => {
      const payload = `data: {"message":{"id":"msg-1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["Hello world"]},"status":"in_progress","metadata":{"model_slug":"gpt-5.3"}}}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("Hello world");
      expect(s.messageId).toBe("msg-1");
      expect(s.model).toBe("gpt-5.3");
      expect(s.done).toBe(false);
    });

    it("parses legacy finished_successfully", () => {
      const payload = `data: {"message":{"id":"msg-1","author":{"role":"assistant"},"content":{"parts":["4"]},"status":"finished_successfully"}}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("4");
      expect(s.done).toBe(true);
    });

    it("parses nested v.message format", () => {
      const payload = `data: {"v":{"message":{"id":"msg-2","author":{"role":"assistant"},"content":{"parts":["nested"]},"status":"in_progress"}}}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("nested");
      expect(s.messageId).toBe("msg-2");
    });

    it("ignores user-role messages", () => {
      const payload = `data: {"message":{"id":"msg-u","author":{"role":"user"},"content":{"parts":["user said"]},"status":"finished_successfully"}}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("");
      expect(s.done).toBe(false);
    });

    it("ignores system-role messages", () => {
      const payload = `data: {"v":{"message":{"id":"sys-1","author":{"role":"system"},"content":{"parts":[""]},"status":"finished_successfully"}}}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("");
    });

    it("parses delta v1 single append op", () => {
      const payload = `data: {"o":"append","p":"/message/content/parts/0","v":"Hello"}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("Hello");
      expect(s.parts).toEqual(["Hello"]);
    });

    it("accumulates delta v1 single ops across calls", () => {
      let s = createEmptyChatGptStreamState();
      s = applyChatGptFramePayload(
        s,
        `data: {"o":"append","p":"/message/content/parts/0","v":"Hel"}`,
      );
      s = applyChatGptFramePayload(
        s,
        `data: {"o":"append","p":"/message/content/parts/0","v":"lo"}`,
      );
      expect(s.text).toBe("Hello");
    });

    it("parses delta v1 batch ops", () => {
      const payload = `data: {"v":[{"o":"append","p":"/message/content/parts/0","v":" world"},{"o":"replace","p":"/message/status","v":"finished_successfully"}]}`;
      let s = applyChatGptFramePayload(
        createEmptyChatGptStreamState(),
        `data: {"o":"append","p":"/message/content/parts/0","v":"Hello"}`,
      );
      s = applyChatGptFramePayload(s, payload);
      expect(s.text).toBe("Hello world");
      expect(s.done).toBe(true);
    });

    it("handles delta replace on /message/id", () => {
      const payload = `data: {"o":"replace","p":"/message/id","v":"msg-replaced"}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.messageId).toBe("msg-replaced");
    });

    it("handles delta replace on /message/metadata/model_slug", () => {
      const payload = `data: {"o":"replace","p":"/message/metadata/model_slug","v":"gpt-5.3"}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.model).toBe("gpt-5.3");
    });

    it("handles [DONE] sentinel", () => {
      const payload = "data: [DONE]";
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.done).toBe(true);
    });

    it("handles message_stream_complete sentinel", () => {
      const payload = "message_stream_complete";
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.done).toBe(true);
    });

    it("handles message_stream_complete as type field", () => {
      const payload = `data: {"type":"message_stream_complete"}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.done).toBe(true);
    });

    it("handles multi-line payload with mixed events", () => {
      const payload = [
        `event: delta`,
        `data: {"o":"append","p":"/message/content/parts/0","v":"2+2 = "}`,
        ``,
        `event: delta`,
        `data: {"v":[{"o":"append","p":"/message/content/parts/0","v":"4"},{"o":"replace","p":"/message/status","v":"finished_successfully"}]}`,
      ].join("\n");
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("2+2 = 4");
      expect(s.done).toBe(true);
    });

    it("handles raw JSON lines without data: prefix", () => {
      const payload = `{"o":"append","p":"/message/content/parts/0","v":"raw"}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("raw");
    });

    it("ignores malformed JSON gracefully", () => {
      const payload = `data: {broken json}\ndata: {"o":"append","p":"/message/content/parts/0","v":"ok"}`;
      const s = applyChatGptFramePayload(createEmptyChatGptStreamState(), payload);
      expect(s.text).toBe("ok");
    });

    it("handles delta replace on parts (overwrite)", () => {
      let s = applyChatGptFramePayload(
        createEmptyChatGptStreamState(),
        `data: {"o":"append","p":"/message/content/parts/0","v":"draft"}`,
      );
      s = applyChatGptFramePayload(
        s,
        `data: {"o":"replace","p":"/message/content/parts/0","v":"final"}`,
      );
      expect(s.text).toBe("final");
    });

    it("is immutable — does not mutate input state", () => {
      const s0 = createEmptyChatGptStreamState();
      const s1 = applyChatGptFramePayload(
        s0,
        `data: {"o":"append","p":"/message/content/parts/0","v":"test"}`,
      );
      expect(s0.text).toBe("");
      expect(s0.parts).toEqual([]);
      expect(s1.text).toBe("test");
    });
  });

  // ==========================================================================
  // DOM text sanitizer
  // ==========================================================================

  describe("sanitizeChatGptAssistantText", () => {
    it("strips Give feedback line", () => {
      expect(sanitizeChatGptAssistantText("4\nGive feedback")).toBe("4");
    });

    it("strips ChatGPT Instruments and Give feedback", () => {
      expect(sanitizeChatGptAssistantText("ChatGPT Instruments\n\n2+2\n\nGive feedback")).toBe(
        "2+2",
      );
    });

    it("strips multiple UI chrome lines", () => {
      const raw = "ChatGPT said:\nHello world\nCopy\nGood response\nBad response";
      expect(sanitizeChatGptAssistantText(raw)).toBe("Hello world");
    });

    it("preserves legitimate prose mentioning UI words", () => {
      const raw = "The give feedback button is useful\nCopy the text to clipboard";
      expect(sanitizeChatGptAssistantText(raw)).toBe(
        "The give feedback button is useful\nCopy the text to clipboard",
      );
    });

    it("returns empty for empty input", () => {
      expect(sanitizeChatGptAssistantText("")).toBe("");
    });

    it("returns empty when only noise", () => {
      expect(sanitizeChatGptAssistantText("ChatGPT\nCopy\nShare")).toBe("");
    });

    it("handles case-insensitive matching", () => {
      expect(sanitizeChatGptAssistantText("GIVE FEEDBACK\nresult")).toBe("result");
    });

    it("strips Read aloud and Regenerate", () => {
      expect(sanitizeChatGptAssistantText("answer\nRead aloud\nRegenerate")).toBe("answer");
    });
  });

  // ==========================================================================
  // Stream vs DOM text arbitration
  // ==========================================================================

  describe("chooseBestText", () => {
    it("prefers DOM when finished and non-empty", () => {
      expect(
        chooseBestText({
          streamText: "stream",
          domText: "dom",
          streamDone: true,
          domFinished: true,
        }),
      ).toBe("dom");
    });

    it("prefers stream when DOM not finished", () => {
      expect(
        chooseBestText({
          streamText: "stream",
          domText: "",
          streamDone: false,
          domFinished: false,
        }),
      ).toBe("stream");
    });

    it("prefers stream when DOM finished but empty", () => {
      expect(
        chooseBestText({
          streamText: "stream",
          domText: "",
          streamDone: true,
          domFinished: true,
        }),
      ).toBe("stream");
    });

    it("returns DOM when stream empty", () => {
      expect(
        chooseBestText({
          streamText: "",
          domText: "dom",
          streamDone: false,
          domFinished: false,
        }),
      ).toBe("dom");
    });

    it("returns empty when both empty", () => {
      expect(
        chooseBestText({
          streamText: "",
          domText: "",
          streamDone: false,
          domFinished: false,
        }),
      ).toBe("");
    });
  });

  // ==========================================================================
  // Text stability tracker
  // ==========================================================================

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
        stableCycles: 1,
        lastChangeAtMs: 1000,
        nowMs: 2500,
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
        stableCycles: 1,
        lastChangeAtMs: 1000,
        nowMs: 1500,
      });
      expect(result.shouldComplete).toBe(false);
    });
  });
});
