// Full WebSocket frame capture — find where thinking trace data actually flows
import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
const prompt = 'Think very carefully step by step about this complex puzzle. You have a 3-gallon jug and a 5-gallon jug. How do you measure exactly 4 gallons? Walk through every step of your reasoning.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-wsfull-probe-'));

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
    await page.locator('[data-testid="model-switcher-dropdown-button"]').first().click({ timeout: 5000 });
    await sleep(600);
    await page.locator('[data-testid="model-switcher-gpt-5-4-thinking"]').first().click({ timeout: 5000 });
    await sleep(500);
    return true;
  } catch { return false; }
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
      let last = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        const sr = turns[i].querySelector('.sr-only');
        const s = (sr?.textContent || '').toLowerCase();
        if (s.includes('chatgpt said') || s.includes('assistant said')) { last = turns[i]; break; }
      }
      const stop = !!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop"]');
      const text = ((last?.querySelector('.markdown')?.innerText) || '').trim();
      return { stop, text, hasCopy: !!last?.querySelector('button[data-testid="copy-turn-action-button"]') };
    });
    if (state.text === lastText && state.text) stable++;
    else { lastText = state.text; stable = 0; }
    if (!state.stop && state.text && (state.hasCopy || stable >= 4)) return state;
  }
  throw new Error('response_timeout');
}

async function main() {
  const headless = process.env.CLOAK_HEADLESS !== '0';
  log('config', { headless, tempDir });

  const context = await launchPersistentContext({
    userDataDir: tempDir,
    headless,
    humanize: true,
    humanPreset: 'careful',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: ['--fingerprint-storage-quota=5000'],
  });

  const page = context.pages()[0] || await context.newPage();
  
  // Capture ALL WebSocket frames with think/thought content
  const thinkFrames = [];
  const allEncodedItems = [];
  
  page.on('websocket', ws => {
    log('ws_opened', { url: ws.url().slice(0, 200) });
    ws.on('framereceived', frame => {
      const text = frame.payload?.toString?.() || '';
      if (text.length < 10) return;
      
      // Store frames with think/thought content
      const lower = text.toLowerCase();
      if (lower.includes('think') || lower.includes('thought') || lower.includes('reason')) {
        thinkFrames.push({
          len: text.length,
          // Store enough to see the full structure
          full: text.length < 5000 ? text : text.slice(0, 5000),
        });
      }
      
      // Also extract all encoded_items for full dump
      try {
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
          if (item?.payload?.payload?.encoded_item) {
            allEncodedItems.push(item.payload.payload.encoded_item);
          }
          // Also check for other payload types
          if (item?.payload && item.payload.type !== 'conversation-turn-stream') {
            thinkFrames.push({
              nonStreamPayload: true,
              type: item.payload.type,
              preview: JSON.stringify(item.payload).slice(0, 500),
            });
          }
        }
      } catch {}
    });
  });

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
    log('send_clicked', 'OK');

    const settled = await waitForResponse(page);
    log('response_settled', { textLen: settled.text.length });
    await sleep(2000);

    // ─── Analysis ───
    log('THINK_FRAMES_COUNT', thinkFrames.length);
    
    // Show think-containing frames with enough detail
    for (let i = 0; i < Math.min(thinkFrames.length, 30); i++) {
      const f = thinkFrames[i];
      if (f.nonStreamPayload) {
        log(`THINK_FRAME_${i}_nonstream`, { type: f.type, preview: f.preview });
      } else {
        // Parse and find the "think" context
        const text = f.full || '';
        // Find lines with "think" or "thought"
        const relevantParts = [];
        try {
          const arr = JSON.parse(text);
          if (Array.isArray(arr)) {
            for (const item of arr) {
              const encoded = item?.payload?.payload?.encoded_item;
              if (encoded && (encoded.toLowerCase().includes('think') || encoded.toLowerCase().includes('thought'))) {
                relevantParts.push(encoded);
              }
            }
          }
        } catch {}
        log(`THINK_FRAME_${i}`, {
          len: f.len,
          relevantEncodedItems: relevantParts.length,
          encodedPreviews: relevantParts.map(e => e.slice(0, 1000)),
        });
      }
    }

    // Save all encoded items to disk for inspection
    writeFileSync('/tmp/ws-encoded-items.txt', allEncodedItems.join('\n===SEPARATOR===\n'));
    log('ENCODED_ITEMS_SAVED', { count: allEncodedItems.length, path: '/tmp/ws-encoded-items.txt' });

    // React fiber check
    const reactCheck = await page.evaluate(`(() => {
      var buttons = Array.from(document.querySelectorAll('button'));
      var thoughtBtn = buttons.find(function(b) { return /Thought for|Thinking for/i.test(b.innerText || b.textContent); });
      if (!thoughtBtn) return { btnText: 'not found' };
      
      var fiberKey = Object.keys(thoughtBtn).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (!fiberKey) return { btnText: thoughtBtn.innerText, fiber: false };
      
      var fiber = thoughtBtn[fiberKey];
      var depth = 0;
      while (fiber && depth < 50) {
        if (fiber.memoizedProps && fiber.memoizedProps.allMessages) {
          var msgs = fiber.memoizedProps.allMessages;
          return {
            btnText: thoughtBtn.innerText,
            msgCount: msgs.length,
            contentTypes: msgs.map(function(m) { return m?.content?.content_type; }).filter(Boolean),
            thoughtsArrayLen: msgs.filter(function(m) { return m?.content?.content_type === 'thoughts'; }).map(function(m) { return m.content.thoughts?.length || 0; }),
            recapText: msgs.filter(function(m) { return m?.content?.content_type === 'reasoning_recap'; }).map(function(m) { return m.content.content || ''; }),
            durationSec: msgs.filter(function(m) { return m?.metadata?.finished_duration_sec; }).map(function(m) { return m.metadata.finished_duration_sec; }),
          };
        }
        fiber = fiber.return;
        depth++;
      }
      return { btnText: thoughtBtn.innerText, notFound: true };
    })()`);
    log('REACT_CHECK', reactCheck);

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
