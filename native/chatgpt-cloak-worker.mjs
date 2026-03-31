/**
 * ChatGPT CloakBrowser Worker
 *
 * Stealth Chromium automation using CloakBrowser (Playwright-based).
 * Defeats bot detection via 33 C++ source-level patches + behavioral humanization.
 *
 * Protocol: stdin JSON lines → stdout JSON lines
 *   Input:  { type:"query", prompt, model?, file?, profile?, timeout?, generateImage? }
 *   Output: { type:"progress"|"success"|"error", … }
 *
 * Environment:
 *   CLOAK_HEADLESS  — "0" for headed (default "1")
 *   CLOAK_HUMANIZE  — "0" to disable (default "1")
 */

import { launchPersistentContext } from 'cloakbrowser';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve as pathResolve } from 'path';
import { loadAndInjectChatgptCookies } from './chatgpt-cloak-profile-auth.mjs';

// ============================================================================
// Logging helpers — everything goes to stdout as JSON lines

const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, t: Date.now() }) + '\n');
const log   = (level, message, data) => emit({ type: 'log', level, message, data });
const progress = (step, total, msg)  => emit({ type: 'progress', step, total, message: msg });
const success  = (payload)           => emit({ type: 'success', ...payload });
const fail     = (code, message, d)  => emit({ type: 'error', code, message, details: d });

/** Native sleep — does NOT leak CDP signals (unlike page.waitForTimeout). */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================================
// Model mapping — mirrors chatgpt-bun-worker-logic.ts

const MODEL_MAP = {
  'gpt-4o':            { mode: 'instant',  tid: 'model-switcher-gpt-5-3' },
  'gpt-4.1':           { mode: 'instant',  tid: 'model-switcher-gpt-5-3' },
  'gpt-4.1-mini':      { mode: 'instant',  tid: 'model-switcher-gpt-5-3' },
  'gpt-5.3':           { mode: 'instant',  tid: 'model-switcher-gpt-5-3' },
  'instant':           { mode: 'instant',  tid: 'model-switcher-gpt-5-3' },
  'o3':                { mode: 'thinking', tid: 'model-switcher-gpt-5-4-thinking' },
  'o4-mini':           { mode: 'thinking', tid: 'model-switcher-gpt-5-4-thinking' },
  'gpt-5.4-thinking':  { mode: 'thinking', tid: 'model-switcher-gpt-5-4-thinking' },
  'thinking':          { mode: 'thinking', tid: 'model-switcher-gpt-5-4-thinking' },
  'o1-pro':            { mode: 'pro',      tid: 'model-switcher-gpt-5-4-pro' },
  'gpt-5.4-pro':       { mode: 'pro',      tid: 'model-switcher-gpt-5-4-pro' },
  'pro':               { mode: 'pro',      tid: 'model-switcher-gpt-5-4-pro' },
  'chatgpt-pro':       { mode: 'pro',      tid: 'model-switcher-gpt-5-4-pro' },
};

function resolveModel(id) {
  return MODEL_MAP[(id || '').toLowerCase().trim()] || { mode: 'default', tid: null };
}

// ============================================================================
// UI noise patterns — strips chrome from DOM text

const UI_NOISE = [
  /^ChatGPT said:\s*/i,
  /Thought for [\w\s]+ seconds?\s*/gi,
  /^Thinking\s*/i,
  /^Analyzing image\s*/i,
  /^Searching the web\s*/i,
  /Give feedback\s*/gi,
  /ChatGPT Instruments\s*/gi,
  /\s*Copy\s*$/gm,
  /^Sources\s*/gm,
  /^\d+\s*\/\s*\d+\s*$/gm,         // pagination "1/3"
  /Upgrade to Plus to use .*$/gim,
  /You've reached the .* limit.*$/gim,
];

function sanitize(raw) {
  if (!raw) return '';
  let text = raw;
  for (const re of UI_NOISE) text = text.replace(re, '');
  return text.trim();
}

// ============================================================================
// Profile directory management

/** Shared persistent profile for no-auth sessions */
function sharedProfileDir() {
  const dir = join(homedir(), '.surf', 'cloak-profile');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Isolated temp profile for --profile sessions (prevents cookie contamination) */
function tempProfileDir() {
  return mkdtempSync(join(tmpdir(), 'surf-cloak-session-'));
}

// ============================================================================
// Launch options builder

function buildLaunchOpts(userDataDir) {
  const headless = process.env.CLOAK_HEADLESS !== '0';
  const humanize = process.env.CLOAK_HUMANIZE !== '0';
  return {
    userDataDir,
    headless,
    humanize,
    humanPreset: 'careful',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: ['--fingerprint-storage-quota=5000'],
  };
}

// ============================================================================
// Readiness checks

async function waitForReady(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      // Cloudflare challenge
      if (document.title.toLowerCase().includes('just a moment')) return 'cloudflare';
      // Editor present = ready
      if (document.querySelector('#prompt-textarea')) return 'ready';
      // Login page
      const btns = Array.from(document.querySelectorAll('button, a'));
      if (btns.some(b => /^(log in|sign in|sign up)$/i.test((b.textContent || '').trim()))) return 'login';
      return 'loading';
    });

    if (state === 'ready') return { ready: true, loggedIn: true };
    if (state === 'login') return { ready: true, loggedIn: false };
    if (state === 'cloudflare') {
      log('warn', 'Cloudflare challenge detected, waiting...');
    }
    await sleep(1000);
  }
  return { ready: false, loggedIn: false };
}

// ============================================================================
// Response text extraction from DOM

const EXTRACT_TEXT_JS = `(() => {
  const turns = document.querySelectorAll('section[data-testid^="conversation-turn-"]');
  for (let k = turns.length - 1; k >= 0; k--) {
    const sr = turns[k].querySelector('.sr-only');
    if (sr && (sr.textContent || '').toLowerCase().includes('chatgpt said')) {
      const md = turns[k].querySelector('.markdown');
      return md ? (md.textContent || '').trim() : '';
    }
  }
  return '';
})()`;

const DETECT_PHASE_JS = `(() => {
  const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop"]');
  if (!stop) return { phase: '', isThinking: false };
  const turns = document.querySelectorAll(
    'section[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn-"], div[data-testid^="conversation-turn-"]'
  );
  let last = null;
  for (let k = turns.length - 1; k >= 0; k--) {
    const sr = turns[k].querySelector('.sr-only');
    if (sr && (sr.textContent || '').toLowerCase().includes('chatgpt said')) { last = turns[k]; break; }
  }
  if (!last) return { phase: 'Connecting', isThinking: true };
  const md = last.querySelector('.markdown');
  if (md && (md.textContent || '').trim()) return { phase: 'Responding', isThinking: false };
  // Thinking/reasoning phase: extract visible label (remove noise, take first line)
  const clone = last.cloneNode(true);
  clone.querySelectorAll('.sr-only, .markdown, button, nav, form, script, style').forEach(el => el.remove());
  const raw = (clone.textContent || '').trim();
  const label = raw.split('\\n')[0].trim().slice(0, 80) || 'Thinking';
  return { phase: label, isThinking: true };
})()`;

// ============================================================================
// Image detection + save

async function detectAndSaveImage(page, savePath) {
  // Find <img> inside the last assistant turn
  const imgData = await page.evaluate(() => {
    const turns = document.querySelectorAll('section[data-testid^="conversation-turn-"]');
    for (let k = turns.length - 1; k >= 0; k--) {
      const sr = turns[k].querySelector('.sr-only');
      if (!sr || !(sr.textContent || '').toLowerCase().includes('chatgpt said')) continue;
      const imgs = turns[k].querySelectorAll('img:not([alt="User"]):not([alt="ChatGPT"])');
      for (const img of imgs) {
        if (img.naturalWidth > 100 && img.naturalHeight > 100) {
          return { src: img.src, width: img.naturalWidth, height: img.naturalHeight };
        }
      }
    }
    return null;
  });

  if (!imgData) return null;

  log('info', 'Image candidate found', { width: imgData.width, height: imgData.height });

  // Fetch image bytes in page context (handles auth/CORS)
  const base64 = await page.evaluate(async (src) => {
    try {
      const resp = await fetch(src);
      const buf = await resp.arrayBuffer();
      return btoa(String.fromCharCode(...new Uint8Array(buf)));
    } catch { return null; }
  }, imgData.src);

  if (!base64) {
    log('warn', 'Image fetch failed');
    return null;
  }

  const resolved = pathResolve(savePath);
  const dir = join(resolved, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolved, Buffer.from(base64, 'base64'));
  log('info', 'Image saved', { path: resolved, bytes: Buffer.from(base64, 'base64').length });
  return resolved;
}

// ============================================================================
// Main query handler

async function runQuery({ prompt, model, file, profile, timeout = 120, generateImage }) {
  const t0 = Date.now();
  const resolved = resolveModel(model);
  const useInjectedProfile = !!profile;
  let tempDir = null;

  // ── Phase 1: Launch ──────────────────────────────────────────────────
  progress(1, 6, `Launching CloakBrowser — ${resolved.mode}`);

  // Profile strategy:
  // - With --profile: temp dir + injected cookies (isolated, no contamination)
  // - Without: shared persistent dir (relies on prior login)
  let userDataDir;
  if (useInjectedProfile) {
    tempDir = tempProfileDir();
    userDataDir = tempDir;
    log('info', 'Using isolated profile for cookie injection', { tempDir });
  } else {
    userDataDir = sharedProfileDir();
    log('info', 'Using shared persistent profile');
  }

  const context = await launchPersistentContext(buildLaunchOpts(userDataDir));
  log('info', 'CloakBrowser launched', {
    headless: process.env.CLOAK_HEADLESS !== '0',
    humanize: process.env.CLOAK_HUMANIZE !== '0',
  });

  // Cleanup on forced kill
  const cleanup = async () => {
    try { await context.close(); } catch {}
    if (tempDir) try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  };
  process.on('SIGTERM', () => cleanup().then(() => process.exit(1)));
  process.on('SIGINT', () => cleanup().then(() => process.exit(1)));

  try {
    const page = context.pages()[0] || await context.newPage();

    // ── Phase 2: Cookie injection (if --profile) ─────────────────────
    if (useInjectedProfile) {
      progress(2, 6, `Authenticating — ${profile}`);
      try {
        const authResult = await loadAndInjectChatgptCookies(context, {
          profileEmail: profile,
          log: (msg) => log('info', msg),
        });
        log('info', 'Cookie auth complete', authResult);
      } catch (e) {
        fail(e.code || 'auth_failed', e.message);
        return;
      }
    } else {
      progress(2, 6, 'Using existing session');
    }

    // ── Phase 3: Navigate ────────────────────────────────────────────
    progress(3, 6, 'Loading ChatGPT');
    await page.goto('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await sleep(2000); // human-like dwell

    const { ready, loggedIn } = await waitForReady(page, 30_000);
    log('info', 'Page state', { ready, loggedIn });

    if (!ready) {
      fail('ui_timeout', 'ChatGPT page did not become ready within 30s');
      return;
    }
    if (!loggedIn) {
      fail('login_required',
        useInjectedProfile
          ? `Login failed for profile "${profile}". Session cookie may be expired.`
          : 'ChatGPT login required. Use --profile <email> or log in via CLOAK_HEADLESS=0.'
      );
      return;
    }

    // ── Phase 4: Model selection ─────────────────────────────────────
    if (resolved.tid) {
      progress(4, 6, `Selecting model — ${resolved.mode}`);
      try {
        const dropdown = page.locator('[data-testid="model-switcher-dropdown-button"]').first();
        await dropdown.click({ timeout: 5_000 });
        await sleep(600);
        const modelBtn = page.locator(`[data-testid="${resolved.tid}"]`).first();
        await modelBtn.click({ timeout: 5_000 });
        await sleep(400);
        log('info', 'Model selected', { mode: resolved.mode, tid: resolved.tid });
      } catch (e) {
        log('warn', 'Model selection failed (continuing with default)', { error: e.message });
      }
    } else {
      progress(4, 6, 'Using default model');
    }

    // ── Phase 5: File upload + send prompt ───────────────────────────
    progress(5, 6, file ? `Uploading ${file.split('/').pop()} + sending prompt` : 'Sending prompt');

    // File upload
    if (file && existsSync(file)) {
      try {
        // Click the attach button first to reveal file input
        const attachBtn = page.locator('button[aria-label*="Attach"], button[data-testid="composer-attach-button"]').first();
        const hasAttach = await attachBtn.count() > 0;
        if (hasAttach) {
          await attachBtn.click({ timeout: 5_000 });
          await sleep(500);
        }

        // Find and use file input
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(file);
        await sleep(3_000); // wait for upload
        log('info', 'File attached', { file });
      } catch (e) {
        log('warn', 'File upload failed', { error: e.message });
      }
    }

    // Prompt entry
    const textarea = page.locator('#prompt-textarea').first();
    await textarea.click({ timeout: 10_000 });
    await sleep(500);

    // Prepare prompt (prefix for image generation)
    let finalPrompt = prompt;
    if (generateImage && !prompt.toLowerCase().startsWith('generate')) {
      finalPrompt = `Generate an image: ${prompt}`;
    }

    // type() is humanized by CloakBrowser (per-char timing, natural rhythm)
    // fill() bypasses event handlers but is faster
    await textarea.type(finalPrompt);
    await sleep(300);

    // Send
    const sendBtn = page.locator('button[data-testid="send-button"]').first();
    await sendBtn.click({ timeout: 10_000 });

    // ── Phase 6: Wait for response ───────────────────────────────────
    progress(6, 6, 'Waiting for response');

    const deadline = Date.now() + timeout * 1000;
    let responseText = '';
    let stableCycles = 0;
    let lastChangeAtMs = Date.now();
    let lastText = '';
    let lastPhase = '';
    let imagePath = null;

    while (Date.now() < deadline) {
      await sleep(500);

      // Detect phase — returns { phase, isThinking }
      const phaseResult = await page.evaluate(DETECT_PHASE_JS);
      const phase = (phaseResult && phaseResult.phase) || phaseResult || '';
      if (phase && phase !== lastPhase) {
        log('info', `⏳ ${phase}`);
        // Emit structured trace event so bridge+CLI can render it like bun worker does
        emit({ type: 'trace', phase, isThinking: !!(phaseResult && phaseResult.isThinking) });
        lastPhase = phase;
      }

      // Extract text
      const text = sanitize(await page.evaluate(EXTRACT_TEXT_JS));

      // Check streaming
      const isStreaming = await page.locator('button[data-testid="stop-button"], button[aria-label="Stop"]').count() > 0;

      // Stability check (mirrors bun advanceTextStability: requiredStableCycles=2, minStableMs=1200)
      const nowMs = Date.now();
      if (text !== lastText) {
        stableCycles = 0;
        lastChangeAtMs = nowMs;
      } else if (text && !isStreaming) {
        stableCycles++;
        const stableMs = nowMs - lastChangeAtMs;
        if (stableCycles >= 2 && stableMs >= 1200) break;
      }
      lastText = text;
      if (text) responseText = text;
    }

    // Image detection
    if (generateImage && responseText) {
      try {
        imagePath = await detectAndSaveImage(page, generateImage);
      } catch (e) {
        log('warn', 'Image detection/save failed', { error: e.message });
      }
    }

    const durationMs = Date.now() - t0;

    if (!responseText) {
      fail('no_response', 'No response text captured within timeout');
      return;
    }

    success({
      response: responseText,
      model: resolved.mode,
      tookMs: durationMs,
      imagePath,
      partial: Date.now() >= (t0 + timeout * 1000),
      backend: 'cloak',
    });

  } catch (e) {
    log('error', 'Query failed', { error: e.message, stack: e.stack });
    fail('query_failed', e.message);
  } finally {
    await context.close();
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ============================================================================
// Stdin protocol — read one query, run it, exit.

async function main() {
  log('info', 'CloakBrowser worker started');

  let buffer = '';
  let resolved = false;

  const queryPromise = new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'query' && !resolved) {
            resolved = true;
            resolve(msg);
          }
        } catch {
          fail('protocol', 'Invalid JSON');
        }
      }
    });
    process.stdin.on('end', () => {
      if (!resolved) resolve(null);
    });
  });

  const msg = await queryPromise;
  if (msg) {
    await runQuery(msg).catch(e => fail('unhandled', e.message));
  } else {
    fail('no_query', 'Stdin closed without receiving a query');
  }

  process.exit(0);
}

main().catch(e => {
  fail('fatal', e.message);
  process.exit(1);
});
