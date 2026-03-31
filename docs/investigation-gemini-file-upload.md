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

**Primary: Use `Page.setInterceptFileChooserDialog` + `Page.handleFileChooser`**

This is the proper CDP approach:
1. Enable interception BEFORE any click
2. Click the upload button / menu item (triggers the file chooser)
3. CDP immediately intercepts the dialog (no OS popup appears)
4. Call `Page.handleFileChooser({ action: "accept", files: [path] })`
5. The browser creates a proper `File` object with real bytes
6. Gemini's normal upload flow runs (XHR to Google's API)
7. Wait for the chip to show "ready"

Note: `Page.handleFileChooser` requires that the file chooser was recently opened. Timing
is tight — must call it within ~500ms of the click.

**Secondary: Verify upload via network poll**

After `handleFileChooser`, poll `surf network` for a successful POST to Gemini's upload endpoint
before proceeding to type+send the prompt.

---

## Session Logging Plan

Build `~/.surf/sessions/` history alongside the fix so future issues are instantly diagnosable.

Each run writes `~/.surf/sessions/YYYY-MM-DD_HH-MM-SS_TOOL.jsonl`:
```json
{"event":"start","ts":1234567890,"tool":"gemini","args":{"file":"/tmp/file.md","model":"gemini-3-pro","profile":"dsebban883@gmail.com"},"env":{"bun_gemini":true},"version":"2.8.0"}
{"event":"step","ts":1234567891,"msg":"[2/6] Authenticating — dsebban883@gmail.com (0.1s)"}
{"event":"step","ts":1234567892,"msg":"[3/6] Loading Gemini (1.3s)"}
{"event":"upload_click","ts":1234567893,"result":"menu"}
{"event":"menu_click","ts":1234567893,"result":"clicked-item"}
{"event":"file_input","ts":1234567894,"nodeId":42,"selector":"input[type=file]"}
{"event":"file_set","ts":1234567894,"file":"/tmp/file.md"}
{"event":"chip_wait","ts":1234567895,"state":"loading"}
{"event":"chip_ready","ts":1234567896,"state":"ready"}
{"event":"end","ts":1234567900,"ok":true,"tookMs":13200,"model":"gemini-3-pro"}
```

This would have immediately revealed the `"menu_click":"no-item"` or wrong nodeId.
