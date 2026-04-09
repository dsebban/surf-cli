# Surf Skills

This directory contains skill files for AI coding agents.

## Pi Agent

To use the surf skill with [Pi coding agent](https://github.com/badlogic/pi-mono):

```bash
# Option 1: Symlink (auto-updates)
ln -s "$(pwd)/skills/surf" ~/.agents/skills/surf

# Option 2: Copy
cp -r skills/surf ~/.agents/skills/
```

The skill will be available when pi detects browser automation tasks.

The bundled surf skill covers the current headless ChatGPT/Gemini operator flow too: `SURF_USE_CLOAK_CHATGPT=1`, profile-based auth, `--prompt-file` for inline large prompts, and `surf session --reconcile --network` for recovery checks.

## Other Agents

The `SKILL.md` file is a comprehensive reference that can be adapted for other AI coding agents or used as documentation for LLM prompts.
