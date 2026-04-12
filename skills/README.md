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

The skill will be available when pi detects headless ChatGPT/Gemini terminal tasks.

The bundled surf skill covers the current operator flow: profile-based auth, `--prompt-file` for inline large prompts, and `surf session --reconcile --network` for recovery checks.

## Other Agents

The `SKILL.md` file is a comprehensive reference that can be adapted for other AI coding agents or used as documentation for LLM prompts.
