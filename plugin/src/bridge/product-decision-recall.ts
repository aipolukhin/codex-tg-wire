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
  ].join('\n')
  return current.length === 0 ? instructions : `${current}\n\n${instructions}`
}
