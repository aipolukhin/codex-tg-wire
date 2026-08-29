import { describe, expect, test } from 'bun:test'

import {
  buildMcpContent,
  mcpDoneKey,
  mcpElicitationStorageValue,
  mcpSkipKey,
  mcpValueKey,
  parseMcpElicitation,
  validateMcpTextValue,
} from '../../src/codex/mcp-elicitation.js'

function form(requestedSchema: unknown) {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'inventory',
    mode: 'form',
    _meta: null,
    message: 'Configure deployment',
    requestedSchema,
  }
}

describe('MCP elicitation schema boundary', () => {
  test('normalizes every standard primitive and enum form field', () => {
    const parsed = parseMcpElicitation(form({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        name: {
          type: 'string',
          title: 'Name',
          minLength: 2,
          maxLength: 20,
          default: 'demo',
        },
        retries: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
        ratio: { type: 'number', minimum: 0, maximum: 1 },
        enabled: { type: 'boolean', default: true },
        region: {
          type: 'string',
          oneOf: [
            { const: 'eu', title: 'Europe' },
            { const: 'us', title: 'United States' },
          ],
        },
        features: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { type: 'string', enum: ['logs', 'metrics', 'traces'] },
        },
      },
      required: ['name', 'retries', 'enabled', 'region', 'features'],
    }))

    expect(parsed?.mode).toBe('form')
    if (parsed?.mode !== 'form') throw new Error('form not parsed')
    expect(parsed.fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ['name', 'string', true],
      ['retries', 'integer', true],
      ['ratio', 'number', false],
      ['enabled', 'boolean', true],
      ['region', 'single', true],
      ['features', 'multi', true],
    ])
    const stored = mcpElicitationStorageValue(parsed)
    expect(parseMcpElicitation(stored)).toEqual(parsed)
    expect(stored).toMatchObject({ _meta: null, requestedSchema: { type: 'object' } })

    const answers = {
      [mcpValueKey(0)]: ['service'],
      [mcpValueKey(1)]: ['3'],
      [mcpSkipKey(2)]: ['skip'],
      [mcpValueKey(3)]: ['true'],
      [mcpValueKey(4)]: ['us'],
      [mcpValueKey(5)]: ['logs', 'metrics'],
      [mcpDoneKey(5)]: ['done'],
    }
    expect(buildMcpContent(parsed.fields, answers)).toEqual({
      outcome: 'complete',
      content: {
        name: 'service',
        retries: 3,
        enabled: true,
        region: 'us',
        features: ['logs', 'metrics'],
      },
    })
  })

  test('validates string formats, numeric bounds and completion markers', () => {
    const parsed = parseMcpElicitation(form({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        date: { type: 'string', format: 'date' },
        count: { type: 'integer', minimum: 2, maximum: 4 },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: { anyOf: [{ const: 'safe', title: 'Safe' }] },
        },
      },
      required: ['email', 'date', 'count', 'tags'],
    }))
    if (parsed?.mode !== 'form') throw new Error('form not parsed')
    expect(validateMcpTextValue(parsed.fields[0]!, 'bad')).toMatchObject({ ok: false })
    expect(validateMcpTextValue(parsed.fields[0]!, 'owner@example.com')).toEqual({
      ok: true,
      value: 'owner@example.com',
    })
    expect(validateMcpTextValue(parsed.fields[1]!, '2026-02-29')).toMatchObject({ ok: false })
    expect(validateMcpTextValue(parsed.fields[2]!, '5')).toMatchObject({ ok: false })
    expect(validateMcpTextValue(parsed.fields[2]!, '0x3')).toMatchObject({ ok: false })
    expect(buildMcpContent(parsed.fields, {
      [mcpValueKey(0)]: ['owner@example.com'],
      [mcpValueKey(1)]: ['2026-02-28'],
      [mcpValueKey(2)]: ['3'],
      [mcpValueKey(3)]: ['safe'],
    })).toEqual({ outcome: 'incomplete' })
  })

  test('accepts only credential-free HTTPS URL flows', () => {
    expect(parseMcpElicitation({
      threadId: 'thread-1',
      turnId: null,
      serverName: 'oauth',
      mode: 'url',
      _meta: null,
      message: 'Authorize',
      url: 'https://accounts.example.com/authorize?state=opaque',
      elicitationId: 'elicit-1',
    })).toMatchObject({
      mode: 'url',
      turnId: '',
      urlHost: 'accounts.example.com',
    })
    for (const url of [
      'http://accounts.example.com/authorize',
      'https://user:password@accounts.example.com/authorize',
      'javascript:alert(1)',
    ]) {
      expect(parseMcpElicitation({
        threadId: 'thread-1',
        turnId: null,
        serverName: 'oauth',
        mode: 'url',
        _meta: null,
        message: 'Authorize',
        url,
        elicitationId: 'elicit-1',
      })).toBeNull()
    }
  })

  test('stores only the normalized request needed for durable callbacks', () => {
    const parsed = parseMcpElicitation({
      ...form({
        type: 'object',
        properties: {
          region: {
            type: 'string',
            enum: ['eu', 'us'],
            ignoredExtension: { privateTrace: 'must-not-be-persisted' },
          },
        },
        required: ['region'],
        ignoredRoot: 'must-not-be-persisted',
      }),
      _meta: { privateTrace: 'must-not-be-persisted' },
    })
    if (parsed?.mode !== 'form') throw new Error('form not parsed')
    const stored = mcpElicitationStorageValue(parsed)
    expect(JSON.stringify(stored)).not.toContain('must-not-be-persisted')
    expect(parseMcpElicitation(stored)).toEqual(parsed)
  })

  test('quarantines unnegotiated openai/form and rejects secret-like or malformed standard schemas', () => {
    expect(parseMcpElicitation({
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'extended',
      mode: 'openai/form',
      _meta: null,
      message: 'Extended form',
      requestedSchema: { type: 'object', properties: {} },
    })).toMatchObject({ mode: 'unsupported', requestedMode: 'openai/form' })

    expect(parseMcpElicitation(form({
      type: 'object',
      properties: { password: { type: 'string', format: 'password' } },
      required: ['password'],
    }))).toBeNull()
    expect(parseMcpElicitation(form({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['missing'],
    }))).toBeNull()
  })
})
