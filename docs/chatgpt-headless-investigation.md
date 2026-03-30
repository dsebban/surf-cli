# Investigation: ChatGPT Headless Response Extraction

## Summary
ChatGPT's new DOM renders response text via empty `<p data-start data-end>` placeholders with range-backed rendering. Actual text is NOT in the DOM. The conversation streams over **WebSocket** (`wss://ws.chatgpt.com`), not the fetch POST to `/backend-api/f/conversation` (which returns 403).

## Symptoms
- `.markdown p` elements exist but `innerText`/`textContent`/`innerHTML` are all empty
- `<p data-start="0" data-end="7">` has positional attributes but no text nodes
- Both `wv.evaluate()` and CDP `Runtime.evaluate` return empty strings
- No canvas, shadow DOM, or iframes detected
- Response IS generated (stop button appears then disappears)

## Investigation Log

### Phase 1 — DOM Inspection
**Hypothesis:** Text is in `.markdown` or `[data-message-content]` or `.prose`
**Findings:** All empty. Turn structure uses `<section data-testid="conversation-turn-N">` with `.sr-only` labels ("ChatGPT said:" / "You said:") for role detection. `data-message-author-role="assistant"` IS present deeply nested.
**Evidence:** `/tmp/debug-md3.ts` — `.markdown` found but empty text across 20 polls
**Conclusion:** Eliminated — DOM is not source of truth for text

### Phase 2 — Fetch Interception
**Hypothesis:** Text arrives via SSE stream on `/backend-api/conversation`
**Findings:** ChatGPT now uses `/backend-api/f/conversation` (with `/f/` prefix). POST to this endpoint returns **HTTP 403** with HTML error page. The fetch monkey-patch captures the request but gets no SSE data.
**Evidence:** `/tmp/debug-binary.ts` — status 403, content-type text/html
**Conclusion:** Eliminated — fetch endpoint is blocked/not the real transport

### Phase 3 — Transport Discovery
**Hypothesis:** Text streams via WebSocket
**Findings:** Transport hook detected `wss://ws.chatgpt.com/p8/ws/user/...` WebSocket connection. Earlier successful direct worker test (14.3s) worked because the initial debug script ran AFTER page JS had already captured a reference to the original fetch — the monkey-patch DID intercept the right call.

Wait — the initial direct worker test that returned `"4"` succeeded. That used `pageEval` injection (after page load). The pre-navigation `Page.addScriptToEvaluateOnNewDocument` version fails because the page's bundled code uses the patched fetch but the request gets 403'd (possibly due to missing CSRF/sentinel tokens that are set up by earlier page JS).

**Conclusion:** The fetch hook works when injected AFTER page JS initializes (via `pageEval`), but fails when injected BEFORE (via `addScriptToEvaluateOnNewDocument`) because session setup hasn't completed yet.

### Key Finding
The successful test used `injectStreamCapture` via `pageEval` AFTER the page loaded. The failing implementation moved it to `Page.addScriptToEvaluateOnNewDocument` BEFORE navigation, which causes the fetch hook to intercept requests before the page's auth/sentinel tokens are ready.

## Root Cause
**Timing of fetch hook injection.** Pre-navigation injection via CDP breaks the page's auth flow. Post-page-load injection via `pageEval` works because the page's auth tokens are already set up.

But wait — the post-load `pageEval` version also failed in the full worker flow. Need to retest.

## Recommendations
1. **Re-test post-load `pageEval` injection** — the initial successful test was a direct Bun script, not the full worker. Compare what's different.
2. **WebSocket interception** — hook `WebSocket.prototype.onmessage` or use CDP `Network.webSocketFrameReceived` to capture streaming messages
3. **CDP Network domain** — use `Network.enable` + `Network.webSocketFrameReceived` events to capture WebSocket frames containing response text
4. **Conversation API** — after response completes, fetch `/backend-api/conversation/{id}` to get the full message text

## Model Picker (SOLVED)
- Button: `[data-testid="model-switcher-dropdown-button"]`
- Requires Radix synthetic click: `pointerdown→mousedown→pointerup→mouseup→click`
- Menu items: `div[role="menuitem"]` with `data-testid`:
  - `model-switcher-gpt-5-3` → Instant (GPT-5.3)
  - `model-switcher-gpt-5-4-thinking` → Thinking (GPT-5.4)
  - `model-switcher-gpt-5-4-pro` → Pro (GPT-5.4)
- Model aliases mapping in `native/chatgpt-bun-worker-logic.ts`
