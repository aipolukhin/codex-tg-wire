import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import {
  collectInstalledPackages,
  createCycloneDxBom,
} from '../../scripts/supply-chain.js'

const PLUGIN_ROOT = resolve(import.meta.dir, '../..')

describe('Codex release supply chain', () => {
  test('collects installed packages with explicit allowlisted licenses', () => {
    const packages = collectInstalledPackages(PLUGIN_ROOT)
    expect(packages.length).toBeGreaterThan(100)
    expect(packages.every((item) => item.name.length > 0 && item.version.length > 0)).toBeTrue()
    expect(packages.every((item) => item.license !== '<missing>')).toBeTrue()
  })

  test('generates CycloneDX without local paths or operator fingerprints', () => {
    const bom = createCycloneDxBom(PLUGIN_ROOT)
    const serialized = JSON.stringify(bom)
    expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 })
    expect(serialized).not.toContain(PLUGIN_ROOT)
    expect(serialized).not.toContain('/home/')
    expect(serialized).not.toContain(['vpn', 'ops'].join(''))
    const refs = (bom.components as Array<{ 'bom-ref': string }>).map((item) => item['bom-ref'])
    expect(new Set(refs).size).toBe(refs.length)
  })
})
