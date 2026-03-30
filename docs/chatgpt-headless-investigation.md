# ChatGPT Headless Response Extraction — Investigation & Architecture

## Final Architecture

**Primary**: Post-load fetch hook (injected via `pageEval` after login verification)  
**Fallback**: DOM polling on `.markdown` containers with UI noise sanitization  
**Transport**: SSE via `/backend-api/f/conversation` (stream_handoff for Thinking/Pro models)

## Summary

ChatGPT's DOM renders response text via empty `<p data-start data-end>` placeholders with range-backed rendering during streaming. Text populates in `.markdown` containers only AFTER streaming completes and React renders. Fetch hook captures SSE stream text before DOM renders; sanitized DOM serves as fallback.

## Key Findings

### Transport Variants
| Mode | Initial SSE | Actual response | Fetch hook captures? |
|------|------------|-----------------|---------------------|
| **Instant (GPT-5.3)** | Full SSE stream with message parts | In initial SSE | ✅ Yes |
| **Thinking (GPT-5.4)** | `stream_handoff` + `[DONE]` (973 bytes) | Via conduit (2nd SSE/WS connection) | ❌ No — DOM fallback used |
| **Pro (GPT-5.4)** | `stream_handoff` (same as Thinking) | Via conduit | ❌ No — DOM fallback used |

### SSE Delta Encoding v1 Format (Instant Mode)
From `gin337/ChatGPTReversed`:
- Client sends `supported_encodings: ["v1"]` in request body
- **Legacy**: `{message: {content: {parts: ["full accumulated text"]}}}`
- **Single delta op**: `{o: "append", p: "/message/content/parts/0", v: "chunk"}`
- **Batch delta ops**: `{v: [{o: "append", p: "...", v: "chunk"}, ...]}`
- **Finish signals**: `finished_successfully` status, `message_stream_complete`, `[DONE]` sentinel

### DOM Extraction
- `.markdown` containers populate AFTER React renders streamed response
- During streaming: empty `<p data-start="0" data-end="7">` placeholders
- After completion: full text in `.markdown`
- Fallback selectors (per `elvatis/conduit-bridge`):
  - `[data-message-author-role="assistant"] .markdown`
  - `article[data-testid*="conversation-turn"] .markdown`
  - `.agent-turn .markdown`

### Session / Auth
- Fetch hook MUST be injected AFTER page load (post-auth/sentinel setup)
- Pre-navigation injection via `Page.addScriptToEvaluateOnNewDocument` causes 403
- Session cookies expire frequently; Chrome profile must have active ChatGPT session
- Stealth patches required to bypass Cloudflare (UA, webdriver, plugins, permissions)

### CDP WebSocket Events
- `Network.webSocketCreated/webSocketFrameReceived` NOT emitted by Bun.WebView (as of v1.3.11)
- ChatGPT's headless context doesn't create WebSocket connections (no `wss://ws.chatgpt.com`)
- Even if WS events worked, Thinking/Pro use conduit handoff transport

## Rejected Approaches

### Pre-navigation fetch hook (`Page.addScriptToEvaluateOnNewDocument`)
- ❌ Causes 403 from `/backend-api/f/conversation` — auth tokens not ready
- Used by `elvatis/conduit-bridge` but they fall back to DOM when it fails

### WebSocket monkey-patching
- ❌ No WebSocket connections in headless context
- ❌ CDP WS events not emitted by Bun.WebView
- ❌ Thinking/Pro use conduit transport, not WS frames

### CDP `Network.webSocketFrameReceived`
- ❌ Events not emitted by Bun.WebView as of v1.3.11-canary
- Only `requestWillBeSent` and `responseReceived` work

## UI Noise Lines (exact-match sanitization)
Stripped from DOM `textContent` to get clean response:
- `Give feedback`, `Copy`, `Good response`, `Bad response`
- `ChatGPT said:`, `Assistant said:`, `You said:`
- `ChatGPT`, `ChatGPT Instruments`
- `Read aloud`, `Share`, `Regenerate`, `Edit`, `Retry`
- `Is this conversation helpful so far?`
- `Thinking`, `Thinking…`, `Thinking...`

## Model Picker (Working)
- Button: `[data-testid="model-switcher-dropdown-button"]`
- Requires Radix synthetic click: `pointerdown→mousedown→pointerup→mouseup→click`
- Items: `div[role="menuitem"]` with `data-testid`:
  - `model-switcher-gpt-5-3` → Instant
  - `model-switcher-gpt-5-4-thinking` → Thinking
  - `model-switcher-gpt-5-4-pro` → Pro

## E2E Validated
| Test | Model | Result | Time |
|------|-------|--------|------|
| `what is 2+2?` | Instant | `4` ✅ | 11.7s |
| `capital of France?` | Default | `Paris` ✅ | 10.1s |
| `what is 7*8?` | Thinking | `56` ✅ | 19.6s |
