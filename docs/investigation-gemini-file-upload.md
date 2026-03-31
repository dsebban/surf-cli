# Investigation: Gemini --file Attachment Silently Not Sent

## Summary

`SURF_USE_BUN_GEMINI=1 surf gemini "..." --file /tmp/file.md` sends only the prompt; the file is
never included in the Gemini message. This is a **silent false-positive upload** bug: the UI chip
appears (pollUntil exits cleanly), but the file bytes were never transmitted to Google's upload API.

---

## Symptoms
- Command runs to completion, response returned
- Gemini UI shows no file attachment in the message thread
- No error / no fallback — worker exits 0

---

## Investigation Log

### Phase 1 — Control flow trace

**CLI → bridge → worker path (lines 3154–3200 cli.cjs + gemini-bun-bridge.cjs):**

1. `toolArgs.file = path.resolve(toolArgs.file)` ✅ — path absolutified correctly
2. `buildWorkerRequest` maps `args.file` → `request.file` ✅
3. `runGeminiViaBun` spawns `bun gemini-bun-worker.ts`, sends JSON on stdin ✅
4. Worker validates file existence via `fs.existsSync(req.file)` ✅
5. Worker calls `uploadFileViaCDP(wv, req.file, 30000)` → **here is the bug**

### Phase 2 — uploadFileViaCDP dissection (gemini-bun-worker.ts:430–535)

**Step A: Click upload button**
```js
var btn = document.querySelector('[aria-label="Open upload file menu"]')
  || document.querySelector('[aria-label="Upload file"]')
  || ...
```
Returns `"menu"` (button found) or `"none"`.

**Step B: Click menu item** ← **FIRST BUG: result not logged**
```js
var items = document.querySelectorAll('[role="menuitem"], [data-test-id*="local-images-files-uploader-button"]');
for ... if txt.includes('upload') || 'file' || 'computer' → click
```
Returns `"clicked-item"` or `"no-item"` but **the return value is DISCARDED** — no log, no throw.

Consequence: if no menu item matched (UI changed, wrong text), the menu click silently
fails, yet execution continues.

**Step C: Poll for `input[type="file"]` via DOM.querySelectorAll**

The menu click ("Upload from computer") triggers a **native OS file chooser dialog** in the
headless Chrome process. In headless mode, this dialog is silently dismissed (no user present).
After dismissal, Gemini may or may not have created a new `input[type="file"]`. However,
Gemini's input area almost always has **pre-existing hidden file inputs** (for drag-and-drop).
DOM.querySelectorAll finds `nodeIds[0]` — likely the drag-and-drop input, NOT the one
activated by the menu.

**Step D: `DOM.setFileInputFiles` on wrong input**

Setting the file on the drag-and-drop `input[type="file"]` fires a `change` event on that
element. Gemini's React app reacts and renders a chip (`uploader-file-preview`). But this
input is wired to the **drag-and-drop upload path**, which may not attach the file reference
to the message composer.

**Step E: waitForUpload — false positive for text files**

```js
var hasPreview = !!chip.querySelector(
  'img[data-test-id="image-preview"], .image-preview.clickable, [data-test-id="file-name"]'
);
```
For a `.md` file, if Gemini renders the chip with `[data-test-id="file-name"]`, this returns
`ready: true`. The poll exits cleanly. Worker proceeds to send the prompt. File not in message.

**Step F: No network upload verification**

There is no check that Gemini actually POSTed the file bytes to its upload API
(`https://alkalimakersuite-pa.clients6.google.com/...` or similar). The poll only checks
DOM state, not actual upload completion.

---

## Root Causes (ordered by impact)

| # | Root cause | Evidence |
|---|-----------|---------|
| 1 | **Menu item click result not logged/checked** — silent failure if Gemini UI changed | Line 467: return value discarded |
| 2 | **Native file chooser dismissed in headless** — dialog never fulfilled | CDP design: headless Chrome silently dismisses OS dialogs |
| 3 | **Wrong file input targeted** — drag-and-drop input found instead of composer input | DOM.querySelectorAll finds first `input[type="file"]` which is pre-existing hidden input |
| 4 | **No network upload verification** — chip appearing ≠ bytes on server | pollUntil only checks DOM, not XHR/fetch to upload API |

---

## The Correct Fix

**Implemented: `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened` CDP event**

This is the proper CDP approach (now live in `gemini-bun-worker.ts`):
1. `Page.setInterceptFileChooserDialog({ enabled: true })` BEFORE any click
2. Register `wv.addEventListener("Page.fileChooserOpened", handler)` listener
3. Click upload button + menu item (triggers file chooser)
4. CDP intercepts the dialog — no OS popup appears in headless
5. `event.data.backendNodeId` gives us the **exact** `<input>` the app activated
6. `DOM.setFileInputFiles({ files: [path], backendNodeId })` on the correct input
7. Gemini's normal upload flow runs (XHR to Google's API)
8. Poll for chip `ready` state (existing `waitForUploadChip`)

Key details:
- Uses Bun.WebView's `addEventListener("Page.fileChooserOpened", ...)` — CDP events
  dispatched as `MessageEvent` with `event.data` = parsed CDP params
- 3-attempt retry with escalating timeouts (10s, 15s, 20s) — mirrors extension
- Always disables interception in `finally` block
- Menu item click result now logged + checked (throws on `"no-item"`)

**Why this fixes the root cause:**
- Old code: `DOM.querySelectorAll('input[type="file"]')` found the **first** (drag-and-drop)
  input, not the one activated by the menu click. Setting files on the wrong input produced
  a UI chip but no actual upload to Google servers.
- New code: `backendNodeId` from the `fileChooserOpened` event identifies the **exact** input
  that triggered the file chooser, guaranteeing we set files on the correct element.

---

## Session Logging (implemented separately)

Session logging now lives in `native/session-store.cjs` + `~/.surf/sessions/`. Each run captures
full stderr progress in `output.log` alongside `meta.json`. The upload button/menu click results
are now visible in session logs via the worker's `log()` calls:

```
[bun-gemini] Upload button: menu
[bun-gemini] Menu item: clicked-direct
[bun-gemini] File chooser opened (backendNodeId=42), setting files...
[bun-gemini] File set via file chooser interception
[bun-gemini] File upload complete
```

This would have immediately revealed the old bug (no `backendNodeId` → wrong input targeted).
