---
name: surf
description: Control Chrome browser via CLI for testing, automation, and debugging. Use when the user needs browser automation, screenshots, form filling, page inspection, network/CPU emulation, network capture, or AI queries via ChatGPT/Gemini/Perplexity/Grok/AI Studio.
---

# Surf Browser Automation

Control a real Chrome-family browser via CLI / native host / extension. Repo + local CLI verified against **surf-cli v2.8.0**.

## When to use

- real browser interaction; not API guesses
- screenshots / DOM / console / network capture
- form fill / file upload / wait / iframe work
- browser-session AI queries: ChatGPT, Gemini, Perplexity, Grok, AI Studio

## Install / sanity check

Always use the live path from Surf itself; do **not** guess bun/npm paths.

```bash
surf extension-path              # path to load in chrome://extensions
surf install <extension-id>      # install native host
surf tab.list                    # sanity check; should list tabs
```

If Surf was upgraded and commands start failing:
1. reload the unpacked extension from `surf extension-path`
2. rerun `surf install <extension-id>`
3. fully restart Chrome

If package-manager paths are nonstandard, set before `surf install`:

```bash
export SURF_NODE_PATH=/path/to/node
export SURF_HOST_PATH=/path/to/native/host.cjs
export SURF_EXTENSION_PATH=/path/to/extension/dist
```

## Core loop

```bash
surf go "https://example.com"
surf read
surf click e5
surf type "hello"
surf snap
```

Aliases:

```bash
surf read        # page.read
surf snap        # screenshot
surf go          # navigate
surf find        # search
```

## High-signal primitives

### Read / inspect

```bash
surf read
surf read --no-text
surf read --depth 3 --compact
surf page.text
surf page.state
surf element.styles e5
surf console
surf network
```

### Robust targeting

Prefer refs or semantic locators over brittle selectors.

```bash
surf click e5
surf locate.role button --name "Submit" --action click
surf locate.text "Accept" --exact --action click
surf locate.label "Email" --action fill --value "test@example.com"
```

### Windows / tabs / frames

```bash
surf window.new "https://example.com"
surf read --window-id 123
surf tab.name app
surf tab.switch app
surf frame.list
surf frame.switch --index 0
surf frame.main
```

### Waits / screenshots

```bash
surf wait 2
surf wait.element ".loaded"
surf wait.network
surf wait.url "/dashboard"
surf snap --output /tmp/shot.png
surf snap --fullpage
```

### Forms / uploads / JS

```bash
surf type "user@example.com" --ref e12
surf select e5 "US"
surf upload --ref e5 --files "/path/to/file.txt"
surf js "return document.title"
```

## AI via browser session

Must already be logged into the target service in the browser.

## ChatGPT — prefer headless mode (CloakBrowser)

**Always use `SURF_USE_CLOAK_CHATGPT=1`** for ChatGPT. CloakBrowser defeats detection (33 C++ patches, 0.9 reCAPTCHA score, human-like behavior). Required for `--file`, `--generate-image`, `--profile`.

```bash
# Standard form — always set SURF_USE_CLOAK_CHATGPT=1
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt "explain this code" --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt "review this PR" --file diff.patch --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt "a robot surfing" --generate-image /tmp/robot.png --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt "deep analysis" --model gpt-5.4-pro --profile dsebban883@gmail.com
```

### ChatGPT models (March 2026 lineup)

| Model alias | Maps to | Use for |
|-------------|---------|--------|
| `instant`, `gpt-5.3`, `gpt-4o` | GPT-5.3 Instant | fast queries, code gen |
| `thinking`, `gpt-5.4-thinking`, `o3`, `o4-mini` | GPT-5.4 Thinking | reasoning, math |
| `pro`, `gpt-5.4-pro`, `o1-pro` | GPT-5.4 Pro | research-grade, hardest tasks |

Progress output (stderr) — structured steps:
```
[bun-chatgpt] [1/5] Launching browser — instant (0.0s)
[bun-chatgpt] [2/5] Authenticating — dsebban883@gmail.com (0.1s)
[bun-chatgpt] [3/5] Loading ChatGPT (1.2s)
[bun-chatgpt] [4/5] Sending prompt — ... (3.4s)
[bun-chatgpt] [5/5] Waiting for response (3.6s)
[bun-chatgpt] ✓ Done — response preview (instant, 12.1s)
```

### Headless backends

| Flag | Backend | Notes |
|------|---------|-------|
| `SURF_USE_CLOAK_CHATGPT=1` | **CloakBrowser** ← **default** | defeats detection; requires `npm install -g cloakbrowser` |
| `SURF_USE_BUN_CHATGPT=1` | Bun.WebView | fallback if CloakBrowser unavailable; requires Bun canary |
| neither | extension path | legacy; no `--file`/`--generate-image`/`--profile` |

### Constraints
- `--profile` macOS only
- `--profile` incompatible with `--with-page`
- `--file` / `--generate-image` / `--profile` require headless flag
- default timeout **2700s = 45min**

### Long-running ChatGPT / reasoning models

For `gpt-5.4-pro`, Thinking, similar long-think runs: launch in tmux, poll logs.

```bash
tmux new -d -s surf-chat "bash -lc 'set -x; SURF_USE_CLOAK_CHATGPT=1 surf chatgpt \"complex analysis\" --model gpt-5.4-pro --profile dsebban883@gmail.com --timeout 3000 2>&1 | tee /tmp/surf-chatgpt.log'"

# poll
tail -f /tmp/surf-chatgpt.log

# inspect session
tmux attach -t surf-chat
```

Why: browser-side AI runs can take many minutes; tmux keeps agent unblocked and observable.

### Fallback: extension-based (legacy)

Only when headless unavailable (`--with-page` requires it):

```bash
surf chatgpt "explain this code"
surf chatgpt "summarize" --with-page
```

## Gemini — preferred: headless mode

**Always use headless mode** with `SURF_USE_BUN_GEMINI=1` and `--profile dsebban883@gmail.com`.
This bypasses the Chrome extension entirely: Bun launches a headless Chrome, injects cookies
from the real Chrome profile, and drives Gemini directly via CDP. Faster, no tab pollution,
no native host required for this path.

```bash
# Standard form — always include both env var and profile flag
SURF_USE_BUN_GEMINI=1 surf gemini "explain quantum computing" --profile dsebban883@gmail.com
SURF_USE_BUN_GEMINI=1 surf gemini "analyze this chart" --file chart.jpg --profile dsebban883@gmail.com
SURF_USE_BUN_GEMINI=1 surf gemini "summarize this video" --youtube "https://youtube.com/..." --profile dsebban883@gmail.com
```

Progress output (stderr) — structured steps, safe to parse:
```
[bun-gemini] [1/6] Launching browser — gemini-3-pro (0.0s)
[bun-gemini] [2/6] Authenticating — dsebban883@gmail.com (0.1s)
[bun-gemini] [3/6] Loading Gemini (1.3s)
[bun-gemini] [4/6] Uploading file — photo.jpg (4.8s)
[bun-gemini] [5/6] Sending prompt — ... (8.2s)
[bun-gemini] [6/6] Waiting for response (8.5s)
[bun-gemini] ✓ Done — response preview (gemini-3-pro, 15.1s)
```

Local `surf gemini --help` documents these model names:
- `gemini-3-pro` (default)
- `gemini-2.5-pro`
- `gemini-2.5-flash`

**`gemini-3.1-pro-preview` also works** via `--model` even though help doesn't list it.
Use it for highest-quality image analysis and reasoning.

### Fallback: extension-based (legacy)

Only use when headless is unavailable (`--with-page` requires it; non-macOS; Bun missing):

```bash
surf gemini "explain quantum computing"
surf gemini "summarize" --with-page
```

### Image generation / editing

```bash
SURF_USE_BUN_GEMINI=1 surf gemini "a robot surfing" --generate-image /tmp/robot.png --profile dsebban883@gmail.com
SURF_USE_BUN_GEMINI=1 surf gemini "wide banner" --generate-image /tmp/banner.png --aspect-ratio 16:9 --profile dsebban883@gmail.com
SURF_USE_BUN_GEMINI=1 surf gemini "add sunglasses" --edit-image photo.jpg --output out.jpg --profile dsebban883@gmail.com
```

Important:
- these image flags live on **`surf gemini`**, not `surf aistudio`
- if you need the newest Google model ids, prefer **AI Studio** section below; Gemini web help lags model naming
- headless mode requires Bun canary (`bun upgrade --canary`) — already installed on this machine

## AI Studio — prefer for latest Gemini 3.1 model ids

Local `surf aistudio --help` says `--model` is **best-effort**: pass an AI Studio model id; if invalid, AI Studio falls back to the **last-selected UI model**.

Preferred ids:
- `gemini-3.1-pro-preview` — best quality / reasoning / code review
- `gemini-3.1-flash-lite-preview` — fast + cheap text work
- `gemini-3.1-flash-image-preview` — **Nano Banana 2**; latest Flash image model name in AI Studio / Google docs

```bash
surf aistudio "review this architecture" --model gemini-3.1-pro-preview
surf aistudio "summarize this page" --with-page --model gemini-3.1-flash-lite-preview
surf aistudio "deep analysis" --model gemini-3.1-pro-preview
```

Notes:
- default timeout from local help: **300s**; raise for hard tasks
- for long pro runs, use tmux + poll same as ChatGPT
- `surf aistudio` does **not** expose dedicated `--generate-image` / `--edit-image` flags in local help
- use AI Studio for latest model selection; use `surf gemini` for Surf's built-in image CLI flow

### Nano Banana 2 note

Official Google naming: **`gemini-3.1-flash-image-preview` = Nano Banana 2**.

Practical Surf guidance:
- latest Google model naming / selection -> `surf aistudio --model gemini-3.1-flash-image-preview`
- CLI image save/edit flow -> `surf gemini ... --generate-image/--edit-image`

If you want both together, try explicit model selection in Gemini web first; if UI/model selection drifts, AI Studio is source-of-truth for current model ids.

## AI Studio App Builder

```bash
surf aistudio.build "build a portfolio site"
surf aistudio.build "todo app" --model gemini-3.1-pro-preview
surf aistudio.build "crm dashboard" --output ./out
surf aistudio.build "game" --keep-open --timeout 600
```

## Perplexity / Grok

```bash
surf perplexity "deep dive on X" --mode research
surf grok "latest AI agent trends on X"
surf grok --validate
surf grok --validate --save-models
```

## Workflows

Use `surf do` to collapse many browser steps into one deterministic run.

```bash
surf do 'go "https://example.com" | click e5 | snap'
surf do --file workflow.json
surf workflow.list
surf workflow.info my-workflow
surf workflow.validate ./workflow.json
```

## Troubleshooting

### `Unknown tool: aistudio` after upgrade

Old extension loaded. Fix:
1. `surf extension-path`
2. reload unpacked extension from that path
3. `surf install <extension-id>`
4. restart Chrome

### `Connection refused. Native host not running.`

Usually extension/native-host mismatch.
- rerun `surf install <extension-id>`
- toggle extension off/on
- restart Chrome
- then `surf tab.list`

### Model selection seems ignored

Expected for AI Studio best-effort model setting. If a passed model id is invalid, AI Studio uses the last-selected UI model. For critical runs:
- do a short smoke query first
- confirm returned model in the UI
- then run the expensive prompt

## Tips

1. use refs / semantic locators over selectors
2. use isolated windows for agent work
3. first CDP action can be slower than later ones
4. use tmux + log polling for long AI/browser jobs
5. prefer **AI Studio** for latest Google model ids
6. prefer **headless Gemini** (`SURF_USE_BUN_GEMINI=1 --profile dsebban883@gmail.com`) for all Gemini work; fall back to extension only for `--with-page`
7. prefer **headless ChatGPT** (`SURF_USE_CLOAK_CHATGPT=1 --profile dsebban883@gmail.com`) for all ChatGPT work; fall back to extension only for `--with-page`
8. use `surf extension-path`; don't hardcode bun/npm install paths
9. if unsure, check local truth first: `surf <command> --help`
