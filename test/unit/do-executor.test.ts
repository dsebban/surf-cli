import { describe, expect, it } from "vitest";

// @ts-expect-error - CommonJS module without type definitions
import * as executor from "../../native/do-executor.cjs";

describe("shouldAutoWait", () => {
  it("returns false after browser auto-waits were removed", () => {
    expect(executor.shouldAutoWait("chatgpt")).toBe(false);
    expect(executor.shouldAutoWait("gemini")).toBe(false);
    expect(executor.shouldAutoWait("click")).toBe(false);
  });
});

describe("getAutoWaitCommand", () => {
  it("returns null because headless AI commands do not need browser auto-waits", () => {
    expect(executor.getAutoWaitCommand("chatgpt")).toBe(null);
    expect(executor.getAutoWaitCommand("gemini")).toBe(null);
    expect(executor.getAutoWaitCommand("click")).toBe(null);
  });
});

describe("substituteVars", () => {
  it("substitutes variables in strings", () => {
    const args = { url: "https://%{domain}/path" };
    const vars = { domain: "example.com" };
    const result = executor.substituteVars(args, vars);
    expect(result.url).toBe("https://example.com/path");
  });

  it("keeps undefined variables as-is", () => {
    const args = { url: "https://%{domain}/path" };
    const vars = {};
    const result = executor.substituteVars(args, vars);
    expect(result.url).toBe("https://%{domain}/path");
  });

  it("handles multiple variables", () => {
    const args = { text: "%{greeting} %{name}!" };
    const vars = { greeting: "Hello", name: "World" };
    const result = executor.substituteVars(args, vars);
    expect(result.text).toBe("Hello World!");
  });

  it("preserves non-string values", () => {
    const args = { x: 100, enabled: true, text: "%{val}" };
    const vars = { val: "test" };
    const result = executor.substituteVars(args, vars);
    expect(result.x).toBe(100);
    expect(result.enabled).toBe(true);
    expect(result.text).toBe("test");
  });

  it("handles null and undefined args", () => {
    expect(executor.substituteVars(null, {})).toBe(null);
    expect(executor.substituteVars(undefined, {})).toBe(undefined);
  });
});

describe("executeSingleStep", () => {
  it("rejects commands outside the headless workflow runtime", async () => {
    const result = await executor.executeSingleStep(
      { cmd: "screenshot", args: {} },
      {},
      {},
      { quiet: true },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not supported by the headless-only workflow runtime");
  });
});

describe("AUTO_WAIT_COMMANDS", () => {
  it("is empty in headless-only mode", () => {
    expect(executor.AUTO_WAIT_COMMANDS).toEqual([]);
  });
});

describe("AUTO_WAIT_MAP", () => {
  it("is empty in headless-only mode", () => {
    expect(executor.AUTO_WAIT_MAP).toEqual({});
  });
});
