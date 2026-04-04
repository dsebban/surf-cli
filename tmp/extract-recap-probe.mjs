// Extract reasoning_recap from React fiber — this is the detailed thinking trace!
import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
const prompt = 'Think carefully, answer in 3 numbered bullets: why is the sky blue? Each bullet 2 sentences.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-recap-probe-'));

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

// Extract all message content from React fiber via the "Thought for" button
const EXTRACT_ALL_MESSAGES_JS = `(() => {
  // Find "Thought for" button
  var buttons = Array.from(document.querySelectorAll('button'));
  var thoughtBtn = buttons.find(function(b) { return /Thought for|Thinking for/i.test(b.innerText || b.textContent); });
  if (!thoughtBtn) return { error: 'no_thought_button' };
  
  var fiberKey = Object.keys(thoughtBtn).find(function(k) { return k.startsWith('__reactFiber$'); });
  if (!fiberKey) return { error: 'no_fiber' };
  
  var fiber = thoughtBtn[fiberKey];
  var depth = 0;
  while (fiber && depth < 50) {
    if (fiber.memoizedProps && fiber.memoizedProps.allMessages) {
      var allMessages = fiber.memoizedProps.allMessages;
      var result = [];
      for (var i = 0; i < allMessages.length; i++) {
        var msg = allMessages[i];
        if (!msg || !msg.content) continue;
        
        // Serialize content safely (avoid circular refs)
        var safe = {
          id: msg.id,
          contentType: msg.content.content_type,
          contentKeys: Object.keys(msg.content),
        };
        
        // For thoughts: extract thoughts array
        if (msg.content.content_type === 'thoughts') {
          safe.thoughts = Array.isArray(msg.content.thoughts) ? msg.content.thoughts : [];
          safe.source_analysis_msg_id = msg.content.source_analysis_msg_id || null;
        }
        
        // For reasoning_recap: extract ALL keys  
        if (msg.content.content_type === 'reasoning_recap') {
          // Get all content fields
          var recapContent = {};
          var ckeys = Object.keys(msg.content);
          for (var k = 0; k < ckeys.length; k++) {
            var key = ckeys[k];
            var val = msg.content[key];
            if (typeof val === 'string') recapContent[key] = val;
            else if (Array.isArray(val)) {
              recapContent[key] = val.map(function(item) {
                if (typeof item === 'string') return item;
                if (typeof item === 'object' && item !== null) {
                  // Safely stringify nested objects
                  try { return JSON.parse(JSON.stringify(item)); } catch(e) { return String(item); }
                }
                return item;
              });
            }
            else if (typeof val === 'object' && val !== null) {
              try { recapContent[key] = JSON.parse(JSON.stringify(val)); } catch(e) { recapContent[key] = String(val); }
            }
            else recapContent[key] = val;
          }
          safe.recapContent = recapContent;
        }
        
        // For text: extract parts
        if (msg.content.content_type === 'text') {
          safe.parts = Array.isArray(msg.content.parts) ? msg.content.parts : [];
        }
        
        // Also include metadata if present
        if (msg.metadata) {
          var metaKeys = Object.keys(msg.metadata);
          safe.metadataKeys = metaKeys;
          // Extract relevant metadata fields
          var relevantMeta = {};
          for (var m = 0; m < metaKeys.length; m++) {
            var mk = metaKeys[m];
            if (/thought|think|reason|stage|model|finish|duration/i.test(mk)) {
              try { relevantMeta[mk] = JSON.parse(JSON.stringify(msg.metadata[mk])); } catch(e) { relevantMeta[mk] = String(msg.metadata[mk]); }
            }
          }
          if (Object.keys(relevantMeta).length > 0) safe.relevantMetadata = relevantMeta;
        }
        
        result.push(safe);
      }
      return { found: true, depth: depth, messages: result };
    }
    fiber = fiber.return;
    depth++;
  }
  return { error: 'no_allMessages' };
})()`;

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

    // Extract ALL messages including reasoning_recap
    const extraction = await page.evaluate(EXTRACT_ALL_MESSAGES_JS);
    log('ALL_MESSAGES', extraction);

    // If reasoning_recap found, show it prominently
    if (extraction.found) {
      for (const msg of extraction.messages) {
        if (msg.contentType === 'reasoning_recap') {
          log('REASONING_RECAP_FULL', msg.recapContent);
        }
      }
    }

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
