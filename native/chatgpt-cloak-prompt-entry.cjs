const { Buffer } = require("buffer");

const DEFAULT_THRESHOLDS = {
  settleMs: 700,
  sendReadyTimeoutMs: 2500,
  sendReadyPollMs: 100,
  nativeInsertChunkBytes: 8 * 1024,
  nativeInsertYieldMs: 10,
  nativeInsertTimeoutMs: 120_000,
  nativeInsertTimeoutPerKBMs: 600,
  fillFallbackPreferredMinBytes: 256 * 1024,
  // Prompts >= this byte size attempt ProseMirror direct replacement instead of keyboardInsertText
  proseMirrorReplaceMinBytes: 8 * 1024,
  minSuccessRatio: 0.95,
  allowedDeltaChars: 2,
};

const EDITABLE_SELECTOR = 'textarea, input, [contenteditable="true"], .ProseMirror';

function normalizeForLengthComparison(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/, "");
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function splitUtf8Chunks(text, chunkBytes = DEFAULT_THRESHOLDS.nativeInsertChunkBytes) {
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

function splitNativeInsertChunks(text, chunkBytes = DEFAULT_THRESHOLDS.nativeInsertChunkBytes) {
  return splitUtf8Chunks(text, chunkBytes).map((chunk) => chunk.text);
}

async function readComposerState(page, promptSelector, sendButtonSelectors = []) {
  return await page.evaluate(({ promptSelector, sendButtonSelectors, editableSelector }) => {
    const resolveEditable = (selector) => {
      const selectors = String(selector || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      for (const candidate of selectors) {
        const root = document.querySelector(candidate);
        if (!root) continue;
        if (typeof root.matches === "function" && root.matches(editableSelector)) return root;
        if (typeof root.querySelector === "function") {
          const nested = root.querySelector(editableSelector);
          if (nested) return nested;
        }
      }
      return null;
    };

    const el = resolveEditable(promptSelector);
    const readProseMirrorText = (node) => {
      if (!node || !node.classList || !node.classList.contains("ProseMirror")) return null;
      const blocks = Array.from(node.children || []);
      if (blocks.length === 0) return node.textContent || "";
      return blocks.map((block) => {
        const text = block.textContent || "";
        if (text) return text;
        const trailingBreak = block.querySelector && block.querySelector("br.ProseMirror-trailingBreak");
        return trailingBreak ? "" : text;
      }).join("\n");
    };

    const rawValue = el && typeof el.value === "string" ? el.value : "";
    const rawInnerText = el && typeof el.innerText === "string" ? el.innerText : "";
    const rawTextContent = el ? (el.textContent || "") : "";
    const rawProseMirrorText = readProseMirrorText(el);
    const actualText = rawValue || rawProseMirrorText || rawInnerText || rawTextContent || "";

    let sendEnabled = false;
    let sendButtonFound = false;
    for (const selector of sendButtonSelectors || []) {
      const buttons = Array.from(document.querySelectorAll(selector));
      for (const btn of buttons) {
        sendButtonFound = true;
        const disabled = btn.hasAttribute("disabled")
          || btn.getAttribute("aria-disabled") === "true"
          || btn.getAttribute("data-disabled") === "true";
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
  return await page.evaluate(({ selector, editableSelector }) => {
    const resolveEditable = (promptRootSelector) => {
      const selectors = String(promptRootSelector || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      for (const candidate of selectors) {
        const root = document.querySelector(candidate);
        if (!root) continue;
        if (typeof root.matches === "function" && root.matches(editableSelector)) return root;
        if (typeof root.querySelector === "function") {
          const nested = root.querySelector(editableSelector);
          if (nested) return nested;
        }
      }
      return null;
    };

    const el = resolveEditable(selector);
    if (!el) return false;
    if (typeof el.focus === "function") el.focus();

    try {
      if (typeof InputEvent !== "undefined") {
        el.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "",
          inputType: "deleteContentBackward",
        }));
      }
    } catch {}

    if (typeof el.value === "string") {
      const proto = Object.getPrototypeOf(el);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (descriptor && typeof descriptor.set === "function") descriptor.set.call(el, "");
      else el.value = "";
      if (typeof el.setSelectionRange === "function") {
        try { el.setSelectionRange(0, 0); } catch {}
      }
    }

    if (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.classList?.contains("ProseMirror")) {
      el.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>';
      const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
      if (selection && typeof document.createRange === "function") {
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        } catch {}
      }
    }

    if (typeof InputEvent !== "undefined") {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "",
        inputType: "deleteContentBackward",
      }));
    } else {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { selector: promptSelector, editableSelector: EDITABLE_SELECTOR });
}

/**
 * Attempt to replace the ProseMirror composer content via a direct EditorView transaction.
 *
 * Returns a result object:
 *   { applied: true, composerKind: "prosemirror", viewResolutionMethod, paragraphCount }
 *   { applied: false, composerKind, fallbackSafe: true, fallbackReason }
 */
async function tryReplaceViaProseMirror(page, promptSelector, prompt, { log } = {}) {
  const logf = typeof log === "function" ? log : () => {};

  const result = await page.evaluate(
    ({ promptSelector: sel, prompt: text, editableSelector }) => {
      const resolveEditable = (selector) => {
        const parts = String(selector || "").split(",").map((s) => s.trim()).filter(Boolean);
        for (const candidate of parts) {
          const root = document.querySelector(candidate);
          if (!root) continue;
          if (typeof root.matches === "function" && root.matches(editableSelector)) return root;
          if (typeof root.querySelector === "function") {
            const nested = root.querySelector(editableSelector);
            if (nested) return nested;
          }
        }
        return null;
      };

      const el = resolveEditable(sel);
      if (!el) return { applied: false, fallbackSafe: true, composerKind: "unknown", fallbackReason: "not_prosemirror" };

      const isPM = el.classList && el.classList.contains("ProseMirror");
      if (!isPM) {
        const kind = typeof el.value === "string" ? (el.tagName === "TEXTAREA" ? "textarea" : "input") : "contenteditable";
        return { applied: false, fallbackSafe: true, composerKind: kind, fallbackReason: "not_prosemirror" };
      }

      let view = null;
      let viewResolutionMethod = null;

      if (el.pmViewDesc && el.pmViewDesc.view && typeof el.pmViewDesc.view.dispatch === "function") {
        view = el.pmViewDesc.view;
        viewResolutionMethod = "pmViewDesc";
      }

      if (!view) {
        const isValidView = (candidate) =>
          candidate
          && typeof candidate === "object"
          && candidate.state
          && candidate.state.doc
          && typeof candidate.dispatch === "function"
          && candidate.dom
          && candidate.state.schema;

        const targets = [el];
        let node = el.parentElement;
        for (let i = 0; i < 5 && node; i += 1, node = node.parentElement) targets.push(node);

        outer: for (const target of targets) {
          for (const key of Object.keys(target)) {
            if (key.startsWith("__reactFiber") || key.startsWith("__reactProps")) continue;
            try {
              const candidate = target[key];
              if (isValidView(candidate) && (candidate.dom === el || el.contains(candidate.dom) || candidate.dom.contains(el))) {
                view = candidate;
                viewResolutionMethod = "property_scan";
                break outer;
              }
            } catch {}
          }
        }
      }

      if (!view) {
        return { applied: false, fallbackSafe: true, composerKind: "prosemirror", fallbackReason: "view_not_found" };
      }

      const schema = view.state.schema;
      if (!schema || !schema.nodes || !schema.nodes.paragraph || !schema.nodes.text) {
        return { applied: false, fallbackSafe: true, composerKind: "prosemirror", fallbackReason: "unsupported_schema" };
      }

      const lines = text.split(/\r\n|\r|\n/);
      const paragraphs = lines.map((line) => {
        if (line.length === 0) return schema.nodes.paragraph.create();
        return schema.nodes.paragraph.create(null, [schema.text(line)]);
      });

      const state = view.state;
      const tr = state.tr.replaceWith(0, state.doc.content.size, paragraphs);
      tr.scrollIntoView();
      view.dispatch(tr);

      if (typeof view.focus === "function") view.focus();
      view.dom.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      view.dom.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        applied: true,
        composerKind: "prosemirror",
        viewResolutionMethod,
        paragraphCount: paragraphs.length,
      };
    },
    { promptSelector, prompt, editableSelector: EDITABLE_SELECTOR },
  );

  if (result.applied) {
    logf("info", `ProseMirror replace applied: ${result.paragraphCount} paragraphs via ${result.viewResolutionMethod}`);
  } else {
    logf("info", `ProseMirror replace skipped (fallbackSafe=${result.fallbackSafe}): composerKind=${result.composerKind}, reason=${result.fallbackReason}`);
  }

  return result;
}

function resolveNativeInsertText(page) {
  if (page?.keyboard && typeof page.keyboard.insertText === "function") {
    return (text) => page.keyboard.insertText(text);
  }
  if (page?._original && typeof page._original.keyboardInsertText === "function") {
    return (text) => page._original.keyboardInsertText(text);
  }
  return null;
}

function resolveNativeInsertTimeoutMs(text, thresholds = DEFAULT_THRESHOLDS) {
  const bytes = byteLength(text);
  const perKB = thresholds?.nativeInsertTimeoutPerKBMs || DEFAULT_THRESHOLDS.nativeInsertTimeoutPerKBMs;
  const baseTimeout = thresholds?.nativeInsertTimeoutMs || DEFAULT_THRESHOLDS.nativeInsertTimeoutMs;
  return Math.max(baseTimeout, Math.ceil(bytes / 1024) * perKB);
}

async function insertViaNativeInsertText(page, prompt, { log, thresholds, methodName = "native_insert_text" } = {}) {
  const insertText = resolveNativeInsertText(page);
  if (!insertText) {
    throw makeInsertionError("prompt_insertion_failed", "Native keyboardInsertText unavailable", {
      method: methodName,
      failureReason: "native_insert_text_unavailable",
    });
  }

  const logf = typeof log === "function" ? log : () => {};
  const startedAt = Date.now();
  const timeoutMs = resolveNativeInsertTimeoutMs(prompt, thresholds);
  let timeoutId = null;
  try {
    await Promise.race([
      insertText(prompt),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(makeInsertionError("prompt_insertion_failed", `Native keyboardInsertText timed out for ${methodName}`, {
            method: methodName,
            failureReason: "native_insert_text_timeout",
            chunkCount: 1,
            chunkChars: String(prompt || "").length,
            chunkBytes: byteLength(prompt),
            chunkElapsedMs: Date.now() - startedAt,
            timeoutMs,
          }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  logf("info", `${methodName} inserted ${String(prompt || "").length} chars in ${Date.now() - startedAt}ms`);
  return true;
}

async function insertViaChunkedNativeInsertText(page, prompt, { log, sleep, thresholds, methodName = "native_insert_text_chunked" } = {}) {
  const insertText = resolveNativeInsertText(page);
  if (!insertText) {
    throw makeInsertionError("prompt_insertion_failed", "Native keyboardInsertText unavailable", {
      method: methodName,
      failureReason: "native_insert_text_unavailable",
    });
  }

  const logf = typeof log === "function" ? log : () => {};
  const chunks = splitUtf8Chunks(prompt, thresholds?.nativeInsertChunkBytes);
  if (chunks.length > 1) {
    logf("info", `${methodName} chunking enabled: ${chunks.length} chunks, maxBytes=${thresholds?.nativeInsertChunkBytes}`);
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const startedAt = Date.now();
    let timeoutId = null;
    try {
      await Promise.race([
        insertText(chunk.text),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(makeInsertionError("prompt_insertion_failed", `Native keyboardInsertText timed out on chunk ${index + 1}/${chunks.length}`, {
              method: methodName,
              failureReason: "native_insert_text_timeout",
              chunkIndex: index,
              chunkCount: chunks.length,
              chunkChars: chunk.chars,
              chunkBytes: chunk.bytes,
              chunkElapsedMs: Date.now() - startedAt,
            }));
          }, thresholds?.nativeInsertTimeoutMs || DEFAULT_THRESHOLDS.nativeInsertTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (chunks.length > 1) {
      logf("info", `${methodName} chunk ${index + 1}/${chunks.length}: ${chunk.chars} chars/${chunk.bytes} bytes in ${Date.now() - startedAt}ms`);
    }
    if (index < chunks.length - 1 && typeof sleep === "function" && (thresholds?.nativeInsertYieldMs || 0) > 0) {
      await sleep(thresholds.nativeInsertYieldMs);
    }
  }

  return true;
}

async function insertViaFillFallback(page, textarea, promptSelector, prompt, { log } = {}) {
  const logf = typeof log === "function" ? log : () => {};
  void textarea;

  await page.evaluate(({ selector, text, editableSelector }) => {
    const resolveEditable = (promptRootSelector) => {
      const selectors = String(promptRootSelector || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      for (const candidate of selectors) {
        const root = document.querySelector(candidate);
        if (!root) continue;
        if (typeof root.matches === "function" && root.matches(editableSelector)) return root;
        if (typeof root.querySelector === "function") {
          const nested = root.querySelector(editableSelector);
          if (nested) return nested;
        }
      }
      return null;
    };

    const escapeHtml = (value) => String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const el = resolveEditable(selector);
    if (!el) return false;

    if (typeof el.focus === "function") el.focus();

    if (typeof el.value === "string") {
      const proto = Object.getPrototypeOf(el);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (descriptor && typeof descriptor.set === "function") descriptor.set.call(el, text);
      else el.value = text;
    }

    if (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.classList?.contains("ProseMirror")) {
      const lines = String(text || "").split(/\r\n|\r|\n/);
      el.innerHTML = lines.map((line) => {
        if (!line) return '<p><br class="ProseMirror-trailingBreak"></p>';
        return `<p>${escapeHtml(line)}</p>`;
      }).join("");
    } else {
      if ("textContent" in el) el.textContent = text;
      if ("innerText" in el) {
        try { el.innerText = text; } catch {}
      }
    }

    const inputEvent = typeof InputEvent !== "undefined"
      ? new InputEvent("input", { bubbles: true, data: text, inputType: "insertFromPaste" })
      : new Event("input", { bubbles: true });
    el.dispatchEvent(inputEvent);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { selector: promptSelector, text: prompt, editableSelector: EDITABLE_SELECTOR });
  logf("info", "fill_fallback DOM assignment applied");
}

function buildMetrics({ method, expectedText, actualState, composerKind }) {
  const normalizedExpected = normalizeForLengthComparison(expectedText);
  const normalizedActual = normalizeForLengthComparison(actualState?.actualText || "");
  const expectedChars = normalizedExpected.length;
  const actualChars = normalizedActual.length;
  const deltaChars = actualChars - expectedChars;
  const ratio = expectedChars > 0 ? actualChars / expectedChars : 1;
  return {
    method: method || "native_insert_text",
    composerKind: composerKind || undefined,
    expectedChars,
    actualChars,
    deltaChars,
    ratio,
    exactMatch: normalizedActual === normalizedExpected,
    sendEnabled: !!actualState?.sendEnabled,
    sendButtonFound: !!actualState?.sendButtonFound,
    sendState: actualState?.sendState || "unknown",
    rawLengths: actualState?.rawLengths || { value: 0, textContent: 0, innerText: 0 },
    actualPreview: normalizedActual.slice(0, 200),
  };
}

function isSoftTextMatch(metrics, thresholds = DEFAULT_THRESHOLDS) {
  return Math.abs(metrics.deltaChars) <= thresholds.allowedDeltaChars && metrics.ratio >= thresholds.minSuccessRatio;
}

function isSuccess(metrics, thresholds = DEFAULT_THRESHOLDS) {
  void thresholds;
  return metrics.exactMatch;
}

async function waitForSendReady({ page, promptSelector, sendButtonSelectors, sleep, thresholds, initialState }) {
  let state = initialState || await readComposerState(page, promptSelector, sendButtonSelectors);
  if (state.sendEnabled || !state.sendButtonFound || typeof sleep !== "function") return state;
  const maxPolls = Math.ceil(thresholds.sendReadyTimeoutMs / thresholds.sendReadyPollMs);
  for (let i = 0; i < maxPolls; i += 1) {
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
  const logf = typeof log === "function" ? log : () => {};
  const promptBytes = byteLength(prompt);
  const promptChars = normalizeForLengthComparison(prompt).length;

  let actualState = null;
  let metrics = null;
  let composerKind = undefined;
  let fillAlreadyTried = false;

  const verify = async (method) => {
    actualState = await readComposerState(page, promptSelector, sendButtonSelectors);
    actualState = await waitForSendReady({
      page,
      promptSelector,
      sendButtonSelectors,
      sleep,
      thresholds: merged,
      initialState: actualState,
    });
    metrics = buildMetrics({ method, expectedText: prompt, actualState, composerKind });
    logf(
      "info",
      `Prompt insert verify: ${metrics.method} ${metrics.actualChars}/${metrics.expectedChars} chars (${(metrics.ratio * 100).toFixed(1)}%), delta=${metrics.deltaChars}, exactMatch=${metrics.exactMatch}, sendEnabled=${metrics.sendEnabled}, sendState=${metrics.sendState}`,
    );
    return metrics;
  };

  const settleAndVerify = async (method) => {
    if (typeof sleep === "function") await sleep(merged.settleMs);
    return await verify(method);
  };

  const tryNativePath = async ({ method, mode }) => {
    logf("info", `Clearing composer before ${method}`);
    await clearComposer(page, promptSelector);
    logf("info", `Composer cleared; starting ${method}`);
    if (mode === "chunked") {
      await insertViaChunkedNativeInsertText(page, prompt, { log: logf, sleep, thresholds: merged, methodName: method });
    } else if (mode === "fill") {
      await insertViaFillFallback(page, textarea, promptSelector, prompt, { log: logf });
    } else {
      await insertViaNativeInsertText(page, prompt, { log: logf, thresholds: merged, methodName: method });
    }
    logf("info", `${method} completed; settling before readback`);
    return await settleAndVerify(method);
  };

  if (promptBytes >= merged.proseMirrorReplaceMinBytes) {
    logf("info", `Prompt insert strategy: attempting prosemirror_replace (${(promptBytes / 1024).toFixed(1)}KB, ${promptChars} chars)`);
    const pmResult = await tryReplaceViaProseMirror(page, promptSelector, prompt, { log: logf });
    composerKind = pmResult.composerKind;

    if (pmResult.applied) {
      const pmMetrics = await settleAndVerify("prosemirror_replace");
      const pmSendReady = pmMetrics.sendEnabled || !pmMetrics.sendButtonFound;
      if (isSuccess(pmMetrics, merged) && pmSendReady) {
        logf("info", `Prompt insert success: ${pmMetrics.method} ${pmMetrics.actualChars}/${pmMetrics.expectedChars} chars (${(pmMetrics.ratio * 100).toFixed(1)}%), sendEnabled=${pmMetrics.sendEnabled}, sendState=${pmMetrics.sendState}`);
        return pmMetrics;
      }
      if (pmMetrics.exactMatch && !pmSendReady) {
        logf("warn", "ProseMirror replace produced exact text but send did not become ready; falling back to native insertion");
      } else {
        logf("warn", "ProseMirror replace verification failed; falling back to native insertion");
      }
    } else {
      logf("info", `ProseMirror replace not available (${pmResult.fallbackReason}); falling back to native insertion`);
    }
  } else {
    logf("info", `Prompt insert strategy: native_insert_text (${(promptBytes / 1024).toFixed(1)}KB, ${promptChars} chars)`);
  }

  if (promptBytes >= merged.fillFallbackPreferredMinBytes) {
    logf("info", `Prompt insert strategy: trying fill_fallback first for very large payload (${(promptBytes / 1024).toFixed(1)}KB)`);
    fillAlreadyTried = true;
    const preferredFillMetrics = await tryNativePath({ method: "fill_fallback", mode: "fill" });
    if (isSuccess(preferredFillMetrics, merged)) {
      logf("info", `Prompt insert success: ${preferredFillMetrics.method} ${preferredFillMetrics.actualChars}/${preferredFillMetrics.expectedChars} chars (${(preferredFillMetrics.ratio * 100).toFixed(1)}%), sendEnabled=${preferredFillMetrics.sendEnabled}, sendState=${preferredFillMetrics.sendState}`);
      return preferredFillMetrics;
    }
    logf("warn", "fill_fallback verification failed for very large payload; falling back to native insertion");
  }

  const bulkMetrics = await tryNativePath({ method: "native_insert_text", mode: "bulk" });
  if (isSuccess(bulkMetrics, merged)) {
    logf("info", `Prompt insert success: ${bulkMetrics.method} ${bulkMetrics.actualChars}/${bulkMetrics.expectedChars} chars (${(bulkMetrics.ratio * 100).toFixed(1)}%), sendEnabled=${bulkMetrics.sendEnabled}, sendState=${bulkMetrics.sendState}`);
    return bulkMetrics;
  }

  if (!bulkMetrics.exactMatch) {
    logf("warn", `Prompt insert bulk verify failed; falling back to chunked native insert`);
  }
  const chunkedMetrics = await tryNativePath({ method: "native_insert_text_chunked", mode: "chunked" });
  if (isSuccess(chunkedMetrics, merged)) {
    logf("info", `Prompt insert success: ${chunkedMetrics.method} ${chunkedMetrics.actualChars}/${chunkedMetrics.expectedChars} chars (${(chunkedMetrics.ratio * 100).toFixed(1)}%), sendEnabled=${chunkedMetrics.sendEnabled}, sendState=${chunkedMetrics.sendState}`);
    return chunkedMetrics;
  }

  if (fillAlreadyTried) {
    const finalMetrics = chunkedMetrics || bulkMetrics || metrics;
    throw makeInsertionError(
      finalMetrics.sendButtonFound && !finalMetrics.sendEnabled ? "prompt_send_not_ready" : "prompt_insertion_failed",
      `Prompt insertion failed: ${finalMetrics.actualChars}/${finalMetrics.expectedChars} chars (${(finalMetrics.ratio * 100).toFixed(1)}%), delta=${finalMetrics.deltaChars}, sendEnabled=${finalMetrics.sendEnabled}, sendState=${finalMetrics.sendState}`,
      {
        ...finalMetrics,
        failureReason: finalMetrics.exactMatch ? "send_not_ready" : "content_mismatch",
      },
    );
  }

  logf("warn", `Prompt insert chunked verify failed; falling back to fill_fallback`);
  const fillMetrics = await tryNativePath({ method: "fill_fallback", mode: "fill" });
  if (isSuccess(fillMetrics, merged)) {
    logf("info", `Prompt insert success: ${fillMetrics.method} ${fillMetrics.actualChars}/${fillMetrics.expectedChars} chars (${(fillMetrics.ratio * 100).toFixed(1)}%), sendEnabled=${fillMetrics.sendEnabled}, sendState=${fillMetrics.sendState}`);
    return fillMetrics;
  }

  const finalMetrics = fillMetrics || chunkedMetrics || bulkMetrics || metrics;
  const textFailed = !finalMetrics.exactMatch;
  throw makeInsertionError(
    !textFailed && finalMetrics.sendButtonFound && !finalMetrics.sendEnabled ? "prompt_send_not_ready" : "prompt_insertion_failed",
    `Prompt insertion failed: ${finalMetrics.actualChars}/${finalMetrics.expectedChars} chars (${(finalMetrics.ratio * 100).toFixed(1)}%), delta=${finalMetrics.deltaChars}, sendEnabled=${finalMetrics.sendEnabled}, sendState=${finalMetrics.sendState}`,
    {
      ...finalMetrics,
      failureReason: textFailed ? "content_mismatch" : "send_not_ready",
    },
  );
}

module.exports = {
  enterPromptWithVerification,
  __private: {
    DEFAULT_THRESHOLDS,
    normalizeForLengthComparison,
    byteLength,
    resolveNativeInsertTimeoutMs,
    splitUtf8Chunks,
    splitNativeInsertChunks,
    readComposerState,
    clearComposer,
    buildMetrics,
    isSoftTextMatch,
    isSuccess,
    tryReplaceViaProseMirror,
  },
};
