import { describe, it, expect } from "vitest";

// Simple test to verify the gemini client module loads
const geminiClient = require("../../native/gemini-client.cjs");

describe("gemini-client module", () => {
  it("exports parseGeminiStreamGenerateResponse function", () => {
    expect(typeof geminiClient.parseGeminiStreamGenerateResponse).toBe("function");
  });

  it("exports required cookie functions", () => {
    expect(typeof geminiClient.hasRequiredCookies).toBe("function");
    expect(typeof geminiClient.buildCookieMap).toBe("function");
  });

  it("has correct exported constants", () => {
    expect(geminiClient.REQUIRED_COOKIES).toBeDefined();
    expect(Array.isArray(geminiClient.REQUIRED_COOKIES)).toBe(true);
    expect(geminiClient.GEMINI_APP_URL).toBeDefined();
  });
});