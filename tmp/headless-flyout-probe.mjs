/**
 * Headless flyout probe — targeted investigation of stage-thread-flyout behavior.
 * 
 * Tests:
 * 1. Does stage-thread-flyout exist in DOM (even at width 0)?
 * 2. Can we force it visible via CSS override?
 * 3. Does click actually trigger React state?
 * 4. Can we extract trace text even from a hidden flyout?
 * 5. Test larger viewport (1920x1080)
 */
import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
const prompt = 'Think carefully, answer in 3 numbered bullets: why is the sky blue? Each bullet 2 sentences.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-flyout-probe-'));

function log(label, data) {
  console.log(`\n=== ${label} ===`);
  if (typeof data === 'string') console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

async function waitForReady(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      if (document.querySelector('#prompt-textarea')) return 'ready';
      const btns = Array.from(document.querySelectorAll('button, a'));
      if (btns.some(b => /^(log in|sign in|sign up)$/i.test((b.textContent || '').trim()))) return 'login';
      return 'loading';
    });
    if (state === 'ready') return true;
    if (state === 'login') throw new Error('login_required');
    await sleep(1000);
  }
  throw new Error('ui_timeout');
}

async function selectThinking(page) {
  try {
    const dropdown = page.locator('[data-testid="model-switcher-dropdown-button"]').first();
    await dropdown.click({ timeout: 5000 });
    await sleep(600);
    const btn = page.locator('[data-testid="model-switcher-gpt-5-4-thinking"]').first();
    await btn.click({ timeout: 5000 });
    await sleep(500);
    return true;
  } catch {
    return false;
  }
}

async function waitForResponse(page, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await sleep(700);
    const state = await page.evaluate(() => {
      const turnSel = 'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]';
      const turns = Array.from(document.querySelectorAll(turnSel));
      const isAssistant = (node) => {
        const sr = node.querySelector('.sr-only');
        const s = (sr?.textContent || '').toLowerCase();
        if (s.includes('chatgpt said') || s.includes('assistant said')) return true;
        return false;
      };
      let last = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isAssistant(turns[i])) { last = turns[i]; break; }
      }
      const stop = !!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop"]');
      const text = ((last?.querySelector('.markdown')?.innerText) || '').trim();
      return {
        stop,
        text,
        hasCopy: !!last?.querySelector('button[data-testid="copy-turn-action-button"]'),
      };
    });
    if (state.text === lastText && state.text) stable += 1;
    else { lastText = state.text; stable = 0; }
    if (!state.stop && state.text && (state.hasCopy || stable >= 4)) return state;
  }
  throw new Error('response_timeout');
}

async function main() {
  const headless = process.env.CLOAK_HEADLESS !== '0';
  const vpWidth = parseInt(process.env.VP_WIDTH || '1920', 10);
  const vpHeight = parseInt(process.env.VP_HEIGHT || '1080', 10);

  log('config', { headless, viewport: { w: vpWidth, h: vpHeight }, tempDir });

  const context = await launchPersistentContext({
    userDataDir: tempDir,
    headless,
    humanize: true,
    humanPreset: 'careful',
    viewport: { width: vpWidth, height: vpHeight },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: ['--fingerprint-storage-quota=5000'],
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    await loadAndInjectChatgptCookies(context, { profileEmail, log: (msg) => console.log('[auth]', msg) });
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForReady(page);
    log('ready', 'OK');

    await selectThinking(page);

    const textarea = page.locator('#prompt-textarea').first();
    await textarea.click({ timeout: 10000 });
    await sleep(400);
    await textarea.type(prompt);
    await sleep(300);
    await page.locator('button[data-testid="send-button"]').first().click({ timeout: 10000 });

    const settled = await waitForResponse(page);
    log('response_settled', { textLen: settled.text.length });

    // ─── TEST 1: Does stage-thread-flyout exist in DOM at all (before click)? ───
    const test1 = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stage-thread-flyout"]');
      if (!el) return { exists: false };
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        exists: true,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        display: style.display,
        visibility: style.visibility,
        overflow: style.overflow,
        overflowX: style.overflowX,
        width: style.width,
        maxWidth: style.maxWidth,
        opacity: style.opacity,
        classList: el.className?.slice(0, 300),
        textLen: (el.innerText || '').length,
        textPreview: (el.innerText || '').slice(0, 400),
      };
    });
    log('TEST1_flyout_before_click', test1);

    // ─── TEST 2: Find the "Thought for" button ───
    const test2 = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const thoughtBtn = buttons.find(b => /Thought for|Thinking for/i.test(b.innerText || b.textContent));
      if (!thoughtBtn) return { found: false };
      const r = thoughtBtn.getBoundingClientRect();
      return {
        found: true,
        text: (thoughtBtn.innerText || thoughtBtn.textContent || '').trim(),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        cls: (thoughtBtn.className || '').slice(0, 200),
        disabled: thoughtBtn.disabled,
        ariaExpanded: thoughtBtn.getAttribute('aria-expanded'),
        ariaControls: thoughtBtn.getAttribute('aria-controls'),
        onclick: typeof thoughtBtn.onclick,
        listeners: thoughtBtn.getAttribute('onclick'),
      };
    });
    log('TEST2_thought_button', test2);

    // ─── TEST 3: Click the button and check flyout state ───
    const thoughtLoc = page.locator('button:has-text("Thought for")').first();
    const thoughtCount = await thoughtLoc.count();
    log('TEST3_locator_count', { count: thoughtCount });

    if (thoughtCount > 0) {
      // Try hover first
      await thoughtLoc.hover({ timeout: 3000 }).catch(e => log('hover_error', e.message));
      await sleep(500);

      // Click
      await thoughtLoc.click({ timeout: 5000 }).catch(e => log('click_error', e.message));
      await sleep(2000);

      // Check flyout state after click
      const test3a = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return { exists: false };
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          exists: true,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          display: style.display,
          visibility: style.visibility,
          overflow: style.overflow,
          overflowX: style.overflowX,
          width: style.width,
          maxWidth: style.maxWidth,
          opacity: style.opacity,
          textLen: (el.innerText || '').length,
          textPreview: (el.innerText || '').slice(0, 800),
        };
      });
      log('TEST3a_flyout_after_click', test3a);

      // ─── TEST 4: Force flyout visible via CSS override ───
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return;
        // Force width + visibility
        el.style.setProperty('width', '400px', 'important');
        el.style.setProperty('min-width', '400px', 'important');
        el.style.setProperty('max-width', '400px', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
        el.style.setProperty('overflow-x', 'visible', 'important');
        el.style.setProperty('display', 'block', 'important');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('opacity', '1', 'important');
        // Also force the inner absolute container
        const inner = el.querySelector('.absolute.h-full');
        if (inner) {
          inner.style.setProperty('width', '400px', 'important');
          inner.style.setProperty('min-width', '400px', 'important');
        }
      });
      await sleep(500);

      const test4 = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return { exists: false };
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          exists: true,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          width: style.width,
          textLen: (el.innerText || '').length,
          textPreview: (el.innerText || '').slice(0, 800),
        };
      });
      log('TEST4_flyout_after_css_force', test4);

      // ─── TEST 5: Extract trace text directly from flyout innerText ───
      const test5 = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return { found: false };
        const fullText = (el.innerText || '').trim();
        return {
          found: true,
          fullTextLength: fullText.length,
          fullText: fullText.slice(0, 3000),
        };
      });
      log('TEST5_flyout_full_text', test5);

      // ─── TEST 6: Check for CSS custom properties controlling flyout width ───
      const test6 = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return {};
        const style = getComputedStyle(el);
        const root = getComputedStyle(document.documentElement);
        return {
          flyoutWidth: style.getPropertyValue('--stage-thread-flyout-preset-width'),
          flyoutOverride: style.getPropertyValue('--stage-thread-flyout-override-width'),
          rootFlyoutWidth: root.getPropertyValue('--stage-thread-flyout-preset-width'),
          rootFlyoutOverride: root.getPropertyValue('--stage-thread-flyout-override-width'),
        };
      });
      log('TEST6_css_custom_props', test6);

      // ─── TEST 7: Try dispatching click manually with bubbling ───
      // Reset flyout first
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (el) el.removeAttribute('style');
        const inner = el?.querySelector('.absolute.h-full');
        if (inner) inner.removeAttribute('style');
      });
      await sleep(300);

      // Dispatch proper mouse events
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const thoughtBtn = buttons.find(b => /Thought for|Thinking for/i.test(b.innerText || b.textContent));
        if (!thoughtBtn) return 'no_button';
        const r = thoughtBtn.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          thoughtBtn.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: cx, clientY: cy,
            pointerId: 1, pointerType: 'mouse',
            button: 0, buttons: type.includes('down') ? 1 : 0,
          }));
        }
        return 'dispatched';
      });
      await sleep(2000);

      const test7 = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return { exists: false };
        const r = el.getBoundingClientRect();
        return {
          exists: true,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          width: getComputedStyle(el).width,
          textLen: (el.innerText || '').length,
        };
      });
      log('TEST7_after_manual_dispatch', test7);

      // ─── TEST 8: Check if CSS custom prop sets the width; try setting it ───
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return;
        // ChatGPT might control the flyout via CSS custom properties on a parent
        // Set the override width on the element and its parents
        el.style.setProperty('--stage-thread-flyout-override-width', '400px');
        el.style.setProperty('--stage-thread-flyout-preset-width', '400px');
        // Also on document root
        document.documentElement.style.setProperty('--stage-thread-flyout-override-width', '400px');
        document.documentElement.style.setProperty('--stage-thread-flyout-preset-width', '400px');
      });
      await sleep(500);

      const test8 = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return { exists: false };
        const r = el.getBoundingClientRect();
        return {
          exists: true,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          width: getComputedStyle(el).width,
          textLen: (el.innerText || '').length,
          textPreview: (el.innerText || '').slice(0, 800),
        };
      });
      log('TEST8_after_css_var_override', test8);

      // ─── TEST 9: Check if React state/context holds trace data ───
      const test9 = await page.evaluate(() => {
        // React fiber inspection - find trace data in component state
        const el = document.querySelector('[data-testid="stage-thread-flyout"]');
        if (!el) return { fiber: false };
        // Walk React internal fiber
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        if (!fiberKey) return { fiber: false, keys: Object.keys(el).filter(k => k.startsWith('__react')).slice(0, 5) };
        let fiber = el[fiberKey];
        const states = [];
        let depth = 0;
        while (fiber && depth < 30) {
          if (fiber.memoizedState) {
            const s = fiber.memoizedState;
            // Capture queue of states
            let current = s;
            let stateIdx = 0;
            while (current && stateIdx < 5) {
              if (current.memoizedState && typeof current.memoizedState === 'object') {
                const keys = Object.keys(current.memoizedState);
                states.push({ depth, stateIdx, keys: keys.slice(0, 10), preview: JSON.stringify(current.memoizedState).slice(0, 200) });
              }
              current = current.next;
              stateIdx++;
            }
          }
          fiber = fiber.return;
          depth++;
        }
        return { fiber: true, stateCount: states.length, states: states.slice(0, 15) };
      });
      log('TEST9_react_fiber_state', test9);
    }

    // Take screenshot
    await page.screenshot({ path: '/tmp/headless-flyout-probe.png', fullPage: false });
    log('done', 'Probe complete');

  } finally {
    try { await context.close(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
