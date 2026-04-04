import { describe, expect, it } from "vitest";

const formatter = require("../../native/chatgpt-chats-formatter.cjs");

const conversation = {
  title: "Auth system design",
  create_time: 1711800120.123,
  current_node: "m5",
  mapping: {
    root: { id: "root", parent: null, children: ["m1"] },
    m1: {
      id: "m1",
      parent: "root",
      children: ["m2", "m3"],
      message: {
        author: { role: "user" },
        content: { parts: ["Design auth"] },
        create_time: 1711800120.3,
        metadata: {},
      },
    },
    m2: {
      id: "m2",
      parent: "m1",
      children: [],
      message: {
        author: { role: "assistant" },
        content: { parts: ["Branch A"] },
        create_time: 1711800180.5,
        metadata: { model_slug: "gpt-5.3" },
      },
    },
    m3: {
      id: "m3",
      parent: "m1",
      children: ["m4", "m-hidden", "m-system"],
      message: {
        author: { role: "assistant" },
        content: { parts: ["Branch B"] },
        create_time: 1711800200,
        metadata: { model_slug: "gpt-5.4-thinking" },
      },
    },
    m4: {
      id: "m4",
      parent: "m3",
      children: ["m5"],
      message: {
        author: { role: "user" },
        content: { parts: ["Go deeper"] },
        create_time: 1711800300,
        metadata: {},
      },
    },
    m5: {
      id: "m5",
      parent: "m4",
      children: [],
      message: {
        author: { role: "assistant" },
        content: { parts: ["Detailed plan"] },
        create_time: 1711800400,
        metadata: { model_slug: "gpt-5.4-thinking" },
      },
    },
    "m-hidden": {
      id: "m-hidden",
      parent: "m3",
      children: [],
      message: {
        author: { role: "assistant" },
        content: { parts: ["hidden"] },
        create_time: 1711800350,
        metadata: { is_hidden: true },
      },
    },
    "m-system": {
      id: "m-system",
      parent: "m3",
      children: [],
      message: {
        author: { role: "system" },
        content: { parts: ["sys"] },
        create_time: 1711800360,
        metadata: {},
      },
    },
  },
};

describe("chatgpt-chats-formatter", () => {
  it("normalizes conversation list items and sorts by updated time", () => {
    const items = formatter.normalizeConversationItems({
      items: [
        { id: "b", title: "Older", create_time: "2025-03-30T11:05:00.000Z" },
        {
          id: "a",
          title: "Newer",
          update_time: "2025-03-30T14:22:00.000Z",
          create_time: "2025-03-30T10:00:00.000Z",
        },
      ],
    });

    expect(items.map((item: any) => item.id)).toEqual(["a", "b"]);
    expect(items[1].update_time).toBe("2025-03-30T11:05:00.000Z");
  });

  it("walks active path (root → current_node) by default, excluding abandoned branches", () => {
    const messages = formatter.walkConversationMessages(conversation);
    // current_node = m5, so active path is: root → m1 → m3 → m4 → m5
    // m2 (Branch A) is on an abandoned branch and should NOT appear
    expect(messages.map((msg: any) => msg.id)).toEqual(["m1", "m3", "m4", "m5"]);
    expect(messages.map((msg: any) => msg.text)).toEqual([
      "Design auth",
      "Branch B",
      "Go deeper",
      "Detailed plan",
    ]);
  });

  it("walks all branches in full mode (DFS)", () => {
    const messages = formatter.walkConversationMessages(conversation, { mode: "full" });
    expect(messages.map((msg: any) => msg.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(messages.map((msg: any) => msg.text)).toEqual([
      "Design auth",
      "Branch A",
      "Branch B",
      "Go deeper",
      "Detailed plan",
    ]);
  });

  it("falls back to full DFS when current_node is missing", () => {
    const noCurrentNode = { ...conversation, current_node: null };
    const messages = formatter.walkConversationMessages(noCurrentNode);
    // Without current_node, falls back to full DFS
    expect(messages.map((msg: any) => msg.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("summarizes conversation using active path and keeps last assistant model", () => {
    const summary = formatter.summarizeConversation(conversation);
    // Active path: m1, m3, m4, m5 (m2 excluded)
    expect(summary.totalMessages).toBe(4);
    expect(summary.model).toBe("gpt-5.4-thinking");
    expect(summary.title).toBe("Auth system design");
  });

  it("applies message limit from the tail of visible messages", () => {
    const summary = formatter.summarizeConversation(conversation, { messageLimit: 2 });
    expect(summary.messages.map((msg: any) => msg.id)).toEqual(["m4", "m5"]);
  });

  it("formats conversation markdown using active path (no abandoned branches)", () => {
    const markdown = formatter.formatConversationMarkdown({ conversation, messageLimit: 3 });
    expect(markdown).toContain("# Auth system design");
    expect(markdown).toContain("### ChatGPT ·");
    expect(markdown).toContain("Detailed plan");
    expect(markdown).not.toContain("hidden");
    expect(markdown).not.toContain("\nsys\n");
    // Branch A (m2) is on abandoned branch → excluded from active path
    expect(markdown).not.toContain("Branch A");
    expect(markdown).toContain("Branch B");
  });

  it("formats conversation list table", () => {
    const output = formatter.formatConversationList({
      items: [
        {
          id: "abc1234567890",
          title: "Auth system design",
          update_time: "2025-03-30T14:22:00.000Z",
        },
      ],
      total: 1,
    });

    expect(output).toContain("ChatGPT Conversations (1 of 1)");
    expect(output).toContain("Auth system design");
    expect(output).toContain("abc1234567890");
  });

  it("returns empty-state list output", () => {
    expect(formatter.formatConversationList({ items: [], total: 0 })).toBe(
      "No conversations found.",
    );
  });

  it("infers export format from explicit flag or extension", () => {
    expect(formatter.inferExportFormat({ exportPath: "/tmp/chat.md" })).toBe("markdown");
    expect(formatter.inferExportFormat({ exportPath: "/tmp/chat.json" })).toBe("json");
    expect(formatter.inferExportFormat({ explicitFormat: "md" })).toBe("markdown");
  });
});
