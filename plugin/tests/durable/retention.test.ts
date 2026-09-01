import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { openDurableDatabase } from '../../src/durable/database.js'
import { DurableDataRetention } from '../../src/durable/retention.js'
import { SqliteInboxRepository, SqliteOutboxRepository } from '../../src/durable/sqlite-repositories.js'

const DAY_MS = 24 * 60 * 60_000
const NOW = 100 * DAY_MS
const OLD = 10 * DAY_MS
let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function fixture(): {
  root: string
  database: Database
  attachments: string
  outbound: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dashi-retention-'))
  roots.push(root)
  const attachments = join(root, 'attachments')
  const outbound = join(root, 'outbound')
  mkdirSync(attachments)
  mkdirSync(outbound)
  return {
    root,
    database: openDurableDatabase(join(root, 'bridge.sqlite3')),
    attachments,
    outbound,
  }
}

function terminalDelivery(
  database: Database,
  id: string,
  payload: unknown,
  updatedAtMs = OLD,
): void {
  database.run(
    `INSERT INTO delivery_jobs
      (id, source_key, kind, payload_json, state, attempt_count, available_at_ms,
       remote_id, created_at_ms, updated_at_ms, delivered_at_ms)
     VALUES (?, ?, 'send_media', ?, 'DELIVERED', 1, ?, ?, ?, ?, ?)`,
    [id, id, JSON.stringify(payload), updatedAtMs, `remote-${id}`, updatedAtMs, updatedAtMs, updatedAtMs],
  )
}

describe('DurableDataRetention', () => {
  test('scrubs aged payloads and private files without breaking idempotency rows', () => {
    const { database, attachments, outbound } = fixture()
    const inbox = new SqliteInboxRepository(database)
    const oldUpdate = inbox.ingest({
      botId: 'bot',
      updateId: 1,
      chatId: '100',
      payload: { message: { text: 'very private inbound text' } },
      receivedAtMs: OLD,
    }).update
    database.run(
      "UPDATE telegram_updates SET state='PROCESSED', processed_at_ms=? WHERE id=?",
      [OLD, oldUpdate.id],
    )
    const freshUpdate = inbox.ingest({
      botId: 'bot',
      updateId: 2,
      chatId: '100',
      payload: { message: { text: 'keep fresh text' } },
      receivedAtMs: NOW,
    }).update

    const attachmentPath = join(attachments, 'private.txt')
    writeFileSync(attachmentPath, 'private attachment')
    database.run(
      `INSERT INTO telegram_attachments
        (id, source_update_id, ordinal, kind, telegram_file_id, telegram_unique_id,
         file_name, mime_type, declared_size, state, local_path, actual_size,
         created_at_ms, updated_at_ms)
       VALUES ('attachment-1', ?, 0, 'file', 'secret-file-id', 'secret-unique-id',
         'private-name.txt', 'text/plain', 18, 'READY', ?, 18, ?, ?)`,
      [oldUpdate.id, attachmentPath, OLD, OLD],
    )
    database.run(
      `INSERT INTO telegram_attachment_proofs (attachment_id, content_sha256, verified_at_ms)
       VALUES ('attachment-1', ?, ?)`,
      ['a'.repeat(64), OLD],
    )

    database.run(
      `INSERT INTO sessions (id, bot_id, chat_id, project_id, state, created_at_ms, updated_at_ms)
       VALUES ('session-1', 'bot', '100', 'main', 'ACTIVE', ?, ?)`,
      [OLD, OLD],
    )
    database.run(
      `INSERT INTO turns
        (id, session_id, state, request_json, final_response_json, created_at_ms, finished_at_ms)
       VALUES ('turn-1', 'session-1', 'COMPLETED', ?, ?, ?, ?)`,
      [JSON.stringify({ text: 'private prompt' }), JSON.stringify({ text: 'private answer' }), OLD, OLD],
    )
    database.run(
      `INSERT INTO codex_interactions
        (id, token, connection_id, server_request_id_json, session_id, thread_id,
         turn_id, item_id, kind, request_json, answers_json, response_json, state,
         created_at_ms, updated_at_ms, expires_at_ms, resolved_at_ms)
       VALUES ('interaction-1', 'abcdef123456', 'connection-1', '1', 'session-1', 'thread-1',
         'turn-1', 'item-1', 'USER_INPUT', ?, ?, ?, 'RESOLVED', ?, ?, ?, ?)`,
      [
        JSON.stringify({ question: 'private question' }),
        JSON.stringify({ answer: 'private answer' }),
        JSON.stringify({ sent: 'private response' }),
        OLD,
        OLD,
        OLD + DAY_MS,
        OLD,
      ],
    )
    database.run(
      `INSERT INTO telegram_busy_prompts
        (id, token, source_operation_key, bot_id, chat_id, project_id, input_json,
         blocking_thread_id, blocking_turn_id, state, response_json, created_at_ms,
         updated_at_ms, resolved_at_ms)
       VALUES ('busy-1', '111111111111', 'busy-source', 'bot', '100', 'main', ?,
         'thread-1', 'turn-1', 'COMPLETED', ?, ?, ?, ?)`,
      [
        JSON.stringify({ text: 'private queued prompt' }),
        JSON.stringify({ finalText: 'private result' }),
        OLD,
        OLD,
        OLD,
      ],
    )
    database.run(
      `INSERT INTO guided_plans
        (id, token, source_operation_key, bot_id, chat_id, project_id, input_json,
         thread_id, planning_turn_id, plan_text, state, result_json, last_error,
         created_at_ms, updated_at_ms, resolved_at_ms)
       VALUES ('plan-1', '222222222222', 'plan-source', 'bot', '100', 'main', ?,
         'thread-1', 'turn-plan', 'private plan', 'COMPLETED', ?, 'private error', ?, ?, ?)`,
      [
        JSON.stringify({ text: 'private plan request' }),
        JSON.stringify({ finalText: 'private execution result' }),
        OLD,
        OLD,
        OLD,
      ],
    )
    database.run(
      `INSERT INTO codex_turn_diffs (thread_id, turn_id, diff_text, updated_at_ms)
       VALUES ('thread-1', 'turn-1', 'private source diff', ?)`,
      [OLD],
    )
    database.run(
      `INSERT INTO telegram_message_routes
        (source_key, bot_id, chat_id, project_id, thread_id, telegram_message_id,
         created_at_ms, delivered_at_ms)
       VALUES ('route-1', 'bot', '100', 'main', 'thread-1', 99, ?, ?)`,
      [OLD, OLD],
    )
    database.run(
      `INSERT INTO turn_task_workspaces
        (operation_key, project_id, mode, phase, canonical_root, canonical_cwd,
         created_at_ms, updated_at_ms)
       VALUES ('old-workspace', 'main', 'PLAIN', 'BYPASSED', '/tmp/project', '/tmp/project', ?, ?)`,
      [OLD, OLD],
    )

    const outboundPath = join(outbound, 'private.bin')
    writeFileSync(outboundPath, 'private outbound')
    terminalDelivery(database, 'old-delivery', { reference: { path: outboundPath } })

    const retention = new DurableDataRetention(database, {
      payloadMaxAgeMs: 30 * DAY_MS,
      intervalMs: DAY_MS,
      attachmentDirectory: attachments,
      outboundMediaDirectory: outbound,
      now: () => NOW,
    })
    const result = retention.runIfDue()

    expect(result).toMatchObject({
      ran: true,
      updatesScrubbed: 1,
      turnsScrubbed: 1,
      deliveriesScrubbed: 1,
      interactionsScrubbed: 1,
      controlInteractionsScrubbed: 2,
      attachmentsScrubbed: 1,
      turnDiffsRemoved: 1,
      messageRoutesRemoved: 1,
      taskWorkspacesRemoved: 1,
      attachmentFilesRemoved: 1,
      outboundFilesRemoved: 1,
    })
    expect(existsSync(attachmentPath)).toBeFalse()
    expect(existsSync(outboundPath)).toBeFalse()
    expect(inbox.get(oldUpdate.id)?.payload).toEqual({ scrubbed: true })
    expect(inbox.get(freshUpdate.id)?.payload).toEqual({ message: { text: 'keep fresh text' } })
    expect(database.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM telegram_updates WHERE bot_id='bot' AND update_id=1",
    ).get()?.count).toBe(1)
    expect(database.query<{ state: string; telegram_file_id: string; local_path: string | null }, []>(
      "SELECT state, telegram_file_id, local_path FROM telegram_attachments WHERE id='attachment-1'",
    ).get()).toEqual({ state: 'REJECTED', telegram_file_id: '[scrubbed]', local_path: null })
    expect(database.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM telegram_attachment_proofs WHERE attachment_id='attachment-1'",
    ).get()?.count).toBe(0)
    expect(database.query<{ request_json: string; final_response_json: string | null }, []>(
      "SELECT request_json, final_response_json FROM turns WHERE id='turn-1'",
    ).get()).toEqual({ request_json: '{"scrubbed":true}', final_response_json: null })
    expect(database.query<{ request_json: string; answers_json: string }, []>(
      "SELECT request_json, answers_json FROM codex_interactions WHERE id='interaction-1'",
    ).get()).toEqual({ request_json: '{"scrubbed":true}', answers_json: '{}' })
    expect(database.query<{
      input_json: string
      response_json: string | null
    }, []>(
      "SELECT input_json, response_json FROM telegram_busy_prompts WHERE id='busy-1'",
    ).get()).toEqual({ input_json: '{"scrubbed":true}', response_json: null })
    expect(database.query<{
      input_json: string
      plan_text: string
      result_json: string | null
      last_error: string | null
    }, []>(
      "SELECT input_json, plan_text, result_json, last_error FROM guided_plans WHERE id='plan-1'",
    ).get()).toEqual({
      input_json: '{"scrubbed":true}',
      plan_text: '[scrubbed]',
      result_json: null,
      last_error: null,
    })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM codex_turn_diffs',
    ).get()?.count).toBe(0)
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM telegram_message_routes',
    ).get()?.count).toBe(0)
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM turn_task_workspaces',
    ).get()?.count).toBe(0)
    expect(new SqliteOutboxRepository(database).get('old-delivery')?.payload).toEqual({ scrubbed: true })
    database.close()
  })

  test('keeps shared/fresh outbound files and never follows paths outside the spool', () => {
    const { root, database, outbound } = fixture()
    const sharedPath = join(outbound, 'shared.bin')
    const externalPath = join(root, 'outside.bin')
    writeFileSync(sharedPath, 'shared')
    writeFileSync(externalPath, 'outside')
    terminalDelivery(database, 'old-shared', { reference: { path: sharedPath } })
    terminalDelivery(database, 'old-escape', { reference: { path: externalPath } })
    database.run(
      `INSERT INTO delivery_jobs
        (id, source_key, kind, payload_json, state, attempt_count, available_at_ms,
         created_at_ms, updated_at_ms)
       VALUES ('fresh-shared', 'fresh-shared', 'send_media', ?, 'PENDING', 0, ?, ?, ?)`,
      [JSON.stringify({ reference: { path: sharedPath } }), NOW, NOW, NOW],
    )
    const retention = new DurableDataRetention(database, {
      payloadMaxAgeMs: 30 * DAY_MS,
      intervalMs: DAY_MS,
      outboundMediaDirectory: outbound,
      now: () => NOW,
    })

    const result = retention.runIfDue()

    expect(result.outboundFilesRemoved).toBe(0)
    expect(existsSync(sharedPath)).toBeTrue()
    expect(existsSync(externalPath)).toBeTrue()
    expect(retention.runIfDue().ran).toBeFalse()
    database.close()
  })

  test('enables SQLite secure_delete for scrubbed content', () => {
    const { database } = fixture()
    const value = database.query<Record<string, number>, []>('PRAGMA secure_delete').get()
    expect(Object.values(value ?? {})[0]).toBe(1)
    database.close()
  })
})
