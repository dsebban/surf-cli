import { describe, it, expect } from "vitest";

const gc = require("../../native/gemini-common.cjs");

describe("gemini-common module", () => {
  describe("resolveGeminiModel", () => {
    it("returns default model for undefined/null/empty", () => {
      expect(gc.resolveGeminiModel(undefined)).toBe("gemini-3-pro");
      expect(gc.resolveGeminiModel(null)).toBe("gemini-3-pro");
      expect(gc.resolveGeminiModel("")).toBe("gemini-3-pro");
    });

    it("returns known models as-is", () => {
      expect(gc.resolveGeminiModel("gemini-3-pro")).toBe("gemini-3-pro");
      expect(gc.resolveGeminiModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
      expect(gc.resolveGeminiModel("gemini-2.5-flash")).toBe("gemini-2.5-flash");
    });

    it("returns default for unknown models", () => {
      expect(gc.resolveGeminiModel("gpt-4")).toBe("gemini-3-pro");
      expect(gc.resolveGeminiModel("random-model")).toBe("gemini-3-pro");
    });
  });

  describe("buildGeminiPrompt", () => {
    it("returns plain prompt when no options", () => {
      expect(gc.buildGeminiPrompt({ prompt: "hello" })).toBe("hello");
    });

    it("appends aspect ratio for image generation", () => {
      const result = gc.buildGeminiPrompt({
        prompt: "a cat",
        aspectRatio: "16:9",
        generateImage: "/tmp/out.png",
      });
      expect(result).toBe("Generate an image: a cat (aspect ratio: 16:9)");
    });

    it("appends aspect ratio for image editing without Generate prefix", () => {
      const result = gc.buildGeminiPrompt({
        prompt: "add hat",
        aspectRatio: "1:1",
        editImage: "/tmp/src.jpg",
      });
      expect(result).toBe("add hat (aspect ratio: 1:1)");
    });

    it("appends YouTube URL", () => {
      const result = gc.buildGeminiPrompt({
        prompt: "summarize",
        youtube: "https://youtube.com/watch?v=abc",
      });
      expect(result).toContain("YouTube video: https://youtube.com/watch?v=abc");
    });

    it("adds Generate prefix for generateImage without editImage", () => {
      const result = gc.buildGeminiPrompt({
        prompt: "a robot",
        generateImage: "/tmp/robot.png",
      });
      expect(result).toBe("Generate an image: a robot");
    });

    it("does NOT add Generate prefix when editImage is set", () => {
      const result = gc.buildGeminiPrompt({
        prompt: "add color",
        generateImage: "/tmp/out.png",
        editImage: "/tmp/src.jpg",
      });
      expect(result).not.toMatch(/^Generate an image:/);
    });

    it("handles empty prompt gracefully", () => {
      const result = gc.buildGeminiPrompt({});
      expect(result).toBe("");
    });
  });

  describe("getModelHeaderCandidates", () => {
    it("returns array for known model", () => {
      const candidates = gc.getModelHeaderCandidates("gemini-3-pro");
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThan(0);
    });

    it("returns fallback for unknown model", () => {
      const candidates = gc.getModelHeaderCandidates("unknown");
      expect(candidates.some((c: any) => c === null)).toBe(true);
    });
  });

  describe("ensureFullSizeImageUrl", () => {
    it("adds =s2048 when no size param", () => {
      const url = "https://lh3.googleusercontent.com/gg-dl/abc";
      expect(gc.ensureFullSizeImageUrl(url)).toBe(`${url}=s2048`);
    });

    it("preserves existing size param", () => {
      const url = "https://lh3.googleusercontent.com/gg-dl/abc=s1024";
      expect(gc.ensureFullSizeImageUrl(url)).toBe(url);
    });
  });

  describe("extractGgdlUrls", () => {
    it("extracts unique gg-dl URLs", () => {
      const text = `here https://lh3.googleusercontent.com/gg-dl/abc and https://lh3.googleusercontent.com/gg-dl/def and again https://lh3.googleusercontent.com/gg-dl/abc`;
      const urls = gc.extractGgdlUrls(text);
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain("abc");
      expect(urls[1]).toContain("def");
    });

    it("returns empty for no matches", () => {
      expect(gc.extractGgdlUrls("no images here")).toEqual([]);
    });
  });

  describe("resolveImageOutputPath", () => {
    it("uses explicit output when provided", () => {
      expect(gc.resolveImageOutputPath({ output: "/tmp/out.png" })).toBe("/tmp/out.png");
    });

    it("uses generateImage when no output", () => {
      expect(gc.resolveImageOutputPath({ generateImage: "/tmp/gen.png" })).toBe("/tmp/gen.png");
    });

    it("defaults to edited.png", () => {
      expect(gc.resolveImageOutputPath({})).toBe("edited.png");
    });
  });

  describe("constants", () => {
    it("exports GEMINI_APP_URL", () => {
      expect(gc.GEMINI_APP_URL).toBe("https://gemini.google.com/app");
    });

    it("exports SUPPORTED_GEMINI_MODELS", () => {
      expect(gc.SUPPORTED_GEMINI_MODELS).toContain("gemini-3-pro");
      expect(gc.SUPPORTED_GEMINI_MODELS).toContain("gemini-2.5-pro");
      expect(gc.SUPPORTED_GEMINI_MODELS).toContain("gemini-2.5-flash");
    });

    it("exports DEFAULT_GEMINI_MODEL", () => {
      expect(gc.DEFAULT_GEMINI_MODEL).toBe("gemini-3-pro");
    });
  });
});
