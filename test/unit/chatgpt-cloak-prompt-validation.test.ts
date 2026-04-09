import { describe, expect, it } from "vitest";

const {
  normalizePromptForComparison,
  extractLatestActiveUserMessage,
  evaluatePromptPersistence,
} = require("../../native/chatgpt-cloak-prompt-validation.cjs");

function makeConversation(): { current_node: string | null; mapping: Record<string, any> } {
  return {
    current_node: "a2-active",
    mapping: {
      root: { id: "root", parent: null, children: ["u1"], message: null },
      u1: {
        id: "u1",
        parent: "root",
        children: ["a1"],
        message: {
          author: { role: "user" },
          create_time: 1,
          content: { content_type: "text", parts: ["first"] },
          metadata: {},
        },
      },
      a1: {
        id: "a1",
        parent: "u1",
        children: ["u2-old", "u2-active"],
        message: {
          author: { role: "assistant" },
          create_time: 2,
          content: { content_type: "text", parts: ["reply"] },
          metadata: {},
        },
      },
      "u2-old": {
        id: "u2-old",
        parent: "a1",
        children: ["a2-old"],
        message: {
          author: { role: "user" },
          create_time: 3,
          content: { content_type: "text", parts: ["old branch"] },
          metadata: {},
        },
      },
      "a2-old": {
        id: "a2-old",
        parent: "u2-old",
        children: [],
        message: {
          author: { role: "assistant" },
          create_time: 4,
          content: { content_type: "text", parts: ["old response"] },
          metadata: {},
        },
      },
      "u2-active": {
        id: "u2-active",
        parent: "a1",
        children: ["a2-active"],
        message: {
          author: { role: "user" },
          create_time: 5,
          content: { content_type: "text", parts: ["hello\nworld"] },
          metadata: {},
        },
      },
      "a2-active": {
        id: "a2-active",
        parent: "u2-active",
        children: [],
        message: {
          author: { role: "assistant" },
          create_time: 6,
          content: { content_type: "text", parts: ["active response"] },
          metadata: {},
        },
      },
    },
  };
}

describe("chatgpt-cloak-prompt-validation", () => {
  it("normalizes line endings and terminal newlines only", () => {
    expect(normalizePromptForComparison("a\r\nb\rc\n\n")).toBe("a\nb\nc");
  });

  it("extracts latest active-path user message and ignores abandoned branches", () => {
    const latest = extractLatestActiveUserMessage(makeConversation());
    expect(latest).toMatchObject({
      nodeId: "u2-active",
      text: "hello\nworld",
      fileMapOnly: false,
      hasBigPasteAttachment: false,
    });
  });

  it("accepts exact normalized match", () => {
    const result = evaluatePromptPersistence({
      conversation: makeConversation(),
      expectedPrompt: "hello\r\nworld",
    });

    expect(result).toMatchObject({
      ok: true,
      failureReason: null,
      exactMatch: true,
      actualChars: 11,
      expectedChars: 11,
      latestUserNodeId: "u2-active",
    });
  });

  it("rejects prefix mismatch instead of ratio success", () => {
    const result = evaluatePromptPersistence({
      conversation: makeConversation(),
      expectedPrompt: "hello\nworld and much more",
    });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "content_mismatch",
      exactMatch: false,
      latestUserNodeId: "u2-active",
    });
  });

  it("rejects <file_map> placeholder", () => {
    const conversation = makeConversation();
    conversation.mapping["u2-active"].message.content.parts = ["<file_map>"];
    conversation.mapping["u2-active"].message.metadata = {
      attachments: [{ name: "Pasted text.txt", is_big_paste: true }],
    };

    const result = evaluatePromptPersistence({
      conversation,
      expectedPrompt: "hello\nworld",
    });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "file_map_placeholder",
      fileMapOnly: true,
      hasBigPasteAttachment: true,
    });
  });

  it("rejects big-paste attachment materialization", () => {
    const conversation = makeConversation();
    conversation.mapping["u2-active"].message.metadata = {
      attachments: [{ name: "pasted.txt", metadata: { is_big_paste: true } }],
    };

    const result = evaluatePromptPersistence({
      conversation,
      expectedPrompt: "hello\nworld",
    });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "big_paste_attachment",
      hasBigPasteAttachment: true,
      attachmentCount: 1,
    });
  });

  it("requires active user node to advance for replies", () => {
    const result = evaluatePromptPersistence({
      conversation: makeConversation(),
      expectedPrompt: "hello\nworld",
      baselineUserNodeId: "u2-active",
    });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "latest_user_not_advanced",
      advancedPastBaseline: false,
      latestUserNodeId: "u2-active",
    });
  });

  it("fails when active path is unavailable", () => {
    const conversation = makeConversation();
    conversation.current_node = null;

    const result = evaluatePromptPersistence({
      conversation,
      expectedPrompt: "hello\nworld",
    });

    expect(result).toMatchObject({
      ok: false,
      failureReason: "no_active_path",
      latestUserNodeId: null,
    });
  });
});
