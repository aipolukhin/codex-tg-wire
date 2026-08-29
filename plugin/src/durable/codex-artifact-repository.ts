import type { Database } from 'bun:sqlite'

import type { AgentArtifactStore, AgentTurnDiff } from '../bridge/contracts.js'

interface DiffRow {
  thread_id: string
  turn_id: string
  diff_text: string
  updated_at_ms: number
}

function fromRow(row: DiffRow): AgentTurnDiff {
  return {
    threadId: row.thread_id,
    turnId: row.turn_id,
    diff: row.diff_text,
    updatedAtMs: row.updated_at_ms,
  }
}

export class SqliteCodexArtifactRepository implements AgentArtifactStore {
  constructor(private readonly database: Database) {}

  recordTurnDiff(diff: AgentTurnDiff): void {
    if (diff.threadId.length === 0 || diff.turnId.length === 0) {
      throw new TypeError('turn diff correlation must not be empty')
    }
    this.database.run(
      `INSERT INTO codex_turn_diffs (thread_id, turn_id, diff_text, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET
         turn_id = excluded.turn_id,
         diff_text = excluded.diff_text,
         updated_at_ms = excluded.updated_at_ms
       WHERE excluded.updated_at_ms >= codex_turn_diffs.updated_at_ms`,
      [diff.threadId, diff.turnId, diff.diff, diff.updatedAtMs],
    )
  }

  getLatestTurnDiff(threadId: string): AgentTurnDiff | null {
    const row = this.database
      .query<DiffRow, [string]>('SELECT * FROM codex_turn_diffs WHERE thread_id = ?')
      .get(threadId)
    return row === null ? null : fromRow(row)
  }
}
