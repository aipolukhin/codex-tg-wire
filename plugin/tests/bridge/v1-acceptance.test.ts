import { describe, expect, test } from 'bun:test'

import { runV1AcceptanceGate } from '../../src/bridge/v1-acceptance.js'

describe('v1 clean-user acceptance', () => {
  test('initializes, delivers, restarts SQLite and resumes the same thread', async () => {
    expect(await runV1AcceptanceGate()).toEqual({
      configInitialized: true,
      doctorPassed: true,
      updatesProcessed: 2,
      deliveriesProven: 2,
      threadPreservedAcrossRestart: true,
      databaseQuickCheck: 'ok',
    })
  })
})
