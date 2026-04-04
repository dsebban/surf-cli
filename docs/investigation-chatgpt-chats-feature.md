# Investigation: ChatGPT Chat Management via CLI (CloakBrowser Headless)

## Summary

Add `surf chatgpt.chats` + `surf chatgpt.reply` commands that use CloakBrowser headless to interact with ChatGPT's internal backend API — list, view, search, export, and reply to conversations from the CLI.

## Current Architecture

### Existing Components

| Component | File | Role |
|-----------|------|------|
| CLI entry + routing | `native/cli.cjs` (3724 LOC) | Command parsing, routing, session management |
| Cloak bridge | `native/chatgpt-cloak-bridge.cjs` | Spawns worker, stdin/stdout JSON-lines protocol |
| Cloak worker | `native/chatgpt-cloak-worker.mjs` | CloakBrowser Playwright automation — launches context, navigates, sends prompts, captures responses |
| Cloak profile auth | `native/chatgpt-cloak-profile-auth.mjs` | Chrome cookie extraction + injection into Playwright context |
| Bun worker logic | `native/chatgpt-bun-worker-logic.ts` | Model mapping, stream parsing, text sanitization |
| Session store | `native/session-store.cjs` | Local session logging (`~/.surf/sessions/`) |

### Current Flow (Cloak path)

```
surf chatgpt "prompt" → cli.cjs → chatgpt-cloak-bridge.cjs
  → spawns chatgpt-cloak-worker.mjs
    → launchPersistentContext (CloakBrowser)
    → (optional) loadAndInjectChatgptCookies
    → navigate to chatgpt.com
    → type prompt → send → wait for response
    → stdout JSON-lines → bridge resolves → cli prints
```

### Key Insight: Auth is Already Solved

The cloak worker already handles:
- Cookie extraction from Chrome profiles (`chatgpt-cloak-profile-auth.mjs`)
- Persistent session via shared profile dir (`~/.surf/cloak-profile`)
- Cloudflare bypass (CloakBrowser's 42 C++ patches)

## ChatGPT Backend API (Verified via Research)

### Authentication Model (Logged-In Users)

**Critical distinction:** The `realasfngl/ChatGPT` repo uses `backend-anon` endpoints with Sentinel/Turnstile tokens — that's for **anonymous** users. For **logged-in** users (our case), auth is much simpler:

1. Navigate to `chatgpt.com` (cookies establish session)
2. `GET /api/auth/session` → returns `{ accessToken: "..." }`
3. Use `Authorization: Bearer <accessToken>` on all API calls

**Verified by:** The [ocombe/ChatGPT-Exporter](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5) gist (March 2026, 2 forks) uses exactly this pattern:

```javascript
const session = await fetch("/api/auth/session").then(r => r.json());
const token = session.accessToken;

// All subsequent calls:
const resp = await fetch(`/backend-api/${path}`, {
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${token}`,
    "Oai-Device-Id": crypto.randomUUID(),
    "Oai-Language": "en-US",
  },
});
```

### Required Headers (Inside Browser Context)

Since `page.evaluate(fetch(...))` runs in the authenticated browser context, the browser already provides cookies + standard headers. We only need to add:

| Header | Value | Source |
|--------|-------|--------|
| `Authorization` | `Bearer <accessToken>` | From `/api/auth/session` |
| `Oai-Device-Id` | UUID or from `oai-did` cookie | Already in browser cookies |
| `Oai-Language` | `en-US` | Static |
| `Content-Type` | `application/json` | Static |
| `Accept` | `application/json` | Static |

### Endpoints

| Endpoint | Method | Purpose | Params |
|----------|--------|---------|--------|
| `GET /api/auth/session` | GET | Get access token | None |
| `GET /backend-api/conversations` | GET | List conversations | `offset`, `limit` (max 100), `order` |
| `GET /backend-api/conversation/{id}` | GET | Full conversation tree | None |
| `GET /backend-api/conversations/search?q=` | GET | Search conversations | `q` (query string) |
| `PATCH /backend-api/conversation/{id}` | PATCH | Rename / archive | `{"title":"..."}` or `{"is_visible":false}` |
| `POST /backend-api/conversations/delete` | POST | Bulk delete | `{"conversation_ids":["..."]}` |
| `GET /backend-api/files/download/{id}` | GET | Download attached file | Returns `{download_url}` |

### Response Schemas (Verified from 0xdevalias + ocombe gists)

**List conversations** (`/backend-api/conversations?offset=0&limit=100`):
```json
{
  "items": [
    {
      "id": "uuid-uuid-uuid",
      "title": "Conversation Title",
      "create_time": "2025-03-30T14:22:00.123456"
    }
  ],
  "total": 150,
  "limit": 100,
  "offset": 0
}
```

**Get conversation** (`/backend-api/conversation/{id}`):
```json
{
  "title": "Conversation Title",
  "create_time": 1711800120.123,
  "current_node": "msg-uuid-latest",
  "mapping": {
    "msg-uuid-1": {
      "id": "msg-uuid-1",
      "message": {
        "author": { "role": "user" },
        "content": { "content_type": "text", "parts": ["User message..."] },
        "create_time": 1711800120.300,
        "metadata": {}
      },
      "parent": "root-uuid",
      "children": ["msg-uuid-2"]
    },
    "msg-uuid-2": {
      "id": "msg-uuid-2",
      "message": {
        "author": { "role": "assistant" },
        "content": { "content_type": "text", "parts": ["Assistant response..."] },
        "create_time": 1711800180.500,
        "metadata": { "model_slug": "gpt-5.3" }
      },
      "parent": "msg-uuid-1",
      "children": []
    }
  }
}
```

## Proposed CLI Design

### Command Structure

```bash
# List conversations
surf chatgpt.chats                          # Last 20 conversations
surf chatgpt.chats --limit 50              # Pagination
surf chatgpt.chats --all                   # All (paginated fetch)

# View a specific conversation
surf chatgpt.chats <conversation-id>       # Full markdown output
surf chatgpt.chats <id> --limit 5          # Last 5 messages
surf chatgpt.chats <id> --json             # Raw JSON

# Search conversations
surf chatgpt.chats --search "auth system"  # Search by title/content

# Export conversation
surf chatgpt.chats <id> --export /tmp/chat.md
surf chatgpt.chats <id> --export /tmp/chat.json --format json

# Reply to existing conversation
surf chatgpt.reply <conversation-id> "follow-up question"
surf chatgpt.reply <id> "follow-up" --model gpt-5.4-thinking

# Rename / Delete (Phase 3)
surf chatgpt.chats <id> --rename "New Title"
surf chatgpt.chats <id> --delete
```

### Output Formats

**List output:**
```
ChatGPT Conversations (20 of 150)

  UPDATED          TITLE                                    ID
  ──────────────── ──────────────────────────────────────── ──────────────────
  03/30 14:22      Auth system design                       a1b2c3d4-e5f6
  03/30 11:05      Rust async investigation                 e5f6g7h8-i9j0

Usage:
  surf chatgpt.chats <id>                  View conversation
  surf chatgpt.chats --search "query"      Search
  surf chatgpt.chats <id> --export out.md  Export as markdown
```

**View output (markdown):**
```markdown
# Auth system design
_2025-03-30 | gpt-5.3 | 12 messages_

---

### You · 14:22
Design an auth system for my Node.js app...

### ChatGPT · 14:23
Here's a comprehensive auth system design:
1. **JWT-based authentication**
...
```

## Implementation Architecture

### CloakBrowser Headless (All-In)

Everything goes through CloakBrowser headless — no raw HTTP, no Cloudflare risk.

```
surf chatgpt.chats → cli.cjs → chatgpt-cloak-bridge.cjs
  → spawns chatgpt-cloak-chats-worker.mjs
    → launchPersistentContext (CloakBrowser)
    → (optional) loadAndInjectChatgptCookies
    → navigate to chatgpt.com (Cloudflare bypass)
    → page.evaluate: GET /api/auth/session → accessToken
    → page.evaluate: GET /backend-api/conversations
    → stdout JSON-lines → bridge resolves → cli formats + prints
```

### Worker Protocol (JSON-Lines)

Same protocol as existing cloak worker:

**Input (stdin):**
```json
{"type": "chats", "action": "list", "limit": 20, "profile": "user@gmail.com"}
{"type": "chats", "action": "get", "conversationId": "uuid-...", "limit": 10}
{"type": "chats", "action": "search", "query": "auth system"}
{"type": "reply", "conversationId": "uuid-...", "prompt": "follow-up", "model": "gpt-5.4-thinking"}
```

**Output (stdout):**
```json
{"type": "progress", "step": 1, "total": 4, "message": "Launching CloakBrowser", "t": 123456}
{"type": "progress", "step": 2, "total": 4, "message": "Loading ChatGPT", "t": 123457}
{"type": "progress", "step": 3, "total": 4, "message": "Fetching conversations", "t": 123458}
{"type": "success", "conversations": [...], "total": 150, "t": 123459}
```

### Conversation Tree → Markdown Converter

**Algorithm** (DFS, verified from ocombe gist):

```javascript
function conversationToMarkdown(convo) {
  const { title, mapping } = convo;
  
  // Find root (parent is null or missing)
  const roots = Object.values(mapping)
    .filter(n => !n.parent || !mapping[n.parent]);
  
  // DFS walk — follow children chain
  const messages = [];
  const seen = new Set();
  
  function visit(nodeId) {
    if (!nodeId || seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!node) return;
    
    const msg = node.message;
    if (msg && msg.author?.role && msg.content?.parts?.length) {
      // Skip system/tool messages
      if (msg.author.role !== 'system' && !msg.metadata?.is_hidden) {
        messages.push({
          role: msg.author.role,
          text: msg.content.parts.join(''),
          time: msg.create_time,
          model: msg.metadata?.model_slug,
        });
      }
    }
    
    // Visit children (sorted for deterministic output)
    const kids = (node.children || []).slice().sort();
    for (const k of kids) visit(k);
  }
  
  for (const root of roots) visit(root.id);
  
  // Format as markdown
  let md = `# ${title}\n\n`;
  for (const m of messages) {
    const role = m.role === 'user' ? 'You' : 'ChatGPT';
    const time = m.time ? new Date(m.time * 1000).toLocaleTimeString() : '';
    md += `### ${role}${time ? ' · ' + time : ''}\n\n${m.text}\n\n---\n\n`;
  }
  return md;
}
```

### New Files

| File | Purpose |
|------|---------|
| `native/chatgpt-cloak-chats-worker.mjs` | CloakBrowser worker for chat management — launches headless context, navigates to ChatGPT, calls backend API via `page.evaluate(fetch(...))`, returns results via JSON-lines |
| `native/chatgpt-chats-formatter.cjs` | Conversation tree → markdown/JSON converter. DFS tree walker, handles branching, formats output. |

### Modified Files

| File | Changes |
|------|---------|
| `native/cli.cjs` | Add `chatgpt.chats`, `chatgpt.reply` command definitions + routing |
| `native/chatgpt-cloak-bridge.cjs` | Add `manageChatsCloakBrowser()` function — spawns chats worker, same JSON-lines protocol |

### Key page.evaluate Pattern

The worker calls the ChatGPT API via `page.evaluate` inside the headless browser:

```javascript
// Step 1: Get access token (runs in browser context, has all cookies)
const session = await page.evaluate(async () => {
  const resp = await fetch('/api/auth/session');
  return resp.json();
});
const token = session.accessToken;

// Step 2: List conversations
const data = await page.evaluate(async (authToken, limit, offset) => {
  const resp = await fetch(`/backend-api/conversations?offset=${offset}&limit=${limit}`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Oai-Device-Id': crypto.randomUUID(),
      'Oai-Language': 'en-US',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}, token, 20, 0);

// Step 3: Emit result
success({ conversations: data.items, total: data.total });
```

**Why this works:** CloakBrowser's 42 C++ patches ensure the browser has a legitimate fingerprint. `page.evaluate(fetch(...))` executes in the real browser context — same TLS, same cookies, same origin. No Cloudflare risk.

**CloakBrowser tips** (from docs):
- Minimize `page.evaluate()` calls before readiness — batch operations
- Use native `sleep()` not `page.waitForTimeout()` (avoids CDP signals)
- Use `humanize: true` + `humanPreset: 'careful'` for realistic behavior

### Reply to Conversation

For `chatgpt.reply`, reuse the existing `chatgpt-cloak-worker.mjs` with one change:

- Navigate to `https://chatgpt.com/c/{conversation_id}` instead of `chatgpt.com/`
- Wait for conversation to load (existing readiness check)
- Type and send prompt (existing send logic)
- Capture response (existing SSE + DOM capture)

Minimal modification — the existing worker already handles everything after navigation.

## Implementation Plan

### Phase 1: Chats Worker + Formatter

1. `native/chatgpt-cloak-chats-worker.mjs` — CloakBrowser worker for API calls
   - Reuse launch/auth/cleanup patterns from existing worker
   - Actions: `list`, `get`, `search`
   - JSON-lines protocol
2. `native/chatgpt-chats-formatter.cjs` — Tree → markdown converter
   - DFS tree walker
   - Markdown + JSON output
   - Handle branching (pick latest branch or include all)

### Phase 2: CLI Integration

1. Add `chatgpt.chats` command definition to TOOLS in `cli.cjs`
2. Add `chatgpt.reply` command definition
3. Route `chatgpt.chats` to `manageChatsCloakBrowser()` in bridge
4. Route `chatgpt.reply` to existing cloak worker (with conversation URL)
5. Formatter integration for terminal output

### Phase 3: Advanced

1. `--rename`, `--delete` (PATCH/POST endpoints)
2. File download from conversations (`/backend-api/files/download/{id}`)
3. `--continue` (open in headed browser via `CLOAK_HEADLESS=0`)
4. Caching layer for conversation list (avoid rate limits)
5. Persistent browser context (avoid cold start on repeated commands)

## Research Sources

| Source | URL | Key Contribution |
|--------|-----|------------------|
| ocombe ChatGPT Exporter | [gist](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5) | Complete API patterns — auth, list, get, tree → markdown, file download |
| 0xdevalias ChatGPT API | [gist](https://gist.github.com/0xdevalias/4e54bb28a02db5357ea4fa3a872fc5fc) | Response schemas for conversations + conversation/{id} |
| realasfngl/ChatGPT | [deepwiki](https://deepwiki.com/realasfngl/ChatGPT/9-openai-backend-endpoints) | Header reference (anon path — different from logged-in) |
| CloakBrowser docs | npm/cloakbrowser | `launchPersistentContext` API, `page.evaluate` patterns |
| rp-cli chats command | AGENTS.md + `rp-cli -d chats` | CLI design patterns — action/list/log, chat_id, limit |

## rp-cli Design Lessons

**Adopt:**
- Positional ID argument (`chatgpt.chats <id>` not `--chat-id`)
- `--limit` for pagination
- Default action = list (no subcommand needed)
- Structured columnar output

**Avoid:**
- Inconsistent positional vs named params
- Action-required parsing (`chats limit=50` fails — need `chats list limit=50`)

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Backend API changes | Low | Stable (used by web app). Pin `Oai-Client-Version`. |
| Rate limiting (20 req/min) | Medium | Cache list, backoff, batch API calls in single evaluate |
| Cold start latency (~15-20s) | Certain | Persistent browser context caching (Phase 3) |
| Large conversations (100+ msg) | Low | `--limit` for message count, streaming output |
| Cookie/session expiry | Low | Already handled by profile auth |

## Dependencies

- **No new npm dependencies** — reuses CloakBrowser (already optional dep)
- Reuses `chrome-profile-utils.cjs` for cookie extraction
- Reuses `chatgpt-cloak-profile-auth.mjs` for cookie injection
