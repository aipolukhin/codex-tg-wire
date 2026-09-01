import { existsSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

import {
  ProductDecisionRegistry,
  ProductHomeRegistryError,
} from './decision-registry.js'
import {
  ProductHomeAuthError,
  telegramInitDataFromRequest,
  verifyTelegramInitData,
} from './auth.js'

export interface ProductHomeServerLogger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
}

export interface ProductHomeServerOptions {
  host: string
  port: number
  publicUrl: string
  staticDirectory: string
  repositoryPath: string
  telegramToken: string
  allowedUserIds: readonly (string | number)[]
  initDataMaxAgeSeconds: number
  logger?: ProductHomeServerLogger
  nowMs?: () => number
}

interface BunServerHandle {
  stop(closeActiveConnections?: boolean): void
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

const STATIC_SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'none'",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join('; '),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function normalizedBasePath(publicUrl: string): string {
  const parsed = new URL(publicUrl)
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return pathname.length === 0 ? '/' : `${pathname}/`
}

function validView(value: string | null): 'all' | 'active' | 'review' | 'superseded' {
  if (value === null || value === 'all') return 'all'
  if (value === 'active' || value === 'review' || value === 'superseded') return value
  throw new TypeError('invalid decision view')
}

export class ProductHomeApplication {
  private readonly registry: ProductDecisionRegistry
  private readonly staticRoot: string
  private readonly basePath: string
  private readonly nowMs: () => number

  constructor(private readonly options: ProductHomeServerOptions) {
    this.staticRoot = resolve(options.staticDirectory)
    this.basePath = normalizedBasePath(options.publicUrl)
    this.nowMs = options.nowMs ?? Date.now
    this.registry = new ProductDecisionRegistry({
      repositoryPath: options.repositoryPath,
      nowMs: this.nowMs,
    })
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'method_not_allowed' })
    }
    if (!url.pathname.startsWith(this.basePath)) return json(404, { error: 'not_found' })
    const relativePath = url.pathname.slice(this.basePath.length)
    if (relativePath === 'api/v1/health') return json(200, { ok: true })
    if (relativePath.startsWith('api/')) return await this.handleApi(request, url, relativePath)
    return await this.staticResponse(relativePath, request.method === 'HEAD')
  }

  private authenticate(request: Request): void {
    const rawInitData = telegramInitDataFromRequest(request)
    verifyTelegramInitData(rawInitData, {
      botToken: this.options.telegramToken,
      allowedUserIds: this.options.allowedUserIds,
      maxAgeSeconds: this.options.initDataMaxAgeSeconds,
      nowMs: this.nowMs(),
    })
  }

  private async handleApi(request: Request, url: URL, relativePath: string): Promise<Response> {
    try {
      this.authenticate(request)
      if (relativePath === 'api/v1/domains') {
        const snapshot = await this.registry.snapshot()
        return json(200, { domains: snapshot.domains, stats: snapshot.stats })
      }
      if (relativePath === 'api/v1/decisions') {
        const query = url.searchParams.get('query')?.trim() ?? ''
        if (query.length > 200) return json(400, { error: 'query_too_long' })
        const domain = url.searchParams.get('domain')?.trim() || undefined
        const view = validView(url.searchParams.get('view'))
        const result = await this.registry.list({
          query,
          ...(domain === undefined ? {} : { domain }),
          view,
        })
        return json(200, {
          decisions: result.decisions,
          total: result.decisions.length,
          domains: result.snapshot.domains,
          stats: result.snapshot.stats,
        })
      }
      const detail = relativePath.match(/^api\/v1\/decisions\/(PD-[A-Z]{2,4}-\d{4})$/)
      if (detail?.[1] !== undefined) {
        const decision = await this.registry.get(detail[1])
        return decision === null
          ? json(404, { error: 'decision_not_found' })
          : json(200, { decision })
      }
      return json(404, { error: 'not_found' })
    } catch (error) {
      if (error instanceof ProductHomeAuthError) return json(401, { error: 'unauthorized' })
      if (error instanceof TypeError) return json(400, { error: 'bad_request' })
      this.options.logger?.warn('Product Home request failed', {
        kind: error instanceof ProductHomeRegistryError ? 'registry' : 'unexpected',
      })
      return json(500, { error: 'product_home_unavailable' })
    }
  }

  private async staticResponse(relativePath: string, head: boolean): Promise<Response> {
    let decoded: string
    try {
      decoded = decodeURIComponent(relativePath)
    } catch {
      return json(400, { error: 'bad_request' })
    }
    if (decoded.includes('\0') || decoded.split('/').some((part) => part === '..')) {
      return json(404, { error: 'not_found' })
    }
    const requested = decoded.length === 0 ? 'index.html' : decoded
    let path = resolve(this.staticRoot, requested)
    if (path !== this.staticRoot && !path.startsWith(`${this.staticRoot}${sep}`)) {
      return json(404, { error: 'not_found' })
    }
    let file = Bun.file(path)
    if (!(await file.exists()) || extname(path).length === 0) {
      path = resolve(this.staticRoot, 'index.html')
      file = Bun.file(path)
    }
    if (!(await file.exists())) return json(503, { error: 'product_home_not_built' })
    const extension = extname(path).toLowerCase()
    const immutable = path.includes(`${sep}assets${sep}`)
    const headers = {
      ...STATIC_SECURITY_HEADERS,
      'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'cache-control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    }
    return new Response(head ? null : file, { status: 200, headers })
  }
}

export class ProductHomeServer {
  private server: BunServerHandle | null = null
  private readonly application: ProductHomeApplication

  constructor(private readonly options: ProductHomeServerOptions) {
    this.application = new ProductHomeApplication(options)
  }

  start(): void {
    if (this.server !== null) throw new Error('Product Home server is already started')
    if (!existsSync(resolve(this.options.staticDirectory, 'index.html'))) {
      throw new Error('Product Home frontend build is missing')
    }
    if (!existsSync(resolve(this.options.repositoryPath, 'docs', 'product'))) {
      throw new Error('Product Home decision repository is missing')
    }
    this.server = Bun.serve({
      hostname: this.options.host,
      port: this.options.port,
      fetch: (request) => this.application.handle(request),
    })
    this.options.logger?.info('Product Home server started', {
      host: this.options.host,
      port: this.options.port,
      basePath: normalizedBasePath(this.options.publicUrl),
    })
  }

  stop(): void {
    this.server?.stop(true)
    this.server = null
  }
}
