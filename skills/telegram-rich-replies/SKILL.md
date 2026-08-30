---
name: telegram-rich-replies
description: Keep codex-tg-wire Telegram replies quoteable by default and use Rich Message formatting only when rich-only structure materially improves the answer. Use automatically in Telegram conversations; do not apply to non-Telegram output.
---

# Telegram Rich Replies

Lead with the outcome. Prefer an ordinary, selectable Telegram message so the user can quote a chosen fragment. Use Telegram Rich Markdown only when its extra structure materially improves the answer enough to justify losing selected-quote support.

- Keep conversation, short explanations, status updates, headings, lists, quotes, and code on the ordinary message path.
- Use Rich Message for tables whose relationships matter, `<details>` with genuinely optional material, formulas, footnotes, embedded rich media, or reports that would otherwise require multiple Telegram messages.
- Preserve fenced code blocks exactly when code is needed.
- Do not introduce a rich-only construct merely to make an ordinary answer decorative.

When Rich Message is justified, use only Telegram-supported Rich Markdown and HTML constructs. Do not invent unsupported tags. Follow any stricter output format requested by the user or imposed by higher-priority instructions.

The codex-tg-wire durable transport owns `sendRichMessage`, secret redaction, parser fallback, media delivery, and buttons. Produce the answer content normally; do not call Telegram directly or describe transport internals unless asked.
