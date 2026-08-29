// TASK-4 — PreToolUse hook wrapper for AskUserQuestion.
//
// Three layers of coverage:
//   1. Pure `buildAskRequest` — validates env handling, skip/error split,
//      and the body shape posted to the plugin.
//   2. Pure `decisionFromPluginResponse` + `renderDecision` — locks the
//      stdout JSON contract for every response status.
//   3. End-to-end — spawn the real wrapper via `bun`, point it at an
//      ephemeral Bun.serve() mock plugin, and assert exit code, stdout,
//      and stderr for each status (answered / pass_through / timeout /
//      503 / ECONNREFUSED).

import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'path'

import {
  buildAskRequest,
  decisionFromPluginResponse,
  isConnectionRefused,
  renderDecision,
  validateLoopbackUrl,
  type AskHookRequest,
} from '../../scripts/ask-user-question-hook.js'

const PLUGIN_DIR = join(import.meta.dir, '..', '..')
const HOOK_SCRIPT = join(PLUGIN_DIR, 'scripts', 'ask-user-question-hook.ts')
const TOKEN = 'unit-test-bearer-token'

function preToolUseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_abc',
    tool_input: {
      questions: [
        {
          question: 'Which framework?',
          header: 'Choose one',
          multiSelect: false,
          options: [{ label: 'React' }, { label: 'Vue' }],
        },
      ],
    },
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 1 — buildAskRequest
// ─────────────────────────────────────────────────────────────────────────

describe('buildAskRequest', () => {
  test('builds POST with bearer + JSON body containing questions', () => {
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/hooks/ask-user-question/request',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: preToolUseEnvelope(),
    })
    expect('kind' in result).toBe(false)
    if ('kind' in result) throw new Error('unreachable')
    expect(result.url).toBe('http://127.0.0.1:8093/hooks/ask-user-question/request')
    expect(result.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(result.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(result.body) as Record<string, unknown>
    expect(body.session_id).toBe('sess-1')
    expect(body.tool_use_id).toBe('toolu_abc')
    expect(body.transcript_path).toBe('/tmp/transcript.jsonl')
    expect(body.timeout_ms).toBe(300_000)
    expect(Array.isArray(body.questions)).toBe(true)
    // Wrapper's own HTTP timeout exceeds the config timeout so the plugin
    // gets a chance to emit its own `timeout` status before fetch aborts.
    expect(result.httpTimeoutMs).toBeGreaterThan(300_000)
  })

  test('ASK_USER_QUESTION_TIMEOUT_MS overrides default', () => {
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
        ASK_USER_QUESTION_TIMEOUT_MS: '60000',
      },
      hook: preToolUseEnvelope(),
    })
    if ('kind' in result) throw new Error('unreachable')
    const body = JSON.parse(result.body) as { timeout_ms: number }
    expect(body.timeout_ms).toBe(60_000)
    expect(result.httpTimeoutMs).toBe(65_000)
  })

  test('invalid ASK_USER_QUESTION_TIMEOUT_MS falls back to default', () => {
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
        ASK_USER_QUESTION_TIMEOUT_MS: 'not-a-number',
      },
      hook: preToolUseEnvelope(),
    })
    if ('kind' in result) throw new Error('unreachable')
    const body = JSON.parse(result.body) as { timeout_ms: number }
    expect(body.timeout_ms).toBe(300_000)
  })

  test('missing TELEGRAM_WEBHOOK_URL → error', () => {
    const result = buildAskRequest({
      env: { TELEGRAM_WEBHOOK_TOKEN: TOKEN },
      hook: preToolUseEnvelope(),
    })
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.reason).toContain('TELEGRAM_WEBHOOK_URL')
  })

  test('missing TELEGRAM_WEBHOOK_TOKEN → error', () => {
    const result = buildAskRequest({
      env: { TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/x' },
      hook: preToolUseEnvelope(),
    })
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.kind).toBe('error')
  })

  test('tool_name !== AskUserQuestion → skip (no-op)', () => {
    const result = buildAskRequest({
      env: { TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/x', TELEGRAM_WEBHOOK_TOKEN: TOKEN },
      hook: preToolUseEnvelope({ tool_name: 'Bash' }),
    })
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.kind).toBe('skip')
  })

  test('hook_event_name !== PreToolUse → skip', () => {
    const result = buildAskRequest({
      env: { TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/x', TELEGRAM_WEBHOOK_TOKEN: TOKEN },
      hook: preToolUseEnvelope({ hook_event_name: 'PostToolUse' }),
    })
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.kind).toBe('skip')
  })

  test('missing tool_input.questions → skip', () => {
    const result = buildAskRequest({
      env: { TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/x', TELEGRAM_WEBHOOK_TOKEN: TOKEN },
      hook: preToolUseEnvelope({ tool_input: { questions: [] } }),
    })
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.kind).toBe('skip')
  })

  test('bearer token never echoed into body', () => {
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/x',
        TELEGRAM_WEBHOOK_TOKEN: 'super-secret-bearer',
      },
      hook: preToolUseEnvelope(),
    })
    if ('kind' in result) throw new Error('unreachable')
    expect(result.body).not.toContain('super-secret-bearer')
    expect(result.headers.Authorization).toBe('Bearer super-secret-bearer')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Layer 2 — decisionFromPluginResponse + renderDecision
// ─────────────────────────────────────────────────────────────────────────

describe('decisionFromPluginResponse', () => {
  test('answered + updatedInput → allow', () => {
    const updatedInput = {
      questions: [{ question: 'Which framework?' }],
      answers: { 'Which framework?': 'React' },
    }
    const decision = decisionFromPluginResponse({ status: 'answered', updatedInput })
    expect(decision.kind).toBe('allow')
    if (decision.kind !== 'allow') throw new Error('unreachable')
    expect(decision.updatedInput).toEqual(updatedInput)
  })

  test('answered without updatedInput → deny (refuse unverified input)', () => {
    const decision = decisionFromPluginResponse({ status: 'answered' })
    expect(decision.kind).toBe('deny')
  })

  test('pass_through → passthrough (empty stdout)', () => {
    const decision = decisionFromPluginResponse({ status: 'pass_through' })
    expect(decision.kind).toBe('passthrough')
  })

  test('timeout → deny with explicit reason', () => {
    const decision = decisionFromPluginResponse({ status: 'timeout' })
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('unreachable')
    expect(decision.reason).toContain('timed out')
  })

  test('unknown status → deny (surface for ops)', () => {
    const decision = decisionFromPluginResponse({ status: 'weird' })
    expect(decision.kind).toBe('deny')
  })
})

describe('renderDecision', () => {
  test('passthrough → empty string', () => {
    expect(renderDecision({ kind: 'passthrough' })).toBe('')
  })

  test('allow → hookSpecificOutput allow + updatedInput', () => {
    const updatedInput = {
      questions: [{ question: 'Q?' }],
      answers: { 'Q?': 'A' },
    }
    const out = JSON.parse(renderDecision({ kind: 'allow', updatedInput }))
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput,
      },
    })
  })

  test('deny → hookSpecificOutput deny + permissionDecisionReason', () => {
    const out = JSON.parse(renderDecision({ kind: 'deny', reason: 'oops' }))
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'oops',
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Layer 3 — end-to-end against a mock Bun.serve plugin.
// ─────────────────────────────────────────────────────────────────────────

type ServerFactory = (req: Request) => Response | Promise<Response>

function startMockPlugin(handler: ServerFactory): { url: string; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => handler(req),
  })
  return {
    url: `http://127.0.0.1:${server.port}/hooks/ask-user-question/request`,
    close: async () => {
      server.stop(true)
    },
  }
}

async function runHook(opts: {
  url: string | null
  stdin: unknown
  timeoutMs?: number
}): Promise<{ code: number; stdout: string; stderr: string }> {
  // Use Bun.spawn over child_process.spawnSync: spawnSync inside `bun test`
  // deadlocks stdin/stdout pipes for any child that takes more than a few
  // ms to start (Bun bug — sync API doesn't drain its pipes properly under
  // the test runner). Bun.spawn is the documented Bun-native path.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TELEGRAM_WEBHOOK_TOKEN: TOKEN,
  }
  if (opts.url) {
    env.TELEGRAM_WEBHOOK_URL = opts.url
    // FIX-T1 F1 (Phase 5): the hook now enforces a loopback-port
    // allowlist. End-to-end tests bind Bun.serve to port 0 (random
    // ephemeral port); thread that port through TELEGRAM_WEBHOOK_PORT
    // so validateLoopbackUrl accepts it.
    try {
      const parsed = new URL(opts.url)
      if (parsed.port) env.TELEGRAM_WEBHOOK_PORT = parsed.port
    } catch {
      /* invalid URL — leave env empty, hook will reject */
    }
  } else {
    delete env.TELEGRAM_WEBHOOK_URL
  }
  if (opts.timeoutMs !== undefined) {
    env.ASK_USER_QUESTION_TIMEOUT_MS = String(opts.timeoutMs)
  }
  const bunBin =
    process.env.BUN_INSTALL_BIN ?? join(process.env.HOME ?? '', '.bun', 'bin')
  env.PATH = `${bunBin}:${process.env.PATH ?? ''}`

  const proc = Bun.spawn(['bun', HOOK_SCRIPT], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  proc.stdin.write(JSON.stringify(opts.stdin))
  await proc.stdin.end()
  const code = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code, stdout, stderr }
}

describe('ask-user-question-hook.ts — end-to-end', () => {
  let mock: { url: string; close: () => Promise<void> } | null = null

  afterEach(async () => {
    if (mock) {
      await mock.close()
      mock = null
    }
  })

  test('answered → exit 0 with allow + updatedInput stdout', async () => {
    const updatedInput = {
      questions: [{ question: 'Which framework?' }],
      answers: { 'Which framework?': 'React' },
    }
    mock = startMockPlugin(async (req) => {
      expect(req.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      const body = (await req.json()) as Record<string, unknown>
      expect(body.tool_use_id).toBe('toolu_abc')
      return Response.json({ status: 'answered', updatedInput })
    })
    const r = await runHook({ url: mock.url, stdin: preToolUseEnvelope() })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.updatedInput).toEqual(updatedInput)
  })

  test('pass_through → exit 0 with empty stdout', async () => {
    mock = startMockPlugin(() => Response.json({ status: 'pass_through' }))
    const r = await runHook({ url: mock.url, stdin: preToolUseEnvelope() })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('timeout → exit 0 with deny + clear reason', async () => {
    mock = startMockPlugin(() => Response.json({ status: 'timeout' }))
    const r = await runHook({ url: mock.url, stdin: preToolUseEnvelope() })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('timed out')
  })

  test('503 error from plugin → exit 0 with deny', async () => {
    mock = startMockPlugin(() => new Response('upstream down', { status: 503 }))
    const r = await runHook({ url: mock.url, stdin: preToolUseEnvelope() })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('503')
  })

  test('plugin unreachable (ECONNREFUSED) → exit 0 empty stdout (fallback)', async () => {
    // Pick a port we know is closed: spin up Bun.serve, capture its port,
    // then stop it before invoking the hook so the connect attempt is
    // refused. This is more reliable than guessing a free port.
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
    const deadUrl = `http://127.0.0.1:${probe.port}/hooks/ask-user-question/request`
    probe.stop(true)
    const r = await runHook({ url: deadUrl, stdin: preToolUseEnvelope() })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('non-AskUserQuestion tool → exit 0 empty stdout (other matchers untouched)', async () => {
    // Endpoint MUST NOT be hit; we wire it to fail loudly so the test fails
    // if the wrapper accidentally posts.
    mock = startMockPlugin(() => {
      throw new Error('endpoint should not be reached for non-AskUserQuestion tools')
    })
    const r = await runHook({
      url: mock.url,
      stdin: preToolUseEnvelope({ tool_name: 'Bash' }),
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('answered without updatedInput → deny (refuse unverified)', async () => {
    mock = startMockPlugin(() => Response.json({ status: 'answered' }))
    const r = await runHook({ url: mock.url, stdin: preToolUseEnvelope() })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  test('malformed JSON response → deny', async () => {
    mock = startMockPlugin(() => new Response('not-json', { status: 200 }))
    const r = await runHook({ url: mock.url, stdin: preToolUseEnvelope() })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  test('empty stdin → exit 0 no stdout (no payload to forward)', async () => {
    // runHook always JSON.stringify's stdin; pass an empty string here by
    // using a small helper that bypasses the JSON encoding.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:1',
      TELEGRAM_WEBHOOK_TOKEN: TOKEN,
    }
    const bunBin =
      process.env.BUN_INSTALL_BIN ?? join(process.env.HOME ?? '', '.bun', 'bin')
    env.PATH = `${bunBin}:${process.env.PATH ?? ''}`
    const proc = Bun.spawn(['bun', HOOK_SCRIPT], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })
    await proc.stdin.end()
    const code = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  test('bearer token never leaked to stderr on error path', async () => {
    // Use a stale-port deadUrl so we hit the connection-refused path. Even
    // though that branch is silent, double-check no token leaks if the
    // wrapper's warn() ever fires for this input.
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
    const deadUrl = `http://127.0.0.1:${probe.port}/hooks/ask-user-question/request`
    probe.stop(true)
    const r = await runHook({ url: deadUrl, stdin: preToolUseEnvelope() })
    expect(r.stderr).not.toContain(TOKEN)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Smoke test for the AskHookRequest type — keeps the export visible so
// downstream consumers can rely on the shape.
// ─────────────────────────────────────────────────────────────────────────

describe('AskHookRequest shape', () => {
  test('exported and has expected fields', () => {
    const result = buildAskRequest({
      env: { TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/x', TELEGRAM_WEBHOOK_TOKEN: TOKEN },
      hook: preToolUseEnvelope(),
    })
    if ('kind' in result) throw new Error('unreachable')
    // Type assertion: result is AskHookRequest at compile time.
    const req: AskHookRequest = result
    expect(typeof req.url).toBe('string')
    expect(typeof req.body).toBe('string')
    expect(typeof req.httpTimeoutMs).toBe('number')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// FIX-T1 F1 (PRX-1 Phase 5, 2026-05-27) — loopback-only egress guard.
//
// The wrapper ships bearer + prompt to TELEGRAM_WEBHOOK_URL. A misconfigured
// remote URL would exfiltrate both. validateLoopbackUrl is the gate:
//   - http scheme only (TLS would imply remote CA path)
//   - hostname in {127.0.0.1, localhost, [::1], ::1}
//   - port in PORT_HARD_WHITELIST OR matches TELEGRAM_WEBHOOK_PORT env
// On failure: buildAskRequest returns `error` so main() exits 0 with empty
// stdout (graceful fallback to native UI), warns to stderr (no token leak).
// ─────────────────────────────────────────────────────────────────────────

describe('validateLoopbackUrl — F1 egress guard', () => {
  test('allows http://127.0.0.1:8093 (default port in hard whitelist)', () => {
    const r = validateLoopbackUrl('http://127.0.0.1:8093/hooks/x', {})
    expect(r.ok).toBe(true)
  })

  test('allows localhost variant on whitelisted port', () => {
    const r = validateLoopbackUrl('http://localhost:8093/hooks/x', {})
    expect(r.ok).toBe(true)
  })

  test('allows IPv6 loopback [::1]', () => {
    const r = validateLoopbackUrl('http://[::1]:8093/hooks/x', {})
    expect(r.ok).toBe(true)
  })

  test('allows env-configured port via TELEGRAM_WEBHOOK_PORT', () => {
    const r = validateLoopbackUrl('http://127.0.0.1:55123/hooks/x', {
      TELEGRAM_WEBHOOK_PORT: '55123',
    })
    expect(r.ok).toBe(true)
  })

  test('rejects remote hostname (exfiltration vector)', () => {
    const r = validateLoopbackUrl('http://attacker.example.com:8093/hooks/x', {})
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('host not loopback')
  })

  test('rejects public IP that resembles loopback prefix', () => {
    const r = validateLoopbackUrl('http://1.2.3.4:8093/hooks/x', {})
    expect(r.ok).toBe(false)
  })

  test('rejects https (TLS implies non-loopback)', () => {
    const r = validateLoopbackUrl('https://127.0.0.1:8093/hooks/x', {})
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('http')
  })

  test('rejects port outside hard whitelist when env override absent', () => {
    const r = validateLoopbackUrl('http://127.0.0.1:9999/hooks/x', {})
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('port')
  })

  test('rejects missing port (ambiguity with reverse proxy)', () => {
    const r = validateLoopbackUrl('http://127.0.0.1/hooks/x', {})
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('port')
  })

  test('rejects malformed URL', () => {
    const r = validateLoopbackUrl('not-a-url', {})
    expect(r.ok).toBe(false)
  })

  test('rejects file:// scheme', () => {
    const r = validateLoopbackUrl('file:///etc/passwd', {})
    expect(r.ok).toBe(false)
  })
})

describe('buildAskRequest — F1 loopback gate integration', () => {
  test('remote URL → error kind with reason; main path produces empty stdout', () => {
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://evil.example.com:8093/hooks/x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: preToolUseEnvelope(),
    })
    if (!('kind' in result)) throw new Error('expected error kind')
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') throw new Error('unreachable')
    expect(result.reason).toContain('loopback gate')
  })

  test('localhost OK → passes through to AskHookRequest', () => {
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093/hooks/x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: preToolUseEnvelope(),
    })
    if ('kind' in result) throw new Error('expected AskHookRequest')
    expect(result.url).toBe('http://127.0.0.1:8093/hooks/x')
  })

  test('port outside allowlist → error kind', () => {
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:31337/hooks/x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: preToolUseEnvelope(),
    })
    if (!('kind' in result)) throw new Error('expected error kind')
    expect(result.kind).toBe('error')
  })

  test('non-AskUserQuestion tool still skips silently even with bad URL (no warn spam on Bash)', () => {
    // The loopback gate runs AFTER tool_name filtering so a misconfigured URL
    // does not trigger a warn on every Bash call. Verify by passing Bash with
    // a remote URL: result must be `skip` (the tool_name skip), not `error`.
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://evil.example.com:8093/hooks/x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: preToolUseEnvelope({ tool_name: 'Bash' }),
    })
    if (!('kind' in result)) throw new Error('expected skip kind')
    expect(result.kind).toBe('skip')
  })

  test('bearer token never leaks into the loopback-reject reason', () => {
    const result = buildAskRequest({
      env: {
        TELEGRAM_WEBHOOK_URL: 'http://evil.example.com:8093/hooks/x',
        TELEGRAM_WEBHOOK_TOKEN: 'super-secret-bearer-VALUE',
      },
      hook: preToolUseEnvelope(),
    })
    if (!('kind' in result) || result.kind !== 'error') {
      throw new Error('expected error kind')
    }
    expect(result.reason).not.toContain('super-secret-bearer-VALUE')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// FIX-T2 F1 — isConnectionRefused narrowing.
// The pre-fix detection matched 'Failed to fetch' / 'Unable to connect'
// substrings, which Node-undici raises for mid-flight failures (TLS
// handshake, post-connect socket reset). Misclassifying those as
// "endpoint unreachable" leads to a silent fallback to native UI AFTER
// the plugin has already sent a Telegram prompt — double prompt.
// The new detection inspects err.cause.code === 'ECONNREFUSED' only.
// ─────────────────────────────────────────────────────────────────────────

describe('isConnectionRefused — FIX-T2 F1', () => {
  test('returns true for node-undici style ECONNREFUSED', () => {
    const err = new TypeError('fetch failed')
    ;(err as { cause?: unknown }).cause = { code: 'ECONNREFUSED', errno: -111 }
    expect(isConnectionRefused(err)).toBe(true)
  })

  test('returns true for direct err.code === ECONNREFUSED', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:1') as Error & { code?: string }
    err.code = 'ECONNREFUSED'
    expect(isConnectionRefused(err)).toBe(true)
  })

  test('returns true for Bun ConnectionRefused name', () => {
    const err = new TypeError('Unable to connect') as TypeError & { name: string }
    err.name = 'ConnectionRefused'
    expect(isConnectionRefused(err)).toBe(true)
  })

  test('returns FALSE for generic "Failed to fetch" with no structured code', () => {
    // Mid-flight failure: connection accepted, then dropped. The plugin
    // has likely already sent a TG prompt. Must NOT match — caller falls
    // to the deny path so the operator is not prompted twice.
    const err = new TypeError('Failed to fetch')
    expect(isConnectionRefused(err)).toBe(false)
  })

  test('returns FALSE for AbortError (httpTimeoutMs fired)', () => {
    const err = new Error('The operation was aborted.') as Error & { name: string }
    err.name = 'AbortError'
    expect(isConnectionRefused(err)).toBe(false)
  })

  test('returns FALSE for unrelated cause.code (ENOTFOUND, ETIMEDOUT)', () => {
    const err = new TypeError('fetch failed')
    ;(err as { cause?: unknown }).cause = { code: 'ENOTFOUND' }
    expect(isConnectionRefused(err)).toBe(false)
    const err2 = new TypeError('fetch failed')
    ;(err2 as { cause?: unknown }).cause = { code: 'ETIMEDOUT' }
    expect(isConnectionRefused(err2)).toBe(false)
  })

  test('returns FALSE for primitives / null / undefined', () => {
    expect(isConnectionRefused(null)).toBe(false)
    expect(isConnectionRefused(undefined)).toBe(false)
    expect(isConnectionRefused('ECONNREFUSED')).toBe(false) // bare string MUST NOT pass
    expect(isConnectionRefused(42)).toBe(false)
  })
})
