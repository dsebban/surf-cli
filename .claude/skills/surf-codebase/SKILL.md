---
name: surf-codebase
description: Navigate and modify the headless-only surf-cli codebase for ChatGPT/Gemini terminal AI workflows.
---

# surf-cli Codebase

## Architecture

```text
native/cli.cjs → provider bridge → headless worker → provider website
                 ├─ ChatGPT: CloakBrowser
                 └─ Gemini: Bun WebView
```

## Core files

**native/cli.cjs** - CLI parser, help text, session wiring, direct provider routing.

**native/chatgpt-cloak-bridge.cjs** - Spawns ChatGPT Cloak workers and manages JSON-line protocol.

**native/chatgpt-cloak-worker.mjs** - ChatGPT prompt/file/image flow in CloakBrowser.

**native/chatgpt-cloak-chats-worker.mjs** - ChatGPT conversation list/search/view/export/reply/manage flow.

**native/gemini-bun-bridge.cjs** - Spawns Gemini Bun worker and handles worker protocol.

**native/gemini-bun-worker.ts** - Gemini prompt/file/video/image/edit flow in Bun WebView.

**native/headless-command-runner.cjs** - Shared CLI subprocess runner for `surf do` and MCP tools.

**native/do-parser.cjs / native/do-executor.cjs** - Headless AI workflow parsing/execution.

**native/mcp-server.cjs** - Stdio MCP server exposing supported headless AI tools.

**native/session-store.cjs / native/session-reconciler.cjs** - AI session logs and reconciliation.

## Add a CLI option

1. Read the relevant provider bridge/worker first.
2. Add help text in `native/cli.cjs`.
3. Thread parsed args into the bridge request.
4. Add focused unit tests for parser/bridge behavior.
5. Run `npm test`, `npm run check`, and `bash native/tests/cli-tests.sh`.

## Add a workflow/MCP-supported option

1. Update `native/headless-command-runner.cjs` arg building if the option name needs normalization.
2. Update `native/mcp-server.cjs` schema if MCP should expose it.
3. Add/adjust unit tests.

## Debug

- CLI JSON: pass `--json` where supported.
- Session logs: `surf session <id>`.
- Recent sessions: `surf session --all`.
- Reconcile: `surf session --reconcile --network`.

## Test

```bash
npm test
npm run check
bash native/tests/cli-tests.sh
```
