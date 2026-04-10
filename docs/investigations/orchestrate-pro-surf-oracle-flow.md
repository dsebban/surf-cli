# Investigation: Orchestrate (Pro) workflow with builder-clarify + surf GPT Pro lane

## Goal
Update the custom RepoPrompt `orchestrate-pro.md` workflow so it:
- runs `context_builder` with `response_type:"clarify"` in a subagent
- spins up a separate surf CLI oracle agent for GPT Pro
- polls thinking/progress output instead of blocking on one long wait
- has a recovery lane if the local surf worker dies after send

## Repo-local facts

### Builder / orchestration shape
- Existing `orchestrate-pro.md` used direct planning in the orchestrator; the new shape moves clarify into a subagent first.
- `plan.md` already treats `context_builder response_type:"clarify"` as the low-bias default.

### Surf CLI facts
- `native/cli.cjs:352-399` documents `chatgpt --prompt-file ... --model gpt-5.4-pro --timeout 2700`.
- `native/chatgpt-cloak-timeout.cjs:1-18` sets ChatGPT query timeout default to **2700s** and chats timeout default to **120s**.
- `native/chatgpt-cloak-bridge.cjs:86-132` re-arms the worker timer on `progress`, `trace`, `meta_update`, `keepalive`, `success`, and `error` events.
- `native/chatgpt-cloak-worker.mjs:1147-1182` emits live thinking deltas (`traceType: "thinking_text"`).
- `native/chatgpt-cloak-worker.mjs:1256-1261` includes `conversationId` in success payloads.
- `native/cli.cjs:1909-2088` implements `session` list/view/reconcile/clear commands.

### Environment drift found during verification
- `surf chatgpt --help` on PATH worked.
- `surf session --help` on PATH returned `Unknown command: session` in this environment.
- `node native/cli.cjs session --hours 1` worked.

Implication: workflow guidance should prefer repo-local CLI inside `surf-cli`, or at least instruct the oracle agent to fall back to `node native/cli.cjs session ...` if PATH surf is stale.

## Existing repo investigations that matter
- `docs/investigation-chatgpt-thinking-trace.md`: cloak path already surfaces live `⏳` status and trace events.
- `docs/investigation-thinking-sidebar-trace.md`: rich right-side trace is capturable in headed mode, but headless is still best treated as log/trace polling plus recovery.
- `docs/investigations/rp-surf-oracle-missing-reply-recovery.md`: if local stdout misses the final answer, `session --reconcile --network` plus `chatgpt.chats <conversationId> --export ...` is the recovery lane.

## exa-cli grounding

### RepoPrompt docs surface
`exa-cli search "RepoPrompt workflow agent_run context_builder markdown workflow" --num-results 5 --contents`
returned official RepoPrompt docs (`https://repoprompt.com/docs`) but no especially useful public custom-workflow examples. Practical workflow format was inferred from the existing local workflow files.

### Long-running supervision pattern
`exa-cli answer "What are reliable patterns for supervising a long-running CLI/browser-automation job so the parent agent does not time out?..."`
returned a consistent pattern across sources:
1. detached execution
2. append-only logs
3. heartbeat / health polling
4. reconciliation / recovery

That maps cleanly to the surf oracle lane:
- detached tmux session
- `.surf/exports/*.response.log`
- polling `[cloak-chatgpt] 🧠 ...` / `⏳ ...` lines
- `session --reconcile --network`
- `chatgpt.chats <conversationId> --export ...`

## Workflow design decisions
1. **Clarify first, in subagent**
   - keeps the orchestrator lean
   - uses builder as the canonical repo-context pass
   - avoids early solution bias from `response_type:"plan"`

2. **Separate surf oracle agent**
   - isolates the long-running GPT Pro call from the main orchestrator
   - gives the agent room to monitor logs, reconcile, and recover without blocking orchestration

3. **Poll instead of one long wait**
   - better observability
   - less fragile than parking on a single long blocking call
   - matches the fact that surf emits incremental trace/progress activity

4. **Prefer repo-local surf CLI when available**
   - avoids PATH drift
   - guarantees access to the local `session` implementation

5. **Use `--prompt-file`, not `--file`**
   - RepoPrompt export should become inline prompt text, not an uploaded attachment

## Resulting workflow shape
1. quick orient (2-3 calls max)
2. clarify subagent → `context_builder response_type:"clarify"`
3. surf oracle subagent → export + tmux + poll + reconcile + recover if needed
4. decompose with clarify/oracle output
5. dispatch implementation agents

## Sources
- https://repoprompt.com/docs
- https://zylos.ai/research/2026-02-20-process-supervision-health-monitoring-ai-agents
- https://open-claw.bot/docs/gateway/background-process
