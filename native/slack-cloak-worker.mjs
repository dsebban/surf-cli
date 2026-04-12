/**
 * Slack CloakBrowser Worker
 *
 * Stealth Chromium automation using CloakBrowser (Playwright-based).
 * Reads Slack conversations via internal APIs from an authenticated browser context.
 *
 * Protocol: stdin JSON lines → stdout JSON lines
 *   Input:  { type:"slack", action:"history"|"replies"|"channels", channel?, threadTs?, limit?, days?, profile?, timeout? }
 *   Output: { type:"progress"|"success"|"error"|"keepalive"|"log", … }
 */

import { launchPersistentContext } from 'cloakbrowser'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { loadAndInjectSlackCookies } from './slack-cloak-profile-auth.mjs'

// ============================================================================
// Logging — everything goes to stdout as JSON lines

const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, t: Date.now() }) + '\n')
const log = (level, message, data) => emit({ type: 'log', level, message, data })
const progress = (step, total, msg) => emit({ type: 'progress', step, total, message: msg })
const success = (payload) => emit({ type: 'success', ...payload })
const fail = (code, message, details) => emit({ type: 'error', code, message, details })
const keepalive = () => emit({ type: 'keepalive' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ============================================================================
// Profile directory management

function tempProfileDir() {
  return mkdtempSync(join(tmpdir(), 'surf-slack-session-'))
}

// ============================================================================
// Launch options

function buildLaunchOpts(userDataDir) {
  return {
    userDataDir,
    headless: true,
    humanize: true,
    humanPreset: 'careful',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: ['--fingerprint-storage-quota=5000'],
  }
}

// ============================================================================
// Page readiness detection

async function waitForSlackReady(page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      if (document.title.toLowerCase().includes('just a moment')) return 'cloudflare'
      // Slack loaded — check for workspace selector or channel view
      if (document.querySelector('[data-qa="channel_sidebar"]')) return 'ready'
      if (document.querySelector('.p-workspace__primary_view')) return 'ready'
      if (document.querySelector('[data-qa="virtual-list-item"]')) return 'ready'
      // Slack login page
      const btns = Array.from(document.querySelectorAll('button, a'))
      if (btns.some(b => /sign.?in/i.test(b.textContent || ''))) return 'login'
      return 'loading'
    })
    if (state === 'ready') return { ready: true, loggedIn: true }
    if (state === 'login') return { ready: true, loggedIn: false }
    if (state === 'cloudflare') log('warn', 'Cloudflare challenge detected, waiting...')
    await sleep(1500)
  }
  return { ready: false, loggedIn: false }
}

// ============================================================================
// Slack token extraction

async function extractSlackToken(page) {
  return await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('localConfig_v2')
      if (!raw) return null
      const config = JSON.parse(raw)
      if (!config.teams) return null
      const teamIds = Object.keys(config.teams)
      if (teamIds.length === 0) return null
      // Return first team's token — for enterprise, the first team is usually correct
      const teamId = teamIds[0]
      const team = config.teams[teamId]
      return { token: team?.token || null, teamId, teamName: team?.name || null }
    } catch {
      return null
    }
  })
}

// ============================================================================
// Slack API helpers — run inside page context for cookie jar access

async function callSlackApi(page, method, params, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const result = await page.evaluate(async ({ method, params }) => {
      try {
        const body = new URLSearchParams()
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== null) body.append(k, String(v))
        }
        const resp = await fetch(`/api/${method}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        })
        const data = await resp.json()
        return { ok: data.ok, data, status: resp.status, error: data.error || null }
      } catch (err) {
        return { ok: false, data: null, status: 0, error: err.message }
      }
    }, { method, params })

    if (result.ok) return result.data

    // Rate limited — back off
    if (result.error === 'ratelimited' && attempt < retries - 1) {
      const wait = Math.pow(2, attempt + 1) * 1000
      log('warn', `Rate limited on ${method}, waiting ${wait}ms...`)
      await sleep(wait)
      continue
    }

    throw Object.assign(
      new Error(`Slack API ${method} failed: ${result.error || `HTTP ${result.status}`}`),
      { code: result.error || 'api_error', status: result.status }
    )
  }
}

// ============================================================================
// Action handlers

async function handleHistory(page, request, token) {
  const { channel, limit = 50, days = 7 } = request
  if (!channel) throw Object.assign(new Error('channel is required'), { code: 'missing_channel' })

  const oldest = Math.floor((Date.now() - days * 86400 * 1000) / 1000)
  progress(1, 4, `Fetching messages from channel ${channel}...`)

  let allMessages = []
  let cursor = ''
  let hasMore = true
  let pageNum = 0
  const maxMessages = limit || 200

  while (hasMore && allMessages.length < maxMessages) {
    pageNum++
    const params = {
      token,
      channel,
      limit: String(Math.min(100, maxMessages - allMessages.length)),
      oldest: String(oldest),
      inclusive: 'true',
    }
    if (cursor) params.cursor = cursor

    const data = await callSlackApi(page, 'conversations.history', params)
    const msgs = data.messages || []
    allMessages = allMessages.concat(msgs)
    hasMore = data.has_more || false
    cursor = data.response_metadata?.next_cursor || ''

    progress(2, 4, `Fetched ${allMessages.length} messages (page ${pageNum})...`)
    keepalive()

    if (hasMore && allMessages.length < maxMessages) await sleep(500)
  }

  // Sort oldest→newest
  allMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))

  // Collect user IDs for resolution
  const userIds = new Set()
  for (const msg of allMessages) {
    if (msg.user) userIds.add(msg.user)
    const mentions = (msg.text || '').match(/<@([A-Z0-9]+)>/g)
    if (mentions) mentions.forEach(m => { const id = m.match(/<@([A-Z0-9]+)>/)?.[1]; if (id) userIds.add(id) })
  }

  // Fetch thread replies for messages that have them
  progress(3, 4, 'Fetching thread replies...')
  const threads = new Map()
  let threadCount = 0
  for (const msg of allMessages) {
    if (msg.thread_ts && msg.reply_count > 0 && msg.thread_ts === msg.ts) {
      if (threadCount > 0) await sleep(800)
      threadCount++
      try {
        const repliesData = await callSlackApi(page, 'conversations.replies', {
          token,
          channel,
          ts: msg.thread_ts,
          limit: '200',
          oldest: String(oldest),
        })
        const replies = (repliesData.messages || []).filter(r => r.ts !== msg.ts)
        threads.set(msg.ts, replies)
        for (const r of replies) {
          if (r.user) userIds.add(r.user)
        }
        keepalive()
      } catch (err) {
        log('warn', `Failed to fetch thread ${msg.thread_ts}: ${err.message}`)
      }
    }
  }

  // Resolve user names
  progress(4, 4, `Resolving ${userIds.size} user names...`)
  const userMap = await resolveUsers(page, token, Array.from(userIds))

  return {
    messages: allMessages,
    threads: Object.fromEntries(threads),
    users: userMap,
    channel,
    messageCount: allMessages.length,
    threadCount: threads.size,
  }
}

async function handleReplies(page, request, token) {
  const { channel, threadTs } = request
  if (!channel) throw Object.assign(new Error('channel is required'), { code: 'missing_channel' })
  if (!threadTs) throw Object.assign(new Error('threadTs is required'), { code: 'missing_thread_ts' })

  progress(1, 3, `Fetching thread ${threadTs}...`)

  const data = await callSlackApi(page, 'conversations.replies', {
    token,
    channel,
    ts: threadTs,
    limit: '200',
  })

  const messages = data.messages || []
  const userIds = new Set()
  for (const msg of messages) {
    if (msg.user) userIds.add(msg.user)
  }

  progress(2, 3, `Resolving ${userIds.size} users...`)
  const userMap = await resolveUsers(page, token, Array.from(userIds))

  return {
    messages,
    users: userMap,
    channel,
    threadTs,
    messageCount: messages.length,
  }
}

async function handleChannels(page, request, token) {
  const { limit = 100 } = request

  progress(1, 2, 'Fetching channel list...')

  let allChannels = []
  let cursor = ''
  let hasMore = true

  while (hasMore && allChannels.length < limit) {
    const params = {
      token,
      types: 'public_channel,private_channel,mpim,im',
      limit: String(Math.min(200, limit - allChannels.length)),
      exclude_archived: 'true',
    }
    if (cursor) params.cursor = cursor

    const data = await callSlackApi(page, 'conversations.list', params)
    const channels = data.channels || []
    allChannels = allChannels.concat(channels)
    hasMore = data.response_metadata?.next_cursor ? true : false
    cursor = data.response_metadata?.next_cursor || ''
    keepalive()

    if (hasMore) await sleep(500)
  }

  progress(2, 2, `Found ${allChannels.length} channels`)

  return {
    channels: allChannels.map(ch => ({
      id: ch.id,
      name: ch.name || ch.user || ch.id,
      topic: ch.topic?.value || '',
      purpose: ch.purpose?.value || '',
      memberCount: ch.num_members || 0,
      isPrivate: ch.is_private || false,
      isIm: ch.is_im || false,
      isMpim: ch.is_mpim || false,
    })),
    channelCount: allChannels.length,
  }
}

// ============================================================================
// User resolution

async function resolveUsers(page, token, userIds) {
  const userMap = {}
  const batchSize = 10

  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize)
    for (const userId of batch) {
      try {
        const data = await callSlackApi(page, 'users.info', { token, user: userId })
        const u = data.user
        userMap[userId] = {
          id: userId,
          name: u?.real_name || u?.profile?.display_name || u?.profile?.real_name || u?.name || 'Unknown',
          displayName: u?.profile?.display_name || u?.real_name || u?.name || 'Unknown',
          avatar: u?.profile?.image_48 || null,
        }
      } catch {
        userMap[userId] = { id: userId, name: 'Unknown User', displayName: 'Unknown User', avatar: null }
      }
      await sleep(100)
    }
    if (i + batchSize < userIds.length) await sleep(500)
  }
  return userMap
}

// ============================================================================
// Main

async function main() {
  let request
  try {
    const input = await new Promise((resolve) => {
      let buf = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        buf += chunk
        const idx = buf.indexOf('\n')
        if (idx !== -1) {
          resolve(buf.slice(0, idx))
        }
      })
      process.stdin.on('end', () => resolve(buf))
    })
    request = JSON.parse(input.trim())
  } catch (err) {
    fail('invalid_input', `Failed to parse stdin: ${err.message}`)
    process.exit(1)
  }

  if (request.type !== 'slack') {
    fail('invalid_type', `Expected type "slack", got "${request.type}"`)
    process.exit(1)
  }

  const { action, profile, timeout = 120 } = request
  let context = null
  let profileDir = null
  let cleanupProfile = false

  try {
    // Launch CloakBrowser
    progress(0, 5, 'Launching browser...')

    if (profile) {
      profileDir = tempProfileDir()
      cleanupProfile = true
    } else {
      profileDir = join(homedir(), '.surf', 'slack-cloak-profile')
      if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true })
    }

    context = await launchPersistentContext(buildLaunchOpts(profileDir))
    log('info', 'Browser launched')

    // Inject cookies from Chrome profile
    if (profile) {
      progress(1, 5, 'Injecting Slack cookies...')
      await loadAndInjectSlackCookies(context, {
        profileEmail: profile,
        log: (msg) => log('info', msg),
      })
    }

    // Navigate to Slack
    progress(2, 5, 'Navigating to Slack...')
    const page = context.pages()[0] || await context.newPage()
    await page.goto('https://app.slack.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })

    const readiness = await waitForSlackReady(page, 45000)
    if (!readiness.ready) {
      fail('page_load_timeout', 'Slack did not load within 45 seconds')
      return
    }
    if (!readiness.loggedIn) {
      fail('login_required', 'Not logged into Slack. Please sign in with this profile in Chrome first.')
      return
    }
    log('info', 'Slack loaded and authenticated')

    // Extract token
    progress(3, 5, 'Extracting auth token...')
    const tokenInfo = await extractSlackToken(page)
    if (!tokenInfo?.token) {
      fail('token_not_found', 'Could not extract Slack auth token from localStorage. Is this profile logged into Slack?')
      return
    }
    log('info', `Token found for team: ${tokenInfo.teamName} (${tokenInfo.teamId})`)
    const token = tokenInfo.token

    // Dispatch action
    progress(4, 5, `Running action: ${action}...`)
    let result

    switch (action) {
      case 'history':
        result = await handleHistory(page, request, token)
        break
      case 'replies':
        result = await handleReplies(page, request, token)
        break
      case 'channels':
        result = await handleChannels(page, request, token)
        break
      default:
        fail('unknown_action', `Unknown action: ${action}. Supported: history, replies, channels`)
        return
    }

    success(result)
  } catch (err) {
    const code = err.code || 'worker_error'
    fail(code, err.message, err.stack)
  } finally {
    if (context) {
      try { await context.close() } catch {}
    }
    if (cleanupProfile && profileDir) {
      try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
    }
  }
}

main().catch((err) => {
  fail('fatal', err.message, err.stack)
  process.exit(1)
})
