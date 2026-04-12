import { describe, expect, it } from "vitest";

const runner = require("../../native/headless-command-runner.cjs");

describe("headless-command-runner buildCliArgs", () => {
  it("builds ChatGPT prompt args with JSON output", () => {
    expect(
      runner.buildCliArgs("chatgpt", { query: "hello", model: "pro", profile: "user@example.com" }),
    ).toEqual(["chatgpt", "hello", "--model", "pro", "--profile", "user@example.com", "--json"]);
  });

  it("builds Gemini prompt args", () => {
    expect(runner.buildCliArgs("gemini", { prompt: "hello", file: "data.csv" })).toEqual([
      "gemini",
      "hello",
      "--file",
      "data.csv",
      "--json",
    ]);
  });

  it("builds ChatGPT conversation args", () => {
    expect(
      runner.buildCliArgs("chatgpt.chats", { conversationId: "abc", noCache: true, limit: 3 }),
    ).toEqual(["chatgpt.chats", "abc", "--no-cache", "--limit", "3", "--json"]);
  });

  it("builds ChatGPT reply args", () => {
    expect(
      runner.buildCliArgs("chatgpt.reply", { conversationId: "abc", prompt: "thanks" }),
    ).toEqual(["chatgpt.reply", "abc", "thanks", "--json"]);
  });

  it("accepts kebab conversation-id for reply args", () => {
    expect(
      runner.buildCliArgs("chatgpt.reply", { "conversation-id": "abc", query: "thanks" }),
    ).toEqual(["chatgpt.reply", "abc", "thanks", "--json"]);
  });

  it("accepts kebab conversation-id for chats args", () => {
    expect(runner.buildCliArgs("chatgpt.chats", { "conversation-id": "abc" })).toEqual([
      "chatgpt.chats",
      "abc",
      "--json",
    ]);
  });

  it("does not add JSON when disabled", () => {
    expect(runner.buildCliArgs("chatgpt", { query: "hello" }, { json: false })).toEqual([
      "chatgpt",
      "hello",
    ]);
  });

  it("does not duplicate existing JSON flag", () => {
    expect(runner.buildCliArgs("gemini", { query: "hello", json: true })).toEqual([
      "gemini",
      "hello",
      "--json",
    ]);
  });

  it("skips false null and undefined options", () => {
    expect(
      runner.buildCliArgs("chatgpt", {
        query: "hello",
        all: false,
        model: null,
        profile: undefined,
      }),
    ).toEqual(["chatgpt", "hello", "--json"]);
  });

  it("converts camelCase options to kebab flags", () => {
    expect(
      runner.buildCliArgs("chatgpt", {
        query: "hello",
        promptFile: "prompt.md",
        generateImage: "/tmp/out.png",
      }),
    ).toEqual([
      "chatgpt",
      "hello",
      "--prompt-file",
      "prompt.md",
      "--generate-image",
      "/tmp/out.png",
      "--json",
    ]);
  });

  it("consumes both prompt aliases without leaking duplicate flags", () => {
    expect(runner.buildCliArgs("chatgpt", { query: "query text", prompt: "prompt text" })).toEqual([
      "chatgpt",
      "query text",
      "--json",
    ]);
  });

  it("consumes both conversation-id aliases without leaking duplicate flags", () => {
    expect(
      runner.buildCliArgs("chatgpt.chats", {
        conversationId: "camel",
        "conversation-id": "kebab",
      }),
    ).toEqual(["chatgpt.chats", "camel", "--json"]);
  });

  it("converts underscore options to kebab flags", () => {
    expect(
      runner.buildCliArgs("gemini", {
        query: "hello",
        aspect_ratio: "16:9",
      }),
    ).toEqual(["gemini", "hello", "--aspect-ratio", "16:9", "--json"]);
  });

  it("serializes array options as comma-separated values", () => {
    expect(runner.buildCliArgs("chatgpt.chats", { deleteIds: ["a", "b"] })).toEqual([
      "chatgpt.chats",
      "--delete-ids",
      "a,b",
      "--json",
    ]);
  });

  it("supports prompt-less chats list", () => {
    expect(runner.buildCliArgs("chatgpt.chats", {})).toEqual(["chatgpt.chats", "--json"]);
  });

  it("supports prompt-less ChatGPT command shape for prompt-file only", () => {
    expect(runner.buildCliArgs("chatgpt", { promptFile: "prompt.md" })).toEqual([
      "chatgpt",
      "--prompt-file",
      "prompt.md",
      "--json",
    ]);
  });

  it("keeps numeric option values as strings in argv", () => {
    expect(runner.buildCliArgs("gemini", { query: "hello", timeout: 30 })).toEqual([
      "gemini",
      "hello",
      "--timeout",
      "30",
      "--json",
    ]);
  });

  it("derives runner timeout from request timeout seconds", () => {
    expect(runner.resolveRunnerTimeoutMs({ timeout: 30 }, {})).toBe(60000);
  });

  it("allows runner timeout override", () => {
    expect(runner.resolveRunnerTimeoutMs({ timeout: 30 }, { timeoutMs: 123 })).toBe(123);
  });

  it("allows disabling runner timeout", () => {
    expect(runner.resolveRunnerTimeoutMs({}, { timeoutMs: false })).toBe(0);
  });

  it("uses a default runner timeout when request timeout is absent", () => {
    expect(runner.resolveRunnerTimeoutMs({}, {})).toBe(runner.DEFAULT_RUNNER_TIMEOUT_MS);
  });

  it("exports the supported command set", () => {
    expect(Array.from(runner.SUPPORTED_HEADLESS_COMMANDS).sort()).toEqual([
      "chatgpt",
      "chatgpt.chats",
      "chatgpt.reply",
      "gemini",
    ]);
  });

  it("does not include removed provider commands in the supported command set", () => {
    expect(runner.SUPPORTED_HEADLESS_COMMANDS.has("aistudio")).toBe(false);
    expect(runner.SUPPORTED_HEADLESS_COMMANDS.has("perplexity")).toBe(false);
    expect(runner.SUPPORTED_HEADLESS_COMMANDS.has("grok")).toBe(false);
  });

  it("rejects removed browser commands", () => {
    expect(() => runner.buildCliArgs("screenshot", {})).toThrow("not supported");
  });
});
