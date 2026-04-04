// React State + WebSocket Probe — find thinking trace in browser JS state.
// The SSE response is just a conduit token; actual data comes via WebSocket.
// But the client state must contain the thinking data since the UI renders it.
import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
const prompt = 'Think carefully, answer in 3 numbered bullets: why is the sky blue? Each bullet 2 sentences.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-react-probe-'));

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
  } catch (e) { return false; }
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
  
  // Monitor WebSocket connections
  const wsMessages = [];
  page.on('websocket', ws => {
    log('websocket_opened', { url: ws.url().slice(0, 300) });
    ws.on('framereceived', frame => {
      const text = frame.payload?.toString?.() || '';
      if (text.length > 10 && wsMessages.length < 500) {
        // Look for thinking-related content
        const isRelevant = text.includes('thought') || text.includes('think') ||
                           text.includes('content') || text.includes('parts') ||
                           text.includes('message') || text.includes('assistant');
        if (isRelevant || wsMessages.length < 50) {
          wsMessages.push({
            len: text.length,
            preview: text.slice(0, 300),
            hasThought: text.includes('thought'),
            hasThink: text.includes('think'),
          });
        }
      }
    });
    ws.on('framesent', frame => {
      const text = frame.payload?.toString?.() || '';
      if (text.length > 10 && wsMessages.length < 500) {
        wsMessages.push({ dir: 'sent', len: text.length, preview: text.slice(0, 200) });
      }
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

    // ─── TEST 1: WebSocket messages ───
    log('TEST1_websocket_messages', {
      total: wsMessages.length,
      withThought: wsMessages.filter(m => m.hasThought).length,
      withThink: wsMessages.filter(m => m.hasThink).length,
      sample: wsMessages.slice(0, 20),
    });

    // ─── TEST 2: React fiber on the "Thought for" button ───
    const test2 = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const thoughtBtn = buttons.find(b => /Thought for|Thinking for/i.test(b.innerText || b.textContent));
      if (!thoughtBtn) return { found: false };
      
      // Walk up the tree to find React fiber with state
      const fiberKey = Object.keys(thoughtBtn).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return { found: true, fiber: false };
      
      let fiber = thoughtBtn[fiberKey];
      const stateInfo = [];
      let depth = 0;
      while (fiber && depth < 40) {
        // Check memoizedProps for thinking data
        if (fiber.memoizedProps) {
          const propKeys = Object.keys(fiber.memoizedProps);
          const interesting = propKeys.filter(k => 
            /thought|think|trace|reason|stage|activity|content|message|turn/i.test(k)
          );
          if (interesting.length > 0) {
            stateInfo.push({
              depth,
              type: fiber.type?.displayName || fiber.type?.name || typeof fiber.type,
              propKeys: interesting,
              propPreviews: interesting.map(k => {
                const v = fiber.memoizedProps[k];
                return typeof v === 'string' ? v.slice(0, 200) : typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v);
              }),
            });
          }
        }
        
        // Check memoizedState for thinking data
        if (fiber.memoizedState) {
          let state = fiber.memoizedState;
          let sIdx = 0;
          while (state && sIdx < 8) {
            const ms = state.memoizedState;
            if (ms && typeof ms === 'object' && !Array.isArray(ms)) {
              const sKeys = Object.keys(ms);
              const interesting = sKeys.filter(k =>
                /thought|think|trace|reason|stage|activity|content|message/i.test(k)
              );
              if (interesting.length > 0) {
                stateInfo.push({
                  depth,
                  stateIdx: sIdx,
                  type: fiber.type?.displayName || fiber.type?.name || typeof fiber.type,
                  stateKeys: interesting,
                  statePreviews: interesting.map(k => {
                    const v = ms[k];
                    return typeof v === 'string' ? v.slice(0, 200) : typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : String(v);
                  }),
                });
              }
            }
            state = state.next;
            sIdx++;
          }
        }
        fiber = fiber.return;
        depth++;
      }
      return { found: true, fiber: true, stateCount: stateInfo.length, states: stateInfo.slice(0, 20) };
    });
    log('TEST2_react_fiber_button', test2);

    // ─── TEST 3: Check __NEXT_DATA__ or global stores ───
    const test3 = await page.evaluate(() => {
      const results = {};
      // __NEXT_DATA__
      if (window.__NEXT_DATA__) {
        results.nextData = { keys: Object.keys(window.__NEXT_DATA__), preview: JSON.stringify(window.__NEXT_DATA__).slice(0, 300) };
      }
      // Check for Redux/Zustand stores
      const rootEl = document.getElementById('__next') || document.getElementById('root');
      if (rootEl) {
        const storeKey = Object.keys(rootEl).find(k => k.includes('store') || k.includes('Store'));
        if (storeKey) results.store = { key: storeKey };
      }
      // Check window globals
      const globals = Object.keys(window).filter(k =>
        /chat|conversation|message|thought|think|store|state/i.test(k) && !k.startsWith('__') && !k.startsWith('webkit')
      ).slice(0, 20);
      results.globals = globals;
      return results;
    });
    log('TEST3_global_state', test3);

    // ─── TEST 4: Walk React tree from assistant turn to find thoughts in props/state ───
    const test4 = await page.evaluate(() => {
      const turnSel = 'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]';
      const turns = Array.from(document.querySelectorAll(turnSel));
      let last = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        const sr = turns[i].querySelector('.sr-only');
        const s = (sr?.textContent || '').toLowerCase();
        if (s.includes('chatgpt said') || s.includes('assistant said')) { last = turns[i]; break; }
      }
      if (!last) return { found: false };
      
      const fiberKey = Object.keys(last).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return { found: true, fiber: false };
      
      let fiber = last[fiberKey];
      const results = [];
      let depth = 0;
      
      // Walk UP the tree
      while (fiber && depth < 50) {
        if (fiber.memoizedProps) {
          const propsStr = JSON.stringify(fiber.memoizedProps);
          if (propsStr.includes('thought') || propsStr.includes('think')) {
            const keys = Object.keys(fiber.memoizedProps);
            results.push({
              depth,
              dir: 'up',
              type: fiber.type?.displayName || fiber.type?.name || typeof fiber.type,
              allKeys: keys.slice(0, 15),
              propsPreview: propsStr.slice(0, 500),
            });
          }
        }
        fiber = fiber.return;
        depth++;
      }
      
      // Also check pendingProps
      fiber = last[fiberKey];
      depth = 0;
      while (fiber && depth < 50) {
        if (fiber.pendingProps) {
          const propsStr = JSON.stringify(fiber.pendingProps);
          if (propsStr.includes('thought') || propsStr.includes('think')) {
            const keys = Object.keys(fiber.pendingProps);
            if (!results.some(r => r.depth === depth && r.dir === 'up')) {
              results.push({
                depth,
                dir: 'up-pending',
                type: fiber.type?.displayName || fiber.type?.name || typeof fiber.type,
                allKeys: keys.slice(0, 15),
              });
            }
          }
        }
        fiber = fiber.return;
        depth++;
      }
      
      return { found: true, fiber: true, matchCount: results.length, matches: results.slice(0, 15) };
    });
    log('TEST4_react_turn_tree', test4);

    // ─── TEST 5: Try to find message data by message-id attribute ───
    const test5 = await page.evaluate(() => {
      const msgEl = document.querySelector('[data-message-author-role="assistant"][data-message-id]');
      if (!msgEl) return { found: false };
      const messageId = msgEl.getAttribute('data-message-id');
      
      const fiberKey = Object.keys(msgEl).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return { found: true, messageId, fiber: false };
      
      let fiber = msgEl[fiberKey];
      let depth = 0;
      const results = [];
      
      while (fiber && depth < 60) {
        if (fiber.memoizedProps) {
          const pk = Object.keys(fiber.memoizedProps);
          // Look for a "message" prop that might contain thoughts
          if (fiber.memoizedProps.message || fiber.memoizedProps.turnMessage || fiber.memoizedProps.data) {
            const msg = fiber.memoizedProps.message || fiber.memoizedProps.turnMessage || fiber.memoizedProps.data;
            if (typeof msg === 'object' && msg !== null) {
              results.push({
                depth,
                type: fiber.type?.displayName || fiber.type?.name || typeof fiber.type,
                propKey: fiber.memoizedProps.message ? 'message' : fiber.memoizedProps.turnMessage ? 'turnMessage' : 'data',
                msgKeys: Object.keys(msg).slice(0, 20),
                hasContent: !!msg.content,
                hasThoughts: !!(msg.content && msg.content.thoughts),
                contentKeys: msg.content ? Object.keys(msg.content).slice(0, 10) : [],
                thoughtsPreview: msg.content?.thoughts ? JSON.stringify(msg.content.thoughts).slice(0, 1000) : null,
                partsPreview: msg.content?.parts ? JSON.stringify(msg.content.parts).slice(0, 300) : null,
              });
            }
          }
        }
        fiber = fiber.return;
        depth++;
      }
      return { found: true, messageId, fiber: true, matchCount: results.length, matches: results.slice(0, 10) };
    });
    log('TEST5_message_props', test5);

    // ─── TEST 6: Broader search - any React component with "thoughts" in stringified props ───
    const test6 = await page.evaluate(() => {
      // Start from multiple elements
      const startPoints = [
        document.querySelector('[data-message-author-role="assistant"]'),
        document.querySelector('main'),
        document.querySelector('[class*="thread"]'),
      ].filter(Boolean);
      
      const found = [];
      for (const start of startPoints) {
        const fiberKey = Object.keys(start).find(k => k.startsWith('__reactFiber$'));
        if (!fiberKey) continue;
        let fiber = start[fiberKey];
        let depth = 0;
        while (fiber && depth < 80) {
          try {
            if (fiber.memoizedProps) {
              const str = JSON.stringify(fiber.memoizedProps);
              if (str.length > 50 && str.includes('"thoughts"')) {
                found.push({
                  startTag: start.tagName,
                  depth,
                  type: fiber.type?.displayName || fiber.type?.name || typeof fiber.type,
                  propsSize: str.length,
                  propsExcerpt: str.slice(str.indexOf('"thoughts"') - 30, str.indexOf('"thoughts"') + 500),
                });
              }
            }
          } catch {}
          fiber = fiber.return;
          depth++;
        }
      }
      return { count: found.length, found: found.slice(0, 10) };
    });
    log('TEST6_broad_thoughts_search', test6);

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
