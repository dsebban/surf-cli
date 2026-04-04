---
name: surf
description: Control Chrome browser via CLI for testing, automation, debugging, and browser-session AI. Use for real browser interaction, screenshots, DOM inspection, file upload, and especially headless ChatGPT/Gemini workflows.
---

# Surf

Real Chrome-family browser control via CLI / native host / extension.
Prefer real browser state over guessed APIs.

Repo + local CLI verified against **surf-cli v2.8.0**.

## Use when

- real browser interaction needed
- screenshots / DOM / console / network capture
- form fill / upload / waits / iframe work
- browser-session AI via ChatGPT / Gemini / AI Studio / Perplexity / Grok

## Sanity check

Always use Surf to discover live paths.

```bash
surf extension-path
surf install <extension-id>
surf tab.list
```

If commands break after upgrade:
1. reload unpacked extension from `surf extension-path`
2. rerun `surf install <extension-id>`
3. restart Chrome fully

## Core browser loop

```bash
surf go "https://example.com"
surf read
surf click e5
surf type "hello"
surf snap
```

Aliases:

```bash
surf read   # page.read
surf snap   # screenshot
surf go     # navigate
surf find   # search
```

## High-signal primitives

```bash
surf read --depth 3 --compact
surf page.state
surf console
surf network
surf locate.role button --name "Submit" --action click
surf locate.label "Email" --action fill --value "test@example.com"
surf wait.element ".loaded"
surf snap --output /tmp/shot.png
surf upload --ref e5 --files "/path/to/file.txt"
surf js "return document.title"
```

## ChatGPT — headless first

**Default to CloakBrowser headless.**
Always set `SURF_USE_CLOAK_CHATGPT=1`.
**Default profile on macOS: `dsebban883@gmail.com`.** Use that `--profile` by default unless the user asks for another account.
Use `--profile dsebban883@gmail.com` for reliable auth and for file / image / chats features.

```bash
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt "explain this code" --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt "review this PR" --file diff.patch --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt "a robot surfing" --generate-image /tmp/robot.png --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt "deep analysis" --model gpt-5.4-pro --profile dsebban883@gmail.com
```

### ChatGPT model aliases

- `instant`, `gpt-5.3`, `gpt-4o` → GPT-5.3 Instant
- `thinking`, `gpt-5.4-thinking`, `o3`, `o4-mini` → GPT-5.4 Thinking
- `pro`, `gpt-5.4-pro`, `o1-pro` → GPT-5.4 Pro

### ChatGPT conversations

These are **Cloak-only** commands.

```bash
# list / search
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats --limit 20 --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats --search "auth system" --profile dsebban883@gmail.com

# view / export
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats <conversation-id> --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats <conversation-id> --export /tmp/chat.md --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats <conversation-id> --export /tmp/chat.json --format json --json --profile dsebban883@gmail.com

# reply / manage
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.reply <conversation-id> "follow-up" --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats <conversation-id> --rename "New Title" --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats <conversation-id> --delete --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats <conversation-id> --download-file <file-id> --output /tmp/file.txt --profile dsebban883@gmail.com
SURF_USE_CLOAK_CHATGPT=1 surf chatgpt.chats --limit 1 --json --continue --profile dsebban883@gmail.com
```

Notes:
- `--continue` runs headed CloakBrowser for that command
- `--delete` is destructive; no CLI undo
- search may use a recent-history fallback; if JSON shows `partial: true`, misses are **not authoritative** for older chats
- `--download-file` needs `--output`

### ChatGPT constraints

- `--profile` macOS only
- `--profile` incompatible with `--with-page`
- `--file` / `--generate-image` / `--profile` require headless
- default timeout: **2700s**

### Long-running ChatGPT runs

Use tmux for long-think models.

```bash
tmux new -d -s surf-chat "bash -lc 'SURF_USE_CLOAK_CHATGPT=1 surf chatgpt \"complex analysis\" --model gpt-5.4-pro --profile dsebban883@gmail.com --timeout 3000 2>&1 | tee /tmp/surf-chatgpt.log'"
tail -f /tmp/surf-chatgpt.log
```

### Legacy fallback

Only if headless is unavailable:

```bash
surf chatgpt "explain this code"
surf chatgpt "summarize" --with-page
```

## Gemini — headless first

**Default to Bun headless Gemini.**
**Default profile on macOS: `dsebban883@gmail.com`.** Use that `--profile` by default unless the user asks for another account.
Always use `SURF_USE_BUN_GEMINI=1` with `--profile dsebban883@gmail.com`.
This path is faster, cleaner, and avoids tab pollution.

```bash
SURF_USE_BUN_GEMINI=1 surf gemini "explain quantum computing" --profile dsebban883@gmail.com
SURF_USE_BUN_GEMINI=1 surf gemini "analyze this chart" --file chart.jpg --profile dsebban883@gmail.com
SURF_USE_BUN_GEMINI=1 surf gemini "summarize this video" --youtube "https://youtube.com/..." --profile dsebban883@gmail.com
```

### Gemini image workflows

```bash
SURF_USE_BUN_GEMINI=1 surf gemini "a robot surfing" --generate-image /tmp/robot.png --profile dsebban883@gmail.com
SURF_USE_BUN_GEMINI=1 surf gemini "wide banner" --generate-image /tmp/banner.png --aspect-ratio 16:9 --profile dsebban883@gmail.com
SURF_USE_BUN_GEMINI=1 surf gemini "add sunglasses" --edit-image photo.jpg --output out.jpg --profile dsebban883@gmail.com
```

### Gemini model notes

Local help lists:
- `gemini-3-pro` default
- `gemini-2.5-pro`
- `gemini-2.5-flash`

Also works:
- `gemini-3.1-pro-preview`

Use `gemini-3.1-pro-preview` for strongest reasoning / image analysis.

### Gemini fallback

Only if headless is unavailable:

```bash
surf gemini "explain quantum computing"
surf gemini "summarize" --with-page
```

## AI Studio

Use when you need latest Gemini model ids and AI Studio-specific behavior.

```bash
surf aistudio "review this architecture" --model gemini-3.1-pro-preview
surf aistudio "summarize this page" --with-page --model gemini-3.1-flash-lite-preview
```

Preferred ids:
- `gemini-3.1-pro-preview`
- `gemini-3.1-flash-lite-preview`
- `gemini-3.1-flash-image-preview`

## Practical rules

- prefer headless for ChatGPT and Gemini
- default macOS profile: `dsebban883@gmail.com` unless user asks otherwise
- always use profile-based auth when available
- use tmux for long jobs
- treat browser-session AI as UI automation: poll logs, expect latency, verify outputs
- for ChatGPT search, JSON `partial: true` means recent-window fallback only
