import { describe, expect, it } from "vitest";

// @ts-expect-error - CommonJS module without type definitions
import * as parser from "../../native/do-parser.cjs";

describe("parseDoCommands", () => {
  it("parses single command", () => {
    const input = 'chatgpt "hello"';
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(1);
    expect(steps[0].cmd).toBe("chatgpt");
    expect(steps[0].args).toEqual({ query: "hello" });
  });

  it("parses pipe-separated commands", () => {
    const input = 'chatgpt "Draft release notes" | gemini "Make them concise"';
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(2);
    expect(steps[0].cmd).toBe("chatgpt");
    expect(steps[0].args.query).toBe("Draft release notes");
    expect(steps[1].cmd).toBe("gemini");
    expect(steps[1].args.query).toBe("Make them concise");
  });

  it("parses newline-separated commands", () => {
    const input = 'chatgpt "hello"\ngemini "world"';
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(2);
    expect(steps[0].cmd).toBe("chatgpt");
    expect(steps[0].args.query).toBe("hello");
    expect(steps[1].cmd).toBe("gemini");
    expect(steps[1].args.query).toBe("world");
  });

  it("ignores blank lines", () => {
    const input = 'chatgpt "hello"\n\n\ngemini "world"';
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(2);
  });

  it("ignores comment lines", () => {
    const input = '# comment\nchatgpt "hello"\n# another comment\ngemini "world"';
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(2);
    expect(steps[0].cmd).toBe("chatgpt");
    expect(steps[1].cmd).toBe("gemini");
  });

  it("handles quoted strings with spaces", () => {
    const input = 'chatgpt "hello world"';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.query).toBe("hello world");
  });

  it("handles single-quoted strings", () => {
    const input = "chatgpt 'hello world'";
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.query).toBe("hello world");
  });

  it("parses options with values", () => {
    const input = 'chatgpt "hello" --model pro --profile user@example.com';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.query).toBe("hello");
    expect(steps[0].args.model).toBe("pro");
    expect(steps[0].args.profile).toBe("user@example.com");
  });

  it("parses numeric option values", () => {
    const input = 'gemini "hello" --timeout 500';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.timeout).toBe(500);
  });

  it("parses boolean option values", () => {
    const input = 'chatgpt.chats --all true';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.all).toBe(true);
  });

  it("parses boolean false option values", () => {
    const input = 'chatgpt.chats --all false';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.all).toBe(false);
  });

  it("parses chatgpt.chats conversation id", () => {
    const input = "chatgpt.chats abc123 --limit 5";
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.conversationId).toBe("abc123");
    expect(steps[0].args.limit).toBe(5);
  });

  it("parses chatgpt.reply with options after prompt", () => {
    const input = 'chatgpt.reply abc123 "hello" --model pro';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args).toEqual({ conversationId: "abc123", prompt: "hello", model: "pro" });
  });

  it("parses prompt-file only ChatGPT commands", () => {
    const input = "chatgpt --prompt-file prompt.md --model pro";
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args).toEqual({ "prompt-file": "prompt.md", model: "pro" });
  });

  it("parses Gemini image options", () => {
    const input = 'gemini "robot" --generate-image /tmp/out.png --aspect-ratio 16:9';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args).toEqual({
      query: "robot",
      "generate-image": "/tmp/out.png",
      "aspect-ratio": "16:9",
    });
  });

  it("keeps unknown commands parseable so executor can reject them", () => {
    const input = "screenshot --output /tmp/out.png";
    const steps = parser.parseDoCommands(input);
    expect(steps[0]).toEqual({ cmd: "screenshot", args: { output: "/tmp/out.png" } });
  });

  it("coerces decimal option values", () => {
    const input = 'gemini "hello" --temperature 0.5';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.temperature).toBe(0.5);
  });

  it("parses complex workflow", () => {
    const input = `
# AI workflow
chatgpt "Draft release notes" --profile user@example.com --model pro
gemini "Make them concise" --profile user@example.com
chatgpt.chats --limit 1 --profile user@example.com
chatgpt.reply abc123 "Thanks" --profile user@example.com
`;
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(4);
    expect(steps[0].cmd).toBe("chatgpt");
    expect(steps[0].args.model).toBe("pro");
    expect(steps[1].cmd).toBe("gemini");
    expect(steps[2].cmd).toBe("chatgpt.chats");
    expect(steps[2].args.limit).toBe(1);
    expect(steps[3].cmd).toBe("chatgpt.reply");
    expect(steps[3].args.conversationId).toBe("abc123");
    expect(steps[3].args.prompt).toBe("Thanks");
  });

  it("handles prompts with special characters", () => {
    const input = 'chatgpt "https://example.com/path?query=value&foo=bar"';
    const steps = parser.parseDoCommands(input);
    expect(steps[0].args.query).toBe("https://example.com/path?query=value&foo=bar");
  });

  it("does not split quoted pipe characters inside prompts", () => {
    const input = 'chatgpt "compare A | B" | gemini "summarize"';
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(2);
    expect(steps[0].args.query).toBe("compare A | B");
  });

  it("treats quoted pipe-only input as a single command", () => {
    const input = 'chatgpt "markdown | table"';
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(1);
    expect(steps[0].args.query).toBe("markdown | table");
  });

  it("exposes quote-aware split helper", () => {
    expect(parser.splitCommands('a "b|c" | d', "|").map((part: string) => part.trim())).toEqual([
      'a "b|c"',
      "d",
    ]);
  });

  it("handles literal backslash-n as newline separator", () => {
    // Simulates bash single-quoted string: 'chatgpt "hello"\ngemini "world"'
    const input = 'chatgpt "hello"\\ngemini "world"\\nchatgpt.chats --limit 1';
    const steps = parser.parseDoCommands(input);
    expect(steps).toHaveLength(3);
    expect(steps[0].cmd).toBe("chatgpt");
    expect(steps[1].cmd).toBe("gemini");
    expect(steps[2].cmd).toBe("chatgpt.chats");
  });
});

describe("tokenize", () => {
  it("splits on spaces", () => {
    expect(parser.tokenize("chatgpt hello")).toEqual(["chatgpt", "hello"]);
  });

  it("respects double quotes", () => {
    expect(parser.tokenize('chatgpt "hello world"')).toEqual(["chatgpt", "hello world"]);
  });

  it("respects single quotes", () => {
    expect(parser.tokenize("gemini 'hello world'")).toEqual(["gemini", "hello world"]);
  });

  it("handles mixed quotes", () => {
    expect(parser.tokenize("chatgpt \"hello\" --profile 'user@example.com'")).toEqual([
      "chatgpt",
      "hello",
      "--profile",
      "user@example.com",
    ]);
  });

  it("handles empty input", () => {
    expect(parser.tokenize("")).toEqual([]);
  });

  it("handles multiple spaces", () => {
    expect(parser.tokenize("chatgpt    hello")).toEqual(["chatgpt", "hello"]);
  });

  it("handles tabs", () => {
    expect(parser.tokenize("chatgpt\thello")).toEqual(["chatgpt", "hello"]);
  });
});

describe("parseCommandLine", () => {
  it("returns null for empty input", () => {
    expect(parser.parseCommandLine("")).toBe(null);
  });

  it("parses command without args", () => {
    const result = parser.parseCommandLine("chatgpt.chats");
    expect(result).toEqual({ cmd: "chatgpt.chats", args: {} });
  });

  it("parses chatgpt.reply positional args", () => {
    const result = parser.parseCommandLine('chatgpt.reply abc123 "hello"');
    expect(result).toEqual({ cmd: "chatgpt.reply", args: { conversationId: "abc123", prompt: "hello" } });
  });
});
