import { describe, expect, it } from "vitest";

const {
  TOOL_SCHEMAS,
  formatResultPayload,
  normalizeToolArgs,
  runMcpHeadlessTool,
  validateMcpArgs,
} = require("../../native/mcp-server.cjs");

describe("mcp-server headless tool surface", () => {
  it("registers only supported headless tools", () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([
      "chatgpt",
      "chatgpt.chats",
      "chatgpt.reply",
      "gemini",
    ]);
  });

  it("normalizes prompt args for prompt-based tools", () => {
    expect(normalizeToolArgs("chatgpt", { prompt: "hello", model: "pro" })).toEqual({
      query: "hello",
      model: "pro",
    });
    expect(normalizeToolArgs("gemini", { prompt: "hello" })).toEqual({ query: "hello" });
  });

  it("formats provider response text as MCP text content", () => {
    expect(formatResultPayload({ result: { response: "ok" } })).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("preserves provider metadata alongside response text", () => {
    const formatted = formatResultPayload({ result: { response: "ok", model: "gpt", conversationId: "abc" } });
    expect(formatted.content[0].text).toBe("ok");
    expect(formatted.content[1].text).toContain('"conversationId"');
  });

  it("formats arbitrary objects as JSON MCP text content", () => {
    const formatted = formatResultPayload({ result: { conversations: [{ id: "abc" }] } });
    expect(formatted.content[0].text).toContain('"conversations"');
  });

  it("formats raw string payloads as MCP text content", () => {
    expect(formatResultPayload("hello")).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("formats text property payloads as MCP text content", () => {
    expect(formatResultPayload({ result: { text: "hello" } })).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("formats empty payloads as JSON object text", () => {
    expect(formatResultPayload(undefined)).toEqual({ content: [{ type: "text", text: "{}" }] });
  });

  it("leaves conversation args unchanged when no prompt normalization is needed", () => {
    expect(normalizeToolArgs("chatgpt.chats", { conversationId: "abc", limit: 1 })).toEqual({
      conversationId: "abc",
      limit: 1,
    });
  });

  it("accepts prompt-file-only ChatGPT MCP args", () => {
    expect(() => validateMcpArgs("chatgpt", { promptFile: "prompt.md" })).not.toThrow();
  });

  it("accepts prompt-file-only ChatGPT reply MCP args", () => {
    expect(() => validateMcpArgs("chatgpt.reply", { conversationId: "abc", promptFile: "reply.md" })).not.toThrow();
  });

  it("rejects ChatGPT MCP args without prompt input", () => {
    expect(() => validateMcpArgs("chatgpt", { model: "pro" })).toThrow("requires prompt or promptFile");
  });

  it("does not mutate MCP args during normalization", () => {
    const args = { prompt: "hello", profile: "user@example.com" };
    normalizeToolArgs("chatgpt", args);
    expect(args).toEqual({ prompt: "hello", profile: "user@example.com" });
  });

  it("runs tools through the injected headless runner", async () => {
    const calls: any[] = [];
    const response = await runMcpHeadlessTool(
      "chatgpt",
      { prompt: "hello", profile: "user@example.com" },
      async (...args: any[]) => {
        calls.push(args);
        return { result: { response: "done" } };
      },
    );

    expect(calls[0][0]).toBe("chatgpt");
    expect(calls[0][1]).toEqual({ query: "hello", profile: "user@example.com" });
    expect(calls[0][2]).toEqual({ json: true });
    expect(response).toEqual({ content: [{ type: "text", text: "done" }] });
  });

  it("passes Gemini args through the injected headless runner", async () => {
    const calls: any[] = [];
    const response = await runMcpHeadlessTool(
      "gemini",
      { prompt: "hello", aspectRatio: "16:9" },
      async (...args: any[]) => {
        calls.push(args);
        return { result: { response: "gemini done" } };
      },
    );

    expect(calls[0][0]).toBe("gemini");
    expect(calls[0][1]).toEqual({ query: "hello", aspectRatio: "16:9" });
    expect(response.content[0].text).toBe("gemini done");
  });

  it("passes reply args through the injected headless runner", async () => {
    const calls: any[] = [];
    await runMcpHeadlessTool("chatgpt.reply", { conversationId: "abc", prompt: "hello" }, async (...args: any[]) => {
      calls.push(args);
      return { result: { response: "ok" } };
    });

    expect(calls[0][1]).toEqual({ conversationId: "abc", prompt: "hello" });
  });

  it("returns MCP errors when the runner fails", async () => {
    const response = await runMcpHeadlessTool("gemini", { prompt: "hello" }, async () => {
      throw new Error("boom");
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("boom");
  });
});
