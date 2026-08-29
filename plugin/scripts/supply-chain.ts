#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PackageJson {
  name?: unknown
  version?: unknown
  license?: unknown
  dependencies?: unknown
  optionalDependencies?: unknown
  devDependencies?: unknown
}

interface InstalledPackage {
  name: string
  version: string
  license: string
  directory: string
  packageJsonPath: string
  dependencies: string[]
}

const ALLOWED_LICENSES = new Set([
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'Python-2.0',
])

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function readPackage(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
}

function packageLicense(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string'
  ) {
    return (value as { type: string }).type.trim()
  }
  return '<missing>'
}

function packageDirectories(nodeModules: string): string[] {
  if (!existsSync(nodeModules)) return []
  const directories: string[] = []
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isDirectory()) directories.push(join(path, scoped.name))
      }
    } else {
      directories.push(path)
    }
  }
  return directories
}

export function collectInstalledPackages(root = PLUGIN_ROOT): InstalledPackage[] {
  const found = new Map<string, InstalledPackage>()
  const visitedNodeModules = new Set<string>()
  const walk = (nodeModules: string): void => {
    if (visitedNodeModules.has(nodeModules)) return
    visitedNodeModules.add(nodeModules)
    for (const directory of packageDirectories(nodeModules)) {
      const packageJsonPath = join(directory, 'package.json')
      if (!existsSync(packageJsonPath) || !statSync(packageJsonPath).isFile()) continue
      const parsed = readPackage(packageJsonPath)
      if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') continue
      const key = `${parsed.name}@${parsed.version}`
      if (!found.has(key)) {
        found.set(key, {
          name: parsed.name,
          version: parsed.version,
          license: packageLicense(parsed.license),
          directory,
          packageJsonPath,
          dependencies: [
            ...Object.keys(stringMap(parsed.dependencies)),
            ...Object.keys(stringMap(parsed.optionalDependencies)),
          ].sort(),
        })
      }
      walk(join(directory, 'node_modules'))
    }
  }
  walk(join(root, 'node_modules'))
  return [...found.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )
}

function packageRef(item: Pick<InstalledPackage, 'name' | 'version'>): string {
  return `pkg:npm/${item.name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(item.version)}`
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertLicenses(packages: readonly InstalledPackage[]): void {
  const violations = packages.filter((item) => !ALLOWED_LICENSES.has(item.license))
  if (violations.length > 0) {
    throw new Error(
      `dependency license gate failed:\n${violations.map((item) => `- ${item.name}@${item.version}: ${item.license}`).join('\n')}`,
    )
  }
}

function directDependencyNames(rootPackage: PackageJson): string[] {
  return [
    ...Object.keys(stringMap(rootPackage.dependencies)),
    ...Object.keys(stringMap(rootPackage.optionalDependencies)),
    ...Object.keys(stringMap(rootPackage.devDependencies)),
  ].sort()
}

export function createCycloneDxBom(root = PLUGIN_ROOT): Record<string, unknown> {
  const rootPath = join(root, 'package.json')
  const rootPackage = readPackage(rootPath)
  if (typeof rootPackage.name !== 'string' || typeof rootPackage.version !== 'string') {
    throw new Error('root package requires name and version')
  }
  const packages = collectInstalledPackages(root)
  assertLicenses(packages)
  const byName = new Map<string, InstalledPackage[]>()
  for (const item of packages) {
    const list = byName.get(item.name) ?? []
    list.push(item)
    byName.set(item.name, list)
  }
  const rootRef = `pkg:npm/${encodeURIComponent(rootPackage.name)}@${encodeURIComponent(rootPackage.version)}`
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      tools: [{ vendor: 'Oven', name: 'Bun', version: Bun.version }],
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: rootPackage.name,
        version: rootPackage.version,
        licenses: [{ expression: packageLicense(rootPackage.license) }],
        hashes: [{ alg: 'SHA-256', content: sha256(rootPath) }],
      },
    },
    components: packages.map((item) => ({
      type: 'library',
      'bom-ref': packageRef(item),
      name: item.name,
      version: item.version,
      purl: packageRef(item),
      licenses: [{ expression: item.license }],
      hashes: [{ alg: 'SHA-256', content: sha256(item.packageJsonPath) }],
    })),
    dependencies: [
      {
        ref: rootRef,
        dependsOn: directDependencyNames(rootPackage)
          .flatMap((name) => byName.get(name)?.slice(0, 1) ?? [])
          .map(packageRef)
          .sort(),
      },
      ...packages.map((item) => ({
        ref: packageRef(item),
        dependsOn: item.dependencies
          .flatMap((name) => byName.get(name)?.slice(0, 1) ?? [])
          .map(packageRef)
          .sort(),
      })),
    ],
  }
}

function usage(): never {
  process.stderr.write('Usage: bun run scripts/supply-chain.ts --check | --sbom <output.json>\n')
  process.exit(2)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const packages = collectInstalledPackages()
  if (args.length === 1 && args[0] === '--check') {
    assertLicenses(packages)
    process.stdout.write(`Dependency license gate passed (${packages.length} packages).\n`)
  } else if (args.length === 2 && args[0] === '--sbom' && args[1] !== undefined) {
    const output = resolve(args[1])
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
    writeFileSync(output, `${JSON.stringify(createCycloneDxBom(), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    process.stdout.write(`CycloneDX SBOM created: ${output}\n`)
  } else {
    usage()
  }
}
