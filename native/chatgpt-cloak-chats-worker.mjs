/**
 * ChatGPT CloakBrowser Chats Worker
 *
 * Read-only / light-management access to ChatGPT conversations via backend API,
 * executed inside the authenticated browser context with page.evaluate(fetch()).
 */

import { launchPersistentContext } from 'cloakbrowser';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname, resolve as pathResolve } from 'path';
import { loadAndInjectChatgptCookies } from './chatgpt-cloak-profile-auth.mjs';
import {
  filterConversationSearchItems,
  mergeConversationSearchItems,
  normalizeConversationSearchItems,
} from './chatgpt-chats-search.mjs';

const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, t: Date.now() }) + '\n');
const log = (level, message, data) => emit({ type: 'log', level, message, data });
const progress = (step, total, message) => emit({ type: 'progress', step, total, message });
const success = (payload) => emit({ type: 'success', ...payload });
const fail = (code, message, details) => emit({ type: 'error', code, message, details });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sharedProfileDir() {
  const dir = join(homedir(), '.surf', 'cloak-profile');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function tempProfileDir() {
  return mkdtempSync(join(tmpdir(), 'surf-cloak-chats-'));
}

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

async function waitForReady(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      if (document.title.toLowerCase().includes('just a moment')) return 'cloudflare';
      if (document.querySelector('#prompt-textarea')) return 'ready';
      const btns = Array.from(document.querySelectorAll('button, a'));
      if (btns.some((b) => /^(log in|sign in|sign up)$/i.test((b.textContent || '').trim()))) return 'login';
      return 'loading';
    });

    if (state === 'ready') return { ready: true, loggedIn: true };
    if (state === 'login') return { ready: true, loggedIn: false };
    if (state === 'cloudflare') log('warn', 'Cloudflare challenge detected, waiting...');
    await sleep(1000);
  }
  return { ready: false, loggedIn: false };
}

function buildBackendError(error, fallbackCode = 'backend_error') {
  if (!error || typeof error !== 'object') {
    return { code: fallbackCode, message: String(error || 'Unknown error') };
  }

  const status = Number.isFinite(error.status) ? error.status : undefined;
  const body = error.body;
  let code = error.code || fallbackCode;
  if (status === 401 || status === 403) code = 'login_required';
  else if (status === 404) code = 'conversation_not_found';
  else if (status === 429) code = 'rate_limited';
  else if (status >= 500) code = 'backend_error';

  return {
    code,
    status,
    body,
    message: error.message || `HTTP ${status || 500}`,
  };
}

async function fetchBackendJson(page, { pathname, method = 'GET', body } = {}) {
  const result = await page.evaluate(async (request) => {
    const readCookie = (name) => {
      const prefix = `${name}=`;
      for (const part of document.cookie.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
      }
      return null;
    };

    const safeJson = async (response) => {
      const text = await response.text();
      if (!text) return { text: '', json: null };
      try {
        return { text, json: JSON.parse(text) };
      } catch {
        return { text, json: null };
      }
    };

    try {
      const sessionResp = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const sessionPayload = await safeJson(sessionResp);
      const accessToken = sessionPayload.json?.accessToken;
      if (!sessionResp.ok || !accessToken) {
        return {
          ok: false,
          error: {
            code: 'login_required',
            status: sessionResp.status || 401,
            message: 'ChatGPT session unavailable — missing access token',
            body: sessionPayload.text,
          },
        };
      }

      const response = await fetch(request.pathname, {
        credentials: 'same-origin',
        method: request.method || 'GET',
        body: request.body,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Oai-Device-Id': readCookie('oai-did') || crypto.randomUUID(),
          'Oai-Language': 'en-US',
        },
      });
      const payload = await safeJson(response);
      if (!response.ok) {
        return {
          ok: false,
          error: {
            status: response.status,
            body: payload.text,
            message:
              payload.json?.detail ||
              payload.json?.message ||
              payload.json?.error ||
              `HTTP ${response.status}`,
          },
        };
      }
      return { ok: true, data: payload.json };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code || 'backend_error',
          status: Number.isFinite(error?.status) ? error.status : undefined,
          message: error?.message || String(error),
          body: error?.body,
        },
      };
    }
  }, { pathname, method, body });

  if (!result?.ok) {
    const mapped = buildBackendError(result?.error, 'backend_error');
    throw Object.assign(new Error(mapped.message), mapped);
  }
  return result.data;
}

async function searchConversations(page, { query, limit } = {}) {
  const requestedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.trunc(Number(limit))) : 20;

  // Try backend search first; if it fails entirely, fall through to local scan
  let backendItems = [];
  let backendTotal = 0;
  let backendSearchFailed = false;
  try {
    const backendPayload = await fetchBackendJson(page, {
      pathname: `/backend-api/conversations/search?query=${encodeURIComponent(query)}`,
    });
    backendItems = normalizeConversationSearchItems(backendPayload);
    backendTotal = Number.isFinite(Number(backendPayload?.total)) ? Number(backendPayload.total) : backendItems.length;
  } catch (err) {
    log('warn', 'Backend search failed, falling back to local scan', { error: err.message, code: err.code });
    backendSearchFailed = true;
  }
  let mergedItems = mergeConversationSearchItems(backendItems);

  let fallbackScanned = 0;
  let fallbackTotal = 0;
  let partial = false;

  if (mergedItems.length < requestedLimit) {
    let offset = 0;
    let total = 0;
    let pagesFetched = 0;
    const maxLocalPages = Number.isFinite(Number(limit)) ? Math.max(3, Math.ceil(requestedLimit / 100)) : 3;

    while (pagesFetched < maxLocalPages) {
      const listPayload = await fetchBackendJson(page, {
        pathname: `/backend-api/conversations?offset=${offset}&limit=100`,
      });
      const batch = Array.isArray(listPayload?.items) ? listPayload.items : [];
      mergedItems = mergeConversationSearchItems(mergedItems, filterConversationSearchItems(batch, query));
      total = Number.isFinite(Number(listPayload?.total)) ? Number(listPayload.total) : Math.max(total, offset + batch.length);
      fallbackScanned += batch.length;
      fallbackTotal = total;
      pagesFetched += 1;
      if (mergedItems.length >= requestedLimit) break;
      if (batch.length === 0 || offset + batch.length >= total) break;
      offset += batch.length;
    }

    partial = fallbackTotal > 0 && fallbackScanned < fallbackTotal && mergedItems.length < requestedLimit;
  }

  return {
    action: 'search',
    query,
    items: mergedItems.slice(0, requestedLimit),
    total: Math.max(backendTotal, mergedItems.length),
    limit: requestedLimit,
    partial,
    backendSearchFailed,
    fallbackScanned,
    fallbackTotal,
  };
}

async function callBackend(page, request) {
  const result = await page.evaluate(async (req) => {
    const readCookie = (name) => {
      const prefix = `${name}=`;
      for (const part of document.cookie.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
      }
      return null;
    };

    const safeJson = async (response) => {
      const text = await response.text();
      if (!text) return { text: '', json: null };
      try {
        return { text, json: JSON.parse(text) };
      } catch {
        return { text, json: null };
      }
    };

    try {
      const sessionResp = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const sessionPayload = await safeJson(sessionResp);
      const accessToken = sessionPayload.json?.accessToken;
      if (!sessionResp.ok || !accessToken) {
        return {
          ok: false,
          error: {
            code: 'login_required',
            status: sessionResp.status || 401,
            message: 'ChatGPT session unavailable — missing access token',
            body: sessionPayload.text,
          },
        };
      }

      const baseHeaders = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Oai-Device-Id': readCookie('oai-did') || crypto.randomUUID(),
        'Oai-Language': 'en-US',
      };

      const api = async (pathname, init = {}) => {
        const response = await fetch(pathname, {
          credentials: 'same-origin',
          ...init,
          headers: {
            ...baseHeaders,
            ...(init.headers || {}),
          },
        });
        const payload = await safeJson(response);
        if (!response.ok) {
          return {
            ok: false,
            error: {
              status: response.status,
              body: payload.text,
              message:
                payload.json?.detail ||
                payload.json?.message ||
                payload.json?.error ||
                `HTTP ${response.status}`,
            },
          };
        }
        return { ok: true, data: payload.json };
      };

      if (req.action === 'list') {
        const requestedLimit = Number.isFinite(Number(req.limit)) ? Math.max(1, Math.trunc(Number(req.limit))) : 20;
        const items = [];
        let offset = 0;
        let total = 0;

        while (true) {
          const remaining = req.all ? 100 : Math.max(1, Math.min(100, requestedLimit - items.length));
          const response = await api(`/backend-api/conversations?offset=${offset}&limit=${remaining}`);
          if (!response.ok) return response;
          const payload = response.data || {};
          const batch = Array.isArray(payload.items) ? payload.items : [];
          items.push(...batch);
          total = Number.isFinite(Number(payload.total)) ? Number(payload.total) : Math.max(total, items.length);
          if (!req.all && items.length >= requestedLimit) break;
          if (batch.length === 0 || items.length >= total) break;
          offset += batch.length;
        }

        return {
          ok: true,
          data: {
            action: 'list',
            items,
            total,
            offset: 0,
            limit: req.all ? items.length : requestedLimit,
            all: !!req.all,
          },
        };
      }

      if (req.action === 'search') {
        const query = String(req.query || '').trim();
        if (!query) {
          return { ok: false, error: { code: 'invalid_request', message: 'Search query is required' } };
        }
        const response = await api(`/backend-api/conversations/search?query=${encodeURIComponent(query)}`);
        if (!response.ok) return response;
        const payload = response.data;
        const rawItems = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.items)
            ? payload.items
            : Array.isArray(payload?.results)
              ? payload.results
              : [];
        const items = rawItems.map((item) => ({
          id: item.id || item.conversation_id || item.conversationId || null,
          conversation_id: item.conversation_id || item.id || item.conversationId || null,
          title: item.title || '(untitled)',
          create_time: item.create_time || item.createTime || null,
          update_time: item.update_time || item.updateTime || null,
          current_node_id: item.current_node_id || item.currentNodeId || null,
          snippet: item.snippet || item.payload?.snippet || null,
          is_archived: item.is_archived ?? false,
        })).filter((item) => item.id || item.conversation_id);
        const requestedLimit = Number.isFinite(Number(req.limit)) ? Math.max(1, Math.trunc(Number(req.limit))) : items.length;
        return {
          ok: true,
          data: {
            action: 'search',
            query,
            items: items.slice(0, requestedLimit),
            total: Number.isFinite(Number(payload?.total)) ? Number(payload.total) : items.length,
            limit: requestedLimit,
          },
        };
      }

      if (req.action === 'get') {
        const conversationId = String(req.conversationId || '').trim();
        if (!conversationId) {
          return { ok: false, error: { code: 'invalid_request', message: 'Conversation ID is required' } };
        }
        const response = await api(`/backend-api/conversation/${encodeURIComponent(conversationId)}`);
        if (!response.ok) return response;
        return {
          ok: true,
          data: {
            action: 'get',
            conversationId,
            conversation: response.data,
          },
        };
      }

      if (req.action === 'rename') {
        const conversationId = String(req.conversationId || '').trim();
        const title = String(req.title || '').trim();
        if (!conversationId || !title) {
          return { ok: false, error: { code: 'invalid_request', message: 'Conversation ID and title are required' } };
        }
        const response = await api(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title }),
        });
        if (!response.ok) return response;
        return { ok: true, data: { action: 'rename', conversationId, title, result: response.data } };
      }

      if (req.action === 'delete') {
        const conversationId = String(req.conversationId || '').trim();
        if (!conversationId) {
          return { ok: false, error: { code: 'invalid_request', message: 'Conversation ID is required' } };
        }

        const hideResponse = await api(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ is_visible: false }),
        });
        if (hideResponse.ok) {
          return {
            ok: true,
            data: { action: 'delete', conversationId, deleteMethod: 'hide', result: hideResponse.data },
          };
        }
        if (![404, 405].includes(Number(hideResponse.error?.status))) {
          return hideResponse;
        }

        const bulkDeleteResponse = await api('/backend-api/conversations/delete', {
          method: 'POST',
          body: JSON.stringify({ conversation_ids: [conversationId] }),
        });
        if (!bulkDeleteResponse.ok) return bulkDeleteResponse;
        return {
          ok: true,
          data: { action: 'delete', conversationId, deleteMethod: 'bulk', result: bulkDeleteResponse.data },
        };
      }

      if (req.action === 'download') {
        const fileId = String(req.fileId || '').trim();
        if (!fileId) {
          return { ok: false, error: { code: 'invalid_request', message: 'File ID is required' } };
        }
        const response = await api(`/backend-api/files/download/${encodeURIComponent(fileId)}`);
        if (!response.ok) return response;

        // Return metadata only — actual file download is streamed Node-side
        return { ok: true, data: { action: 'download', fileId, result: response.data, file: null, outputPath: req.outputPath || null } };
      }

      return { ok: false, error: { code: 'invalid_action', message: `Unsupported action: ${req.action}` } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code || 'backend_error',
          status: Number.isFinite(error?.status) ? error.status : undefined,
          message: error?.message || String(error),
          body: error?.body,
        },
      };
    }
  }, request);

  if (!result?.ok) {
    const mapped = buildBackendError(result?.error, 'backend_error');
    throw Object.assign(new Error(mapped.message), mapped);
  }
  return result.data;
}

async function runAction({ action, conversationId, query, limit, all, profile, timeout = 120, title, fileId, outputPath }) {
  let context = null;
  let tempDir = null;
  try {
    progress(1, 4, 'Launching CloakBrowser');

    const userDataDir = profile ? (tempDir = tempProfileDir()) : sharedProfileDir();
    context = await launchPersistentContext(buildLaunchOpts(userDataDir));

    if (profile) {
      progress(2, 4, 'Loading ChatGPT cookies from Chrome profile');
      await loadAndInjectChatgptCookies(context, {
        profileEmail: profile,
        log: (message) => log('info', message),
      });
    }

    const page = context.pages()[0] || await context.newPage();
    progress(2, 4, 'Loading ChatGPT');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const ready = await waitForReady(page, 45_000);
    if (!ready.ready) {
      fail('ui_timeout', 'Timed out waiting for ChatGPT');
      return;
    }
    if (!ready.loggedIn) {
      fail('login_required', 'ChatGPT is not logged in');
      return;
    }

    progress(3, 4, 'Fetching conversations');
    const result = action === 'search'
      ? await searchConversations(page, { query, limit })
      : await callBackend(page, { action, conversationId, query, limit, all, title, fileId, includeBytes: false, outputPath });

    // Stream file download Node-side (no size cap, no base64 overhead)
    if (action === 'download' && outputPath && result.result?.download_url) {
      const resolvedPath = pathResolve(outputPath);
      const outDir = dirname(resolvedPath);
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      progress(4, 4, 'Downloading file to disk');
      const downloadResp = await page.request.fetch(result.result.download_url);
      if (!downloadResp.ok()) {
        fail('download_failed', `Download failed: HTTP ${downloadResp.status()}`);
        return;
      }
      const body = await downloadResp.body();
      writeFileSync(resolvedPath, body);

      const disposition = downloadResp.headers()['content-disposition'] || '';
      const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
      result.file = {
        savedPath: resolvedPath,
        mimeType: downloadResp.headers()['content-type'] || null,
        fileName: decodeURIComponent(match?.[1] || match?.[2] || ''),
        size: body.byteLength,
      };
    }
    success({ ...result, backend: 'cloak' });
  } catch (error) {
    log('error', 'Chats worker failed', { error: error.message, code: error.code, status: error.status });
    fail(error.code || 'query_failed', error.message, {
      status: error.status,
      body: error.body,
    });
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function main() {
  log('info', 'Cloak chats worker started');

  let buffer = '';
  let resolved = false;
  const message = await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'chats' && !resolved) {
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

  if (!message) {
    fail('no_query', 'Stdin closed without receiving a chats request');
    process.exit(0);
  }

  await runAction(message).catch((error) => fail('unhandled', error.message));
  process.exit(0);
}

main().catch((error) => {
  fail('fatal', error.message);
  process.exit(1);
});
