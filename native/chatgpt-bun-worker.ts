#!/usr/bin/env bun
/// <reference path="./bun-webview.d.ts" />
/**
 * Bun WebView worker for ChatGPT queries.
 *
 * Standalone Bun script — reads one JSON request from stdin,
 * drives a headless Chrome-backed WebView against chatgpt.com,
 * writes one JSON result to stdout.
 *
 * Protocol:
 *   stdin  → WorkerRequest  (JSON)
 *   stdout → WorkerResponse (JSON)
 *   stderr → diagnostics (never JSON)
 */

// ============================================================================
// Constants & selectors
// ============================================================================

const CHATGPT_URL = "https://chatgpt.com/";

const SEL = {
  // Editor / input
  editor: '#prompt-textarea, [data-testid="composer-textarea"], .ProseMirror, [contenteditable="true"][data-virtualkeyboard="true"]',
  sendButton: 'button[data-testid="send-button"], button[data-testid*="composer-send"], form button[type="submit"]',

  // Model picker
  modelButton: '[data-testid="model-switcher-dropdown-button"]',
  menuItem: 'div[role="menuitem"], [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]',

  // Response — section first (current DOM), then article/div fallbacks
  stopButton: '[data-testid="stop-button"]',
  finishedActions: 'button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"]',
  conversationTurn: 'section[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]',

  // Upload
  fileInput: 'input[type="file"]',
  attachButton: 'button[aria-label="Attach files"], button[aria-label="Upload file"], button[data-testid="composer-attach-button"]',

  // Cloudflare / login
  cloudflareScript: 'script[src*="/challenge-platform/"]',
} as const;

// ============================================================================
// Types
// ============================================================================

interface WorkerRequest {
  prompt: string;
  model?: string;
  file?: string | null;
  generateImage?: string | null;
  timeoutMs?: number;
  profileEmail?: string | null;
}

interface WorkerResult {
  response: string;
  model: string;
  tookMs: number;
  imagePath: string | null;
  messageId: string | null;
  partial: boolean;
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
// Logging & progress
// ============================================================================

function log(msg: string) {
  process.stderr.write(`[bun-chatgpt] ${msg}\n`);
}

class Progress {
  private current = 0;
  private total: number;
  private startMs = Date.now();
  private steps: string[];

  constructor(steps: string[]) {
    this.total = steps.length;
    this.steps = steps;
  }

  step(detail?: string) {
    this.current++;
    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
    const label = this.steps[this.current - 1] || "Working";
    const suffix = detail ? ` — ${detail}` : "";
    process.stderr.write(
      `[bun-chatgpt] [${this.current}/${this.total}] ${label}${suffix} (${elapsed}s)\n`,
    );
  }

  done(detail: string) {
    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
    process.stderr.write(
      `[bun-chatgpt] ✓ Done — ${detail} (${elapsed}s)\n`,
    );
  }
}

// ============================================================================
// Helpers
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

type WebView = InstanceType<typeof Bun.WebView>;

async function pageEval(wv: WebView, js: string): Promise<any> {
  try {
    return await wv.evaluate(js);
  } catch (e: any) {
    throw new Error(`evaluate failed: ${e?.message ?? e}`);
  }
}

// ============================================================================
// Readiness & login
// ============================================================================

async function waitForReady(wv: WebView, timeoutMs: number) {
  return pollUntil(
    async () => {
      const hasEditor = await pageEval(
        wv,
        `!!document.querySelector('${SEL.editor}')`,
      );
      const hasLogin = await pageEval(
        wv,
        `!!document.querySelector('input[type="email"]')`,
      );
      return { hasEditor, hasLogin };
    },
    (v) => v.hasEditor || v.hasLogin,
    300,
    timeoutMs,
    "waitForReady",
  );
}

async function isCloudflareBlocked(wv: WebView): Promise<boolean> {
  return pageEval(wv, `
    (function() {
      var title = document.title.toLowerCase();
      if (title.includes("just a moment")) return true;
      return !!document.querySelector('${SEL.cloudflareScript}');
    })()
  `);
}

async function checkLoginStatus(wv: WebView): Promise<{ loggedIn: boolean; hasLoginCta: boolean }> {
  return pageEval(wv, `
    (async function() {
      try {
        var r = await fetch('/backend-api/me', { cache: 'no-store', credentials: 'include' });
        var hasLoginCta = Array.from(document.querySelectorAll('a[href*="/auth/login"], button'))
          .some(function(el) {
            var t = (el.textContent || '').toLowerCase().trim();
            return t.startsWith('log in') || t.startsWith('sign in') || t.startsWith('sign up');
          });
        return { loggedIn: r.status === 200, hasLoginCta: hasLoginCta };
      } catch(e) {
        return { loggedIn: false, hasLoginCta: true };
      }
    })()
  `);
}

// ============================================================================
// Editor interaction
// ============================================================================

async function focusEditor(wv: WebView) {
  const focused = await pageEval(wv, `
    (function() {
      var selectors = ${JSON.stringify(SEL.editor)}.split(', ');
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (!el) continue;
        el.click();
        if (typeof el.focus === 'function') el.focus();
        return true;
      }
      return false;
    })()
  `);
  if (!focused) throw new Error("Failed to focus editor");
}

async function readEditorContent(wv: WebView): Promise<string> {
  return pageEval(wv, `
    (function() {
      var selectors = ${JSON.stringify(SEL.editor)}.split(', ');
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (!el) continue;
        return (el.innerText || el.value || el.textContent || '').trim();
      }
      return '';
    })()
  `);
}

async function waitForSendButton(wv: WebView, timeoutMs = 5000) {
  try {
    await pollUntil(
      () => pageEval(wv, `
        (function() {
          var selectors = ${JSON.stringify(SEL.sendButton)}.split(', ');
          for (var i = 0; i < selectors.length; i++) {
            var btn = document.querySelector(selectors[i]);
            if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
          }
          return false;
        })()
      `),
      (v) => v === true,
      150,
      timeoutMs,
      "waitForSendButton",
    );
  } catch {
    // Non-fatal
  }
}

async function clickSend(wv: WebView): Promise<string> {
  const method = await pageEval(wv, `
    (function() {
      var selectors = ${JSON.stringify(SEL.sendButton)}.split(', ');
      for (var i = 0; i < selectors.length; i++) {
        var btn = document.querySelector(selectors[i]);
        if (btn && !btn.disabled) { btn.click(); return 'button'; }
      }
      return 'none';
    })()
  `);
  if (method === "button") return method;
  await wv.press("Enter");
  return "enter";
}

// ============================================================================
// Model selection
// ============================================================================

// Synthetic click dispatcher for Radix UI controls (simple .click() doesn't work)
const CLICK_DISPATCH_JS = `function dispatchClick(target) {
  if (!target) return false;
  var types = ['pointerdown','mousedown','pointerup','mouseup','click'];
  for (var i = 0; i < types.length; i++) {
    var type = types[i];
    var common = { bubbles: true, cancelable: true, view: window };
    var event;
    if (type.startsWith('pointer') && 'PointerEvent' in window) {
      event = new PointerEvent(type, Object.assign({}, common, { pointerId: 1, pointerType: 'mouse' }));
    } else {
      event = new MouseEvent(type, common);
    }
    target.dispatchEvent(event);
  }
  return true;
}`;

async function trySelectModel(wv: WebView, model: string): Promise<void> {
  const { buildChatGptModelSelectionSpec } = require("./chatgpt-bun-worker-logic.ts");
  const spec = buildChatGptModelSelectionSpec(model);
  log(`Model "${model}" → mode=${spec.mode}, testIds=[${spec.preferredTestIdFragments.join(",")}]`);

  // Check if model picker exists
  const hasButton = await pageEval(wv, `!!document.querySelector('${SEL.modelButton}')`);
  if (!hasButton) {
    log("Model picker not found — continuing with current model");
    return;
  }

  // Open picker with synthetic click dispatch (Radix controls need full event sequence)
  await pageEval(wv, `
    (function() {
      ${CLICK_DISPATCH_JS}
      var btn = document.querySelector('${SEL.modelButton}');
      if (btn) dispatchClick(btn);
    })()
  `);

  // Poll for menu items to appear (up to 3s)
  let menuReady = false;
  const menuDeadline = Date.now() + 3000;
  while (Date.now() < menuDeadline) {
    await delay(200);
    menuReady = await pageEval(wv, `!!document.querySelector('${SEL.menuItem}')`);
    if (menuReady) break;
  }

  if (!menuReady) {
    log("Model picker menu did not appear — continuing with current model");
    return;
  }

  // Score menu items against spec
  const selected = await pageEval(wv, `
    (function() {
      ${CLICK_DISPATCH_JS}
      var preferredTestIds = ${JSON.stringify(spec.preferredTestIdFragments)};
      var preferredTexts = ${JSON.stringify(spec.preferredTextFragments)};
      var rawFragments = ${JSON.stringify(spec.fallbackRawFragments)};

      var items = document.querySelectorAll('${SEL.menuItem}');
      var bestMatch = null;
      var bestScore = 0;
      var bestBy = '';
      var available = [];

      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var testId = (el.getAttribute('data-testid') || '').toLowerCase();
        var text = (el.textContent || '').replace(/\\s+/g,' ').trim().toLowerCase();
        var label = (el.textContent || '').replace(/\\s+/g,' ').trim().split('\\n')[0].slice(0, 40);
        if (testId.includes('configure')) continue;
        available.push(label + ' [' + testId + ']');

        var score = 0;
        var by = '';
        // Preferred testid: highest priority
        for (var t = 0; t < preferredTestIds.length; t++) {
          if (testId.includes(preferredTestIds[t])) { score = 300; by = 'testid:' + preferredTestIds[t]; break; }
        }
        // Preferred text keyword
        if (score < 200) {
          for (var t = 0; t < preferredTexts.length; t++) {
            if (text.includes(preferredTexts[t])) { score = Math.max(score, 200); by = by || 'text:' + preferredTexts[t]; break; }
          }
        }
        // Raw fragment fallback
        if (score < 100) {
          for (var t = 0; t < rawFragments.length; t++) {
            if (text.includes(rawFragments[t]) || testId.includes(rawFragments[t])) {
              score = Math.max(score, 100); by = by || 'raw:' + rawFragments[t]; break;
            }
          }
        }
        if (score > bestScore) { bestScore = score; bestMatch = el; bestBy = by; }
      }

      if (bestMatch) {
        dispatchClick(bestMatch);
        return 'selected:' + (bestMatch.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 40) + '|by:' + bestBy;
      }
      document.body.click();
      return 'not-found|available:' + available.join('; ');
    })()
  `);

  if (selected.startsWith("selected")) {
    log(`Model "${model}" → ${selected}`);
    await delay(300);
  } else {
    log(`Model "${model}" not matched in picker (${selected}), continuing with current model`);
  }
}

// ============================================================================
// File upload via CDP
// ============================================================================

async function uploadFileViaCDP(
  wv: WebView,
  filePath: string,
  timeoutMs: number,
): Promise<void> {
  // Enable DOM + find file input
  await wv.cdp("DOM.enable");

  // Try clicking attach button to reveal file input
  await pageEval(wv, `
    (function() {
      var selectors = ${JSON.stringify(SEL.attachButton)}.split(', ');
      for (var i = 0; i < selectors.length; i++) {
        var btn = document.querySelector(selectors[i]);
        if (btn) { btn.click(); return 'clicked'; }
      }
      return 'no-button';
    })()
  `);
  await delay(400);

  // Find the file input element
  const doc = await wv.cdp("DOM.getDocument", { depth: 0 });
  const rootId = doc.root.nodeId;

  let inputNodeId: number | null = null;

  // Try multiple selectors for file input
  for (const selector of ["input[type='file']", "input[accept]"]) {
    try {
      const result = await wv.cdp("DOM.querySelector", {
        nodeId: rootId,
        selector,
      });
      if (result.nodeId) {
        inputNodeId = result.nodeId;
        break;
      }
    } catch {}
  }

  if (!inputNodeId) {
    throw Object.assign(new Error("File input not found in DOM"), {
      code: "upload_failed",
    });
  }

  // Set file
  await wv.cdp("DOM.setFileInputFiles", {
    nodeId: inputNodeId,
    files: [filePath],
  });

  log(`File set via CDP: ${require("path").basename(filePath)}`);

  // Poll for upload confirmation (attachment chip/preview appears)
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  while (Date.now() < deadline) {
    await delay(500);
    const hasAttachment = await pageEval(wv, `
      (function() {
        // Look for attachment indicators
        var indicators = document.querySelectorAll(
          '[data-testid*="attachment"], [data-testid*="file"], [class*="attachment"], [class*="upload"]'
        );
        for (var i = 0; i < indicators.length; i++) {
          if (indicators[i].offsetParent !== null || indicators[i].clientWidth > 0) return true;
        }
        // Also check if file input value was set
        var input = document.querySelector('input[type="file"]');
        if (input && input.files && input.files.length > 0) return true;
        return false;
      })()
    `);
    if (hasAttachment) {
      log("File upload confirmed");
      return;
    }
  }

  // Non-fatal: file may have been accepted without visible indicator
  log("Warning: upload confirmation not detected, proceeding anyway");
}

// ============================================================================
// Image generation tool activation
// ============================================================================

async function activateImageTool(wv: WebView, timeoutMs = 5000): Promise<void> {
  // ChatGPT may support DALL-E image generation via tool activation or just
  // via prompt prefix. Try to find and activate the image tool if available.

  // Look for a "Create image" or image-related tool button/chip
  const activated = await pageEval(wv, `
    (function() {
      // Check if there's an image tool toggle/button
      var btns = document.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null && b.clientWidth === 0) continue;
        var text = (b.textContent || '').toLowerCase().trim();
        var aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if ((text.includes('create image') || text.includes('dall') || text.includes('image generation') ||
             aria.includes('create image') || aria.includes('dall') || aria.includes('image generation')) &&
            !text.includes('video')) {
          b.click();
          return 'clicked:' + text.slice(0, 40);
        }
      }
      return 'not-found';
    })()
  `);

  if (activated.startsWith("clicked")) {
    log(`Image tool: ${activated}`);
    await delay(300);
    return;
  }

  // ChatGPT 4o and later models have native image gen without tool activation.
  // The prompt prefix "Generate an image:" should be sufficient.
  log("Image tool button not found — relying on prompt prefix (GPT-4o+ native image gen)");
}

// ============================================================================
// SSE stream interception — capture response text from fetch, not DOM
// ============================================================================

/**
 * Inject a fetch monkey-patch AFTER page load (post-auth/sentinel setup).
 * ChatGPT's conversation API returns SSE with delta_encoding v1 format.
 * Must be called AFTER navigating to chatgpt.com and verifying login.
 *
 * The hook intercepts POST to /backend-api/f/conversation or /backend-api/conversation,
 * clones the response, reads the SSE stream, and parses:
 *   - legacy full-message: {message: {content: {parts: [...]}}}
 *   - nested v.message:    {v: {message: {content: {parts: [...]}}}}
 *   - delta v1 single op:  {o: "append", p: "/message/content/parts/0", v: "chunk"}
 *   - delta v1 batch ops:  {v: [{o, p, v}, ...]}
 *   - sentinels: [DONE], message_stream_complete
 */
async function injectFetchStreamCapture(wv: WebView): Promise<void> {
  await pageEval(wv, `
    (function() {
      window.__surfChatResponse = { text: '', done: false, messageId: null, model: null, parts: [] };
      var origFetch = window.fetch;
      window.fetch = function() {
        var args = arguments;
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        var opts = args[1] || {};
        var method = (opts.method || 'GET').toUpperCase();
        var result = origFetch.apply(this, args);
        var isConv = method === 'POST' && (url.indexOf('/backend-api/f/conversation') !== -1 || url.indexOf('/backend-api/conversation') !== -1);
        if (isConv) {
          result.then(function(resp) {
            if (!resp.body || !resp.ok) return;
            // Reset state for new conversation
            window.__surfChatResponse = { text: '', done: false, messageId: null, model: null, parts: [] };
            var clone = resp.clone();
            var reader = clone.body.getReader();
            var decoder = new TextDecoder();
            var buf = '';
            function pump() {
              reader.read().then(function(chunk) {
                if (chunk.done) { window.__surfChatResponse.done = true; return; }
                buf += decoder.decode(chunk.value, { stream: true });
                var lines = buf.split('\\n');
                buf = lines.pop() || '';
                for (var i = 0; i < lines.length; i++) {
                  var line = lines[i].trim();
                  if (!line) continue;
                  if (line.indexOf('event:') === 0) continue;
                  if (line.indexOf('data: ') === 0) line = line.slice(6).trim();
                  if (line === '[DONE]') { window.__surfChatResponse.done = true; continue; }
                  if (line === 'message_stream_complete') { window.__surfChatResponse.done = true; continue; }
                  if (line[0] !== '{') continue;
                  try {
                    var obj = JSON.parse(line);
                    if (obj.type === 'message_stream_complete') { window.__surfChatResponse.done = true; continue; }
                    // Legacy / nested message format
                    var msg = (obj.v && obj.v.message) || obj.message;
                    if (msg && msg.author && msg.author.role === 'assistant' && msg.content && msg.content.parts) {
                      var t = msg.content.parts.join('');
                      if (t) { window.__surfChatResponse.text = t; window.__surfChatResponse.parts = msg.content.parts.slice(); }
                      if (msg.id) window.__surfChatResponse.messageId = msg.id;
                      if (msg.metadata && msg.metadata.model_slug) window.__surfChatResponse.model = msg.metadata.model_slug;
                      if (msg.status === 'finished_successfully') window.__surfChatResponse.done = true;
                      continue;
                    }
                    // Delta v1 single op: {o, p, v}
                    if (typeof obj.o === 'string' && typeof obj.p === 'string') {
                      applyOp(obj);
                      continue;
                    }
                    // Delta v1 batch ops: {v: [{o, p, v}, ...]}
                    if (Array.isArray(obj.v)) {
                      for (var j = 0; j < obj.v.length; j++) {
                        var op = obj.v[j];
                        if (typeof op.o === 'string' && typeof op.p === 'string') applyOp(op);
                      }
                      continue;
                    }
                  } catch(e) {}
                }
                pump();
              }).catch(function() { window.__surfChatResponse.done = true; });
            }
            function applyOp(op) {
              var r = window.__surfChatResponse;
              var m = op.p.match(/^\\/message\\/content\\/parts\\/(\\d+)$/);
              if (m) {
                var idx = parseInt(m[1], 10);
                while (r.parts.length <= idx) r.parts.push('');
                if (op.o === 'append' && typeof op.v === 'string') r.parts[idx] += op.v;
                else if (op.o === 'replace') r.parts[idx] = typeof op.v === 'string' ? op.v : JSON.stringify(op.v);
                r.text = r.parts.join('');
                return;
              }
              if (op.p === '/message/status' && op.o === 'replace' && op.v === 'finished_successfully') { r.done = true; return; }
              if (op.p === '/message/id' && op.o === 'replace' && typeof op.v === 'string') { r.messageId = op.v; return; }
              if (op.p === '/message/metadata/model_slug' && op.o === 'replace' && typeof op.v === 'string') { r.model = op.v; return; }
            }
            pump();
          }).catch(function() {});
        }
        return result;
      };
    })()
  `);
}

/**
 * Read the captured stream response.
 */
async function readStreamResponse(wv: WebView): Promise<{ text: string; done: boolean; messageId: string | null; model: string | null }> {
  return pageEval(wv, `window.__surfChatResponse || { text: '', done: false, messageId: null, model: null }`);
}

// ============================================================================
// Response polling
// ============================================================================

interface ImageCandidate {
  source: string;
  kind: "img" | "link";
  width: number;
  height: number;
  fingerprint: string;
  isDisplayImage: boolean;
}

interface PollState {
  text: string;
  imageCandidates: ImageCandidate[];
  isStreaming: boolean;
  isThinking: boolean; // stop button visible + no .markdown text + "Thinking" label
  thinkingLabel: string; // e.g. "Thinking", "Analyzing image", "Searching"
  assistantTurnCount: number;
  latestAssistantTurnId: string | null; // stable: data-testid or index
  messageId: string | null;
  finished: boolean;
}

async function pollResponseState(wv: WebView): Promise<PollState> {
  return pageEval(wv, `
    (function() {
      var TURN_SEL = '${SEL.conversationTurn}';
      var STOP_SEL = '${SEL.stopButton}';
      var FINISH_SEL = '${SEL.finishedActions}';

      // Classify turn as assistant via .sr-only label (primary) or data attributes (fallback)
      var isAssistant = function(node) {
        if (!(node instanceof HTMLElement)) return false;
        // Primary: .sr-only text "ChatGPT said:" / "Assistant said:"
        var sr = node.querySelector('.sr-only');
        if (sr) {
          var srText = (sr.textContent || '').toLowerCase().trim();
          if (srText.includes('chatgpt said') || srText.includes('assistant said')) return true;
          if (srText.includes('you said') || srText.includes('user said')) return false;
        }
        // Fallback: data attributes (older DOM)
        var role = (node.getAttribute('data-message-author-role') || '').toLowerCase();
        if (role === 'assistant') return true;
        if (role === 'user') return false;
        var turn = (node.getAttribute('data-turn') || '').toLowerCase();
        if (turn === 'assistant') return true;
        // If we still can't tell, check for assistant message selector
        return !!node.querySelector('[data-message-author-role="assistant"]');
      };

      var turns = document.querySelectorAll(TURN_SEL);
      var lastAssistant = null;
      var assistantCount = 0;
      for (var i = turns.length - 1; i >= 0; i--) {
        if (isAssistant(turns[i])) {
          assistantCount++;
          if (!lastAssistant) lastAssistant = turns[i];
        }
      }

      var text = '';
      var messageId = null;
      var finished = false;
      var latestAssistantTurnId = null;
      if (lastAssistant) {
        // Stable turn ID from data-testid (e.g. "conversation-turn-2")
        latestAssistantTurnId = lastAssistant.getAttribute('data-testid') || ('assistant:' + assistantCount);

        // Extract text: prefer .markdown, then sanitized fallback
        var md = lastAssistant.querySelector('.markdown');
        if (md) {
          text = (md.innerText || md.textContent || '').trim();
        } else {
          var content = lastAssistant.querySelector('[data-message-content]')
                     || lastAssistant.querySelector('.prose')
                     || lastAssistant;
          // Clone and remove non-content elements for clean extraction
          var clone = content.cloneNode(true);
          var remove = clone.querySelectorAll('.sr-only, button, nav, form, script, style');
          for (var r = 0; r < remove.length; r++) remove[r].remove();
          text = (clone.innerText || clone.textContent || '').trim();
        }

        // Message ID from descendant
        var msgEl = lastAssistant.querySelector('[data-message-id]');
        messageId = msgEl ? msgEl.getAttribute('data-message-id') : null;

        // Finished = action buttons present on this turn
        finished = !!lastAssistant.querySelector(FINISH_SEL);
      }

      var isStreaming = !!document.querySelector(STOP_SEL);

      // Detect thinking/processing phase: streaming + no .markdown text + status label
      var isThinking = false;
      var thinkingLabel = '';
      if (isStreaming && !text && lastAssistant) {
        // Get non-sr-only, non-markdown, non-button text from the turn
        var labelClone = lastAssistant.cloneNode(true);
        var labelRemove = labelClone.querySelectorAll('.sr-only, .markdown, button, nav, form, script, style');
        for (var lr = 0; lr < labelRemove.length; lr++) labelRemove[lr].remove();
        var labelText = (labelClone.textContent || '').trim();
        if (labelText) {
          thinkingLabel = labelText;
          isThinking = true;
        }
      }

      // Image candidates from latest assistant turn
      var candidates = [];
      var seen = {};
      var root = lastAssistant || document;

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

      var links = root.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].href || '';
        if (!href || !(href.startsWith('blob:') || href.startsWith('data:image') || href.includes('oaidalleapiprodscus'))) continue;
        var fp = href.split('?')[0].slice(-80);
        if (seen[fp]) continue;
        seen[fp] = true;
        candidates.push({ source: href, kind: 'link', width: 0, height: 0, fingerprint: fp, isDisplayImage: false });
      }

      return {
        text: text,
        imageCandidates: candidates,
        isStreaming: isStreaming,
        isThinking: isThinking,
        thinkingLabel: thinkingLabel,
        assistantTurnCount: assistantCount,
        latestAssistantTurnId: latestAssistantTurnId,
        messageId: messageId,
        finished: finished,
      };
    })()
  `);
}

// ============================================================================
// Wait for response
// ============================================================================

function newCandidates(state: PollState, baseline: PollState): ImageCandidate[] {
  const bfp = new Set(baseline.imageCandidates.map((c) => c.fingerprint));
  return state.imageCandidates.filter((c) => !bfp.has(c.fingerprint));
}

async function waitForResponse(
  wv: WebView,
  baseline: PollState,
  timeoutMs: number,
  expectsImage: boolean,
): Promise<{ text: string; imageCandidates: ImageCandidate[]; messageId: string | null; partial: boolean }> {
  const { advanceTextStability, sanitizeChatGptAssistantText, chooseBestText } = require("./chatgpt-bun-worker-logic.ts");
  const deadline = Date.now() + timeoutMs;
  let sawNewActivity = false;
  let lastText = "";
  let lastMessageId: string | null = null;
  let lastImgFp = "";
  let lastGoodCandidates: ImageCandidate[] = [];
  let imgStableCount = 0;
  let textNoImgStableCount = 0;

  // Text stability tracking
  let stableCycles = 0;
  let lastChangeAtMs = Date.now();
  let lastProgressPhase = "";

  while (Date.now() < deadline) {
    await delay(400);

    // Primary: read from SSE stream capture (bypasses empty DOM issue)
    const stream = await readStreamResponse(wv);
    // Fallback: poll DOM state for completion signals + images
    const state = await pollResponseState(wv);

    // Emit progress feedback for thinking/processing phases
    const phase = state.isThinking ? state.thinkingLabel : (state.isStreaming && state.text ? "Responding" : "");
    if (phase && phase !== lastProgressPhase) {
      log(`⏳ ${phase}`);
      lastProgressPhase = phase;
    }

    // Sanitize DOM text and choose best source
    const sanitizedDom = sanitizeChatGptAssistantText(state.text);
    const currentText = chooseBestText({
      streamText: stream.text,
      domText: sanitizedDom,
      streamDone: stream.done,
      domFinished: state.finished,
    });
    const currentMessageId = stream.messageId || state.messageId;

    // Detect new assistant turn via stable turn ID or stream activity
    const hasNewTurn =
      state.assistantTurnCount > baseline.assistantTurnCount ||
      (state.latestAssistantTurnId !== null &&
       state.latestAssistantTurnId !== baseline.latestAssistantTurnId) ||
      stream.text.length > 0;

    const newImgs = newCandidates(state, baseline);
    const imgFp = newImgs.map((c) => c.fingerprint).sort().join("|");

    if (hasNewTurn || newImgs.length > 0) {
      sawNewActivity = true;
    }

    if (!sawNewActivity) continue;

    lastMessageId = currentMessageId;

    if (expectsImage) {
      // Image mode: if turn stabilized with text but no images → refusal/error
      if (!state.isStreaming && currentText.length > 0 && newImgs.length === 0) {
        textNoImgStableCount++;
        if (textNoImgStableCount >= 3) {
          return { text: currentText, imageCandidates: [], messageId: currentMessageId, partial: false };
        }
      } else {
        textNoImgStableCount = 0;
      }

      if (newImgs.length > 0 && !state.isStreaming) {
        if (imgFp === lastImgFp) {
          imgStableCount++;
          if (imgStableCount >= 2) {
            return { text: currentText, imageCandidates: newImgs, messageId: currentMessageId, partial: false };
          }
        } else {
          imgStableCount = 0;
          lastGoodCandidates = newImgs;
        }
        lastImgFp = imgFp;
      }
      lastText = currentText;
    } else {
      // Text mode — completion via stream.done OR DOM stability
      // Stream done with actual stream text = authoritative completion.
      // Note: stream_handoff sends [DONE] with empty stream.text — don't
      // treat that as completion; fall through to DOM stability instead.
      if (stream.done && stream.text.length > 0) {
        return { text: currentText, imageCandidates: newImgs, messageId: currentMessageId, partial: false };
      }

      // DOM-based stability as fallback (for non-stream cases)
      const stability = advanceTextStability({
        text: currentText,
        previousText: lastText,
        isStreaming: state.isStreaming,
        finished: state.finished,
        stableCycles,
        lastChangeAtMs,
        nowMs: Date.now(),
        requiredStableCycles: 2,
        minStableMs: 1200,
      });

      stableCycles = stability.stableCycles;
      lastChangeAtMs = stability.lastChangeAtMs;
      lastText = currentText;

      if (stability.shouldComplete && currentText.length > 0) {
        return { text: currentText, imageCandidates: newImgs, messageId: currentMessageId, partial: false };
      }
    }
  }

  // Timeout — return partial if activity was seen
  if (sawNewActivity) {
    if (expectsImage && lastGoodCandidates.length > 0) {
      return { text: lastText, imageCandidates: lastGoodCandidates, messageId: lastMessageId, partial: true };
    }
    if (!expectsImage && lastText) {
      return { text: lastText, imageCandidates: [], messageId: lastMessageId, partial: true };
    }
  }

  throw Object.assign(
    new Error(`Response timed out after ${timeoutMs}ms — ${sawNewActivity ? "activity seen but no stable content" : "ChatGPT never produced a new turn"}`),
    { code: "timeout" },
  );
}

// ============================================================================
// Image save
// ============================================================================

async function saveGeneratedImage(
  wv: WebView,
  candidates: ImageCandidate[],
  outputPath: string,
): Promise<void> {
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
    const url = candidate.source;
    log(`Saving image (${candidate.kind}): ${url.slice(0, 80)}...`);

    try {
      if (url.startsWith("blob:")) {
        // Blob URLs: draw img to canvas, fallback to fetch
        b64 = await pageEval(wv, `
          (function() {
            return new Promise(function(resolve, reject) {
              var imgs = document.querySelectorAll('img');
              var target = null;
              for (var i = 0; i < imgs.length; i++) {
                if ((imgs[i].currentSrc || imgs[i].src) === ${JSON.stringify(url)}) {
                  target = imgs[i]; break;
                }
              }
              if (!target) {
                return fetch(${JSON.stringify(url)}, { credentials: 'include' })
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
              var canvas = document.createElement('canvas');
              canvas.width = target.naturalWidth || target.width || 1024;
              canvas.height = target.naturalHeight || target.height || 1024;
              var ctx = canvas.getContext('2d');
              try {
                ctx.drawImage(target, 0, 0, canvas.width, canvas.height);
                var dataUrl = canvas.toDataURL('image/png');
                resolve(dataUrl.split(',')[1]);
              } catch(canvasErr) {
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
                    reject('canvas: ' + canvasErr.message + ' | fetch: ' + (fetchErr.message || fetchErr));
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
              fetch(${JSON.stringify(url)}, { credentials: 'include' })
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
    throw Object.assign(new Error("All image candidate sources failed to fetch"), {
      code: "image_save_failed",
    });
  }

  log(`Image fetched from: ${savedSource.slice(0, 80)}`);

  const bytes = Buffer.from(b64, "base64");
  const dir = require("path").dirname(outputPath);
  if (dir && dir !== ".") {
    require("fs").mkdirSync(dir, { recursive: true });
  }
  require("fs").writeFileSync(outputPath, bytes);
  log(`Image saved to ${outputPath}`);
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

    if (!req.prompt && !req.generateImage) {
      throw Object.assign(new Error("prompt required"), {
        code: "protocol_error",
      });
    }

    const startTime = Date.now();
    const timeoutMs = req.timeoutMs || 300000;
    const hasFile = !!req.file;
    const wantsImage = !!req.generateImage;

    // Build prompt — prefix for image generation
    let fullPrompt = req.prompt;
    if (wantsImage && !fullPrompt.toLowerCase().startsWith("generate")) {
      fullPrompt = `Generate an image: ${fullPrompt}`;
    }

    // Build step list
    const stepNames: string[] = [
      "Launching browser",
      ...(process.platform === "darwin" ? ["Authenticating"] : []),
      "Loading ChatGPT",
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

    // Step: Launch browser
    progress.step(req.model || "default");
    wv = new Bun.WebView({ headless: true, backend: "chrome" });

    // Pre-navigation staging on about:blank (required for cookie injection + stealth)
    await wv.navigate("about:blank");
    await delay(200);

    // Step: Authenticate (macOS only)
    if (process.platform === "darwin") {
      progress.step(req.profileEmail || "default profile");
      try {
        const { loadAndInjectChatgptCookies } = await import(
          "./chatgpt-bun-profile-auth.ts"
        );
        await loadAndInjectChatgptCookies(wv, {
          profileEmail: req.profileEmail ?? null,
        });
      } catch (authErr: any) {
        if (req.profileEmail) {
          throw authErr;
        }
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

    // Step: Load ChatGPT
    progress.step();
    await wv.navigate(CHATGPT_URL);
    await delay(3000);

    // Check for Cloudflare
    if (await isCloudflareBlocked(wv)) {
      throw Object.assign(
        new Error("Cloudflare challenge detected — complete in browser first"),
        { code: "cloudflare_challenge" },
      );
    }

    try {
      await waitForReady(wv, Math.min(timeoutMs, 20000));
    } catch {
      const loginStatus = await checkLoginStatus(wv);
      if (!loginStatus.loggedIn || loginStatus.hasLoginCta) {
        throw Object.assign(
          new Error(
            "ChatGPT login required. Sign into chatgpt.com in Chrome and try again.",
          ),
          { code: "login_required" },
        );
      }
      throw Object.assign(new Error("ChatGPT page did not become ready"), {
        code: "ui_changed",
      });
    }

    // Verify login
    const loginStatus = await checkLoginStatus(wv);
    if (!loginStatus.loggedIn || loginStatus.hasLoginCta) {
      throw Object.assign(
        new Error("ChatGPT login required. Sign into chatgpt.com in Chrome and try again."),
        { code: "login_required" },
      );
    }
    log("Login verified");

    // Inject fetch stream capture AFTER login (auth/sentinel tokens ready)
    await injectFetchStreamCapture(wv);
    log("Stream capture injected");

    // Model selection (best-effort)
    if (req.model) {
      await trySelectModel(wv, req.model);
    }

    // Step: Upload file
    if (hasFile) {
      const fileName = require("path").basename(req.file!);
      progress.step(fileName);
      await uploadFileViaCDP(wv, req.file!, Math.min(timeoutMs, 30000));
    }

    // Activate image tool if needed
    if (wantsImage) {
      await activateImageTool(wv, 5000);
    }

    // Capture baseline
    const baseline = await pollResponseState(wv);

    // Step: Send prompt
    const promptPreview = fullPrompt.length > 60
      ? fullPrompt.slice(0, 57) + "..."
      : fullPrompt;
    progress.step(promptPreview);
    await focusEditor(wv);
    await delay(100);
    await wv.type(fullPrompt);
    await delay(300);

    // Verify text was entered
    const editorContent = await readEditorContent(wv);
    if (!editorContent || editorContent.trim().length === 0) {
      log("Warning: editor appears empty after typing");
    }

    await waitForSendButton(wv);
    await clickSend(wv);

    // Step: Wait for response
    progress.step();
    const { text: responseText, imageCandidates, messageId, partial } =
      await waitForResponse(wv, baseline, timeoutMs, wantsImage);

    if (!responseText && imageCandidates.length === 0) {
      throw Object.assign(new Error("Empty response from ChatGPT"), {
        code: "timeout",
      });
    }

    // Handle image save
    let imagePath: string | null = null;

    if (wantsImage && imageCandidates.length > 0) {
      const outputPath = req.generateImage!;
      progress.step(outputPath);
      await saveGeneratedImage(wv, imageCandidates, outputPath);
      imagePath = outputPath;
    } else if (wantsImage && imageCandidates.length === 0) {
      // Image was requested but none produced — include text (may be refusal)
      log(`Image generation did not produce images. Response: ${responseText.slice(0, 200)}`);
    }

    const tookMs = Date.now() - startTime;
    const responsePreview = responseText.length > 80
      ? responseText.slice(0, 77) + "..."
      : responseText;
    progress.done(`${responsePreview} (${req.model || "default"}, ${(tookMs / 1000).toFixed(1)}s)`);

    const result: WorkerResult = {
      response: responseText,
      model: req.model || "default",
      tookMs,
      imagePath,
      messageId,
      partial,
    };

    console.log(JSON.stringify({ ok: true, result }));
  } catch (err: any) {
    const code = err.code || "unknown";
    const message = err.message || String(err);
    log(`Error [${code}]: ${message}`);

    // Fallback policy: hard-fail for Bun-only features; recommend fallback for others
    const HARD_FAIL_CODES = new Set([
      "upload_failed",
      "image_save_failed",
      "profile_not_found",
      "profile_ambiguous",
      "profile_unsupported_platform",
      "protocol_error",
    ]);

    console.log(
      JSON.stringify({
        ok: false,
        code,
        error: message,
        fallbackRecommended: !HARD_FAIL_CODES.has(code),
      }),
    );
  } finally {
    if (wv) {
      try { wv.close(); } catch {}
    }
  }
}

main();
