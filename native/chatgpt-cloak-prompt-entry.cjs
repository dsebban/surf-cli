const { Buffer } = require("buffer");

const DEFAULT_THRESHOLDS = {
  typedMaxBytes: 8 * 1024,
  chunkedMinBytes: 50 * 1024,
  chunkBytes: 8 * 1024,
  minSuccessRatio: 0.95,
  allowedDeltaChars: 2,
  chunkDelayMs: 50,
  settleMs: 500,
  sendReadyTimeoutMs: 1500,
  sendReadyPollMs: 100,
};

const EDITABLE_SELECTOR = 'textarea, input, [contenteditable="true"], .ProseMirror';

function normalizeForLengthComparison(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function selectPromptInsertionStrategy(promptBytes, thresholds = DEFAULT_THRESHOLDS) {
  if (promptBytes <= thresholds.typedMaxBytes) return "type";
  if (promptBytes > thresholds.chunkedMinBytes) return "clipboard_paste";
  return "exec";
}

function splitUtf8Chunks(text, chunkBytes = DEFAULT_THRESHOLDS.chunkBytes) {
  const chunks = [];
  let current = "";
  let currentBytes = 0;

  for (const char of String(text || "")) {
    const charBytes = byteLength(char);
    if (current && currentBytes + charBytes > chunkBytes) {
      chunks.push({ text: current, bytes: currentBytes, chars: current.length, index: chunks.length });
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }

  if (current || chunks.length === 0) {
    chunks.push({ text: current, bytes: currentBytes, chars: current.length, index: chunks.length });
  }

  return chunks;
}

async function readComposerState(page, promptSelector, sendButtonSelectors = []) {
  return await page.evaluate(({ promptSelector, sendButtonSelectors, editableSelector }) => {
    // Resolve editable child if promptSelector points to a wrapper
    const resolveComposer = (selector) => {
      const root = document.querySelector(selector);
      if (!root) return null;
      if (typeof root.matches === "function" && root.matches(editableSelector)) return root;
      if (typeof root.querySelector === "function") {
        const nested = root.querySelector(editableSelector);
        if (nested) return nested;
      }
      return root;
    };

    const el = resolveComposer(promptSelector);
    const rawValue = el && typeof el.value === "string" ? el.value : "";
    const rawInnerText = el && typeof el.innerText === "string" ? el.innerText : "";
    const rawTextContent = el ? (el.textContent || "") : "";
    const actualText = rawValue || rawInnerText || rawTextContent || "";

    let sendEnabled = false;
    let sendButtonFound = false;
    for (const selector of sendButtonSelectors || []) {
      const buttons = Array.from(document.querySelectorAll(selector));
      for (const btn of buttons) {
        sendButtonFound = true;
        const disabled = btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true" || btn.getAttribute("data-disabled") === "true";
        if (!disabled) {
          sendEnabled = true;
          break;
        }
      }
      if (sendEnabled) break;
    }

    return {
      actualText,
      actualChars: actualText.length,
      rawLengths: {
        value: rawValue.length,
        textContent: rawTextContent.length,
        innerText: rawInnerText.length,
      },
      sendEnabled,
      sendButtonFound,
      sendState: sendEnabled ? "enabled" : (sendButtonFound ? "disabled" : "unknown"),
    };
  }, { promptSelector, sendButtonSelectors, editableSelector: EDITABLE_SELECTOR });
}

async function clearComposer(page, promptSelector) {
  await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;

    const dispatch = (type, event) => {
      try {
        el.dispatchEvent(event);
      } catch {}
    };

    if (typeof el.focus === "function") el.focus();
    try { document.execCommand("selectAll", false, null); } catch {}
    try { document.execCommand("delete", false, null); } catch {}

    if (typeof el.value === "string") el.value = "";
    if ("textContent" in el) el.textContent = "";
    if ("innerText" in el) {
      try { el.innerText = ""; } catch {}
    }

    if (typeof InputEvent !== "undefined") {
      dispatch("input", new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
    } else {
      dispatch("input", new Event("input", { bubbles: true }));
    }
    dispatch("change", new Event("change", { bubbles: true }));
    return true;
  }, promptSelector);
}

async function insertViaExecCommand(page, promptSelector, prompt) {
  await page.evaluate(({ selector, text }) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    if (typeof el.focus === "function") el.focus();
    document.execCommand("insertText", false, text);
    return true;
  }, { selector: promptSelector, text: prompt });
}

async function insertViaChunkedExecCommand(page, promptSelector, chunks, log, sleep, expectedChars, sendButtonSelectors, thresholds) {
  let finalState = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    await insertViaExecCommand(page, promptSelector, chunk.text);
    if (i < chunks.length - 1) await sleep(thresholds.chunkDelayMs);
    finalState = await readComposerState(page, promptSelector, sendButtonSelectors);
    const expectedSoFar = normalizeForLengthComparison(chunks.slice(0, i + 1).map((part) => part.text).join("")).length;
    const ratio = expectedSoFar > 0 ? finalState.actualChars / expectedSoFar : 1;
    log("info", `Prompt insert chunk ${i + 1}/${chunks.length}: ${finalState.actualChars}/${expectedSoFar} chars (${(ratio * 100).toFixed(1)}%)`);
    if (expectedSoFar > 0 && ratio < thresholds.minSuccessRatio) {
      return { state: finalState, hardMismatch: true };
    }
  }

  return { state: finalState, hardMismatch: false };
}

async function insertViaFillFallback(page, textarea, promptSelector, prompt) {
  try {
    await textarea.fill(prompt);
  } catch {}

  await page.evaluate(({ selector, text }) => {
    const el = document.querySelector(selector);
    if (!el) return false;

    if (typeof el.focus === "function") el.focus();
    if (typeof el.value === "string") el.value = text;
    if ("textContent" in el) el.textContent = text;
    if ("innerText" in el) {
      try { el.innerText = text; } catch {}
    }

    const inputEvent = typeof InputEvent !== "undefined"
      ? new InputEvent("input", { bubbles: true, data: text, inputType: "insertFromPaste" })
      : new Event("input", { bubbles: true });
    el.dispatchEvent(inputEvent);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { selector: promptSelector, text: prompt });
}

async function insertViaClipboardPaste(page, promptSelector, prompt) {
  // Simulate a native paste event — works with ProseMirror/contenteditable editors
  // that ignore execCommand for large text but handle paste events correctly.
  return await page.evaluate(({ selector, text, editableSelector }) => {
    const root = document.querySelector(selector);
    const el = !root
      ? null
      : ((typeof root.matches === "function" && root.matches(editableSelector))
          ? root
          : (typeof root.querySelector === "function" ? root.querySelector(editableSelector) : null)) || root;
    if (!el) return false;

    if (typeof el.focus === "function") el.focus();

    // Build a synthetic ClipboardEvent with DataTransfer carrying the text
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const pasteEvent = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(pasteEvent);
    return true;
  }, { selector: promptSelector, text: prompt, editableSelector: EDITABLE_SELECTOR });
}

function buildMetrics({ method, expectedText, actualState, usedFallback = false, chunkCount = 0 }) {
  const expectedChars = normalizeForLengthComparison(expectedText).length;
  const actualChars = normalizeForLengthComparison(actualState?.actualText || "").length;
  const deltaChars = actualChars - expectedChars;
  const ratio = expectedChars > 0 ? actualChars / expectedChars : 1;
  return {
    method,
    usedFallback,
    expectedChars,
    actualChars,
    deltaChars,
    ratio,
    sendEnabled: !!actualState?.sendEnabled,
    sendButtonFound: !!actualState?.sendButtonFound,
    sendState: actualState?.sendState || "unknown",
    rawLengths: actualState?.rawLengths || { value: 0, textContent: 0, innerText: 0 },
    chunkCount,
  };
}

function isSuccess(metrics, thresholds) {
  const textOk = Math.abs(metrics.deltaChars) <= thresholds.allowedDeltaChars && metrics.ratio >= thresholds.minSuccessRatio;
  if (!textOk) return false;
  // If no send button found at all (selector drift), don't block — send phase will try click/Enter fallback
  if (!metrics.sendButtonFound) return true;
  return metrics.sendEnabled;
}

async function waitForSendReady({ page, promptSelector, sendButtonSelectors, sleep, thresholds, initialState }) {
  let state = initialState || await readComposerState(page, promptSelector, sendButtonSelectors);
  if (state.sendEnabled || !state.sendButtonFound || typeof sleep !== "function") return state;
  const maxPolls = Math.ceil(thresholds.sendReadyTimeoutMs / thresholds.sendReadyPollMs);
  for (let i = 0; i < maxPolls; i++) {
    await sleep(thresholds.sendReadyPollMs);
    state = await readComposerState(page, promptSelector, sendButtonSelectors);
    if (state.sendEnabled || !state.sendButtonFound) return state;
  }
  return state;
}

function makeInsertionError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

async function enterPromptWithVerification({
  page,
  textarea,
  prompt,
  log,
  sleep,
  promptSelector,
  sendButtonSelectors,
  thresholds = {},
}) {
  const merged = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const normalizedPrompt = normalizeForLengthComparison(prompt);
  const promptBytes = byteLength(prompt);
  const strategy = selectPromptInsertionStrategy(promptBytes, merged);
  const logf = typeof log === "function" ? log : () => {};

  logf("info", `Prompt insert strategy: ${strategy} (${(promptBytes / 1024).toFixed(1)}KB, ${normalizedPrompt.length} chars)`);

  await clearComposer(page, promptSelector);
  let actualState;
  let usedFallback = false;
  let chunkCount = 0;

  if (strategy === "type") {
    await textarea.type(prompt);
    await sleep(merged.settleMs);
    actualState = await readComposerState(page, promptSelector, sendButtonSelectors);
    actualState = await waitForSendReady({ page, promptSelector, sendButtonSelectors, sleep, thresholds: merged, initialState: actualState });
  } else if (strategy === "exec") {
    await insertViaExecCommand(page, promptSelector, prompt);
    await sleep(merged.settleMs);
    actualState = await readComposerState(page, promptSelector, sendButtonSelectors);
    actualState = await waitForSendReady({ page, promptSelector, sendButtonSelectors, sleep, thresholds: merged, initialState: actualState });
  } else if (strategy === "clipboard_paste") {
    // Clipboard paste — preferred for large prompts (>50KB).
    // Dispatches a synthetic paste event which ProseMirror handles natively.
    logf("info", "Attempting clipboard paste insertion for large prompt");
    await insertViaClipboardPaste(page, promptSelector, prompt);
    await sleep(merged.settleMs + 500); // extra settle for paste processing
    actualState = await readComposerState(page, promptSelector, sendButtonSelectors);
    actualState = await waitForSendReady({ page, promptSelector, sendButtonSelectors, sleep, thresholds: merged, initialState: actualState });

    // Verify paste worked — if not, fall back to chunked exec
    const pasteMetrics = buildMetrics({ method: "clipboard_paste", expectedText: prompt, actualState });
    if (pasteMetrics.ratio < merged.minSuccessRatio) {
      logf("warn", `Clipboard paste insertion low ratio (${(pasteMetrics.ratio * 100).toFixed(1)}%) — falling back to chunked_exec`);
      await clearComposer(page, promptSelector);
      // Fall through to chunked_exec
      const chunks = splitUtf8Chunks(prompt, merged.chunkBytes);
      chunkCount = chunks.length;
      const chunked = await insertViaChunkedExecCommand(
        page, promptSelector, chunks, logf, sleep,
        normalizedPrompt.length, sendButtonSelectors, merged,
      );
      actualState = chunked.state || await readComposerState(page, promptSelector, sendButtonSelectors);
      actualState = await waitForSendReady({ page, promptSelector, sendButtonSelectors, sleep, thresholds: merged, initialState: actualState });
      if (chunked.hardMismatch) {
        logf("warn", "Prompt chunked insert fell below success ratio — switching to fallback");
      }
    }
  } else {
    const chunks = splitUtf8Chunks(prompt, merged.chunkBytes);
    chunkCount = chunks.length;
    const chunked = await insertViaChunkedExecCommand(
      page,
      promptSelector,
      chunks,
      logf,
      sleep,
      normalizedPrompt.length,
      sendButtonSelectors,
      merged,
    );
    actualState = chunked.state || await readComposerState(page, promptSelector, sendButtonSelectors);
    actualState = await waitForSendReady({ page, promptSelector, sendButtonSelectors, sleep, thresholds: merged, initialState: actualState });
    if (chunked.hardMismatch) {
      logf("warn", "Prompt chunked insert fell below success ratio — switching to fallback");
    }
  }

  let metrics = buildMetrics({ method: strategy, expectedText: prompt, actualState, usedFallback, chunkCount });
  logf("info", `Prompt insert verify: ${metrics.method} ${metrics.actualChars}/${metrics.expectedChars} chars (${(metrics.ratio * 100).toFixed(1)}%), delta=${metrics.deltaChars}, sendEnabled=${metrics.sendEnabled}, sendState=${metrics.sendState}`);

  if (!isSuccess(metrics, merged)) {
    logf("warn", `Prompt insert fallback: fill_fallback after ${metrics.method} mismatch`);
    usedFallback = true;
    await clearComposer(page, promptSelector);
    await insertViaFillFallback(page, textarea, promptSelector, prompt);
    await sleep(merged.settleMs);
    actualState = await readComposerState(page, promptSelector, sendButtonSelectors);
    actualState = await waitForSendReady({ page, promptSelector, sendButtonSelectors, sleep, thresholds: merged, initialState: actualState });
    metrics = buildMetrics({ method: "fill_fallback", expectedText: prompt, actualState, usedFallback, chunkCount });
    logf("info", `Prompt insert verify: ${metrics.method} ${metrics.actualChars}/${metrics.expectedChars} chars (${(metrics.ratio * 100).toFixed(1)}%), delta=${metrics.deltaChars}, sendEnabled=${metrics.sendEnabled}, sendState=${metrics.sendState}`);
  }

  if (!isSuccess(metrics, merged)) {
    const textFailed = Math.abs(metrics.deltaChars) > merged.allowedDeltaChars || metrics.ratio < merged.minSuccessRatio;
    throw makeInsertionError(
      !textFailed && metrics.sendButtonFound && !metrics.sendEnabled ? "prompt_send_not_ready" : "prompt_insertion_failed",
      `Prompt insertion failed: ${metrics.actualChars}/${metrics.expectedChars} chars (${(metrics.ratio * 100).toFixed(1)}%), sendEnabled=${metrics.sendEnabled}, sendState=${metrics.sendState}`,
      metrics,
    );
  }

  logf("info", `Prompt insert success: ${metrics.method} ${metrics.actualChars}/${metrics.expectedChars} chars (${(metrics.ratio * 100).toFixed(1)}%), sendEnabled=${metrics.sendEnabled}, sendState=${metrics.sendState}`);
  return metrics;
}

module.exports = {
  enterPromptWithVerification,
  __private: {
    DEFAULT_THRESHOLDS,
    normalizeForLengthComparison,
    byteLength,
    selectPromptInsertionStrategy,
    splitUtf8Chunks,
    readComposerState,
    clearComposer,
    buildMetrics,
    isSuccess,
  },
};
