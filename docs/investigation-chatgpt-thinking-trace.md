# Investigation: ChatGPT Live Thinking Trace — Bun → Cloak Port

## Summary

Bun worker emits live `⏳ Thinking` / `⏳ Responding` phase labels directly to stderr.
Cloak worker already detected the same phases but emitted them only as `{type:'log'}` events
that were invisible to users (gated by `SURF_DEBUG`). Three-layer fix: add `{type:'trace'}`
event in worker → bridge forwards to callback → CLI renders identically to bun.

---

## Investigation Log

### Phase 1 — Architecture trace

**Bun path:**
```
cli.cjs → runChatGPTViaBun() → chatgpt-bun-worker.ts
  waitForResponse() polls DOM every 400ms
  pollResponseState() extracts PollState { isThinking, thinkingLabel, isStreaming, ... }
  phase change → log(`⏳ ${phase}`) → stderr → user sees it immediately
```

**Cloak path (before fix):**
```
cli.cjs → queryWithCloakBrowser(opts, onProgress) → chatgpt-cloak-worker.mjs
  response loop polls DOM every 500ms
  DETECT_PHASE_JS extracts phase string
  phase change → log('info', `⏳ ${phase}`) → {type:'log'} JSON stdout
  bridge: case 'log': only printed if SURF_DEBUG=1  ← INVISIBLE TO USER
  CLI: onProgress() only handles {type:'progress'} step events
```

### Phase 2 — Root causes

| # | Issue | Location |
|---|-------|---------|
| 1 | `{type:'log'}` events not forwarded when `SURF_DEBUG` unset | `chatgpt-cloak-bridge.cjs` |
| 2 | No structured `trace` event type in worker protocol | `chatgpt-cloak-worker.mjs` |
| 3 | CLI progress callback only handles step progress, not trace | `cli.cjs` |
| 4 | `DETECT_PHASE_JS` returned plain string, not `{phase, isThinking}` | `chatgpt-cloak-worker.mjs` |
| 5 | Stability check used `stableCycles >= 3` without minStableMs | `chatgpt-cloak-worker.mjs` |

### Phase 3 — What bun actually does for thinking models

From `chatgpt-bun-worker.ts` `pollResponseState()`:
```js
// isThinking = stop visible + no .markdown text + visible label text outside markdown
if (isStreaming && !text && lastAssistant) {
  var labelClone = lastAssistant.cloneNode(true);
  labelClone.querySelectorAll('.sr-only, .markdown, button, nav, form, script, style').forEach(r => r.remove());
  var labelText = labelClone.textContent.trim();
  if (labelText) { thinkingLabel = labelText; isThinking = true; }
}
// In waitForResponse():
const phase = state.isThinking ? state.thinkingLabel : (state.isStreaming && state.text ? "Responding" : "");
if (phase && phase !== lastProgressPhase) {
  log(`⏳ ${phase}`);  // → "[bun-chatgpt] ⏳ Thinking" on stderr
  lastProgressPhase = phase;
}
```

Cloak's `DETECT_PHASE_JS` was already doing the same DOM clone+strip logic — just not
surfacing the result through the right channel.

---

## Changes Made

### 1. `native/chatgpt-cloak-worker.mjs`

**`DETECT_PHASE_JS`** — now returns `{phase, isThinking}` object instead of raw string:
```js
// Thinking phase: extract first line of visible label (max 80 chars)
const raw = (clone.textContent || '').trim();
const label = raw.split('\n')[0].trim().slice(0, 80) || 'Thinking';
return { phase: label, isThinking: true };
// Responding: { phase: 'Responding', isThinking: false }
// No stop button: { phase: '', isThinking: false }
```

**Response loop** — emits `trace` event + improved stability:
```js
emit({ type: 'trace', phase, isThinking: phaseResult.isThinking });
// Stability: requiredStableCycles=2, minStableMs=1200 (matches bun advanceTextStability)
```

### 2. `native/chatgpt-cloak-bridge.cjs`
```js
case "trace":
  onProgress({ type: "trace", phase: msg.phase, isThinking: msg.isThinking });
  break;
```

### 3. `native/cli.cjs`
```js
if (progress.type === "trace") {
  const msg = `[cloak-chatgpt] ⏳ ${progress.phase}`;
  if (msg !== lastProgress) { process.stderr.write(msg + "\n"); lastProgress = msg; }
  return;
}
```

---

## Result: UX parity

**Bun (before):**
```
[bun-chatgpt] [1/5] Launching browser (0.0s)
[bun-chatgpt] [4/5] Sending prompt — explain quantum... (3.2s)
[bun-chatgpt] ⏳ Thinking
[bun-chatgpt] ⏳ Responding
[bun-chatgpt] ✓ Done — Quantum entanglement is... (o3, 28.4s)
```

**Cloak (after fix):**
```
[cloak-chatgpt] [1/6] Launching CloakBrowser — thinking (0.0s)
[cloak-chatgpt] [5/6] Sending prompt — explain quantum... (4.1s)
[cloak-chatgpt] ⏳ Thinking
[cloak-chatgpt] ⏳ Thinking for 15 seconds     ← live label from ChatGPT UI
[cloak-chatgpt] ⏳ Responding
[cloak-chatgpt] success
```

---

## What Was NOT Ported (intentional)

1. **Fetch/SSE interception (`injectFetchStreamCapture`)** — bun uses this for instant
   text capture. For thinking/pro, stream_handoff sends early [DONE] with empty text,
   so bun falls back to DOM anyway. Not needed for parity on thinking/pro models.

2. **`chooseBestText` / `sanitizeChatGptAssistantText`** from bun-worker-logic.ts —
   cloak has its own `sanitize()` + `UI_NOISE` array which covers the same patterns.
   Shared module would reduce drift; tracked in autoresearch.ideas.md.

3. **`messageId` / `assistantTurnId` in trace events** — would improve session log
   richness but requires additional DOM queries per poll cycle. Low priority.
