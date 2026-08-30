import { describe, expect, test } from 'bun:test'

import { PERSONAL_ALPHA_BOT_COMMANDS } from '../../src/bridge/personal-alpha-command-menu.js'

describe('PERSONAL_ALPHA_BOT_COMMANDS', () => {
  test('is a valid, unique and useful Telegram slash menu', () => {
    const names = PERSONAL_ALPHA_BOT_COMMANDS.map((item) => item.command)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('start')
    expect(names).toContain('settings')
    expect(names).toContain('status')
    expect(names).toContain('stop')
    expect(names).toContain('sessions')
    expect(names).toContain('diff')
    for (const item of PERSONAL_ALPHA_BOT_COMMANDS) {
      expect(item.command).toMatch(/^[a-z0-9_]{1,32}$/)
      expect(item.description.length).toBeGreaterThan(0)
      expect(item.description.length).toBeLessThanOrEqual(256)
    }
  })
})
