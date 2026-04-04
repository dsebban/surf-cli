import { launchPersistentContext } from 'cloakbrowser';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadAndInjectChatgptCookies } from '../native/chatgpt-cloak-profile-auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileEmail = process.env.PROFILE_EMAIL || 'dsebban883@gmail.com';
const prompt = process.env.PROBE_PROMPT || 'Think carefully, then answer in 6 numbered bullets: why preserving transport-level event streams is more reliable than scraping rendered DOM for long reasoning-model outputs. Each bullet 2 sentences.';
const tempDir = mkdtempSync(join(tmpdir(), 'surf-reasoning-probe-'));
const beforeShot = '/tmp/reasoning-sidebar-before.png';
const afterShot = '/tmp/reasoning-sidebar-after.png';

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

async function waitForResponse(page, timeoutMs = 240000) {
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
        if (s.includes('you said') || s.includes('user said')) return false;
        const role = (node.getAttribute('data-message-author-role') || '').toLowerCase();
        if (role === 'assistant') return true;
        if (role === 'user') return false;
        return !!node.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]');
      };
      let last = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isAssistant(turns[i])) { last = turns[i]; break; }
      }
      const stop = !!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop"]');
      const text = ((last?.querySelector('.markdown')?.innerText) || (last?.innerText) || '').trim();
      return {
        stop,
        text,
        turnId: last?.getAttribute('data-testid') || null,
        hasCopy: !!last?.querySelector('button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"]'),
      };
    });
    if (state.text === lastText && state.text) stable += 1;
    else { lastText = state.text; stable = 0; }
    if (!state.stop && state.text && (state.hasCopy || stable >= 4)) return state;
  }
  throw new Error('response_timeout');
}

async function findTraceCandidates(page) {
  return await page.evaluate(() => {
    const turnSel = 'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]';
    const turns = Array.from(document.querySelectorAll(turnSel));
    const isAssistant = (node) => {
      const sr = node.querySelector('.sr-only');
      const s = (sr?.textContent || '').toLowerCase();
      if (s.includes('chatgpt said') || s.includes('assistant said')) return true;
      if (s.includes('you said') || s.includes('user said')) return false;
      const role = (node.getAttribute('data-message-author-role') || '').toLowerCase();
      if (role === 'assistant') return true;
      if (role === 'user') return false;
      return !!node.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]');
    };
    let last = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (isAssistant(turns[i])) { last = turns[i]; break; }
    }
    const toEntry = (el) => ({
      tag: el.tagName,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      tid: el.getAttribute('data-testid'),
      role: el.getAttribute('role'),
      cls: (el.getAttribute('class') || '').slice(0, 160),
      rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    });
    const score = (el) => {
      const hay = [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.getAttribute('class')].filter(Boolean).join(' ').toLowerCase();
      let s = 0;
      for (const kw of ['thought', 'reason', 'trace', 'thinking', 'steps']) if (hay.includes(kw)) s += 3;
      if (hay.includes('seconds') || hay.includes('minute')) s += 2;
      return s;
    };

    const turnButtons = last ? Array.from(last.querySelectorAll('button,[role="button"],a')).map(el => ({...toEntry(el), score: score(el)})).sort((a,b) => b.score - a.score) : [];
    const globalButtons = Array.from(document.querySelectorAll('button,[role="button"],a')).map(el => ({...toEntry(el), score: score(el)})).filter(x => x.score > 0).sort((a,b) => b.score - a.score).slice(0, 20);

    return {
      turnButtons: turnButtons.slice(0, 20),
      globalButtons,
      turnId: last?.getAttribute('data-testid') || null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
}

async function armMutationProbe(page) {
  return await page.evaluate(() => {
    window.__surfMutations = [];
    const sample = (n) => {
      if (!(n instanceof Element)) return null;
      const r = n.getBoundingClientRect();
      return {
        tag: n.tagName,
        tid: n.getAttribute('data-testid'),
        role: n.getAttribute('role'),
        aria: n.getAttribute('aria-label'),
        cls: (n.getAttribute('class') || '').slice(0, 120),
        text: (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      };
    };
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (window.__surfMutations.length >= 120) break;
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => {
            const s = sample(n);
            if (s) window.__surfMutations.push({ type: 'added', node: s });
          });
        } else if (m.type === 'attributes') {
          const s = sample(m.target);
          if (s) window.__surfMutations.push({ type: 'attr', attr: m.attributeName, node: s });
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state', 'open'] });
    window.__surfMutationObserver = observer;
    return true;
  });
}

async function readMutations(page) {
  return await page.evaluate(() => {
    try { window.__surfMutationObserver?.disconnect(); } catch {}
    return window.__surfMutations || [];
  });
}

async function clickBestCandidate(page) {
  const meta = await page.evaluate(() => {
    const turnSel = 'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]';
    const turns = Array.from(document.querySelectorAll(turnSel));
    const isAssistant = (node) => {
      const sr = node.querySelector('.sr-only');
      const s = (sr?.textContent || '').toLowerCase();
      if (s.includes('chatgpt said') || s.includes('assistant said')) return true;
      if (s.includes('you said') || s.includes('user said')) return false;
      const role = (node.getAttribute('data-message-author-role') || '').toLowerCase();
      if (role === 'assistant') return true;
      if (role === 'user') return false;
      return !!node.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]');
    };
    let last = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (isAssistant(turns[i])) { last = turns[i]; break; }
    }
    const candidates = Array.from((last || document).querySelectorAll('button,[role="button"],a'));
    const score = (el) => {
      const hay = [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.getAttribute('class')].filter(Boolean).join(' ').toLowerCase();
      let s = 0;
      for (const kw of ['thought', 'reason', 'trace', 'thinking', 'steps']) if (hay.includes(kw)) s += 3;
      if (hay.includes('seconds') || hay.includes('minute')) s += 2;
      return s;
    };
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const s = score(el);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    if (!best || bestScore <= 0) return null;
    const r = best.getBoundingClientRect();
    return {
      text: (best.innerText || best.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      aria: best.getAttribute('aria-label'),
      title: best.getAttribute('title'),
      tid: best.getAttribute('data-testid'),
      score: bestScore,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  });
  if (!meta) return null;
  const candidates = [
    'button:has-text("Thought for")',
    'button:has-text("Thinking for")',
    'button:has-text("Thought")',
    'button:has-text("Thinking")'
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      await loc.hover({ timeout: 3000 }).catch(() => {});
      await loc.click({ timeout: 5000 }).catch(() => {});
      await sleep(300);
      return meta;
    }
  }
  return meta;
}

async function readRightSide(page) {
  return await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nodes = Array.from(document.querySelectorAll('aside,[role="dialog"],[role="complementary"],div,section,article'));
    const items = [];
    for (const el of nodes) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 160 || r.height < 80) continue;
      if (r.left < vw * 0.58) continue;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 20) continue;
      items.push({
        tag: el.tagName,
        role: el.getAttribute('role'),
        tid: el.getAttribute('data-testid'),
        aria: el.getAttribute('aria-label'),
        cls: (el.getAttribute('class') || '').slice(0, 140),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        text: text.slice(0, 1800),
        score: (text.match(/\b(Thought|Thinking|seconds|minute|Step|Research|Analyzing|Reasoning)\b/gi) || []).length,
      });
    }
    items.sort((a,b) => (b.score - a.score) || ((b.rect.w * b.rect.h) - (a.rect.w * a.rect.h)) || (b.text.length - a.text.length));
    return { viewport: { w: vw, h: vh }, items: items.slice(0, 20) };
  });
}

async function main() {
  const context = await launchPersistentContext({
    userDataDir: tempDir,
    headless: process.env.CLOAK_HEADLESS !== '0',
    humanize: process.env.CLOAK_HUMANIZE !== '0',
    humanPreset: 'careful',
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: ['--fingerprint-storage-quota=5000'],
  });

  const page = context.pages()[0] || await context.newPage();
  const net = [];
  page.on('request', req => {
    const url = req.url();
    if (/chatgpt\.com\/backend-api|chatgpt\.com\/backend-anon|openai/i.test(url)) net.push({ t: Date.now(), kind: 'req', method: req.method(), url });
  });
  page.on('response', res => {
    const url = res.url();
    if (/chatgpt\.com\/backend-api|chatgpt\.com\/backend-anon|openai/i.test(url)) net.push({ t: Date.now(), kind: 'res', status: res.status(), url });
  });

  try {
    await loadAndInjectChatgptCookies(context, { profileEmail, log: (msg) => console.log('[auth]', msg) });
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForReady(page);
    log('ready', { ok: true });

    const selected = await selectThinking(page);
    log('model_selected', { thinking: selected });

    const textarea = page.locator('#prompt-textarea').first();
    await textarea.click({ timeout: 10000 });
    await sleep(400);
    await textarea.type(prompt);
    await sleep(300);
    await page.locator('button[data-testid="send-button"]').first().click({ timeout: 10000 });

    const settled = await waitForResponse(page);
    log('response_settled', settled);

    const before = await findTraceCandidates(page);
    log('trace_candidates_before_click', before);
    await page.screenshot({ path: beforeShot, fullPage: false });
    await armMutationProbe(page);

    const netBefore = net.length;
    const clicked = await clickBestCandidate(page);
    log('clicked', clicked || { clicked: false });
    await sleep(4500);
    await page.screenshot({ path: afterShot, fullPage: false });

    const right = await readRightSide(page);
    const mutations = await readMutations(page);
    log('right_side_after_click', right);
    log('mutations_after_click', mutations.slice(0, 80));
    log('network_after_click', net.slice(netBefore).slice(0, 120));
    log('screenshots', { beforeShot, afterShot });
  } finally {
    try { await context.close(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
