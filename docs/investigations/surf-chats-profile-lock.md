# Investigation: pi-surf-chats CloakBrowser profile lock

## Summary
`/surf-chats` was still failing because the extension never passed `--profile dsebban883@gmail.com`, so `chatgpt.chats` always used the shared `~/.surf/cloak-profile` directory. That shared path was the one colliding; the same command succeeded immediately once `--profile dsebban883@gmail.com` was supplied.

## Symptoms
- Opening `/surf-chats` failed with `CloakBrowser profile locked. Close other surf instances first.`
- Prior fix changed CLI resolution, but runtime still hit the profile-lock path.

## Investigation Log

### Phase 1 - Initial assessment
**Hypothesis:** Extension reached the correct CLI now, but surf-cli/CloakBrowser was still using a shared locked profile path.
**Findings:** Confirmed.
**Evidence:**
- `.pi/extensions/pi-surf-chats/surf-client.ts:121-152` invoked `chatgpt.chats` commands without any `--profile` flag.
- `native/cli.cjs:3458-3465` forwards `requestedProfile` into `chatArgs.profile` for `chatgpt.chats`.
- `native/chatgpt-cloak-chats-worker.mjs:502-510` chooses `tempProfileDir()` when `profile` is set, otherwise `sharedProfileDir()`.
- Repro without profile: `node native/cli.cjs chatgpt.chats --json --limit 1` failed with `Failed to create a ProcessSingleton for your profile directory` against `/Users/danielsivan/.surf/cloak-profile`.
- Repro with profile: `node native/cli.cjs chatgpt.chats --json --limit 1 --profile dsebban883@gmail.com` succeeded and returned conversation JSON.
**Conclusion:** Root cause confirmed: extension omitted `--profile`, so isolated temp-profile mode never activated.

### Phase 2 - Fix
**Hypothesis:** Defaulting the extension to `--profile dsebban883@gmail.com` on macOS will route chats operations onto the isolated temp-profile path and avoid shared-profile collisions.
**Findings:** Implemented in extension client.
**Evidence:**
- `.pi/extensions/pi-surf-chats/surf-client.ts` now defines a default profile and appends `--profile dsebban883@gmail.com` to all surf invocations on macOS.
- `.pi/extensions/pi-surf-chats/index.ts`, `types.ts`, and `overlay.ts` now expose the resolved profile in overlay debug info.
**Conclusion:** Fix applied; requires `/reload` in pi to pick up updated extension code.

## Root Cause
The extension runtime did not inherit behavior from `~/.agents/skills/surf/SKILL.md`; that skill only affects agent command choice, not the extension's direct `pi.exec()` calls. In the extension, `.pi/extensions/pi-surf-chats/surf-client.ts:143-152` called `chatgpt.chats` without `--profile`. In surf-cli, `native/cli.cjs:3464` forwards `profile: requestedProfile`, and `native/chatgpt-cloak-chats-worker.mjs:502-510` switches to an isolated temporary user-data dir only when `profile` is truthy. Without `--profile`, the worker fell back to the shared persistent directory `~/.surf/cloak-profile`, which was already locked.

## Recommendations
1. Reload pi with `/reload`, then reopen `/surf-chats`.
2. Verify overlay footer now shows `Profile: dsebban883@gmail.com`.
3. If a lock ever reappears outside the extension, prefer explicit `--profile dsebban883@gmail.com` for direct `surf chatgpt.chats` commands too.

## Preventive Measures
- Keep profile choice explicit in extension-owned CLI wrappers; do not assume agent skills affect extension runtime.
- Surface resolved CLI path + profile in the overlay for fast diagnosis.
