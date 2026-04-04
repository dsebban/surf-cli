// SSE Thoughts Probe v2 — capture thinking trace from SSE stream in headless mode.
// Added network monitoring + better wait logic.
import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
const prompt = 'Think carefully, answer in 3 numbered bullets: why is the sky blue? Each bullet 2 sentences.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-thoughts-probe-'));

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
    // Try clicking the model switcher
    const dropdown = page.locator('[data-testid="model-switcher-dropdown-button"]').first();
    const dropdownCount = await dropdown.count();
    log('model_dropdown_count', dropdownCount);
    if (dropdownCount === 0) {
      log('model_dropdown', 'not found, trying alternatives');
      // Maybe the dropdown has a different selector
      const altDropdown = page.locator('button:has-text("ChatGPT")').first();
      if (await altDropdown.count()) {
        await altDropdown.click({ timeout: 5000 });
        await sleep(800);
      }
    } else {
      await dropdown.click({ timeout: 5000 });
      await sleep(800);
    }
    
    // List available model options
    const options = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-testid^="model-switcher-"]');
      return Array.from(items).map(el => ({
        tid: el.getAttribute('data-testid'),
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
      }));
    });
    log('model_options', options);

    // Try selecting thinking model
    const thinkingSelectors = [
      '[data-testid="model-switcher-gpt-5-4-thinking"]',
      '[data-testid="model-switcher-o4-mini-high"]',
      '[data-testid="model-switcher-o3"]',
      '[data-testid*="thinking"]',
      '[data-testid*="o4"]',
      '[data-testid*="o3"]',
    ];
    for (const sel of thinkingSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        log('selecting_model', sel);
        await btn.click({ timeout: 5000 });
        await sleep(500);
        return true;
      }
    }
    // Dismiss dropdown
    await page.keyboard.press('Escape');
    log('model_selection', 'no thinking model found, using default');
    return false;
  } catch (e) {
    log('model_error', e.message);
    return false;
  }
}

async function injectEnhancedStreamCapture(page) {
  await page.evaluate(`
    (function() {
      if (window.__surfEnhancedFetchPatched) return;
      window.__surfEnhancedFetchPatched = true;
      window.__surfChatResponse = {
        text: '', done: false, messageId: null, model: null, parts: [],
        thoughts: [],
        isThinking: false,
        finishedText: null,
        rawEvents: [],
        interceptedUrls: [],
        allPaths: [],
      };
      var origFetch = window.fetch;
      window.fetch = function() {
        var args = arguments;
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        var opts = args[1] || {};
        var method = (opts.method || 'GET').toUpperCase();
        var result = origFetch.apply(this, args);
        var isConv = method === 'POST' && (url.indexOf('/backend-api/f/conversation') !== -1 || url.indexOf('/backend-api/conversation') !== -1);
        if (isConv) {
          window.__surfChatResponse.interceptedUrls.push(url);
          result.then(function(resp) {
            if (!resp.body || !resp.ok) {
              window.__surfChatResponse.interceptedUrls.push('not_ok:' + resp.status);
              return;
            }
            window.__surfChatResponse = {
              text: '', done: false, messageId: null, model: null, parts: [],
              thoughts: [], isThinking: false, finishedText: null,
              rawEvents: [], interceptedUrls: window.__surfChatResponse.interceptedUrls,
              allPaths: [],
            };
            var clone = resp.clone();
            var reader = clone.body.getReader();
            var decoder = new TextDecoder();
            var buf = '';
            function applyOp(op) {
              var r = window.__surfChatResponse;
              // Track ALL paths for debugging
              if (r.allPaths.length < 200) r.allPaths.push(op.p);
              
              // Thoughts content
              var thoughtContentMatch = op.p.match(/^\\/message\\/content\\/thoughts\\/(\\\\d+)\\/content$/);
              if (thoughtContentMatch) {
                var idx = parseInt(thoughtContentMatch[1], 10);
                while (r.thoughts.length <= idx) r.thoughts.push({ content: '', summary: '' });
                if (op.o === 'append' && typeof op.v === 'string') r.thoughts[idx].content += op.v;
                else if (op.o === 'replace') r.thoughts[idx].content = typeof op.v === 'string' ? op.v : JSON.stringify(op.v);
                r.isThinking = true;
                return;
              }
              // Thoughts summary
              var thoughtSummaryMatch = op.p.match(/^\\/message\\/content\\/thoughts\\/(\\\\d+)\\/summary$/);
              if (thoughtSummaryMatch) {
                var sidx = parseInt(thoughtSummaryMatch[1], 10);
                while (r.thoughts.length <= sidx) r.thoughts.push({ content: '', summary: '' });
                if (op.o === 'append' && typeof op.v === 'string') r.thoughts[sidx].summary += op.v;
                else if (op.o === 'replace') r.thoughts[sidx].summary = typeof op.v === 'string' ? op.v : JSON.stringify(op.v);
                return;
              }
              // finished_text = end of thinking
              if (op.p === '/message/metadata/finished_text') {
                r.isThinking = false;
                r.finishedText = typeof op.v === 'string' ? op.v : JSON.stringify(op.v);
                return;
              }
              // Parts
              var m = op.p.match(/^\\/message\\/content\\/parts\\/(\\\\d+)$/);
              if (m) {
                var pidx = parseInt(m[1], 10);
                while (r.parts.length <= pidx) r.parts.push('');
                if (op.o === 'append' && typeof op.v === 'string') r.parts[pidx] += op.v;
                else if (op.o === 'replace') r.parts[pidx] = typeof op.v === 'string' ? op.v : JSON.stringify(op.v);
                r.text = r.parts.join('');
                return;
              }
              if (op.p === '/message/status' && op.o === 'replace' && op.v === 'finished_successfully') { r.done = true; return; }
              if (op.p === '/message/id' && op.o === 'replace' && typeof op.v === 'string') { r.messageId = op.v; return; }
              if (op.p === '/message/metadata/model_slug' && op.o === 'replace' && typeof op.v === 'string') { r.model = op.v; return; }
            }
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
                    // Store raw thought-related events
                    if (typeof obj.p === 'string' && (obj.p.indexOf('thought') !== -1 || obj.p.indexOf('finished_text') !== -1 || obj.p.indexOf('think') !== -1)) {
                      window.__surfChatResponse.rawEvents.push({ p: obj.p, o: obj.o, vLen: typeof obj.v === 'string' ? obj.v.length : -1, vPreview: typeof obj.v === 'string' ? obj.v.slice(0, 100) : obj.v });
                    }
                    var msg = (obj.v && obj.v.message) || obj.message;
                    if (msg && msg.author && msg.author.role === 'assistant' && msg.content && msg.content.parts) {
                      var t = msg.content.parts.join('');
                      if (t) { window.__surfChatResponse.text = t; window.__surfChatResponse.parts = msg.content.parts.slice(); }
                      if (msg.id) window.__surfChatResponse.messageId = msg.id;
                      if (msg.metadata && msg.metadata.model_slug) window.__surfChatResponse.model = msg.metadata.model_slug;
                      if (msg.status === 'finished_successfully') window.__surfChatResponse.done = true;
                      if (msg.content.thoughts && Array.isArray(msg.content.thoughts)) {
                        window.__surfChatResponse.thoughts = msg.content.thoughts.map(function(t) {
                          return { content: t.content || '', summary: t.summary || '' };
                        });
                      }
                      continue;
                    }
                    if (typeof obj.o === 'string' && typeof obj.p === 'string') { applyOp(obj); continue; }
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
              }).catch(function(e) { window.__surfChatResponse.done = true; });
            }
            pump();
          }).catch(function() {});
        }
        return result;
      };
    })()
  `);
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
  
  // Monitor network
  const netLog = [];
  page.on('request', req => {
    const url = req.url();
    if (/backend-api|backend-anon/i.test(url)) {
      netLog.push({ t: Date.now(), kind: 'req', method: req.method(), url: url.slice(0, 200) });
    }
  });
  page.on('response', res => {
    const url = res.url();
    if (/backend-api|backend-anon/i.test(url)) {
      netLog.push({ t: Date.now(), kind: 'res', status: res.status(), url: url.slice(0, 200) });
    }
  });

  try {
    await loadAndInjectChatgptCookies(context, { profileEmail, log: (msg) => console.log('[auth]', msg) });
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForReady(page);
    log('ready', 'OK');

    const modelSelected = await selectThinking(page);
    log('model_selected', { success: modelSelected });

    // Inject enhanced SSE capture BEFORE sending prompt
    await injectEnhancedStreamCapture(page);
    log('sse_capture_injected', 'OK');

    const textarea = page.locator('#prompt-textarea').first();
    await textarea.click({ timeout: 10000 });
    await sleep(400);
    await textarea.type(prompt);
    await sleep(300);
    
    // Verify textarea has content
    const textareaContent = await page.evaluate(() => {
      const ta = document.querySelector('#prompt-textarea');
      return ta ? (ta.innerText || ta.textContent || ta.value || '').trim().slice(0, 200) : 'NOT_FOUND';
    });
    log('textarea_content', textareaContent);

    // Click send
    const sendBtn = page.locator('button[data-testid="send-button"]').first();
    const sendCount = await sendBtn.count();
    log('send_button_count', sendCount);
    if (sendCount > 0) {
      await sendBtn.click({ timeout: 10000 });
      log('send_clicked', 'OK');
    }

    // Poll for completion
    const deadline = Date.now() + 180000;
    let pollCount = 0;
    let lastLog = '';
    while (Date.now() < deadline) {
      await sleep(2000);
      pollCount++;
      const state = await page.evaluate('window.__surfChatResponse');
      
      const status = JSON.stringify({
        textLen: state.text.length,
        thoughtsCount: state.thoughts.length,
        totalThoughtsChars: state.thoughts.reduce((a, t) => a + t.content.length, 0),
        isThinking: state.isThinking,
        done: state.done,
        rawEventsCount: state.rawEvents.length,
        interceptedUrls: state.interceptedUrls.length,
        allPathsCount: state.allPaths.length,
      });
      if (status !== lastLog) {
        log(`poll_${pollCount}`, JSON.parse(status));
        lastLog = status;
      }
      
      if (state.done) break;

      // Also check DOM for stop button
      const stopVisible = await page.locator('button[data-testid="stop-button"], button[aria-label="Stop"]').count();
      if (pollCount === 5) {
        log('debug_poll5', {
          stopVisible,
          url: await page.url(),
          title: await page.title(),
          netLogCount: netLog.length,
        });
      }
    }

    // Final results
    const final = await page.evaluate('window.__surfChatResponse');
    log('FINAL_response', {
      textLen: final.text.length,
      textPreview: final.text.slice(0, 500),
      done: final.done,
      messageId: final.messageId,
      model: final.model,
      finishedText: final.finishedText,
      interceptedUrls: final.interceptedUrls,
    });

    log('FINAL_thoughts', {
      count: final.thoughts.length,
      thoughts: final.thoughts.map((t, i) => ({
        idx: i,
        contentLen: t.content.length,
        contentPreview: t.content.slice(0, 500),
        summaryLen: t.summary.length,
        summaryPreview: t.summary.slice(0, 200),
      })),
    });

    log('FINAL_raw_events_sample', final.rawEvents.slice(0, 30));

    // Show unique paths from SSE
    const uniquePaths = [...new Set(final.allPaths)];
    log('FINAL_unique_paths', uniquePaths);

    // Full thoughts text
    if (final.thoughts.length > 0) {
      const fullThoughts = final.thoughts.map((t, i) => {
        let s = `--- Thought ${i} ---\n`;
        if (t.summary) s += `Summary: ${t.summary}\n`;
        s += t.content;
        return s;
      }).join('\n\n');
      log('FULL_THOUGHTS_TEXT', fullThoughts);
    }

    // Network log
    const convRequests = netLog.filter(n => n.url.includes('conversation'));
    log('NETWORK_conversation_requests', convRequests);

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
