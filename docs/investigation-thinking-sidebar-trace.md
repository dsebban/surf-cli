# Investigation: ChatGPT Right-Side Thinking Trace Capture

## Summary

Yes — the richer right-side thinking trace **is capturable** from ChatGPT UI, but with an important caveat: in my runtime probes it opened reliably in **headed CloakBrowser**, not in **headless CloakBrowser**. The trace appears to come from a **flyout already present in client state / DOM-driven UI**, not from a dedicated post-click network fetch.

## Symptoms

- Current `surf chatgpt` cloak path only surfaces live inline trace labels (`⏳ Thinking`, snippets) via `DETECT_PHASE_JS`
- User reports clicking the trace chip in ChatGPT opens a right sidebar with elapsed time + full thinking trace
- Need to know whether surf-cli can capture that richer sidebar instead of only the inline phase label

## Initial Assessment

Current code only watches the **last assistant turn** and extracts:
- rendered answer text via `EXTRACT_TEXT_JS`
- inline phase label via `DETECT_PHASE_JS`

It does **not**:
- click the trace chip
- inspect global portal/flyout containers
- persist sidebar text in worker success payload

Relevant code:
- `native/chatgpt-cloak-worker.mjs:145-223` — turn selectors, `EXTRACT_TEXT_JS`, `DETECT_PHASE_JS`
- `native/chatgpt-cloak-worker.mjs:539-620` — response polling loop, emits `trace` events only
- `native/chatgpt-cloak-bridge.cjs:98-126` — forwards `trace` events only
- `native/cli.cjs:3121-3143` — prints `[cloak-chatgpt] ⏳ ...` only

## Investigation Log

### Phase 1 — Existing code path
**Hypothesis:** maybe current worker is already close to sidebar capture.

**Findings:**
- Current cloak worker scopes all reading to the **last assistant turn** via `FIND_LAST_ASSISTANT_JS`
- `DETECT_PHASE_JS` clones the turn and strips `.markdown` to infer a short phase label only
- No selectors/state for trace-chip trigger, flyout root, sidebar content, or close button

**Evidence:**
- `native/chatgpt-cloak-worker.mjs:145-223`
- `native/chatgpt-cloak-worker.mjs:539-620`

**Conclusion:** confirmed — current implementation cannot capture the right-side trace without a new post-response step.

### Phase 2 — External repo scan
**Hypothesis:** other ChatGPT automation projects may already capture the full sidebar trace.

**Findings:**
- I checked multiple browser automation / reverse-engineered ChatGPT projects via `librarian`
- None showed code that clicks the thinking chip and parses the right sidebar
- Most repos capture only:
  - final assistant text from DOM, or
  - final `message.content.parts[0]` from API/SSE
- No repo found with sidebar selectors, flyout parsing, or elapsed-thinking-time extraction

**Conclusion:** this would be a **novel implementation** in surf-cli, not a standard borrowed pattern.

### Phase 3 — Runtime probe: headless Cloak
**Hypothesis:** the trace chip opens a flyout in headless too; we just need selectors.

**Experiment:** one-off probe script `tmp/reasoning-sidebar-probe.mjs`
- sends a thinking-model prompt
- waits for response
- finds the `Thought for Ns` button near the assistant turn
- clicks it
- inspects right-side DOM, mutations, screenshots, network

**Findings:**
- Headless run found the chip/button text, e.g. `Thought for 5s` / `Thought for 9s`
- But clicking did **not** open a visible flyout
- Screenshots before/after were visually identical
- Right-side scan returned no pane
- Mutations did not show a flyout node
- Network after click did not show a dedicated reasoning-panel request

**Evidence:**
- `/tmp/reasoning-sidebar-before.png`
- `/tmp/reasoning-sidebar-after.png`
- `/tmp/reasoning-sidebar-probe.log`

**Conclusion:** in headless Cloak, this affordance was **not reliably openable** in my probe.

### Phase 4 — Runtime probe: headed Cloak
**Hypothesis:** UI behavior differs in headed mode; the trace chip may become interactive.

**Experiment:** same probe script, but `CLOAK_HEADLESS=0`

**Findings:**
- The trace chip/button was present and hoverable: `Thought for 17s`
- Playwright-level click opened a real right-side flyout
- Flyout root had stable selector: `data-testid="stage-thread-flyout"`
- Flyout geometry: right-side panel at approx `x=1040, w=400, h=1000`
- Flyout text included:
  - header: `Activity · 17s`
  - section heading: `Thinking`
  - full point-by-point reasoning trace
  - footer: `Thought for 17s Done`
- Mutation log showed repeated width/style changes on the flyout as it animated open
- No evidence of a dedicated post-click trace-network request; panel appears to be rendered from existing client state / DOM model

**Evidence:**
- Screenshot after click: `/tmp/reasoning-sidebar-after.png`
- Headed probe log: `/tmp/reasoning-sidebar-headed.log`
- Key DOM evidence from log:
  - trigger text: `Thought for 17s`
  - flyout root: `data-testid="stage-thread-flyout"`
  - flyout class: `stage-thread-flyout-preset-default`
  - flyout text prefix: `Activity · 17s Thinking ...`

**Conclusion:** confirmed — the full sidebar trace is capturable from DOM in headed mode.

## Root Cause / Why surf-cli misses it today

surf-cli misses the full trace because the current cloak worker only performs **passive turn-local polling**:
- reads final answer text from the assistant turn
- reads an inline phase label from the assistant turn
- never activates the trace UI affordance
- never inspects global flyout containers attached outside the turn tree

So the richer trace is not “missing from the page entirely”; it is simply outside the current extraction model.

## Source Classification

Best current classification: **client-side flyout / DOM state**, not a trace-specific network fetch.

Why:
- Headed click produced a flyout with stable `data-testid="stage-thread-flyout"`
- Mutation log showed style/width animation on the flyout
- No trace-specific post-click request was observed
- Therefore the likely source is: existing client/React state rendered into the flyout on click

## Important Caveat

### Headed vs headless divergence

This is the main risk.

Observed behavior:
- **Headed Cloak:** trace chip opens flyout successfully
- **Headless Cloak:** chip exists, but flyout did not open in my probes

Possible explanations:
1. ChatGPT disables this interaction in headless
2. Different CSS/interaction state makes the chip effectively non-interactive in headless
3. More precise pointer choreography is required in headless
4. A/B experiment / account / viewport variance

So: **capturable, yes — but not yet proven reliable in current production headless path.**

## Recommended Fix Shape

### Safe path: additive post-response probe in cloak worker

Add a new post-response step in `native/chatgpt-cloak-worker.mjs`, after response completion and before `success(...)`:

1. find trace trigger near latest assistant turn
   - visible button text matching `Thought for` / `Thinking for`
2. click it with Playwright-level click/hover
3. poll for flyout root:
   - `[data-testid="stage-thread-flyout"]`
4. extract:
   - elapsed time from header (`Activity · 17s`)
   - section title(s) (`Thinking`)
   - full flyout text / bullet steps
5. optionally close flyout
6. return additive payload in `success(...)`, e.g.
   - `thinkingTraceText`
   - `thinkingTraceElapsed`
   - `thinkingTraceAvailable`

### Why this shape
- keeps main response capture stable
- additive; no protocol break required
- easy to guard behind thinking/pro modes only
- easier to debug than embedding into main poll loop

## Minimal Selector Set Discovered

### Trigger
- visible button within last assistant turn
- text pattern: `Thought for <n>s`

### Flyout root
- `[data-testid="stage-thread-flyout"]`

### Flyout contents
Observed visible text structure:
- `Activity · <elapsed>`
- `Thinking`
- bullet / prose reasoning trace
- trailing status: `Thought for <elapsed>` + `Done`

## Eliminated Hypotheses

- **Dedicated post-click network fetch for trace panel** — not supported by observed traffic
- **Another repo already solved this** — no evidence found in librarian scan
- **Current worker already nearly captures it** — false; current worker never opens flyout or reads global panel DOM

## Resolution: React Fiber Extraction (Implemented)

### Key Discovery: ChatGPT's New Streaming Architecture

ChatGPT no longer streams conversation data via HTTP SSE. The architecture is:

1. **HTTP POST `/backend-api/f/conversation`** → returns a 973-byte resume/conduit token
2. **WebSocket `wss://ws.chatgpt.com/p8/ws/user/...`** → actual streaming via conduit frames
3. **Each frame contains `encoded_item`** with embedded SSE-format data

The thinking trace flows through WebSocket frames at path `/message/content/thoughts` with `"o": "append"` operations. Each thought is an object:
```json
{
  "summary": "Providing short puzzle solution",
  "content": "Alright, to solve it...",
  "chunks": ["line 1", "line 2", ...],
  "finished": true
}
```

After response completes, the data persists in **React fiber state** at:
- "Thought for" button → fiber depth ~8 → `allMessages` prop
- Message with `content_type: "thoughts"` → `thoughts` array
- Message with `content_type: "reasoning_recap"` → duration + recap text

### Why Flyout Approach Failed Headless

The "Thought for Xs" button has `disabled: true` and `cursor-default` class in headless mode. The `stage-thread-flyout` DOM element is **never created** in headless (not just hidden). ChatGPT intentionally disables this UI affordance in headless browsers.

### Implementation (Landed)

Files changed:
- `native/chatgpt-cloak-worker.mjs` — `EXTRACT_THINKING_TRACE_JS` + `extractThinkingTrace()` 
- `native/chatgpt-cloak-bridge.cjs` — pass through `thinkingTrace` in `mapSuccess`
- `native/cli.cjs` — include in JSON output + stderr summary

The extraction:
1. Finds "Thought for" button via text match
2. Walks React fiber tree upward (~8 levels)
3. Finds `allMessages` prop with full conversation data
4. Extracts `thoughts` array (point-by-point reasoning) + duration + recap text
5. Returns additive `thinkingTrace` field in success payload

JSON output includes:
```json
{
  "thinkingTrace": {
    "thoughts": [{"summary": "...", "content": "..."}],
    "durationSec": 12,
    "recapText": "Thought for 12s"
  }
}
```

Stderr shows: `🧠 Thinking trace: N step(s), Xs`

### Behavior by Thinking Duration

| Duration | thoughts array | Notes |
|----------|---------------|-------|
| 2-5s | Empty `[]` | Short thinking, no detailed trace |
| 12s+ | Populated | 1+ entries with summary + content |
| 21m+ (Pro) | Many entries | Full sidebar-equivalent trace |

### Validated

- ✅ Headless mode: React fiber extraction works
- ✅ 3s thinking: captures duration + recap (thoughts empty, expected)
- ✅ 12s thinking: captures 1 thought with full content (via probe)
- ✅ JSON output includes thinkingTrace
- ✅ stderr shows trace summary
- ⏳ Pro/Extended Pro with 20m+ thinking: not yet validated (expected to work)

## Eliminated Hypotheses

- **Dedicated post-click network fetch for trace panel** — not supported by observed traffic
- **Another repo already solved this** — no evidence found in librarian scan  
- **Current worker already nearly captures it** — false; required new React fiber extraction
- **SSE/HTTP stream contains thoughts** — false; ChatGPT moved to WebSocket conduit
- **Flyout approach works headless** — false; button is `disabled: true` in headless
- **Fetch monkey-patch captures data** — false; HTTP response is just a conduit token

## Artifacts

- Probe scripts: `tmp/reasoning-sidebar-probe.mjs`, `tmp/extract-recap-probe.mjs`, `tmp/ws-full-probe.mjs`
- Headless log: `/tmp/reasoning-sidebar-probe.log`
- Headed log: `/tmp/reasoning-sidebar-headed.log`
- WebSocket dump: `/tmp/ws-encoded-items.txt`
- Before screenshot: `/tmp/reasoning-sidebar-before.png`
- After screenshot: `/tmp/reasoning-sidebar-after.png`
