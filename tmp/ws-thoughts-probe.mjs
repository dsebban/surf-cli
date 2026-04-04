// WebSocket + React probe — parse thinking trace from conduit WebSocket frames.
// Uses a harder prompt to force longer thinking time.
import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
// Harder prompt to force longer thinking
const prompt = 'Think very carefully step by step. A farmer has 17 sheep. All but 9 die. He buys 3 more, then half the total escape. How many remain? Show all reasoning.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-ws-probe-'));

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

// Parse SSE-format data embedded in WebSocket frames
function parseEncodedItem(encodedItem) {
  const results = { thoughts: [], parts: [], paths: [], metadata: {} };
  if (typeof encodedItem !== 'string') return results;
  
  const lines = encodedItem.split('\n');
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('event:')) continue;
    if (line.startsWith('data: ')) line = line.slice(6).trim();
    if (line === '[DONE]' || line === 'message_stream_complete') continue;
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.p === 'string') {
        results.paths.push(obj.p);
        // Thoughts content
        const tm = obj.p.match(/\/message\/content\/thoughts\/(\d+)\/content$/);
        if (tm && typeof obj.v === 'string') {
          const idx = parseInt(tm[1], 10);
          while (results.thoughts.length <= idx) results.thoughts.push({ content: '', summary: '' });
          if (obj.o === 'append') results.thoughts[idx].content += obj.v;
          else if (obj.o === 'replace') results.thoughts[idx].content = obj.v;
        }
        // Thoughts summary
        const sm = obj.p.match(/\/message\/content\/thoughts\/(\d+)\/summary$/);
        if (sm && typeof obj.v === 'string') {
          const idx = parseInt(sm[1], 10);
          while (results.thoughts.length <= idx) results.thoughts.push({ content: '', summary: '' });
          if (obj.o === 'append') results.thoughts[idx].summary += obj.v;
          else if (obj.o === 'replace') results.thoughts[idx].summary = obj.v;
        }
        // Parts
        const pm = obj.p.match(/\/message\/content\/parts\/(\d+)$/);
        if (pm && typeof obj.v === 'string') {
          const idx = parseInt(pm[1], 10);
          while (results.parts.length <= idx) results.parts.push('');
          if (obj.o === 'append') results.parts[idx] += obj.v;
          else if (obj.o === 'replace') results.parts[idx] = obj.v;
        }
        // Metadata paths
        if (obj.p.includes('metadata') || obj.p.includes('reasoning') || obj.p.includes('finished')) {
          results.metadata[obj.p] = obj.v;
        }
      }
      // Array of ops
      if (Array.isArray(obj.v)) {
        for (const op of obj.v) {
          if (typeof op.p !== 'string') continue;
          results.paths.push(op.p);
          const tm = op.p.match(/\/message\/content\/thoughts\/(\d+)\/content$/);
          if (tm && typeof op.v === 'string') {
            const idx = parseInt(tm[1], 10);
            while (results.thoughts.length <= idx) results.thoughts.push({ content: '', summary: '' });
            if (op.o === 'append') results.thoughts[idx].content += op.v;
          }
          const sm = op.p.match(/\/message\/content\/thoughts\/(\d+)\/summary$/);
          if (sm && typeof op.v === 'string') {
            const idx = parseInt(sm[1], 10);
            while (results.thoughts.length <= idx) results.thoughts.push({ content: '', summary: '' });
            if (op.o === 'append') results.thoughts[idx].summary += op.v;
          }
          const pm = op.p.match(/\/message\/content\/parts\/(\d+)$/);
          if (pm && typeof op.v === 'string') {
            const idx = parseInt(pm[1], 10);
            while (results.parts.length <= idx) results.parts.push('');
            if (op.o === 'append') results.parts[idx] += op.v;
          }
          if (op.p.includes('metadata') || op.p.includes('reasoning') || op.p.includes('finished')) {
            results.metadata[op.p] = op.v;
          }
        }
      }
      // Full message object
      const msg = (obj.v && obj.v.message) || obj.message;
      if (msg && msg.content) {
        if (msg.content.thoughts && Array.isArray(msg.content.thoughts)) {
          results.thoughts = msg.content.thoughts.map(t => 
            typeof t === 'string' ? { content: t, summary: '' } : { content: t?.content || '', summary: t?.summary || '' }
          );
        }
      }
    } catch {}
  }
  return results;
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
  
  // Collect WebSocket frames
  const allFrames = [];
  const aggregated = { thoughts: [], parts: [], paths: new Set(), metadata: {} };
  
  page.on('websocket', ws => {
    log('ws_opened', { url: ws.url().slice(0, 200) });
    ws.on('framereceived', frame => {
      const text = frame.payload?.toString?.() || '';
      if (text.length < 10) return;
      try {
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
          if (item.type !== 'message' || !item.payload) continue;
          const payload = item.payload;
          if (payload.type !== 'conversation-turn-stream') continue;
          const inner = payload.payload;
          if (!inner || inner.type !== 'stream-item') continue;
          const encoded = inner.encoded_item;
          if (!encoded) continue;
          
          // Parse the embedded SSE data
          const parsed = parseEncodedItem(encoded);
          
          // Aggregate
          for (const t of parsed.thoughts) {
            // Merge by index
            const idx = aggregated.thoughts.length;
            aggregated.thoughts.push(t);
          }
          for (const p of parsed.parts) {
            if (aggregated.parts.length === 0) aggregated.parts.push('');
            aggregated.parts[0] += p;
          }
          for (const path of parsed.paths) aggregated.paths.add(path);
          Object.assign(aggregated.metadata, parsed.metadata);
          
          // Store frame for debugging
          if (allFrames.length < 200) {
            allFrames.push({
              len: encoded.length,
              thoughtsFound: parsed.thoughts.length,
              partsFound: parsed.parts.length,
              pathsFound: parsed.paths.length,
              preview: encoded.slice(0, 300),
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
    
    // Wait a moment for any trailing frames
    await sleep(2000);

    // ─── WebSocket Results ───
    log('WS_FRAMES', {
      total: allFrames.length,
      withThoughts: allFrames.filter(f => f.thoughtsFound > 0).length,
      withParts: allFrames.filter(f => f.partsFound > 0).length,
    });

    log('WS_UNIQUE_PATHS', [...aggregated.paths]);

    log('WS_THOUGHTS', {
      count: aggregated.thoughts.length,
      thoughts: aggregated.thoughts.map((t, i) => ({
        idx: i,
        contentLen: t.content.length,
        contentPreview: t.content.slice(0, 300),
        summaryLen: t.summary.length,
        summary: t.summary.slice(0, 200),
      })),
    });

    log('WS_PARTS', {
      count: aggregated.parts.length,
      totalLen: aggregated.parts.join('').length,
      preview: aggregated.parts.join('').slice(0, 500),
    });

    log('WS_METADATA', aggregated.metadata);

    // Full concatenated thoughts text
    const thoughtsText = aggregated.thoughts.map(t => t.content).filter(Boolean).join('\n');
    if (thoughtsText) {
      log('FULL_THOUGHTS_TEXT', thoughtsText);
      log('FULL_THOUGHTS_LENGTH', thoughtsText.length);
    }

    // ─── Also check React fiber ───
    const reactExtraction = await page.evaluate(`(() => {
      var buttons = Array.from(document.querySelectorAll('button'));
      var thoughtBtn = buttons.find(function(b) { return /Thought for|Thinking for/i.test(b.innerText || b.textContent); });
      if (!thoughtBtn) return { error: 'no_button' };
      var fiberKey = Object.keys(thoughtBtn).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (!fiberKey) return { error: 'no_fiber' };
      var fiber = thoughtBtn[fiberKey];
      var depth = 0;
      while (fiber && depth < 50) {
        if (fiber.memoizedProps && fiber.memoizedProps.allMessages) {
          var msgs = fiber.memoizedProps.allMessages;
          var result = [];
          for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            if (!m || !m.content) continue;
            var entry = { ct: m.content.content_type, keys: Object.keys(m.content) };
            if (m.content.content_type === 'thoughts') {
              entry.thoughtsLen = Array.isArray(m.content.thoughts) ? m.content.thoughts.length : -1;
              if (entry.thoughtsLen > 0) {
                entry.firstThought = typeof m.content.thoughts[0] === 'string' ? m.content.thoughts[0].slice(0, 200) : JSON.stringify(m.content.thoughts[0]).slice(0, 200);
              }
            }
            if (m.content.content_type === 'reasoning_recap') {
              entry.recap = m.content.content;
            }
            if (m.metadata) {
              entry.duration = m.metadata.finished_duration_sec;
              entry.reasoningStatus = m.metadata.reasoning_status;
            }
            result.push(entry);
          }
          return { found: true, messages: result };
        }
        fiber = fiber.return;
        depth++;
      }
      return { error: 'not_found' };
    })()`);
    log('REACT_STATE', reactExtraction);

    // Sample frames for debugging
    log('SAMPLE_FRAMES', allFrames.slice(0, 10));

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
