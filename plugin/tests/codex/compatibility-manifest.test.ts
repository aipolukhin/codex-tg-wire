import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import compatibility from '../../codex-app-server.compatibility.json'
import pkg from '../../package.json'

const ROOT = join(import.meta.dir, '../..')

describe('standalone bridge compatibility manifest', () => {
  test('pins v1 bridge, Bun and one supported Codex schema', () => {
    expect(compatibility.formatVersion).toBe(1)
    expect(compatibility.bridgeVersion).toMatch(/^1\.0\.\d+$/)
    expect(pkg.packageManager).toBe(`bun@${compatibility.bunVersion}`)
    expect(compatibility.matrix).toContainEqual({
      bridge: '1.0.x',
      codexCli: compatibility.codexCliVersion,
      bun: '1.4.x',
      appServerTransport: 'stdio',
      status: 'supported',
    })
  })

  test('uses bridgeVersion for standalone identity and release names', async () => {
    const release = await Bun.file(join(ROOT, 'scripts/build-release-artifacts.ts')).text()
    const service = await Bun.file(join(ROOT, 'src/bridge/durable-service.ts')).text()
    const smoke = await Bun.file(join(ROOT, 'scripts/codex-app-server-smoke.ts')).text()
    const compose = await Bun.file(join(ROOT, 'deploy/docker/compose.yaml')).text()

    expect(release).toContain('dashi-codex-bridge-${compatibility.bridgeVersion}')
    expect(service).toContain('version: compatibility.bridgeVersion')
    expect(smoke).toContain('version: compatibility.bridgeVersion')
    expect(compose).toContain(`dashi-codex-bridge:${compatibility.bridgeVersion}`)
  })

  test('keeps the human matrix synchronized with the manifest', async () => {
    const documentation = await Bun.file(join(ROOT, 'docs/codex-compatibility.md')).text()
    expect(documentation).toContain(`\`1.0.x\` | \`${compatibility.codexCliVersion}\` | \`1.4.x\``)
    expect(documentation).toContain(compatibility.schemaSha256)
  })
})
