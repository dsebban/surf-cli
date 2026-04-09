# Investigation: ChatGPT ProseMirror Direct Replacement

## Summary

CDP `Input.insertText` (keyboardInsertText) is quadratically slow for ChatGPT's ProseMirror composer. A 225 KB prompt takes ~11.5 min via 28 chunks with chunk latency growing from 5 s → 45 s. Root cause: ProseMirror reflow/transaction cost per insertion grows with document size. Fix: bypass insertText entirely and dispatch a single ProseMirror `tr.replaceWith()` transaction via `page.evaluate()`.

## Symptoms

- chunk 1/7: timeout at 20 s (32 K chunks)
- 8 K chunks: chunk 12 = 34.5 s, chunk 20 = 44.0 s, chunk 23 = 42.8 s — classic quadratic growth
- Total insert: 28 chunks, ~11.5 min before readback
- After 11.5 min: readback off by 1 char (228207 vs 228206) — ProseMirror trailing-newline canonicalization
- No new conversations sent

## Root Cause

ChatGPT's composer is a ProseMirror `EditorView`. Each `CDP Input.insertText` call triggers:
- ProseMirror mutation observer
- One `insertText` DOM InputEvent
- A ProseMirror transaction + state update
- Full document re-render/reflow

As document grows, each new insertText reprocesses the growing document. Cost ≈ O(n) per call × O(n) calls = O(n²) total.

## Fix: Direct ProseMirror Transaction

### Implementation (`native/chatgpt-cloak-prompt-entry.cjs`)

Added `tryReplaceViaProseMirror(page, promptSelector, prompt)`:

1. Resolves `.ProseMirror` DOM element via existing selector logic
2. Resolves `EditorView` in order:
   - `el.pmViewDesc.view` (standard ProseMirror property)
   - Property scan on el + 5 DOM ancestors (looks for `{state.doc, dispatch(), dom, state.schema}`)
3. Validates schema has `paragraph` + `text` node types
4. Builds replacement: split prompt on newlines → array of `schema.nodes.paragraph` nodes
5. Dispatches single transaction: `tr.replaceWith(0, doc.content.size, paragraphs)`
6. Fires `input` + `change` events for React reactivity
7. Returns `{ applied, composerKind, viewResolutionMethod, paragraphCount }`

Safe fallback (no mutation): if not ProseMirror, or view not found, or unsupported schema → returns `{ applied: false, fallbackSafe: true, fallbackReason }` → caller falls through to native insertText.

### Strategy selection in `enterPromptWithVerification()`

- Prompt bytes ≥ `proseMirrorReplaceMinBytes` (default 8 KB) → attempt PM replace first
- Smaller prompts → direct native path
- PM replace success requires exact normalized readback; if send stays disabled, caller falls back to native insertion
- PM replace fallback → bulk native `insertText()` → chunked UTF-8-aware `insertText()` → final fill fallback

### Canonicalization drift (off-by-1 char)

Root cause: `readComposerState` reconstructs ProseMirror text as block text joined by `\n`. The PM replace path builds paragraphs from `prompt.split(/\r\n|\r|\n/)` — same split that `normalizeForLengthComparison` uses on the expected side. This alignment eliminates the trailing-newline drift.

## Files Changed

- `native/chatgpt-cloak-prompt-entry.cjs` — added `tryReplaceViaProseMirror`, bytes-based PM gating, exact readback verification, native/fill fallback ladder, UTF-8-aware chunking helpers
- `native/chatgpt-cloak-worker.mjs` — now captures baseline user/message ids, emits sent checkpoint metadata, and validates prompt persistence against the conversation backend after send
- `native/chatgpt-cloak-prompt-validation.cjs` — new backend prompt-persistence validator for exact latest-user-message checks plus `<file_map>` / big-paste detection
- `test/unit/chatgpt-cloak-prompt-entry.test.ts` — expanded PM/native/fallback coverage
- `test/unit/chatgpt-cloak-prompt-validation.test.ts` — prompt persistence regression coverage

## Unknowns to Validate Live

1. Does `el.pmViewDesc.view` exist in current ChatGPT headless Chromium build?
2. Does property scan fallback discover the view successfully if not?
3. How often does live ChatGPT keep PM send disabled even after an exact transaction-based write?
4. Can PM replace be made reliable enough live to beat the now-working bulk native `insertText()` path for very large payloads?

Run a test session with a >8 KB prompt and check logs for:
- `ProseMirror replace applied: N paragraphs via pmViewDesc`
- `Prompt insert verify: prosemirror_replace ACTUAL/EXPECTED chars, exactMatch=true`

## Complexity

- O(1) transaction regardless of prompt size
- Single `page.evaluate()` call instead of 28+ CDP calls
- Expected: <1 s for 225 KB prompt (vs 11.5 min)
