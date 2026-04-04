import { describe, expect, it } from "vitest";

import {
  filterConversationSearchItems,
  mergeConversationSearchItems,
  normalizeConversationSearchItems,
} from "../../native/chatgpt-chats-search.mjs";

describe("chatgpt-chats-search", () => {
  it("normalizes backend search payloads", () => {
    const items = normalizeConversationSearchItems({
      results: [
        { conversation_id: "c2", title: "Older", update_time: "2026-04-02T19:00:00.000Z" },
        { id: "c1", title: "Newer", update_time: "2026-04-02T20:00:00.000Z" },
      ],
    });

    expect(items.map((item: any) => item.id)).toEqual(["c2", "c1"]);
    expect(items[0].conversation_id).toBe("c2");
  });

  it("filters local conversation list by title/snippet case-insensitively", () => {
    const matches = filterConversationSearchItems(
      {
        items: [
          { id: "c1", title: "Surf E2E Final 20260402T192754Z", snippet: null },
          { id: "c2", title: "Other", snippet: "contains FILE_READY" },
          { id: "c3", title: "Ignore me", snippet: null },
        ],
      },
      "surf e2e final 20260402t192754z",
    );

    expect(matches.map((item: any) => item.id)).toEqual(["c1"]);
  });

  it("dedupes backend and local fallback results while preserving freshest metadata", () => {
    const merged = mergeConversationSearchItems(
      [
        {
          id: "c1",
          title: "Surf E2E Final 20260402T192754Z",
          snippet: "FILE_READY",
          update_time: "2026-04-02T19:34:00.000Z",
        },
      ],
      [{ id: "c1", title: "FILE_READY", snippet: null, update_time: "2026-04-02T19:28:00.000Z" }],
      [{ id: "c2", title: "Another", update_time: "2026-04-02T19:20:00.000Z" }],
    );

    expect(merged.map((item: any) => item.id)).toEqual(["c1", "c2"]);
    expect(merged[0].title).toBe("Surf E2E Final 20260402T192754Z");
    expect(merged[0].snippet).toBe("FILE_READY");
  });
});
