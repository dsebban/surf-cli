# Investigation: CloakBrowser ChatGPT Response Capture Bug

## Summary

The CloakBrowser worker (`chatgpt-cloak-worker.mjs`) captures truncated/incomplete responses due to:
1. **DOM selector mismatch** — `EXTRACT_TEXT_JS` only queries `section` but ChatGPT DOM uses `article`/`div` too
2. **No SSE stream capture** — unlike the Bun worker which intercepts the actual API response stream, the cloak worker relies solely on fragile DOM extraction
3. **`textContent` vs `innerText`** — uses `textContent` which includes hidden elements

## Symptoms

- ChatGPT Pro spent ~35min thinking but only a summary paragraph was captured
- `[pro | 2140.5s | cloak]` — timing IS correct (35min)
- "Took 0.0s" — from calling pipeline, not surf-cli
- Response text was only the final visible paragraph, not the full response

---

## Research: How Other Tools Solve This

### Tools Analyzed

| Tool | Strategy | Strengths | Weaknesses |
|------|----------|-----------|------------|
| **CatGPT-Gateway** (14⭐) | DOM: copy-button counting + clipboard read | Model-agnostic, gets clean markdown | Higher latency, no streaming |
| **reverse-engineered-chatgpt** (287⭐) | WebSocket + SSE interception (no DOM) | Complete text, delta tracking | Needs auth tokens, API changes break it |
| **node-chatgpt-api** (4.2k⭐) | Pure SSE interception via `/backend-api/conversation` | Clean, no DOM dependency | Needs access token, no browser fallback |
| **ChatGPT-Browser-Automation** (Selenium) | DOM: wait for stop button disappear, get last `[data-message-author-role="assistant"]` | Simple | Fragile, no thinking model support |
| **Our Bun worker** | **Hybrid**: SSE stream capture + DOM polling + `chooseBestText` arbitration | Best of both worlds | Bun-only, can't run in CloakBrowser |

### Key Takeaways

1. **SSE stream interception is the gold standard** for complete text capture — used by 3/4 mature tools
2. **Copy-button counting** (CatGPT) is the most robust DOM-only completion signal — model-agnostic, works for thinking/Pro
3. **`data-message-author-role="assistant"` + `.agent-turn`** are the current stable DOM selectors (CatGPT uses these)
4. **Text stability of 5 seconds** is the safe threshold for DOM-only approaches (CatGPT uses 5 consecutive stable seconds vs our 1.2s)
5. **No tool relies solely on `section[data-testid]`** — all use role-based selectors or stream interception

---

## Investigation Log

### Phase 1 — Selector Mismatch (ROOT CAUSE #1)

**Hypothesis:** `EXTRACT_TEXT_JS` uses different DOM selectors than `DETECT_PHASE_JS`

**Findings:**
- `EXTRACT_TEXT_JS`: queries ONLY `section[data-testid^="conversation-turn-"]`
- `DETECT_PHASE_JS`: queries `section`, `article`, AND `div` variants
- `chatgpt-bun-worker.ts` SEL.conversationTurn: includes all three variants
- CatGPT-Gateway uses `[data-message-author-role="assistant"]` (role-based, element-agnostic)

**Evidence:**
```js
// EXTRACT_TEXT_JS — BROKEN (only section)
'section[data-testid^="conversation-turn-"]'

// DETECT_PHASE_JS — CORRECT (all three)
'section[..], article[..], div[..]'

// CatGPT-Gateway — BEST (role-based)
'[data-message-author-role="assistant"]'
```

**Conclusion:** CONFIRMED — if ChatGPT renders turns as `article`/`div`, extraction finds nothing.

### Phase 2 — No Stream Capture (ROOT CAUSE #2)

**Hypothesis:** The cloak worker misses response text because it has no SSE stream interception

**Findings:**
- Our Bun worker uses `injectFetchStreamCapture()` — monkey-patches `window.fetch` to capture SSE stream from `/backend-api/conversation`
- Bun worker arbitrates between stream text and DOM text via `chooseBestText()`
- Cloak worker has NO equivalent — 100% DOM `.markdown` textContent
- `reverse-engineered-chatgpt` and `node-chatgpt-api` both rely on SSE/WebSocket (zero DOM)
- For Pro/thinking models, DOM may render collapsed/truncated while stream has full text

**Conclusion:** CONFIRMED — this is the architectural gap. The bun worker already solved this.

### Phase 3 — Completion Detection Too Aggressive

**Hypothesis:** Stability thresholds allow premature completion

**Findings:**
- Cloak worker: `requiredStableCycles=2, minStableMs=1200` (~2 seconds)
- CatGPT-Gateway: 5 consecutive stable seconds for DOM-only
- CatGPT also uses **copy-button appearance** as primary signal (most robust)
- Our Bun worker uses `stream.done` as primary signal (stability is just fallback)

**Conclusion:** The cloak worker's 2-cycle / 1.2s threshold is too aggressive for Pro/thinking models where text can briefly stabilize during render transitions.

### Phase 4 — textContent vs innerText (MINOR)

- `EXTRACT_TEXT_JS` uses `.textContent` (includes hidden elements)
- Bun worker uses `.innerText` first (respects visibility)
- CatGPT uses clipboard copy (cleanest — gets rendered markdown)

---

## Root Causes (Ranked)

1. **DOM selector mismatch** — `EXTRACT_TEXT_JS` queries only `section` but DOM uses `article`/`div`
2. **No SSE stream capture** — no fetch monkey-patching means 100% DOM dependency
3. **Stability threshold too low** — 2 cycles / 1.2s vs CatGPT's 5 seconds
4. **`textContent` instead of `innerText`** — minor noise contribution

## Recommendations

### Fix 1: Align EXTRACT_TEXT_JS selectors + use role-based detection (immediate, high confidence)

Update `EXTRACT_TEXT_JS` to:
- Query all three element types (section, article, div) like `DETECT_PHASE_JS`
- Use `.sr-only` text detection (already correct pattern)
- Use `innerText` instead of `textContent`

### Fix 2: Add SSE stream capture (high impact, medium effort)

Port `injectFetchStreamCapture` from `chatgpt-bun-worker.ts` to cloak worker:
- Inject the same `window.fetch` monkey-patch via Playwright's `page.evaluate()`
- Read `window.__surfChatResponse` during polling loop
- Use `chooseBestText` arbitration (stream wins during streaming, DOM wins after render)
- Use `stream.done` as primary completion signal

### Fix 3: Increase stability thresholds (quick fix)

Increase `requiredStableCycles` from 2 to 4 and `minStableMs` from 1200 to 2500.

### Fix 4: Add copy-button completion signal (robust, from CatGPT)

Count copy buttons before sending → poll for new copy button → most reliable model-agnostic completion signal.

## Preventive Measures

- Extract conversation turn selector into a shared constant used by both EXTRACT and DETECT
- Add integration test verifying both scripts use the same selectors
- Consider extracting DOM evaluation JS into shared files used by both workers
