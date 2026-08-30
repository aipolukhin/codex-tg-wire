import type { Database } from 'bun:sqlite'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'

import type { AgentSandboxMode } from './contracts.js'
import type { ProjectDefinition, ProjectResolver } from './durable-session-coordinator.js'

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_PROJECTS = 100

interface RegisteredProjectRow {
  project_id: string
  cwd: string
  sandbox_mode: AgentSandboxMode | null
  writable_roots_json: string
  network_access: number | null
}

export type ProjectRegistrationResult =
  | { outcome: 'existing' | 'registered'; project: ProjectDefinition }
  | { outcome: 'disabled' | 'not_found' | 'ambiguous' | 'conflict' | 'invalid' | 'full'; details?: string }

export interface ProjectCatalog extends ProjectResolver {
  list(): readonly ProjectDefinition[]
  resolveOrRegister(input: string): Promise<ProjectRegistrationResult>
  readonly dynamicRegistrationEnabled: boolean
}

export interface DurableProjectCatalogOptions {
  staticProjects: readonly ProjectDefinition[]
  dynamicRegistrationEnabled?: boolean
  discoveryRoots?: readonly string[]
  dynamicDefaults?: Pick<ProjectDefinition, 'sandboxMode' | 'writableRoots' | 'networkAccess'>
  now?: () => number
}

function parseRoots(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
  } catch {
    return []
  }
}

function fromRow(row: RegisteredProjectRow): ProjectDefinition {
  return {
    id: row.project_id,
    cwd: row.cwd,
    ...(row.sandbox_mode === null ? {} : { sandboxMode: row.sandbox_mode }),
    writableRoots: parseRoots(row.writable_roots_json),
    ...(row.network_access === null ? {} : { networkAccess: row.network_access === 1 }),
  }
}

export class StaticProjectCatalog implements ProjectCatalog {
  readonly dynamicRegistrationEnabled = false
  private readonly projects: readonly ProjectDefinition[]
  private readonly byId: ReadonlyMap<string, ProjectDefinition>

  constructor(projects: readonly ProjectDefinition[]) {
    this.projects = [...projects]
    this.byId = new Map(projects.map((project) => [project.id, project]))
  }

  list(): readonly ProjectDefinition[] {
    return this.projects
  }

  resolve(projectId: string): ProjectDefinition | null {
    return this.byId.get(projectId) ?? null
  }

  async resolveOrRegister(input: string): Promise<ProjectRegistrationResult> {
    const project = this.resolve(input.trim())
    return project === null ? { outcome: 'disabled' } : { outcome: 'existing', project }
  }
}

export class DurableProjectCatalog implements ProjectCatalog {
  readonly dynamicRegistrationEnabled: boolean
  private readonly staticProjects: readonly ProjectDefinition[]
  private readonly staticById: ReadonlyMap<string, ProjectDefinition>
  private readonly discoveryRoots: readonly string[]
  private readonly defaults: Pick<ProjectDefinition, 'sandboxMode' | 'writableRoots' | 'networkAccess'>
  private readonly now: () => number

  constructor(
    private readonly database: Database,
    options: DurableProjectCatalogOptions,
  ) {
    this.staticProjects = [...options.staticProjects]
    this.staticById = new Map(this.staticProjects.map((project) => [project.id, project]))
    if (this.staticById.size !== this.staticProjects.length) {
      throw new TypeError('project catalog ids must be unique')
    }
    this.dynamicRegistrationEnabled = options.dynamicRegistrationEnabled ?? false
    this.discoveryRoots = [...new Set((options.discoveryRoots ?? []).map((root) => resolve(root)))]
    this.defaults = options.dynamicDefaults ?? {}
    this.now = options.now ?? Date.now
  }

  list(): readonly ProjectDefinition[] {
    const dynamic = this.database.query<RegisteredProjectRow, []>(
      'SELECT project_id, cwd, sandbox_mode, writable_roots_json, network_access FROM registered_projects ORDER BY created_at_ms, project_id',
    ).all()
    const seen = new Set(this.staticProjects.map((project) => project.id))
    const configuredPaths = new Set(this.staticProjects.map((project) => resolve(project.cwd)))
    return [
      ...this.staticProjects,
      ...dynamic
        .filter((row) => !seen.has(row.project_id) && !configuredPaths.has(resolve(row.cwd)))
        .map(fromRow),
    ]
  }

  resolve(projectId: string): ProjectDefinition | null {
    const configured = this.staticById.get(projectId)
    if (configured !== undefined) return configured
    const row = this.database.query<RegisteredProjectRow, [string]>(
      'SELECT project_id, cwd, sandbox_mode, writable_roots_json, network_access FROM registered_projects WHERE project_id = ?',
    ).get(projectId)
    return row === null ? null : fromRow(row)
  }

  async resolveOrRegister(input: string): Promise<ProjectRegistrationResult> {
    const requested = input.trim()
    if (requested.length === 0 || requested.length > 1_024 || requested.includes('\0')) {
      return { outcome: 'invalid' }
    }
    const existing = this.resolve(requested)
    if (existing !== null) return { outcome: 'existing', project: existing }
    if (!this.dynamicRegistrationEnabled) return { outcome: 'disabled' }
    const candidates = isAbsolute(requested)
      ? [requested]
      : this.discoveryRoots.map((root) => resolve(root, requested))
    const found = new Set<string>()
    for (const candidate of candidates) {
      try {
        const canonical = await realpath(candidate)
        if ((await stat(canonical)).isDirectory()) found.add(canonical)
      } catch {
        // Try the next deterministic discovery root.
      }
    }
    if (found.size === 0) return { outcome: 'not_found' }
    if (found.size > 1) return { outcome: 'ambiguous', details: [...found].join('\n') }

    const cwd = [...found][0]
    if (cwd === undefined) return { outcome: 'not_found' }
    const configuredPath = this.staticProjects.find((project) => resolve(project.cwd) === cwd)
    if (configuredPath !== undefined) return { outcome: 'existing', project: configuredPath }
    const byPath = this.database.query<RegisteredProjectRow, [string]>(
      'SELECT project_id, cwd, sandbox_mode, writable_roots_json, network_access FROM registered_projects WHERE cwd = ?',
    ).get(cwd)
    if (byPath !== null) return { outcome: 'existing', project: fromRow(byPath) }
    if (this.list().length >= MAX_PROJECTS) return { outcome: 'full' }

    const id = isAbsolute(requested) || requested.includes('/') || requested.includes('\\')
      ? basename(cwd)
      : requested
    if (!PROJECT_ID.test(id)) return { outcome: 'invalid', details: basename(cwd) }
    const collision = this.resolve(id)
    if (collision !== null) {
      return collision.cwd === cwd
        ? { outcome: 'existing', project: collision }
        : { outcome: 'conflict', details: `${id}: ${collision.cwd}` }
    }

    const nowMs = this.now()
    try {
      this.database.run(
        `INSERT INTO registered_projects
          (project_id, cwd, sandbox_mode, writable_roots_json, network_access,
           created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          cwd,
          this.defaults.sandboxMode ?? null,
          JSON.stringify(this.defaults.writableRoots ?? []),
          this.defaults.networkAccess === undefined ? null : this.defaults.networkAccess ? 1 : 0,
          nowMs,
          nowMs,
        ],
      )
    } catch {
      const raced = this.resolve(id)
      if (raced !== null && raced.cwd === cwd) return { outcome: 'existing', project: raced }
      return { outcome: 'conflict', details: id }
    }
    const project = this.resolve(id)
    if (project === null) throw new Error(`registered project ${id} was not persisted`)
    return { outcome: 'registered', project }
  }
}
