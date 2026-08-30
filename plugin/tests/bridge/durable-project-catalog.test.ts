import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { openDurableDatabase } from '../../src/durable/database.js'
import { DurableProjectCatalog } from '../../src/bridge/durable-project-catalog.js'

let root: string
let database: Database

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-projects-'))
  database = openDurableDatabase(':memory:')
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function catalog(enabled = true): DurableProjectCatalog {
  const main = join(root, 'codex-workspace')
  mkdirSync(main, { recursive: true })
  return new DurableProjectCatalog(database, {
    staticProjects: [{ id: 'main', cwd: main, sandboxMode: 'danger-full-access' }],
    dynamicRegistrationEnabled: enabled,
    discoveryRoots: [root],
    dynamicDefaults: {
      sandboxMode: 'danger-full-access',
      writableRoots: [],
      networkAccess: true,
    },
    now: () => 1_800_000_000_000,
  })
}

describe('DurableProjectCatalog', () => {
  test('discovers a sibling project by id and restores it from SQLite', async () => {
    const target = join(root, 'vpn-infra')
    mkdirSync(target)
    const projects = catalog()

    expect(await projects.resolveOrRegister('vpn-infra')).toEqual({
      outcome: 'registered',
      project: {
        id: 'vpn-infra',
        cwd: target,
        sandboxMode: 'danger-full-access',
        writableRoots: [],
        networkAccess: true,
      },
    })

    const restored = catalog()
    expect(restored.resolve('vpn-infra')?.cwd).toBe(target)
    expect(restored.list().map((project) => project.id)).toEqual(['main', 'vpn-infra'])
  })

  test('accepts an absolute directory in YOLO mode', async () => {
    const elsewhere = join(root, 'nested', 'operations')
    mkdirSync(elsewhere, { recursive: true })

    const result = await catalog().resolveOrRegister(elsewhere)
    expect(result.outcome).toBe('registered')
    if (result.outcome === 'registered') {
      expect(result.project.id).toBe('operations')
      expect(result.project.cwd).toBe(elsewhere)
    }
  })

  test('does not discover unconfigured projects outside YOLO mode', async () => {
    mkdirSync(join(root, 'vpn-infra'))
    expect(await catalog(false).resolveOrRegister('vpn-infra')).toEqual({ outcome: 'disabled' })
  })

  test('rejects id collisions instead of silently changing cwd', async () => {
    const first = join(root, 'first', 'shared')
    const second = join(root, 'second', 'shared')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    const projects = catalog()
    expect((await projects.resolveOrRegister(first)).outcome).toBe('registered')
    const result = await projects.resolveOrRegister(second)
    expect(result.outcome).toBe('conflict')
    expect(projects.resolve('shared')?.cwd).toBe(first)
  })
})
