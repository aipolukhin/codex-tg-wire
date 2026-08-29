// Tests for build_prompt media_descriptors support, the skip-empty
// contract and the speaker-line fingerprint preference in
// src/chats/hooks/multichat-entrypoint.sh (fix 2026-06-11).
//
// Production bug: voice messages reached the per-chat inbox with empty
// `text` and no media payload (transcript dropped on the TS side); the
// watcher then submitted an effectively empty prompt and could not
// confirm it. The fix carries rendered descriptors in
// `media_descriptors`, renders them into the prompt (reply_context →
// media → speaker line), skips messages with no payload at all, and
// fingerprints the stable `[from @user]` line instead of a long
// descriptor line that tmux may wrap.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'chats',
  'hooks',
  'multichat-entrypoint.sh',
)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'entrypoint-media-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runHelpers(
  snippet: string,
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(
    'bash',
    [
      '-c',
      `set -uo pipefail
MULTICHAT_ENTRYPOINT_TEST_ONLY=1 source "${SCRIPT}"
PANE='%1'
CHAT_ID='test-chat'
${snippet}`,
    ],
    {
      env: {
        ...process.env,
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 15_000,
    },
  )
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

function writeInboxJson(name: string, payload: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(payload))
  return p
}

const VOICE_DESCRIPTOR =
  '<media kind="voice" file_id="abc" mime="audio/ogg" size="37410" duration_sec="10" transcript="Проверь воркшоп, владелец ждёт" transcription_status="ok" />'

describe('build_prompt — media_descriptors', () => {
  test('voice descriptor lands between reply_context and the speaker line', () => {
    const f = writeInboxJson('msg.json', {
      text: '',
      user: 'example_owner',
      chat_id: '-1',
      user_id: '1',
      timestamp: 'x',
      reply_context: '<untrusted_metadata type="telegram_reply">ctx</untrusted_metadata>',
      media_descriptors: [VOICE_DESCRIPTOR],
    })
    const res = runHelpers(`build_prompt '${f}'`)
    expect(res.code).toBe(0)
    const parts = res.stdout.split('\n\n')
    expect(parts[0]).toContain('untrusted_metadata')
    expect(parts[1]).toBe(VOICE_DESCRIPTOR)
    expect(parts[2]).toContain('[from @example_owner]')
  })

  test('descriptor without reply_context still renders before speaker line', () => {
    const f = writeInboxJson('msg.json', {
      text: 'и текст тоже',
      user: 'example_owner',
      media_descriptors: [VOICE_DESCRIPTOR],
    })
    const res = runHelpers(`build_prompt '${f}'`)
    expect(res.code).toBe(0)
    const parts = res.stdout.split('\n\n')
    expect(parts[0]).toBe(VOICE_DESCRIPTOR)
    expect(parts[1]).toBe('[from @example_owner] и текст тоже')
  })

  test('non-string entries in media_descriptors are ignored', () => {
    const f = writeInboxJson('msg.json', {
      text: 'привет',
      user: 'u',
      media_descriptors: [42, null, VOICE_DESCRIPTOR],
    })
    const res = runHelpers(`build_prompt '${f}'`)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain(VOICE_DESCRIPTOR)
    expect(res.stdout).not.toContain('42')
  })
})

describe('build_prompt — skip-empty contract', () => {
  test('no text, no media, no reply_context → exit 3, empty stdout', () => {
    const f = writeInboxJson('msg.json', {
      text: '',
      user: 'example_owner',
      chat_id: '-1',
    })
    const res = runHelpers(`rc=0; build_prompt '${f}' || rc=$?; echo "rc=$rc" >&2`)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('rc=3')
  })

  test('whitespace-only text with no other payload → exit 3', () => {
    const f = writeInboxJson('msg.json', { text: '   ', user: 'u' })
    const res = runHelpers(`rc=0; build_prompt '${f}' || rc=$?; echo "rc=$rc" >&2`)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('rc=3')
  })

  test('empty text WITH media descriptor is NOT skipped', () => {
    const f = writeInboxJson('msg.json', {
      text: '',
      user: 'u',
      media_descriptors: [VOICE_DESCRIPTOR],
    })
    const res = runHelpers(`rc=0; build_prompt '${f}' || rc=$?; echo "rc=$rc" >&2`)
    expect(res.stderr).toContain('rc=0')
    expect(res.stdout).toContain('transcript=')
    // Speaker attribution survives even with empty text.
    expect(res.stdout).toContain('[from @u]')
  })

  test('empty text WITH reply_context only is NOT skipped (status quo)', () => {
    const f = writeInboxJson('msg.json', {
      text: '',
      user: 'u',
      reply_context: 'ctx-not-empty',
    })
    const res = runHelpers(`rc=0; build_prompt '${f}' || rc=$?; echo "rc=$rc" >&2`)
    expect(res.stderr).toContain('rc=0')
    expect(res.stdout).toContain('ctx-not-empty')
  })
})

describe('process_inbox — skipped-empty files', () => {
  test('empty message moves to .processed/skipped-empty-*, no tmux calls', () => {
    // Stub tmux that records calls — none expected.
    const binDir = join(dir, 'bin')
    spawnSync('mkdir', ['-p', binDir])
    writeFileSync(
      join(binDir, 'tmux'),
      `#!/usr/bin/env bash\necho "$@" >> "${dir}/tmux.log"\nexit 0\n`,
    )
    spawnSync('chmod', ['755', join(binDir, 'tmux')])

    const inbox = join(dir, 'inbox')
    const processed = join(inbox, '.processed')
    spawnSync('mkdir', ['-p', processed])
    writeFileSync(
      join(inbox, '100-aaaa.json'),
      JSON.stringify({ text: '', user: 'u' }),
    )

    const res = runHelpers(
      `INBOX='${inbox}'; PROCESSED='${processed}'; process_inbox; ls "${processed}"`,
      { PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
    )
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('skipped-empty-100-aaaa.json')
    // No paste/submit attempted for an empty message.
    expect(res.stdout).not.toContain('submit-unconfirmed')
  })
})

describe('prompt_fingerprint — speaker-line preference', () => {
  test('prefers the [from @user] line over a long leading descriptor', () => {
    const prompt = `${VOICE_DESCRIPTOR}\n[from @example_owner] Проверь воркшоп`
    const res = runHelpers(`prompt_fingerprint "$(printf '%s' '${prompt.replace(/'/g, "'\\''")}')"`)
    expect(res.code).toBe(0)
    expect(res.stdout.startsWith('[from @example_owner]')).toBe(true)
  })

  test('falls back to first long-enough line when no speaker line exists', () => {
    const res = runHelpers(`prompt_fingerprint 'обычный текст без атрибуции достаточно длинный'`)
    expect(res.stdout.startsWith('обычный текст')).toBe(true)
  })
})

describe('build_prompt — whitespace-only reply_context (Codex finding 2)', () => {
  test('reply_context of spaces with no other payload → exit 3', () => {
    const f = writeInboxJson('msg.json', {
      text: '',
      user: 'u',
      reply_context: '   ',
    })
    const res = runHelpers(`rc=0; build_prompt '${f}' || rc=$?; echo "rc=$rc" >&2`)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('rc=3')
  })
})

describe('prompt_fingerprint — reply-context steal (Codex finding 1)', () => {
  test('quoted [from @old] inside reply_context does not steal the fingerprint', () => {
    const prompt = [
      '<untrusted_metadata type="telegram_reply">',
      '[from @old_user] цитата прошлого сообщения достаточно длинная',
      '</untrusted_metadata>',
      '',
      VOICE_DESCRIPTOR,
      '',
      '[from @example_owner] Проверь воркшоп немедленно',
    ].join('\n')
    const res = runHelpers(
      `prompt_fingerprint "$(printf '%s' '${prompt.replace(/'/g, "'\\''")}')"`,
    )
    expect(res.code).toBe(0)
    expect(res.stdout.startsWith('[from @example_owner]')).toBe(true)
  })

  test('bare short speaker line falls back to unique descriptor head', () => {
    // Caption-less voice note: "[from @u]" is identical across messages —
    // the descriptor head (carrying file_id) must win instead.
    const prompt = `${VOICE_DESCRIPTOR}\n\n[from @u]`
    const res = runHelpers(
      `prompt_fingerprint "$(printf '%s' '${prompt.replace(/'/g, "'\\''")}')"`,
    )
    expect(res.code).toBe(0)
    expect(res.stdout.startsWith('<media kind="voice" file_id="abc"')).toBe(true)
  })
})
