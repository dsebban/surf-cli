#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { runSurfHeadlessCommand } = require("./headless-command-runner.cjs");

const TOOL_SCHEMAS = {
  chatgpt: {
    desc: "Send a prompt to ChatGPT via CloakBrowser headless",
    schema: {
      prompt: z.string().optional().describe("Prompt text"),
      model: z.string().optional().describe("Model shortcut or provider model name"),
      file: z.string().optional().describe("File path to attach"),
      promptFile: z.string().optional().describe("Read prompt text from this file path"),
      generateImage: z.string().optional().describe("Generate an image and save it to this path"),
      profile: z.string().optional().describe("macOS Chrome profile email for auth"),
      timeout: z.number().optional().describe("Inactivity timeout in seconds"),
    },
  },
  gemini: {
    desc: "Send a prompt to Gemini via Bun WebView headless",
    schema: {
      prompt: z.string().describe("Prompt text"),
      model: z.string().optional().describe("Gemini model name"),
      file: z.string().optional().describe("File path to attach"),
      generateImage: z.string().optional().describe("Generate an image and save it to this path"),
      editImage: z.string().optional().describe("Image path to edit"),
      output: z.string().optional().describe("Output path for image editing"),
      youtube: z.string().optional().describe("YouTube URL to analyze"),
      aspectRatio: z.string().optional().describe("Image aspect ratio, e.g. 1:1 or 16:9"),
      profile: z.string().optional().describe("macOS Chrome profile email for auth"),
      timeout: z.number().optional().describe("Request timeout in seconds"),
    },
  },
  "chatgpt.chats": {
    desc: "List, search, view, export, rename, delete, and download ChatGPT conversations",
    schema: {
      conversationId: z.string().optional().describe("Conversation ID to view or manage"),
      limit: z.number().optional().describe("List count or message limit"),
      all: z.boolean().optional().describe("Fetch all conversations"),
      search: z.string().optional().describe("Search query"),
      export: z.string().optional().describe("Export path"),
      format: z.enum(["markdown", "md", "json"]).optional().describe("Export format"),
      rename: z.string().optional().describe("New title"),
      delete: z.boolean().optional().describe("Delete conversation"),
      deleteIds: z.string().optional().describe("Comma-separated conversation IDs to delete"),
      downloadFile: z.string().optional().describe("File ID to download"),
      output: z.string().optional().describe("Output path for downloaded file"),
      noCache: z.boolean().optional().describe("Bypass local chats cache"),
      profile: z.string().optional().describe("macOS Chrome profile email for auth"),
      timeout: z.number().optional().describe("Timeout in seconds"),
    },
  },
  "chatgpt.reply": {
    desc: "Reply inside an existing ChatGPT conversation",
    schema: {
      conversationId: z.string().describe("Conversation ID"),
      prompt: z.string().optional().describe("Reply prompt"),
      model: z.string().optional().describe("Model shortcut or provider model name"),
      promptFile: z.string().optional().describe("Read reply prompt from this file path"),
      profile: z.string().optional().describe("macOS Chrome profile email for auth"),
      timeout: z.number().optional().describe("Inactivity timeout in seconds"),
    },
  },
};

function normalizeToolArgs(tool, args = {}) {
  const normalized = { ...args };
  if ((tool === "chatgpt" || tool === "gemini") && normalized.prompt !== undefined) {
    normalized.query = normalized.prompt;
    delete normalized.prompt;
  }
  return normalized;
}

function hasPromptInput(args) {
  return Boolean(args.query || args.prompt || args.promptFile || args["prompt-file"]);
}

function validateMcpArgs(tool, args = {}) {
  if ((tool === "chatgpt" || tool === "chatgpt.reply") && !hasPromptInput(args)) {
    throw new Error(`${tool} requires prompt or promptFile`);
  }
}

function formatResultPayload(value) {
  const result = value && value.result !== undefined ? value.result : value;
  if (result && typeof result === "object" && typeof result.response === "string") {
    const metadata = { ...result };
    delete metadata.response;
    if (Object.keys(metadata).length > 0) {
      return {
        content: [
          { type: "text", text: result.response },
          { type: "text", text: JSON.stringify(metadata, null, 2) },
        ],
      };
    }
    return { content: [{ type: "text", text: result.response }] };
  }
  if (result && typeof result === "object" && typeof result.text === "string") {
    const metadata = { ...result };
    delete metadata.text;
    if (Object.keys(metadata).length > 0) {
      return {
        content: [
          { type: "text", text: result.text },
          { type: "text", text: JSON.stringify(metadata, null, 2) },
        ],
      };
    }
    return { content: [{ type: "text", text: result.text }] };
  }
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result ?? {}, null, 2) }] };
}

async function runMcpHeadlessTool(name, args, runner = runSurfHeadlessCommand) {
  try {
    const normalizedArgs = normalizeToolArgs(name, args);
    validateMcpArgs(name, normalizedArgs);
    const value = await runner(name, normalizedArgs, { json: true });
    return formatResultPayload(value);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

class SurfMcpServer {
  constructor({ runner = runSurfHeadlessCommand } = {}) {
    this.runner = runner;
    this.server = new McpServer({
      name: "surf",
      version: "1.0.0",
    });
    this.registerTools();
  }

  registerTools() {
    for (const [name, def] of Object.entries(TOOL_SCHEMAS)) {
      const schemaObj = {};
      for (const [key, val] of Object.entries(def.schema)) {
        schemaObj[key] = val;
      }

      this.server.tool(
        name,
        def.desc,
        schemaObj,
        async (args) => runMcpHeadlessTool(name, args, this.runner),
      );
    }
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("surf MCP server started");
  }
}

async function main() {
  const server = new SurfMcpServer();
  await server.start();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("MCP Server error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  SurfMcpServer,
  PiChromeMcpServer: SurfMcpServer,
  TOOL_SCHEMAS,
  formatResultPayload,
  normalizeToolArgs,
  runMcpHeadlessTool,
  validateMcpArgs,
};
