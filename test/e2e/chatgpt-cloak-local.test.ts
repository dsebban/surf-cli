import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { isCloakBrowserAvailable, queryWithCloakBrowser } =
  require("../../native/chatgpt-cloak-bridge.cjs") as {
    isCloakBrowserAvailable: () => boolean;
    queryWithCloakBrowser: (opts: { query: string; model: string; timeout: number }) => Promise<{
      response: string;
      model: string;
      backend: string;
    }>;
  };

const RUN_LOCAL = process.env.SURF_E2E_CLOAK_CHATGPT_LOCAL === "1";

describe("e2e: chatgpt cloak local", () => {
  it("answers a trivial prompt in instant mode", { timeout: 45_000 }, async () => {
    if (!RUN_LOCAL) {
      return;
    }

    expect(isCloakBrowserAvailable()).toBe(true);

    const result = await queryWithCloakBrowser({
      query: "Reply with only the number: 2+2",
      model: "instant",
      timeout: 30,
    });

    expect(result.backend).toBe("cloak");
    expect((result.model || "").toLowerCase()).toMatch(/gpt-5\.3|instant/);
    expect(result.response).toMatch(/\b4\b/);
  });
});
