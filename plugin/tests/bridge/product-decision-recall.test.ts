import { describe, expect, test } from 'bun:test'

import { withProductDecisionRecall } from '../../src/bridge/product-decision-recall.js'

describe('withProductDecisionRecall', () => {
  test('adds one evidence-only recall contract without replacing existing instructions', () => {
    const once = withProductDecisionRecall('existing', '/srv/vpn-infra')
    expect(once).toContain('existing')
    expect(once).toContain('/srv/vpn-infra/docs/product/implementation-checks/')
    expect(once).toContain('resolve the complete policy_key chain')
    expect(once).toContain('Never infer a missing reason')
    expect(once).toContain('intent and conversation context')
    expect(once).toContain('end product-decision discussion mode immediately')
    expect(once).toContain('rejected or invalid decision card is terminal')
    expect(once).toContain('Never expose internal Git commands')
    expect(once).toContain('<product-decision-brief>')
    expect(once).toContain('«Принимаю» callback button')
    expect(withProductDecisionRecall(once, '/different/path')).toBe(once)
  })

  test('rejects unsafe repository paths', () => {
    expect(() => withProductDecisionRecall(undefined, 'relative')).toThrow('absolute safe path')
    expect(() => withProductDecisionRecall(undefined, '/safe\nINJECT')).toThrow('absolute safe path')
  })
})
