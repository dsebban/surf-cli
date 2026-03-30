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

interface PollState {
  text: string;
  imageUrls: string[];
  loading: boolean;
  turnCount: number;
}

async function pollResponseState(wv: WebView): Promise<PollState> {
  return pageEval(wv, `
    (function() {
      var turns = document.querySelectorAll('model-response');
      var last = turns.length > 0 ? turns[turns.length - 1] : null;

      var text = '';
      if (last) {
        var mc = last.querySelector('message-content');
        text = mc ? (mc.textContent || '').trim() : (last.textContent || '').trim();
      }

      var imgs = [];
      var imgEls = document.querySelectorAll('img[src*="gg-dl"]');
      for (var i = 0; i < imgEls.length; i++) {
        if (imgEls[i].naturalWidth >= 512) imgs.push(imgEls[i].src);
      }

      var loading = !!(
        document.querySelector('mat-progress-bar') ||
        document.querySelector('.loading-indicator') ||
        document.querySelector('message-loading')
      );

      return { text: text, imageUrls: imgs, loading: loading, turnCount: turns.length };
    })()
  `);
}

async function waitForResponse(
  wv: WebView,
  baselineTurnCount: number,
  baselineImageUrls: string[],
  timeoutMs: number,
): Promise<{ text: string; imageUrls: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let stableCount = 0;
  // Only track content AFTER a new turn has been observed, to prevent
  // returning stale text from a previous conversation on timeout.
  let sawNewTurn = false;
  let lastNewTurnText = "";
  let lastNewTurnImgCount = 0;
  const baselineImgSet = new Set(baselineImageUrls);

  while (Date.now() < deadline) {
    await delay(600);

    const state = await pollResponseState(wv);
    const newImgs = state.imageUrls.filter((u) => !baselineImgSet.has(u));
    const hasNewTurn = state.turnCount > baselineTurnCount;

    if (hasNewTurn) {
      sawNewTurn = true;
      const hasContent = !!(state.text && state.text.length > 0) || newImgs.length > 0;

      if (hasContent && !state.loading) {
        // Stability: same content on 2 consecutive polls → done
        if (state.text === lastNewTurnText && newImgs.length === lastNewTurnImgCount) {
          stableCount++;
          if (stableCount >= 2) {
            return { text: state.text, imageUrls: newImgs };
          }
        } else {
          stableCount = 0;
        }
        lastNewTurnText = state.text;
        lastNewTurnImgCount = newImgs.length;
      } else {
        stableCount = 0;
      }
    }
  }

  // Timeout — only return cached content if a new turn was actually observed
  if (sawNewTurn && lastNewTurnText) {
    const state = await pollResponseState(wv);
    const newImgs = state.imageUrls.filter((u) => !baselineImgSet.has(u));
    return { text: lastNewTurnText, imageUrls: newImgs };
  }

  throw Object.assign(
    new Error(`Response timed out after ${timeoutMs}ms — ${sawNewTurn ? "new turn seen but no stable content" : "Gemini never produced a new turn (send may have failed)"}`),
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

  // Click the upload/attachment button
  const clickedUpload = await pageEval(wv, `
    (function() {
      // Try multiple known selectors for the upload trigger
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
    // Fallback: try to find a hidden file input directly
    log("Upload button not found, trying direct file input...");
  } else {
    // Wait for menu to appear, then click "Upload file" option
    await delay(500);
    await pageEval(wv, `
      (function() {
        // Click the file upload option in the menu
        var items = document.querySelectorAll('[role="menuitem"], [data-test-id*="local-images-files-uploader-button"]');
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
    await delay(300);
  }

  // Poll for the file input element via CDP (may appear async after menu click)
  let fileNodeId: number | null = null;
  const inputDeadline = Date.now() + Math.min(timeoutMs, 10000);
  while (Date.now() < inputDeadline) {
    const docResult = (await wv.cdp("DOM.getDocument")) as any;
    const rootNodeId = docResult.root.nodeId;
    const searchResult = (await wv.cdp("DOM.querySelectorAll", {
      nodeId: rootNodeId,
      selector: 'input[type="file"]',
    })) as any;

    const nodeIds: number[] = searchResult?.nodeIds || [];
    if (nodeIds.length > 0) {
      fileNodeId = nodeIds[0];
      break;
    }
    await delay(300);
  }

  if (fileNodeId === null) {
    throw new Error("No file input found on page for upload (polled until timeout)");
  }

  // Set files on the discovered file input
  await wv.cdp("DOM.setFileInputFiles", {
    nodeId: fileNodeId,
    files: [filePath],
  });

  log("File set on input, waiting for processing...");

  // Wait for file preview chip to appear AND finish processing.
  // The chip transitions: .image-preview.loading → .image-preview.clickable <img>
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

  log("File upload complete");
}

// ============================================================================
// Image save
// ============================================================================

async function saveGeneratedImage(
  wv: WebView,
  imageUrls: string[],
  outputPath: string,
) {
  if (imageUrls.length === 0) {
    throw new Error("No generated images found to save");
  }

  const url = ensureFullSizeImageUrl(imageUrls[0]);
  log(`Saving image: ${url.slice(0, 80)}...`);

  // Download image bytes via page context (authenticated)
  const b64 = await pageEval(wv, `
    (function() {
      return new Promise(function(resolve, reject) {
        fetch("${url}", { credentials: "include" })
          .then(function(r) { return r.blob(); })
          .then(function(blob) { return blob.arrayBuffer(); })
          .then(function(buf) {
            var bytes = new Uint8Array(buf);
            var binary = '';
            for (var i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            resolve(btoa(binary));
          })
          .catch(function(e) { reject(e); });
      });
    })()
  `);

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

    // Step: Authenticate (macOS only — inject cookies from Chrome profile)
    // CDP requires an active session, so navigate to about:blank first.
    if (process.platform === "darwin") {
      progress.step(req.profileEmail || "default profile");
      try {
        await wv.navigate("about:blank");
        await delay(200);
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

    // Capture baseline state before submitting
    const baseline = await pollResponseState(wv);
    const baselineTurnCount = baseline.turnCount;
    const baselineImageUrls = baseline.imageUrls;

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
    const { text: responseText, imageUrls: newImageUrls } =
      await waitForResponse(
        wv,
        baselineTurnCount,
        baselineImageUrls,
        timeoutMs,
      );

    if (!responseText && newImageUrls.length === 0) {
      throw Object.assign(new Error("Empty response from Gemini"), {
        code: "timeout",
      });
    }

    // Handle image save
    let imagePath: string | null = null;
    let imageCount = newImageUrls.length;

    if (wantsImage && newImageUrls.length > 0) {
      const outputPath = resolveImageOutputPath({
        output: req.output,
        generateImage: req.generateImage,
        editImage: req.editImage,
      });
      progress.step(outputPath);
      await saveGeneratedImage(wv, newImageUrls, outputPath);
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
