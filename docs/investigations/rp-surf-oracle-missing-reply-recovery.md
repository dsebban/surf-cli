# Investigation: rp-surf-oracle missing local reply despite ChatGPT Pro UI response

## Summary
The ChatGPT Pro run did produce a valid assistant response remotely, and that response is recoverable via the chats retrieval path. The local `rp-surf-oracle` / `surf chatgpt` run failed to return it because the cloak query path uses a 120s default timeout while CLI help advertises 2700s, and this specific GPT-5.4 Pro conversation ran for roughly 46 minutes. Reconcile later marked the session completed, but it only stores recovery metadata, not the final assistant body.

## Symptoms
- Prompt insertion succeeded for a ~446KB RepoPrompt export.
- Backend prompt persistence validation succeeded.
- Session log reached `[6/6] Waiting for response` and thinking trace streamed.
- No final local `success` payload or assistant body was returned.
- ChatGPT UI showed a completed response.
- `surf session --reconcile --network` later recovered the session.

## Investigation Log

### Query timeout defaults
**Hypothesis:** the local worker was timing out before a long GPT-5.4 Pro reply completed.

**Findings:** CLI help says ChatGPT timeout default is 2700s, but the cloak query implementation defaults to 120s in both bridge and worker.

**Evidence:**
- `native/cli.cjs:390` advertises `Timeout in seconds (default: 2700 = 45min)`.
- `native/chatgpt-cloak-bridge.cjs:49-50` starts the worker timer from `timeout = 120`.
- `native/chatgpt-cloak-bridge.cjs:211` destructures `timeout = 120` in `queryWithCloakBrowser()`.
- `native/chatgpt-cloak-worker.mjs:1025-1026` enters phase 6 response wait with `const deadline = Date.now() + timeout * 1000`.

**Conclusion:** confirmed. This run used the cloak path and the real timeout default on that path is 120s, not 2700s.

### Conversation duration vs timeout
**Hypothesis:** this particular conversation outlasted the 120s timeout.

**Findings:** the recovered conversation markdown shows the initial user turn at `07:53` and the final assistant turn at `08:39`.

**Evidence:**
- Export command used:
  - `SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats 69d730dc-7f68-8389-9001-9993d8d8020d --export /tmp/chatgpt-69d730dc.md --format markdown --profile dsebban883@gmail.com`
- Exported file: `/tmp/chatgpt-69d730dc.md`
- Header/body markers in export:
  - first user turn: `### You · 07:53`
  - final assistant turn: `### ChatGPT · 08:39`

**Conclusion:** confirmed. The remote run lasted far beyond 120s, so a local 120s timeout is sufficient to explain why the worker did not deliver the final reply.

### Session recovery behavior
**Hypothesis:** reconcile marks completion but does not hydrate the final assistant text.

**Findings:** reconcile stores recovery metadata only: `conversationId`, `nodeId`, `ok`, `reconciled`. No assistant body is persisted.

**Evidence:**
- `native/session-reconciler.cjs:237-252` updates session to `completed` with:
  - `result.ok = true`
  - `result.reconciled = true`
  - `result.conversationId`
  - `result.nodeId`
- `native/session-store.cjs:108-118` `Session.finish()` only persists model/image/`responsePreview`; there is no field for full assistant text.

**Conclusion:** confirmed. Reconcile can close the session state, but it cannot recover the missing answer into session output today.

### Direct recovery path
**Hypothesis:** the final answer can be recovered outside the query path using the existing chats API worker.

**Findings:** `chatgpt.chats <conversationId>` uses the dedicated chats worker, which calls the backend conversation GET endpoint and can export markdown.

**Evidence:**
- `native/chatgpt-cloak-chats-worker.mjs:625-630` returns `{ action: 'get', conversationId, conversation: data }`.
- `native/chatgpt-chats-formatter.cjs:228-245` renders the full conversation into markdown.
- Actual recovery succeeded with the command above and produced `/tmp/chatgpt-69d730dc.md`.

**Conclusion:** confirmed. The reply is recoverable today using `surf chatgpt.chats <conversationId>`.

## Root Cause
Primary cause for this run: timeout mismatch.

The user-facing CLI help says ChatGPT queries default to 2700 seconds (`native/cli.cjs:390`), but the cloak query path actually defaults to 120 seconds in both `queryWithCloakBrowser()` and `runCloakWorker()` (`native/chatgpt-cloak-bridge.cjs:49-50`, `native/chatgpt-cloak-bridge.cjs:211`). This run used GPT-5.4 Pro and the recovered conversation spans roughly 46 minutes (`/tmp/chatgpt-69d730dc.md`: `### You · 07:53` to `### ChatGPT · 08:39`), so the local worker would have been killed long before the remote reply finished.

Secondary issue: even after recovery, the session system does not hydrate the full assistant text. `reconcileSessions()` only marks the session completed with metadata (`native/session-reconciler.cjs:237-252`), and `Session.finish()` only persists a preview (`native/session-store.cjs:108-118`).

## Recovered Response
The full recovered conversation is saved at:
- `/tmp/chatgpt-69d730dc.md`

The final assistant turn begins:
- `Implemented a targeted stabilization pass for the CloakBrowser ChatGPT path...`

## Recommendations
1. Align the ChatGPT cloak query default timeout with CLI help and intended Pro behavior.
   - Files: `native/chatgpt-cloak-bridge.cjs`, possibly worker call sites / argument normalization in `native/cli.cjs`.
2. Add a recovery path that can hydrate assistant text into recovered sessions.
   - Files: `native/session-reconciler.cjs`, `native/session-store.cjs`, possibly `native/cli.cjs` session display.
3. Add a regression test for “remote reply exists after query worker death/timeout”.
   - Files: `test/unit/chatgpt-cloak-bridge.test.ts`, `test/unit/session-reconciler.test.ts`.

## Preventive Measures
- Keep help/defaults in sync with actual query path behavior.
- For long-running ChatGPT Pro runs, either pass explicit `--timeout 2700` or raise the cloak default.
- Persist recoverable response text or export path when network reconcile succeeds.
