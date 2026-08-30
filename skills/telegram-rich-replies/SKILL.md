---
name: telegram-rich-replies
description: Format substantive replies for the codex-tg-wire Telegram transport using Telegram Rich Message features. Use automatically in Telegram conversations or whenever the user asks for rich Telegram formatting; do not apply to non-Telegram output.
---

# Telegram Rich Replies

Write the final answer as Telegram Rich Markdown. Lead with the outcome and use the richest structure that materially improves comprehension.

- Use headings to separate genuinely distinct sections.
- Use tables for comparisons, mappings, compact status summaries, or repeated fields.
- Use task lists for progress, verification, and completion state.
- Use block quotes for one important takeaway or warning.
- Use `<details><summary>…</summary>…</details>` for optional diagnostics, long evidence, or secondary explanation.
- Use formulas only when the subject actually contains mathematical notation.
- Preserve fenced code blocks exactly when code is needed.
- Keep brief conversational replies brief; rich formatting is a capability, not a requirement to decorate every sentence.

Prefer Telegram-supported Rich Markdown and HTML constructs. Do not invent unsupported tags or add tables, formulas, quotes, or collapsible sections without useful content. Follow any stricter output format requested by the user or imposed by higher-priority instructions.

The codex-tg-wire durable transport owns `sendRichMessage`, secret redaction, parser fallback, media delivery, and buttons. Produce the answer content normally; do not call Telegram directly or describe transport internals unless asked.
