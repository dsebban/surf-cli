// SSE Route Probe — intercept at Playwright network level, not fetch monkey-patch.
// This bypasses any issues with in-page fetch cloning.
import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
const prompt = 'Think carefully, answer in 3 numbered bullets: why is the sky blue? Each bullet 2 sentences.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-route-probe-'));

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
  } catch (e) {
    log('model_error', e.message);
    return false;
  }
}

function parseSSEChunk(text) {
  const results = { thoughts: [], parts: [], paths: [], events: [] };
  const lines = text.split('\n');
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('event:')) continue;
    if (line.startsWith('data: ')) line = line.slice(6).trim();
    if (line === '[DONE]' || line === 'message_stream_complete') continue;
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      
      // Full message object
      const msg = (obj.v && obj.v.message) || obj.message;
      if (msg && msg.author && msg.author.role === 'assistant') {
        if (msg.content) {
          if (msg.content.parts) {
            results.parts = msg.content.parts.slice();
          }
          if (msg.content.thoughts) {
            results.thoughts = msg.content.thoughts.slice();
          }
        }
        results.events.push({ type: 'full_message', hasThoughts: !!(msg.content && msg.content.thoughts), hasParts: !!(msg.content && msg.content.parts) });
        continue;
      }
      
      // JSON-patch style
      if (typeof obj.p === 'string') {
        results.paths.push(obj.p);
        // Thought content
        const thoughtMatch = obj.p.match(/^\/message\/content\/thoughts\/(\d+)\/content$/);
        if (thoughtMatch) {
          const idx = parseInt(thoughtMatch[1], 10);
          while (results.thoughts.length <= idx) results.thoughts.push({ content: '', summary: '' });
          if (obj.o === 'append' && typeof obj.v === 'string') results.thoughts[idx].content += obj.v;
          else if (obj.o === 'replace') results.thoughts[idx].content = typeof obj.v === 'string' ? obj.v : '';
        }
        // Thought summary
        const summaryMatch = obj.p.match(/^\/message\/content\/thoughts\/(\d+)\/summary$/);
        if (summaryMatch) {
          const idx = parseInt(summaryMatch[1], 10);
          while (results.thoughts.length <= idx) results.thoughts.push({ content: '', summary: '' });
          if (obj.o === 'append' && typeof obj.v === 'string') results.thoughts[idx].summary += obj.v;
          else if (obj.o === 'replace') results.thoughts[idx].summary = typeof obj.v === 'string' ? obj.v : '';
        }
        // Parts
        const partsMatch = obj.p.match(/^\/message\/content\/parts\/(\d+)$/);
        if (partsMatch) {
          const idx = parseInt(partsMatch[1], 10);
          while (results.parts.length <= idx) results.parts.push('');
          if (typeof results.parts[idx] !== 'string') results.parts[idx] = '';
          if (obj.o === 'append' && typeof obj.v === 'string') results.parts[idx] += obj.v;
          else if (obj.o === 'replace') results.parts[idx] = typeof obj.v === 'string' ? obj.v : '';
        }
        continue;
      }
      
      // Array of ops
      if (Array.isArray(obj.v)) {
        for (const op of obj.v) {
          if (typeof op.p === 'string') {
            results.paths.push(op.p);
            const tm = op.p.match(/^\/message\/content\/thoughts\/(\d+)\/content$/);
            if (tm) {
              const idx = parseInt(tm[1], 10);
              while (results.thoughts.length <= idx) results.thoughts.push({ content: '', summary: '' });
              if (op.o === 'append' && typeof op.v === 'string') results.thoughts[idx].content += op.v;
            }
            const sm = op.p.match(/^\/message\/content\/thoughts\/(\d+)\/summary$/);
            if (sm) {
              const idx = parseInt(sm[1], 10);
              while (results.thoughts.length <= idx) results.thoughts.push({ content: '', summary: '' });
              if (op.o === 'append' && typeof op.v === 'string') results.thoughts[idx].summary += op.v;
            }
            const pm = op.p.match(/^\/message\/content\/parts\/(\d+)$/);
            if (pm) {
              const idx = parseInt(pm[1], 10);
              while (results.parts.length <= idx) results.parts.push('');
              if (typeof results.parts[idx] !== 'string') results.parts[idx] = '';
              if (op.o === 'append' && typeof op.v === 'string') results.parts[idx] += op.v;
            }
          }
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
  
  // Collect raw SSE data at Playwright route level
  let sseChunks = [];
  let sseComplete = false;
  
  // Use Playwright route to intercept the conversation response
  await page.route('**/backend-api/f/conversation', async (route) => {
    log('route_intercepted', { method: route.request().method(), url: route.request().url().slice(0, 200) });
    
    // Only intercept POST (the actual conversation request)
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    
    // Fetch the actual response
    const response = await route.fetch();
    const status = response.status();
    const headers = response.headers();
    log('route_response', { status, contentType: headers['content-type'] });
    
    // Read the full body
    const body = await response.body();
    const bodyText = body.toString('utf-8');
    sseChunks.push(bodyText);
    sseComplete = true;
    log('route_body_size', { bytes: body.length, chars: bodyText.length, preview: bodyText.slice(0, 500) });
    
    // Fulfill the route with the original response
    await route.fulfill({
      status,
      headers,
      body,
    });
  });
  
  // Also intercept non-/f/ variant
  await page.route('**/backend-api/conversation', async (route) => {
    const url = route.request().url();
    // Skip /f/ variant (already handled), prepare, init, etc
    if (url.includes('/f/conversation') || url.includes('/prepare') || url.includes('/init') || url.includes('/autocompletions')) {
      await route.continue();
      return;
    }
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    log('route_intercepted_alt', { url: url.slice(0, 200) });
    const response = await route.fetch();
    const body = await response.body();
    sseChunks.push(body.toString('utf-8'));
    sseComplete = true;
    log('route_alt_body_size', { bytes: body.length });
    await route.fulfill({ status: response.status(), headers: response.headers(), body });
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

    // Wait for SSE to complete or timeout
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !sseComplete) {
      await sleep(2000);
      log('waiting', { sseChunksCount: sseChunks.length, sseComplete });
    }
    
    // Give extra time for stream to finish
    if (sseComplete) {
      await sleep(5000);
    }

    // Parse collected SSE data
    const allText = sseChunks.join('\n');
    log('total_sse_data', { totalBytes: allText.length, chunksCount: sseChunks.length });
    
    // Save raw SSE for inspection
    writeFileSync('/tmp/sse-raw-dump.txt', allText);
    log('raw_dump_saved', '/tmp/sse-raw-dump.txt');

    // Parse
    const parsed = parseSSEChunk(allText);
    
    // Unique paths
    const uniquePaths = [...new Set(parsed.paths)];
    log('UNIQUE_PATHS', uniquePaths);

    // Response text
    const responseText = parsed.parts.join('');
    log('RESPONSE_TEXT', {
      length: responseText.length,
      preview: responseText.slice(0, 500),
    });

    // Thoughts
    log('THOUGHTS', {
      count: parsed.thoughts.length,
      thoughts: parsed.thoughts.map((t, i) => ({
        idx: i,
        contentLen: (t.content || '').length,
        contentPreview: (t.content || '').slice(0, 500),
        summaryLen: (t.summary || '').length,
        summaryPreview: (t.summary || '').slice(0, 200),
      })),
    });

    // Full thoughts text
    if (parsed.thoughts.length > 0) {
      const fullThoughts = parsed.thoughts.map((t, i) => {
        let s = `--- Thought ${i} ---\n`;
        if (t.summary) s += `Summary: ${t.summary}\n`;
        s += (t.content || '');
        return s;
      }).join('\n\n');
      log('FULL_THOUGHTS_TEXT', fullThoughts);
    }

    log('EVENTS_SAMPLE', parsed.events.slice(0, 10));

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
