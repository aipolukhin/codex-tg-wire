import { describe, expect, test } from 'bun:test'

import {
  TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS,
  TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS,
  withTelegramProgressContract,
} from '../../src/bridge/telegram-progress-contract.js'

describe('Telegram progress contract', () => {
  test('distinguishes an explicit task from discussion and keeps execution autonomous', () => {
    expect(TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS).toContain(
      "Infer the conversation mode from the owner's intent",
    )
    expect(TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS).toContain(
      'enters execution immediately and does not need a second confirmation',
    )
    expect(TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS).toContain(
      'stays in ordinary discussion mode',
    )
    expect(TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS).toContain(
      "wait for the owner's go-ahead",
    )
    expect(TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS).toContain(
      'execute the agreed scope end-to-end autonomously',
    )
    expect(TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS).toContain(
      'a service restart needed to make the agreed bot change effective',
    )
    expect(TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS).toContain(
      'not a per-command permission gate',
    )
    expect(TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS).toContain(
      'not a reason to cripple execution with a blanket read-only sandbox',
    )
  })

  test('requires timely plan updates and a final synchronization', () => {
    expect(TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS).toContain('call update_plan')
    expect(TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS).toContain('[telegram-task-progress]')
    expect(TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS).toContain(
      'discussion, clarification, status reporting, answer-only work or read-only inspection',
    )
    expect(TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS).toContain('exactly one step in_progress')
    expect(TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS).toContain('Immediately after a step')
    expect(TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS).toContain('Before the final answer')
    expect(TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS).toContain('every 60 seconds')
  })

  test('preserves existing developer instructions and appends the contract once', () => {
    const once = withTelegramProgressContract('Keep repository rules.')
    const twice = withTelegramProgressContract(once)
    expect(once).toStartWith('Keep repository rules.')
    expect(once.match(/TELEGRAM DISCUSS-THEN-EXECUTE CONTRACT/g)).toHaveLength(1)
    expect(once.match(/TELEGRAM PROGRESS CONTRACT/g)).toHaveLength(1)
    expect(twice).toBe(once)
  })

  test('upgrades an existing progress-only contract with the discussion phase', () => {
    const upgraded = withTelegramProgressContract(TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS)
    expect(upgraded.match(/TELEGRAM DISCUSS-THEN-EXECUTE CONTRACT/g)).toHaveLength(1)
    expect(upgraded.match(/TELEGRAM PROGRESS CONTRACT/g)).toHaveLength(1)
  })
})
