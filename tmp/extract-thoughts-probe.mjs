// Extract thinking trace from React fiber state — focused probe.
// We know: "Thought for" button → depth 8 React fiber → allMessages → content_type:"thoughts"
import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
const prompt = 'Think carefully, answer in 3 numbered bullets: why is the sky blue? Each bullet 2 sentences.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-extract-probe-'));

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

    // ─── Extract thoughts from React fiber ───
    const extraction = await page.evaluate(() => {
      // Find "Thought for" button
      const buttons = Array.from(document.querySelectorAll('button'));
      const thoughtBtn = buttons.find(b => /Thought for|Thinking for/i.test(b.innerText || b.textContent));
      if (!thoughtBtn) return { error: 'no_thought_button' };

      const fiberKey = Object.keys(thoughtBtn).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return { error: 'no_fiber' };

      let fiber = thoughtBtn[fiberKey];
      let depth = 0;
      
      // Walk up to find the component with allMessages
      while (fiber && depth < 50) {
        if (fiber.memoizedProps && fiber.memoizedProps.allMessages) {
          const allMessages = fiber.memoizedProps.allMessages;
          
          // Extract thoughts messages
          const thoughtsMessages = [];
          const textMessages = [];
          
          for (const msg of allMessages) {
            if (!msg || !msg.content) continue;
            
            if (msg.content.content_type === 'thoughts') {
              thoughtsMessages.push({
                id: msg.id,
                content_type: msg.content.content_type,
                thoughtsCount: Array.isArray(msg.content.thoughts) ? msg.content.thoughts.length : 0,
                thoughts: Array.isArray(msg.content.thoughts) ? msg.content.thoughts.map(t => ({
                  content: typeof t === 'string' ? t : (t?.content || ''),
                  summary: typeof t === 'object' ? (t?.summary || '') : '',
                  contentLen: typeof t === 'string' ? t.length : (t?.content?.length || 0),
                })) : [],
                // Also check for source_annotation
                source_annotation: msg.content.source_annotation || null,
                // Raw keys
                contentKeys: Object.keys(msg.content),
              });
            }
            
            if (msg.content.content_type === 'text') {
              textMessages.push({
                id: msg.id,
                content_type: msg.content.content_type,
                partsCount: Array.isArray(msg.content.parts) ? msg.content.parts.length : 0,
                textPreview: Array.isArray(msg.content.parts) ? msg.content.parts.join('').slice(0, 300) : '',
              });
            }
          }
          
          return {
            found: true,
            depth,
            totalMessages: allMessages.length,
            thoughtsMessages,
            textMessages,
            allContentTypes: allMessages.map(m => m?.content?.content_type).filter(Boolean),
          };
        }
        fiber = fiber.return;
        depth++;
      }
      return { error: 'no_allMessages_found' };
    });
    log('EXTRACTION', extraction);

    // If thoughts found, get full text
    if (extraction.found && extraction.thoughtsMessages?.length > 0) {
      const fullThoughts = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const thoughtBtn = buttons.find(b => /Thought for|Thinking for/i.test(b.innerText || b.textContent));
        const fiberKey = Object.keys(thoughtBtn).find(k => k.startsWith('__reactFiber$'));
        let fiber = thoughtBtn[fiberKey];
        let depth = 0;
        while (fiber && depth < 50) {
          if (fiber.memoizedProps && fiber.memoizedProps.allMessages) {
            const allMessages = fiber.memoizedProps.allMessages;
            for (const msg of allMessages) {
              if (msg?.content?.content_type === 'thoughts' && Array.isArray(msg.content.thoughts)) {
                // Return full thoughts array with complete content
                return msg.content.thoughts.map((t, i) => {
                  if (typeof t === 'string') return { idx: i, type: 'string', content: t };
                  return {
                    idx: i,
                    type: 'object',
                    content: t?.content || '',
                    summary: t?.summary || '',
                    keys: typeof t === 'object' ? Object.keys(t) : [],
                  };
                });
              }
            }
            return [];
          }
          fiber = fiber.return;
          depth++;
        }
        return [];
      });
      log('FULL_THOUGHTS', fullThoughts);

      // Get the concatenated thinking text
      if (fullThoughts.length > 0) {
        const thinkingText = fullThoughts.map(t => {
          let s = '';
          if (t.summary) s += `[${t.summary}] `;
          s += t.content || '';
          return s;
        }).join('\n');
        log('THINKING_TEXT', thinkingText);
        log('THINKING_TEXT_LENGTH', thinkingText.length);
      }
    }

    // Also try extracting grouped messages for completeness
    const grouped = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const thoughtBtn = buttons.find(b => /Thought for|Thinking for/i.test(b.innerText || b.textContent));
      const fiberKey = Object.keys(thoughtBtn).find(k => k.startsWith('__reactFiber$'));
      let fiber = thoughtBtn[fiberKey];
      let depth = 0;
      while (fiber && depth < 50) {
        if (fiber.memoizedProps && fiber.memoizedProps.groupedMessagesToRender) {
          const groups = fiber.memoizedProps.groupedMessagesToRender;
          return groups.map(g => ({
            type: g.type,
            groupCount: g.groups?.length || 0,
            groups: (g.groups || []).map(gg => ({
              type: gg.type,
              messageCount: gg.messages?.length || 0,
              contentTypes: (gg.messages || []).map(m => m?.content?.content_type).filter(Boolean),
            })),
          }));
        }
        fiber = fiber.return;
        depth++;
      }
      return null;
    });
    log('GROUPED_MESSAGES', grouped);

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
