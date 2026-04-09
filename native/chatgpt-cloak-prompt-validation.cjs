"use strict";

const { walkConversationMessages } = require("./chatgpt-chats-formatter.cjs");

function normalizePromptForComparison(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/, "");
}

function hasActivePath(conversation) {
  const mapping = conversation && conversation.mapping ? conversation.mapping : null;
  const currentNode = conversation && conversation.current_node ? conversation.current_node : null;
  return !!(mapping && typeof mapping === "object" && currentNode && mapping[currentNode]);
}

function getActiveUserNodeId(conversation) {
  if (!hasActivePath(conversation)) return null;
  const messages = walkConversationMessages(conversation, { mode: "active" });
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === "user" && messages[i].id) return messages[i].id;
  }
  return null;
}

function extractRawMessageText(message) {
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts : null;
  if (!parts) return typeof message?.content?.text === "string" ? message.content.text : "";
  return parts
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (part && typeof part.text === "string") return [part.text];
      return [];
    })
    .join("");
}

function isBigPasteAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return false;
  return attachment.is_big_paste === true
    || attachment?.metadata?.is_big_paste === true
    || attachment.name === "Pasted text.txt";
}

function extractLatestActiveUserMessage(conversation) {
  if (!hasActivePath(conversation)) return null;
  const mapping = conversation.mapping || {};
  const nodeId = getActiveUserNodeId(conversation);
  if (!nodeId || !mapping[nodeId] || !mapping[nodeId].message) return null;

  const message = mapping[nodeId].message;
  const attachments = Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : [];
  const text = normalizePromptForComparison(extractRawMessageText(message));

  return {
    nodeId,
    text,
    createTime: message.create_time ?? null,
    attachments,
    attachmentCount: attachments.length,
    attachmentNames: attachments.map((attachment) => attachment?.name).filter(Boolean),
    hasBigPasteAttachment: attachments.some(isBigPasteAttachment),
    fileMapOnly: text.trim() === "<file_map>",
  };
}

function evaluatePromptPersistence({ conversation, expectedPrompt, baselineUserNodeId = null }) {
  const expectedText = normalizePromptForComparison(expectedPrompt);

  if (!hasActivePath(conversation)) {
    return {
      ok: false,
      failureReason: "no_active_path",
      expectedChars: expectedText.length,
      actualChars: 0,
      exactMatch: false,
      latestUserNodeId: null,
      advancedPastBaseline: baselineUserNodeId ? false : null,
      fileMapOnly: false,
      hasBigPasteAttachment: false,
      attachmentCount: 0,
      attachmentNames: [],
      actualText: "",
    };
  }

  const latestUser = extractLatestActiveUserMessage(conversation);
  if (!latestUser) {
    return {
      ok: false,
      failureReason: "no_user_message",
      expectedChars: expectedText.length,
      actualChars: 0,
      exactMatch: false,
      latestUserNodeId: null,
      advancedPastBaseline: baselineUserNodeId ? false : null,
      fileMapOnly: false,
      hasBigPasteAttachment: false,
      attachmentCount: 0,
      attachmentNames: [],
      actualText: "",
    };
  }

  const actualText = latestUser.text;
  const exactMatch = actualText === expectedText;
  const advancedPastBaseline = baselineUserNodeId ? latestUser.nodeId !== baselineUserNodeId : null;

  let failureReason = null;
  if (baselineUserNodeId && latestUser.nodeId === baselineUserNodeId) failureReason = "latest_user_not_advanced";
  else if (latestUser.fileMapOnly) failureReason = "file_map_placeholder";
  else if (latestUser.hasBigPasteAttachment) failureReason = "big_paste_attachment";
  else if (!exactMatch) failureReason = "content_mismatch";

  return {
    ok: !failureReason,
    failureReason,
    expectedChars: expectedText.length,
    actualChars: actualText.length,
    exactMatch,
    latestUserNodeId: latestUser.nodeId,
    advancedPastBaseline,
    fileMapOnly: latestUser.fileMapOnly,
    hasBigPasteAttachment: latestUser.hasBigPasteAttachment,
    attachmentCount: latestUser.attachmentCount,
    attachmentNames: latestUser.attachmentNames,
    actualText,
  };
}

module.exports = {
  normalizePromptForComparison,
  extractLatestActiveUserMessage,
  evaluatePromptPersistence,
  __private: {
    hasActivePath,
    extractRawMessageText,
    isBigPasteAttachment,
  },
};
