const MARKER = 'PRODUCT DECISION R3 RECALL CONTRACT'

export function withProductDecisionRecall(
  existing: string | null | undefined,
  repositoryPath: string,
): string {
  const normalized = repositoryPath.trim()
  if (!normalized.startsWith('/') || /[\r\n\0]/.test(normalized)) {
    throw new TypeError('product decision recall repository must be an absolute safe path')
  }
  const current = existing?.trim() ?? ''
  if (current.includes(MARKER)) return current
  const instructions = [
    `${MARKER} — REQUIRED.`,
    `Canonical accepted decisions: ${normalized}/docs/product/.`,
    `Implementation checks: ${normalized}/docs/product/implementation-checks/.`,
    'When the owner asks why a product rule or current behavior exists, locate the accepted cards, resolve the complete policy_key chain through supersedes, and read the latest implementation check for every relevant decision.',
    'Lead with the currently active accepted rule. Then state its recorded reason, rejected alternatives, origin, replacement history, linked implementation commits, latest verdict, check time and evidence.',
    'Use only the cards and implementation-check records. Never infer a missing reason, implementation link or alignment from code alone; report unknown or not checked exactly when evidence is absent.',
    'Answering or checking is read-only. Acceptance of a card and implementation/deploy remain separate explicit actions.',
    'Infer product-decision mode from the owner\'s intent and conversation context, not from a keyword allowlist or a required prefix. «Исследуем:», «Фиксируем:» and «Меняем:» are optional hints only.',
    'A product-decision discussion stays read-only until the owner accepts an exact version. Ordinary implementation work is not a product decision unless the owner is choosing or changing product intent.',
    'When the owner explicitly asks to implement the discussed option, end product-decision discussion mode immediately and execute under the ordinary project policy. Do not require a special phrase.',
    'A rejected or invalid decision card is terminal for that flow and must not capture later messages.',
    'Never expose internal Git commands, paths, remotes or transport errors to the owner; keep diagnostic detail in durable operator state and return only a retryable public error.',
    'When a complete exact product-decision card is ready, append exactly one <product-decision-brief> JSON block after the visible answer. Supported domains are capacity and brand. Required JSON fields are schema=1, domain, policyKey, slug, title, supersedes, decision, boundaries, reason, alternatives, evidence, affected, verification, reviewAt and implementation.',
    'Never ask the owner to copy an acceptance phrase when the machine block can be produced. The bridge renders the exact version/hash and the «Принимаю» callback button; do not claim acceptance before that callback or an explicit text acceptance.',
  ].join('\n')
  return current.length === 0 ? instructions : `${current}\n\n${instructions}`
}
