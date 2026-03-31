#!/usr/bin/env bun
/// <reference path="./bun-webview.d.ts" />
/**
 * Bun WebView worker for Gemini queries.
 *
 * Standalone Bun script — reads one JSON request from stdin,
 * drives a headless Chrome-backed WebView against gemini.google.com,
 * writes one JSON result to stdout.
 *
 * Protocol:
 *   stdin  → WorkerRequest  (JSON)
 *   stdout → WorkerResponse (JSON)
 *   stderr → diagnostics (never JSON)
 */

// Import shared helpers (CJS compat)
const {
  GEMINI_APP_URL,
  resolveGeminiModelForUI,
  buildGeminiPrompt,
  ensureFullSizeImageUrl,
  resolveImageOutputPath,
} = require("./gemini-common.cjs");

// ============================================================================
// Types
// ============================================================================

interface WorkerRequest {
  prompt: string;
  model?: string;
  file?: string | null;
  generateImage?: string | null;
  editImage?: string | null;
  output?: string | null;
  youtube?: string | null;
  aspectRatio?: string | null;
  timeoutMs?: number;
  profileEmail?: string | null;
}

interface WorkerResult {
  response: string;
  model: string;
  tookMs: number;
  imagePath: string | null;
  imageCount: number;
  thoughts: string | null;
}

interface WorkerResponse {
  ok: true;
  result: WorkerResult;
}

interface WorkerError {
  ok: false;
  code: string;
  error: string;
  fallbackRecommended: boolean;
}

// ============================================================================
// Logging & progress (always stderr, never corrupts stdout)
// ============================================================================

function log(msg: string) {
  process.stderr.write(`[bun-gemini] ${msg}\n`);
}

/** Structured step-based progress for LLM-friendly output. */
class Progress {
  private current = 0;
  private total: number;
  private startMs = Date.now();

  constructor(steps: string[]) {
    this.total = steps.length;
    this.steps = steps;
  }
  private steps: string[];

  step(detail?: string) {
    this.current++;
    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
    const label = this.steps[this.current - 1] || "Working";
    const suffix = detail ? ` — ${detail}` : "";
    process.stderr.write(
      `[bun-gemini] [${this.current}/${this.total}] ${label}${suffix} (${elapsed}s)\n`,
    );
  }

  done(detail: string) {
    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
    process.stderr.write(
      `[bun-gemini] ✓ Done — ${detail} (${elapsed}s)\n`,
    );
  }
}

// ============================================================================
// Polling helpers
// ============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  check: (val: T) => boolean,
  intervalMs: number,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (check(val)) return val;
    await delay(intervalMs);
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

// ============================================================================
// WebView page helpers
// ============================================================================

type WebView = InstanceType<typeof Bun.WebView>;

/**
 * eval() wrapper that catches and rethrows with context.
 * Bun.WebView.evaluate() does not support template literal backtick-heavy
 * code in single-quote shell args, so we always use this from TS strings.
 */
async function pageEval(wv: WebView, js: string): Promise<any> {
  try {
    return await wv.evaluate(js);
  } catch (e: any) {
    throw new Error(`evaluate failed: ${e?.message ?? e}`);
  }
}

/** Wait until the Gemini editor is ready (not a login page). */
async function waitForReady(wv: WebView, timeoutMs: number) {
  return pollUntil(
    async () => {
      const url = wv.url;
      const hasEditor = await pageEval(
        wv,
        "!!document.querySelector('.ql-editor[contenteditable=\"true\"]')",
      );
      const hasLogin = await pageEval(
        wv,
        "!!document.querySelector('input[type=\"email\"]')",
      );
      return { url, hasEditor, hasLogin };
    },
    (s) => s.hasEditor && !s.hasLogin,
    400,
    timeoutMs,
    "waitForReady",
  );
}

/** Focus the Gemini editor. */
async function focusEditor(wv: WebView) {
  const focused = await pageEval(wv, `
    (function() {
      var e = document.querySelector('.ql-editor[contenteditable="true"]');
      if (!e) return false;
      e.focus();
      return true;
    })()
  `);
  if (!focused) throw new Error("Could not focus Gemini editor");
}

/** Read the current content of the editor. */
async function readEditorContent(wv: WebView): Promise<string> {
  return (
    (await pageEval(
      wv,
      "document.querySelector('.ql-editor')?.textContent || ''",
    )) || ""
  );
}

/** Click the send button. Returns method used. */
async function clickSend(wv: WebView): Promise<string> {
  // Try finding the send button by aria-label
  const method = await pageEval(wv, `
    (function() {
      var btn = document.querySelector('button[aria-label="Send message"]')
        || document.querySelector('button[aria-label*="Send"]')
        || document.querySelector('button[aria-label*="send"]');
      if (btn && !btn.disabled) { btn.click(); return 'button'; }
      return 'none';
    })()
  `);

  if (method === "button") return method;

  // Fallback: press Enter
  await wv.press("Enter");
  return "enter";
}

/** Wait for send button to become enabled. */
async function waitForSendButton(wv: WebView, timeoutMs = 3000) {
  try {
    await pollUntil(
      () =>
        pageEval(wv, `
        (function() {
          var btn = document.querySelector('button[aria-label="Send message"]')
            || document.querySelector('button[aria-label*="Send"]');
          return !!(btn && !btn.disabled);
        })()
      `),
      (v) => v === true,
      150,
      timeoutMs,
      "waitForSendButton",
    );
  } catch {
    // Non-fatal: we can still try clicking or pressing Enter
  }
}

// ============================================================================
// Response extraction
// ============================================================================

interface ImageCandidate {
  source: string;        // fetchable URL (img src, blob:, data:, etc.)
  kind: "img" | "source" | "link";
  width: number;
  height: number;
  fingerprint: string;   // stable dedup key
  isDisplayImage: boolean;
}

interface PollState {
  text: string;
  imageCandidates: ImageCandidate[];
  loading: boolean;
  turnCount: number;
  latestTurnKey: string; // stable ID for last turn (outerHTML hash or index)
}

async function pollResponseState(wv: WebView): Promise<PollState> {
  return pageEval(wv, `
    (function() {
      var turns = document.querySelectorAll('model-response');
      var last = turns.length > 0 ? turns[turns.length - 1] : null;

      // Text from latest response
      var text = '';
      if (last) {
        var mc = last.querySelector('message-content');
        text = mc ? (mc.textContent || '').trim() : (last.textContent || '').trim();
      }

      // Stable key for the last turn (use index + first 40 chars of text)
      var latestTurnKey = turns.length + ':' + text.slice(0, 40);

      // Collect image candidates from the latest model-response subtree
      var candidates = [];
      var seen = {};
      var root = last || document;

      // 1. <img> elements
      var imgs = root.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var el = imgs[i];
        var src = el.currentSrc || el.src || '';
        if (!src || src.startsWith('data:image/svg') || src.endsWith('.svg')) continue;
        var w = el.naturalWidth || el.clientWidth || 0;
        var h = el.naturalHeight || el.clientHeight || 0;
        if (Math.max(w, h) < 256) continue;
        var fp = src.split('?')[0].slice(-80);
        if (seen[fp]) continue;
        seen[fp] = true;
        candidates.push({ source: src, kind: 'img', width: w, height: h, fingerprint: fp, isDisplayImage: true });
      }

      // 2. <picture><source srcset> if no img candidates yet
      if (candidates.length === 0) {
        var sources = root.querySelectorAll('picture source[srcset]');
        for (var i = 0; i < sources.length; i++) {
          var srcset = sources[i].getAttribute('srcset') || '';
          var parts = srcset.trim().split(',').map(function(p) { return p.trim().split(/\s+/)[0]; }).filter(Boolean);
          var src = parts[parts.length - 1] || '';
          if (!src) continue;
          var fp = src.split('?')[0].slice(-80);
          if (seen[fp]) continue;
          seen[fp] = true;
          candidates.push({ source: src, kind: 'source', width: 0, height: 0, fingerprint: fp, isDisplayImage: true });
        }
      }

      // 3. <a href> download links (secondary)
      var links = root.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].href || '';
        if (!href || !(href.startsWith('blob:') || href.startsWith('data:image') || href.includes('googleusercontent') || href.includes('gg-dl'))) continue;
        var fp = href.split('?')[0].slice(-80);
        if (seen[fp]) continue;
        seen[fp] = true;
        candidates.push({ source: href, kind: 'link', width: 0, height: 0, fingerprint: fp, isDisplayImage: false });
      }

      // Scope loading detection to the latest model-response only —
      // unrelated page spinners must not block response completion.
      var loadingRoot = last || document;
      var loading = !!(
        loadingRoot.querySelector('mat-progress-bar') ||
        loadingRoot.querySelector('.loading-indicator') ||
        loadingRoot.querySelector('message-loading')
      );

      return {
        text: text,
        imageCandidates: candidates,
        loading: loading,
        turnCount: turns.length,
        latestTurnKey: latestTurnKey,
      };
    })()
  `);
}

const IMAGE_GENERATING_PATTERNS = [
  /creating your image/i,
  /generating image/i,
  /^generating\b/i,
];

function isImagePlaceholderText(text: string): boolean {
  return IMAGE_GENERATING_PATTERNS.some((re) => re.test(text.trim()));
}

function newDisplayCandidates(state: PollState, baseline: PollState): ImageCandidate[] {
  const bfp = new Set(baseline.imageCandidates.map((c) => c.fingerprint));
  return state.imageCandidates.filter((c) => !bfp.has(c.fingerprint) && c.isDisplayImage);
}

async function waitForResponse(
  wv: WebView,
  baseline: PollState,
  timeoutMs: number,
  expectsImage: boolean,
): Promise<{ text: string; imageCandidates: ImageCandidate[] }> {
  const deadline = Date.now() + timeoutMs;
  let stableCount = 0;
  let sawNewActivity = false;
  let lastText = "";
  let lastImgFingerprints = "";
  let lastGoodCandidates: ImageCandidate[] = [];

  while (Date.now() < deadline) {
    await delay(700);
    const state = await pollResponseState(wv);

    const hasNewTurn =
      state.turnCount > baseline.turnCount ||
      state.latestTurnKey !== baseline.latestTurnKey;

    const newImgs = newDisplayCandidates(state, baseline);
    const imgFp = newImgs.map((c) => c.fingerprint).sort().join("|");

    if (hasNewTurn || newImgs.length > 0) {
      sawNewActivity = true;
    }

    if (!sawNewActivity) continue;

    if (expectsImage) {
      // For image mode: require at least one new display image before completing
      if (newImgs.length === 0) { stableCount = 0; continue; }
      if (!state.loading) {
        if (imgFp === lastImgFingerprints) {
          stableCount++;
          if (stableCount >= 2) return { text: state.text, imageCandidates: newImgs };
        } else {
          stableCount = 0;
          lastGoodCandidates = newImgs;
        }
        lastImgFingerprints = imgFp;
      } else {
        stableCount = 0;
      }
    } else {
      // Text mode
      const hasContent = state.text.length > 0;
      if (hasContent && !state.loading) {
        if (state.text === lastText) {
          stableCount++;
          if (stableCount >= 2) return { text: state.text, imageCandidates: newImgs };
        } else {
          stableCount = 0;
        }
        lastText = state.text;
      } else {
        stableCount = 0;
      }
    }
  }

  // Timeout — return best observed if activity was seen
  if (sawNewActivity) {
    if (expectsImage && lastGoodCandidates.length > 0) {
      return { text: lastText, imageCandidates: lastGoodCandidates };
    }
    if (!expectsImage && lastText) {
      return { text: lastText, imageCandidates: [] };
    }
  }

  throw Object.assign(
    new Error(`Response timed out after ${timeoutMs}ms — ${sawNewActivity ? "activity seen but no stable content" : "Gemini never produced a new turn (send may have failed)"}`),
    { code: "timeout" },
  );
}

// ============================================================================
// File upload via CDP
// ============================================================================

async function uploadFileViaCDP(
  wv: WebView,
  filePath: string,
  timeoutMs: number,
) {
  log(`Uploading file: ${filePath}`);

  // Enable required CDP domains
  await wv.cdp("DOM.enable");
  await wv.cdp("Page.enable");

  // Intercept file chooser dialogs so the OS file picker never appears.
  // When Gemini opens a file chooser, Chrome emits Page.fileChooserOpened
  // with the backendNodeId of the <input>. We then set files on that exact
  // input — the one the app activated — not a random pre-existing one.
  await wv.cdp("Page.setInterceptFileChooserDialog", { enabled: true });

  const clickUploadSequence = async () => {
    // Close menu if already open (idempotent)
    await pageEval(wv, `
      (function() {
        var btn = document.querySelector('[aria-label="Close upload file menu"]');
        if (btn) btn.click();
      })()
    `);
    await delay(300);

    // Open upload menu
    const clickedUpload = await pageEval(wv, `
      (function() {
        var btn = document.querySelector('[aria-label="Open upload file menu"]')
          || document.querySelector('[aria-label="Upload file"]')
          || document.querySelector('[aria-label="Attach files"]')
          || document.querySelector('button[data-test-id*="upload"]')
          || document.querySelector('.upload-button');
        if (btn) { btn.click(); return 'menu'; }
        return 'none';
      })()
    `);
    if (clickedUpload === "none") {
      throw new Error("Upload button not found on Gemini page");
    }
    log(`Upload button: ${clickedUpload}`);
    await delay(500);

    // Click "Upload files" / "Upload from computer" menu item
    const clickedItem = await pageEval(wv, `
      (function() {
        var btn = document.querySelector('[data-test-id="local-images-files-uploader-button"]');
        if (btn) { btn.click(); return 'clicked-direct'; }
        var items = document.querySelectorAll('[role="menuitem"]');
        for (var i = 0; i < items.length; i++) {
          var txt = (items[i].textContent || '').toLowerCase();
          if (txt.includes('upload') || txt.includes('file') || txt.includes('computer')) {
            items[i].click();
            return 'clicked-item';
          }
        }
        return 'no-item';
      })()
    `);
    log(`Menu item: ${clickedItem}`);
    if (clickedItem === "no-item") {
      throw new Error("Upload menu item not found — Gemini UI may have changed");
    }
  };

  // Create a cancellable file-chooser waiter.
  // Returns { promise, cancel } so the caller can clean up stale listeners
  // if clickUploadSequence() throws before the event fires.
  const createFileChooserWaiter = (attemptTimeoutMs: number) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let handler: ((event: any) => void) | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (handler) { wv.removeEventListener("Page.fileChooserOpened", handler); handler = null; }
    };

    const promise = new Promise<void>((resolve, reject) => {
      handler = async (event: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          // event.data contains { frameId, mode, backendNodeId }
          // Harden extraction: backendNodeId must be a number (CDP spec)
          const data = event?.data ?? event;
          const backendNodeId = data?.backendNodeId;
          if (typeof backendNodeId !== "number") {
            throw new Error(
              `fileChooserOpened event: expected numeric backendNodeId, got ${typeof backendNodeId} (${backendNodeId})`,
            );
          }
          log(`File chooser opened (backendNodeId=${backendNodeId}), setting files...`);
          await wv.cdp("DOM.setFileInputFiles", {
            files: [filePath],
            backendNodeId,
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`File chooser did not open within ${attemptTimeoutMs / 1000}s`));
      }, attemptTimeoutMs);

      wv.addEventListener("Page.fileChooserOpened", handler);
    });

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };

    return { promise, cancel };
  };

  // Retry loop — only retries chooser open + file set.
  // waitForUploadChip runs ONCE after successful file set (not retried).
  const maxAttempts = 3;
  const attemptTimeouts = [10000, 15000, 20000];
  let lastError: Error | null = null;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const waiter = createFileChooserWaiter(
        Math.min(attemptTimeouts[attempt - 1], timeoutMs),
      );
      try {
        await clickUploadSequence();
        await waiter.promise;
        log("File set via file chooser interception");
        break; // success — exit retry loop
      } catch (err: any) {
        waiter.cancel(); // always clean up stale listener/timer
        lastError = err;
        log(`Upload attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
        if (attempt === maxAttempts) {
          throw new Error(`File upload failed after ${maxAttempts} attempts: ${lastError.message}`);
        }
        await delay(1000);
      }
    }

    // Chip readiness: runs once after successful file set (outside retry scope)
    await waitForUploadChip(wv, timeoutMs);
    log("File upload complete");
  } finally {
    // Always disable interception on exit
    try {
      await wv.cdp("Page.setInterceptFileChooserDialog", { enabled: false });
    } catch {}
  }
}

/**
 * Wait for the Gemini file preview chip to finish processing.
 * The chip transitions: loading spinner → file name / image preview.
 */
async function waitForUploadChip(wv: WebView, timeoutMs: number) {
  await pollUntil(
    () =>
      pageEval(wv, `
      (function() {
        var chip = document.querySelector(
          'uploader-file-preview, .file-preview-chip'
        );
        if (!chip || chip.offsetParent === null) return { ready: false, state: 'no-chip' };
        var stillLoading = !!chip.querySelector('.loading, [class*="loading"], .progress-spinner');
        var hasPreview = !!chip.querySelector('img[data-test-id="image-preview"], .image-preview.clickable, [data-test-id="file-name"]');
        return { ready: !stillLoading && hasPreview, state: stillLoading ? 'loading' : hasPreview ? 'ready' : 'waiting' };
      })()
    `),
    (s: any) => s.ready === true,
    500,
    timeoutMs,
    "waitForUpload",
  );
}

// ============================================================================
// Image save
// ============================================================================

async function saveGeneratedImage(
  wv: WebView,
  candidates: ImageCandidate[],
  outputPath: string,
) {
  if (candidates.length === 0) {
    throw new Error("No generated images found to save");
  }

  // Sort: display images first, larger area first, then links
  const sorted = [...candidates].sort((a, b) => {
    if (a.isDisplayImage !== b.isDisplayImage) return a.isDisplayImage ? -1 : 1;
    return (b.width * b.height) - (a.width * a.height);
  });

  let b64 = "";
  let savedSource = "";

  for (const candidate of sorted) {
    const rawUrl = candidate.source;
    const url = rawUrl.includes("gg-dl") ? ensureFullSizeImageUrl(rawUrl) : rawUrl;
    log(`Saving image (${candidate.kind}): ${url.slice(0, 80)}...`);

    try {
      if (url.startsWith("blob:")) {
        // Blob URLs expire — draw the img element to a canvas immediately
        b64 = await pageEval(wv, `
          (function() {
            return new Promise(function(resolve, reject) {
              // Find the img element with this blob src
              var imgs = document.querySelectorAll('img');
              var target = null;
              for (var i = 0; i < imgs.length; i++) {
                if ((imgs[i].currentSrc || imgs[i].src) === ${JSON.stringify(url)}) {
                  target = imgs[i]; break;
                }
              }
              if (!target) {
                // Fallback: try fetch while blob is still alive
                return fetch(${JSON.stringify(url)}, { credentials: "include" })
                  .then(function(r) { return r.blob(); })
                  .then(function(blob) { return blob.arrayBuffer(); })
                  .then(function(buf) {
                    var bytes = new Uint8Array(buf);
                    var binary = '';
                    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    resolve(btoa(binary));
                  })
                  .catch(function(e) { reject('fetch: ' + (e.message || String(e))); });
              }
              // Draw img to canvas → toDataURL; fall back to fetch if tainted
              var canvas = document.createElement('canvas');
              canvas.width = target.naturalWidth || target.width || 1024;
              canvas.height = target.naturalHeight || target.height || 1024;
              var ctx = canvas.getContext('2d');
              try {
                ctx.drawImage(target, 0, 0, canvas.width, canvas.height);
                var dataUrl = canvas.toDataURL('image/png');
                resolve(dataUrl.split(',')[1]);
              } catch(canvasErr) {
                // Canvas tainted or SecurityError — try fetch as last resort
                fetch(${JSON.stringify(url)}, { credentials: 'include' })
                  .then(function(r) { return r.blob(); })
                  .then(function(blob) { return blob.arrayBuffer(); })
                  .then(function(buf) {
                    var bytes = new Uint8Array(buf);
                    var binary = '';
                    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    resolve(btoa(binary));
                  })
                  .catch(function(fetchErr) {
                    reject('canvas: ' + (canvasErr.message || canvasErr) + ' | fetch: ' + (fetchErr.message || fetchErr));
                  });
              }
            });
          })()
        `);
      } else {
        // HTTP URL: fetch with credentials
        b64 = await pageEval(wv, `
          (function() {
            return new Promise(function(resolve, reject) {
              fetch(${JSON.stringify(url)}, { credentials: "include" })
                .then(function(r) {
                  if (!r.ok) throw new Error('HTTP ' + r.status);
                  return r.blob();
                })
                .then(function(blob) { return blob.arrayBuffer(); })
                .then(function(buf) {
                  var bytes = new Uint8Array(buf);
                  var binary = '';
                  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                  resolve(btoa(binary));
                })
                .catch(function(e) { reject(e.message || String(e)); });
            });
          })()
        `);
      }
      savedSource = url;
      break;
    } catch (err) {
      log(`Fetch failed for ${url.slice(0, 60)}: ${err}`);
    }
  }

  if (!b64) {
    throw new Error("All image candidate sources failed to fetch");
  }
  log(`Image fetched from: ${savedSource.slice(0, 80)}`);

  if (!b64 || typeof b64 !== "string") {
    throw new Error("Failed to download image bytes from page context");
  }

  // Ensure output directory exists
  const dir = require("path").dirname(outputPath);
  if (dir) {
    require("fs").mkdirSync(dir, { recursive: true });
  }

  // Write binary
  require("fs").writeFileSync(outputPath, Buffer.from(b64, "base64"));
  log(`Image saved to ${outputPath}`);
}

// ============================================================================
// Create image tool activation
// ============================================================================

/**
 * Activate the "Create image" tool in the Gemini input toolbar.
 * Verified activation: throws ui_changed if tool cannot be confirmed active.
 */
async function activateCreateImageTool(wv: WebView, timeoutMs = 5000): Promise<void> {
  // Shared text-matcher: "image" or "images" as first word (matches menu item AND active chip)
  // Used in alreadyActive check, menu click, and post-click verification.
  const IMAGE_TOOL_MATCH_JS = `(function isImageItem(text) {
    var t = text.toLowerCase().replace(/\\s+/g,' ').trim();
    var fw = t.split(' ')[0];
    return (fw === 'image' || fw === 'images') && !t.includes('video') && !t.includes('music') && !t.includes('canvas');
  })`;

  // Step 1: check if already active via aria-checked on menuitemcheckbox
  // (requires opening/closing the menu, but that's the only reliable signal)
  // Fallback: look for active dismiss-chip with matching text + close button
  const alreadyActive = await pageEval(wv, `
    (function() {
      var isImageItem = ${IMAGE_TOOL_MATCH_JS};
      // Check dismiss chip at bottom of input (has close/remove button inside)
      var chips = document.querySelectorAll('mat-chip, [class*="chip"]');
      for (var i = 0; i < chips.length; i++) {
        var c = chips[i];
        var hasClose = !!c.querySelector('button[aria-label*="close" i], button[aria-label*="remove" i], [class*="close"], [class*="remove"], mat-icon');
        if (hasClose && isImageItem(c.textContent || '')) return true;
      }
      return false;
    })()
  `);
  if (alreadyActive) { log("Create image tool: already active"); return; }

  // Step 2: wait for Tools button to appear (toolbar loads async), then click
  const toolsBtnDeadline = Date.now() + 4000;
  while (Date.now() < toolsBtnDeadline) {
    const ready = await pageEval(wv, `!!document.querySelector('button[aria-label="Tools"]')`);
    if (ready) break;
    await delay(300);
  }

  const openResult = await pageEval(wv, `
    (function() {
      // Direct aria selectors (case-insensitive where possible)
      var directSelectors = [
        'button[aria-label="Tools"]',
        'button[aria-label="Open tools"]',
        'button[aria-label="More options"]',
        'button[aria-label*="tool" i]',
        'button[aria-label*="more" i]',
        'button[data-test-id*="tool" i]',
      ];
      for (var s = 0; s < directSelectors.length; s++) {
        var btn = document.querySelector(directSelectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return 'direct:' + directSelectors[s]; }
      }

      // Scoped scan: find composer root near the editor
      var editor = document.querySelector('.ql-editor[contenteditable="true"]');
      var root = editor;
      var rootSelectors = ['form','[role="group"]','rich-textarea','message-input','[class*="input-area"]','[class*="composer"]'];
      for (var r = 0; r < rootSelectors.length && root; r++) {
        root = editor.closest(rootSelectors[r]) || root;
      }
      if (!root) root = document.body;

      // Scan visible buttons in root for + / tools button
      var btns = root.querySelectorAll('button');
      var labels = [];
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var aria = (b.getAttribute('aria-label') || '').toLowerCase();
        var text = (b.textContent || '').trim();
        var iconText = '';
        var icon = b.querySelector('mat-icon, [class*="material"]');
        if (icon) iconText = (icon.textContent || '').toLowerCase().trim();
        labels.push(aria || text.slice(0, 20));
        if (aria.includes('tool') || aria.includes('more') || aria.includes('add') ||
            text === '+' || iconText === 'add' || iconText === 'add_circle') {
          b.click();
          return 'scoped:' + (aria || text || iconText);
        }
      }
      return 'no-button|visible:' + labels.slice(0,8).join(',');
    })()
  `);

  log(`Create image tool open: ${openResult}`);
  if (openResult.startsWith("no-button")) {
    log("Warning: could not find tools button — relying on prompt prefix");
    return;
  }

  await delay(500);

  // Step 3: find and click "Images" in the overlay menu
  const clickResult = await pageEval(wv, `
    (function() {
      var isImageItem = ${IMAGE_TOOL_MATCH_JS};
      var roleSelectors = '[role="menuitemcheckbox"],[role="menuitemradio"],[role="menuitem"],[role="option"],mat-option';
      var items = document.querySelectorAll(roleSelectors);
      var found = [];
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var raw = (el.textContent || '').replace(/\\s+/g,' ').trim();
        found.push(raw.slice(0,30));
        if (!isImageItem(raw)) continue;
        // Skip if already checked (aria-checked="true") — clicking would toggle OFF
        var checked = el.getAttribute('aria-checked');
        if (checked === 'true') {
          return 'already-checked:' + raw.slice(0,30);
        }
        el.click();
        return 'clicked:' + raw.slice(0,30);
      }
      document.body.click();
      return 'not-found|items:' + found.join(';');
    })()
  `);

  log(`Create image tool click: ${clickResult}`);

  if (clickResult.startsWith("already-checked")) {
    log("Create image tool: already checked in menu — closing");
    await pageEval(wv, "document.body.click()");
    return;
  }

  if (!clickResult.startsWith("clicked")) {
    log("Warning: Create image item not found in menu — relying on prompt prefix");
    return;
  }

  await delay(300);

  // Step 4: verify chip appeared (poll up to timeoutMs) using same text-matcher
  const deadline = Date.now() + Math.min(timeoutMs, 3000);
  while (Date.now() < deadline) {
    await delay(300);
    const verified = await pageEval(wv, `
      (function() {
        var isImageItem = ${IMAGE_TOOL_MATCH_JS};
        var chips = document.querySelectorAll('mat-chip, [class*="chip"]');
        for (var i = 0; i < chips.length; i++) {
          var c = chips[i];
          var hasClose = !!c.querySelector('button[aria-label*="close" i], button[aria-label*="remove" i], [class*="close"], [class*="remove"], mat-icon');
          if (hasClose && isImageItem(c.textContent || '')) return true;
        }
        return false;
      })()
    `);
    if (verified) { log("Create image tool: verified active (chip)"); return; }
  }

  log("Warning: Create image chip not confirmed — proceeding anyway");
}

// ============================================================================
// Model selection (best-effort)
// ============================================================================

/**
 * Map model IDs to Gemini UI mode keywords.
 * The Gemini picker shows mode names like "Fast", "Thinking", "Pro" —
 * not raw model IDs. We match against the first word (mode name) or
 * fall back to substring search across the full menu item text.
 */
const MODEL_TO_MODE_KEYWORDS: Record<string, string[]> = {
  // Fast / Flash tier
  "gemini-3-pro":                   ["fast"],
  "gemini-2.5-flash":               ["fast"],
  "gemini-3.1-flash-lite-preview":  ["fast"],
  "gemini-3.1-flash":               ["fast"],
  // Thinking tier
  "gemini-3.1-thinking":            ["thinking"],
  "gemini-2.5-pro":                 ["thinking"],
  // Pro tier
  "gemini-3.1-pro-preview":         ["pro"],
  "gemini-3.1-pro":                 ["pro"],
};

function modelToModeKeywords(model: string): string[] {
  const norm = model.trim().toLowerCase();
  if (MODEL_TO_MODE_KEYWORDS[norm]) return MODEL_TO_MODE_KEYWORDS[norm];
  // Heuristic fallbacks for unknown model IDs
  if (norm.includes("pro"))      return ["pro"];
  if (norm.includes("thinking")) return ["thinking"];
  if (norm.includes("flash") || norm.includes("lite") || norm.includes("fast")) return ["fast"];
  return [];
}

async function trySelectModel(wv: WebView, model: string) {
  // Find the mode picker button (aria-label="Open mode picker")
  const hasPicker = await pageEval(wv, `
    !!(document.querySelector('[data-test-id="bard-mode-menu-button"]') ||
       document.querySelector('[aria-label="Open mode picker"]') ||
       document.querySelector('.model-picker-container button'))
  `);

  if (!hasPicker) {
    log(`No model picker found, continuing with default`);
    return;
  }

  // Click to open the menu
  await pageEval(wv, `
    (function() {
      var btn = document.querySelector('[data-test-id="bard-mode-menu-button"]')
        || document.querySelector('[aria-label="Open mode picker"]')
        || document.querySelector('.model-picker-container button');
      if (btn) btn.click();
    })()
  `);

  await delay(500);

  const keywords = modelToModeKeywords(model);

  const selected = await pageEval(wv, `
    (function() {
      var items = document.querySelectorAll('[role="menuitem"]');
      var keywords = ${JSON.stringify(keywords)};

      // First pass: match by leading mode keyword (e.g. "pro", "fast", "thinking")
      for (var i = 0; i < items.length; i++) {
        var text = (items[i].textContent || '').toLowerCase().trim();
        var firstWord = text.split(/\\s+/)[0];
        for (var k = 0; k < keywords.length; k++) {
          if (firstWord === keywords[k]) {
            items[i].click();
            return 'selected:' + firstWord;
          }
        }
      }

      // Second pass: substring match anywhere in text (handles future renames)
      for (var i = 0; i < items.length; i++) {
        var text = (items[i].textContent || '').toLowerCase();
        for (var k = 0; k < keywords.length; k++) {
          if (text.includes(keywords[k])) {
            items[i].click();
            return 'selected-fuzzy:' + keywords[k];
          }
        }
      }

      // Close menu, return list of available modes for diagnostic
      var modes = [];
      for (var i = 0; i < items.length; i++) {
        modes.push((items[i].textContent || '').trim().split('\\n')[0].trim().substring(0, 40));
      }
      document.body.click();
      return 'not-found|available:' + modes.join(',');
    })()
  `);

  if (selected.startsWith("selected")) {
    log(`Model "${model}" → mode ${selected}`);
    await delay(300);
  } else {
    log(`Model "${model}" not matched in picker (${selected}), continuing with current mode`);
  }
}

// ============================================================================
// Main worker flow
// ============================================================================

async function main() {
  let wv: WebView | null = null;

  try {
    // Parse stdin
    const raw = await Bun.stdin.text();
    if (!raw.trim()) {
      throw Object.assign(new Error("Empty stdin"), { code: "protocol_error" });
    }

    let req: WorkerRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("Invalid JSON on stdin"), {
        code: "protocol_error",
      });
    }

    if (!req.prompt && !req.generateImage && !req.editImage) {
      throw Object.assign(new Error("prompt required"), {
        code: "protocol_error",
      });
    }

    const startTime = Date.now();
    const resolvedModel = resolveGeminiModelForUI(req.model);
    const fullPrompt = buildGeminiPrompt({
      prompt: req.prompt,
      youtube: req.youtube,
      aspectRatio: req.aspectRatio,
      generateImage: req.generateImage,
      editImage: req.editImage,
    });
    const timeoutMs = req.timeoutMs || 300000;
    const hasFile = !!(req.file || req.editImage);
    const wantsImage = !!(req.generateImage || req.editImage);

    // Build step list dynamically based on request
    const stepNames: string[] = [
      "Launching browser",
      ...(process.platform === "darwin" ? ["Authenticating"] : []),
      "Loading Gemini",
      ...(hasFile ? ["Uploading file"] : []),
      "Sending prompt",
      "Waiting for response",
      ...(wantsImage ? ["Saving image"] : []),
    ];
    const progress = new Progress(stepNames);

    // Validate files exist
    if (req.file) {
      const fs = require("fs");
      if (!fs.existsSync(req.file)) {
        throw Object.assign(new Error(`File not found: ${req.file}`), {
          code: "upload_failed",
        });
      }
    }
    if (req.editImage) {
      const fs = require("fs");
      if (!fs.existsSync(req.editImage)) {
        throw Object.assign(new Error(`File not found: ${req.editImage}`), {
          code: "upload_failed",
        });
      }
    }

    // Step: Launch browser
    progress.step(resolvedModel);
    wv = new Bun.WebView({ headless: true, backend: "chrome" });

    // Pre-navigation staging on about:blank (required for cookie injection + stealth)
    await wv.navigate("about:blank");
    await delay(200);

    // Step: Authenticate (macOS only — inject cookies from Chrome profile)
    if (process.platform === "darwin") {
      progress.step(req.profileEmail || "default profile");
      try {
        const { loadAndInjectGeminiCookies } = await import(
          "./gemini-bun-profile-auth.ts"
        );
        await loadAndInjectGeminiCookies(wv, {
          profileEmail: req.profileEmail ?? null,
        });
      } catch (authErr: any) {
        // If profile was explicitly requested, fail hard
        if (req.profileEmail) {
          throw authErr;
        }
        // Otherwise, log and continue (may hit login page)
        log(`Cookie injection skipped: ${authErr.message}`);
      }
    } else if (req.profileEmail) {
      throw Object.assign(
        new Error("--profile is only supported on macOS"),
        { code: "profile_unsupported_platform" },
      );
    }

    // CDP stealth patches — reduce headless fingerprint before target navigation
    try {
      const { applyCdpStealth } = require("./cdp-stealth.cjs");
      const stealthResult = await applyCdpStealth(wv);
      log(`Stealth: UA=${stealthResult.uaOverrideApplied}, script=${stealthResult.initScriptApplied}`);
    } catch (stealthErr: any) {
      log(`CDP stealth skipped: ${stealthErr.message}`);
    }

    // Step: Load Gemini
    progress.step();
    await wv.navigate(GEMINI_APP_URL);
    await delay(1000);

    try {
      await waitForReady(wv, Math.min(timeoutMs, 20000));
    } catch {
      const hasLogin = await pageEval(
        wv,
        "!!document.querySelector('input[type=\"email\"]')",
      );
      if (hasLogin) {
        throw Object.assign(
          new Error(
            "Gemini login required. Sign into gemini.google.com in Chrome and try again.",
          ),
          { code: "login_required" },
        );
      }
      throw Object.assign(new Error("Gemini page did not become ready"), {
        code: "ui_changed",
      });
    }

    // Model selection (best-effort, no separate step).
    // Always attempt when model was explicitly requested (req.model set).
    const DEFAULT_MODEL = "gemini-3-pro";
    if (req.model || resolvedModel !== DEFAULT_MODEL) {
      await trySelectModel(wv, resolvedModel);
    }

    // Step: Upload file
    if (hasFile) {
      const filePath = req.editImage || req.file!;
      const fileName = require("path").basename(filePath);
      progress.step(fileName);
      await uploadFileViaCDP(wv, filePath, Math.min(timeoutMs, 30000));
    }

    // Activate Create image tool BEFORE baseline capture and typing
    const needsCreateImageTool = !!req.generateImage;
    const expectsImageOutput = !!(req.generateImage || req.editImage);
    if (needsCreateImageTool) {
      await activateCreateImageTool(wv, 5000);
    }

    // Capture baseline state after tool activation, before submitting
    const baseline = await pollResponseState(wv);

    // Step: Send prompt
    const promptPreview = fullPrompt.length > 60
      ? fullPrompt.slice(0, 57) + "..."
      : fullPrompt;
    progress.step(promptPreview);
    await focusEditor(wv);
    await delay(100);
    await wv.type(fullPrompt);
    await delay(200);

    // Verify text was entered
    const editorContent = await readEditorContent(wv);
    if (!editorContent || editorContent.trim().length === 0) {
      log("Warning: editor appears empty after typing");
    }

    await waitForSendButton(wv);
    await clickSend(wv);

    // Step: Wait for response
    progress.step();
    const { text: responseText, imageCandidates: newImageCandidates } =
      await waitForResponse(wv, baseline, timeoutMs, expectsImageOutput);

    if (!responseText && newImageCandidates.length === 0) {
      throw Object.assign(new Error("Empty response from Gemini"), {
        code: "timeout",
      });
    }

    // Handle image save
    let imagePath: string | null = null;
    const imageCount = newImageCandidates.length;

    if (expectsImageOutput && newImageCandidates.length > 0) {
      const outputPath = resolveImageOutputPath({
        output: req.output,
        generateImage: req.generateImage,
        editImage: req.editImage,
      });
      progress.step(outputPath);
      await saveGeneratedImage(wv, newImageCandidates, outputPath);
      imagePath = outputPath;
    }

    const tookMs = Date.now() - startTime;
    const responsePreview = responseText.length > 80
      ? responseText.slice(0, 77) + "..."
      : responseText;
    progress.done(`${responsePreview} (${resolvedModel}, ${(tookMs / 1000).toFixed(1)}s)`);

    // Emit result
    const result: WorkerResponse = {
      ok: true,
      result: {
        response: responseText,
        model: resolvedModel,
        tookMs,
        imagePath,
        imageCount,
        thoughts: null,
      },
    };
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err: any) {
    const code = err.code || "unknown";
    // Hard failures: explicit user choices that shouldn't silently fall back
    const hardFailCodes = new Set([
      "upload_failed",           // file doesn't exist — not a transient issue
      "profile_not_found",       // --profile specified but not found
      "profile_ambiguous",       // --profile matched multiple profiles
      "profile_unsupported_platform",
    ]);
    // Everything else (including "unknown" DOM/CDP failures) recommends fallback
    // so the legacy extension path gets a chance. The CLI will override this
    // and hard-fail if --profile was explicitly passed by the user.
    const fallbackRecommended = !hardFailCodes.has(code);

    const errorResp: WorkerError = {
      ok: false,
      code,
      error: err.message || String(err),
      fallbackRecommended,
    };
    process.stdout.write(JSON.stringify(errorResp) + "\n");
    process.exit(1);
  } finally {
    if (wv) {
      try {
        wv.close();
      } catch {}
    }
  }
}

main();
