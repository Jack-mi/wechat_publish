---
name: wechat-article
description: Produce or improve WeChat Official Account articles through the Vault's audited wechat-agent harness. Use for topic-to-article, improving a Markdown draft, previewing a WeChat article, or creating/updating an approved draft.
---

# WeChat Article Harness

Use the project CLI as the only production control plane. It owns runs, Agent threads, artifacts, rendering, QA, upload, and WeChat draft side effects.

- Run from `/Users/miller/Projects/wechat-agent`. For a topic, run `pnpm --dir scripts/wechat wechat-agent topic "<topic>" --vault /absolute/vault --audience "..." --angle "..."`.
- For an existing Markdown draft, run `pnpm --dir scripts/wechat wechat-agent improve <article.md> --vault /absolute/vault --goal "..." --cover <image>`.
- Use `status`, `resume`, `preview`, and `report` to inspect an existing run. Do not edit `.runtime/runs` manually.
- Read [editorial rules](references/editorial-rules.md) for writing or revising. Read [publishing rules](references/publishing-rules.md) before a draft action. Read [conflict resolution](references/conflict-resolution.md) whenever the run pauses on facts.

The original Vault Markdown is never modified. `export <run-id> --output <vault-path>` is the only route that writes the final work copy back into the Vault.

When the user explicitly says “创建草稿” or “更新草稿”, call `approve-draft <run-id>` or `update-draft <run-id> --media-id <media-id>` directly. The CLI consumes its internal one-time approval value automatically; never ask the user to copy a token. Never invoke a mass-send or publication action; this harness has no such command. Return only a real draft URL when available; otherwise return the actual `media_id` and say the URL is unavailable.
