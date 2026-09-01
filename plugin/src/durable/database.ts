import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { Database } from 'bun:sqlite'

interface Migration {
  version: number
  name: string
  statements: readonly string[]
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'durable_transport_core',
    statements: [
      `CREATE TABLE telegram_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        update_id INTEGER NOT NULL,
        chat_id TEXT,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'RECEIVED'
          CHECK (state IN ('RECEIVED', 'LEASED', 'PROCESSED', 'RETRY_WAIT', 'FAILED')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at_ms INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at_ms INTEGER,
        received_at_ms INTEGER NOT NULL,
        processed_at_ms INTEGER,
        last_error TEXT,
        UNIQUE (bot_id, update_id),
        CHECK ((state = 'LEASED') = (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL))
      )`,
      `CREATE INDEX telegram_updates_claim_idx
        ON telegram_updates (state, available_at_ms, update_id)`,
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'ARCHIVED')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (bot_id, chat_id, project_id)
      )`,
      `CREATE TABLE thread_bindings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PROVISIONAL'
          CHECK (state IN ('PROVISIONAL', 'ACTIVE', 'ARCHIVED', 'BROKEN')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (backend, thread_id),
        UNIQUE (session_id, backend)
      )`,
      `CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        backend_turn_id TEXT,
        source_update_id INTEGER REFERENCES telegram_updates(id),
        state TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (state IN ('QUEUED', 'ACTIVE', 'COMPLETED', 'INTERRUPTED', 'FAILED', 'UNKNOWN')),
        request_json TEXT NOT NULL,
        final_response_json TEXT,
        created_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        finished_at_ms INTEGER,
        UNIQUE (session_id, backend_turn_id)
      )`,
      `CREATE INDEX turns_session_state_idx ON turns (session_id, state, created_at_ms)`,
      `CREATE TABLE delivery_jobs (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('send_text', 'send_media', 'send_album', 'edit', 'delete', 'reaction')),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (state IN ('PENDING', 'LEASED', 'RETRY_WAIT', 'DELIVERED', 'AMBIGUOUS', 'FAILED', 'EXPIRED', 'ARCHIVED')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER,
        lease_owner TEXT,
        lease_expires_at_ms INTEGER,
        send_started_at_ms INTEGER,
        remote_id TEXT,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        delivered_at_ms INTEGER,
        CHECK ((state = 'LEASED') = (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)),
        CHECK (state != 'DELIVERED' OR (remote_id IS NOT NULL AND length(remote_id) > 0))
      )`,
      `CREATE INDEX delivery_jobs_claim_idx
        ON delivery_jobs (state, available_at_ms, created_at_ms)`,
      `CREATE INDEX delivery_jobs_session_idx
        ON delivery_jobs (session_id, state, created_at_ms)`,
    ],
  },
  {
    version: 2,
    name: 'idempotent_turn_operations',
    statements: [
      'ALTER TABLE turns ADD COLUMN operation_key TEXT',
      `CREATE UNIQUE INDEX turns_operation_key_idx
        ON turns (operation_key) WHERE operation_key IS NOT NULL`,
    ],
  },
  {
    version: 3,
    name: 'telegram_poll_cursors',
    statements: [
      `CREATE TABLE telegram_poll_cursors (
        bot_id TEXT PRIMARY KEY,
        next_update_id INTEGER NOT NULL CHECK (next_update_id >= 0),
        updated_at_ms INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 4,
    name: 'codex_interactions',
    statements: [
      `CREATE TABLE codex_interactions (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        server_request_id_json TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('COMMAND_APPROVAL', 'FILE_APPROVAL', 'USER_INPUT')),
        request_json TEXT NOT NULL,
        answers_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT,
        state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (state IN ('PENDING', 'RESOLVING', 'RESOLVED', 'EXTERNALLY_RESOLVED', 'STALE', 'EXPIRED', 'FAILED')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        last_error TEXT,
        UNIQUE (connection_id, server_request_id_json)
      )`,
      `CREATE INDEX codex_interactions_pending_idx
        ON codex_interactions (state, expires_at_ms, created_at_ms)`,
      `CREATE INDEX codex_interactions_thread_idx
        ON codex_interactions (thread_id, state, created_at_ms)`,
    ],
  },
  {
    version: 5,
    name: 'telegram_update_routing',
    statements: [
      `ALTER TABLE telegram_updates ADD COLUMN routing_class TEXT NOT NULL DEFAULT 'OTHER'
        CHECK (routing_class IN ('CONTROL', 'MESSAGE', 'QUEUED_MESSAGE', 'OTHER'))`,
      `CREATE INDEX telegram_updates_routing_idx
        ON telegram_updates (bot_id, chat_id, routing_class, state, update_id)`,
    ],
  },
  {
    version: 6,
    name: 'delivery_problem_actions',
    statements: [
      `CREATE TABLE delivery_problem_actions (
        id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL REFERENCES delivery_jobs(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('RETRY', 'RESOLVE', 'ARCHIVE')),
        from_state TEXT NOT NULL CHECK (from_state IN ('FAILED', 'AMBIGUOUS', 'EXPIRED')),
        to_state TEXT NOT NULL CHECK (to_state IN ('PENDING', 'DELIVERED', 'ARCHIVED')),
        actor_bot_id TEXT NOT NULL,
        actor_chat_id TEXT NOT NULL,
        remote_id TEXT,
        created_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX delivery_problem_actions_job_idx
        ON delivery_problem_actions (job_id, created_at_ms)`,
    ],
  },
  {
    version: 7,
    name: 'thread_registry',
    statements: [
      `CREATE TABLE thread_registry (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'AVAILABLE'
          CHECK (state IN ('AVAILABLE', 'ARCHIVED', 'BROKEN')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        last_used_at_ms INTEGER NOT NULL,
        UNIQUE (backend, thread_id),
        UNIQUE (session_id, backend, thread_id)
      )`,
      `INSERT INTO thread_registry
        (id, session_id, backend, thread_id, state, created_at_ms, updated_at_ms, last_used_at_ms)
       SELECT id, session_id, backend, thread_id,
         CASE state WHEN 'ARCHIVED' THEN 'ARCHIVED' WHEN 'BROKEN' THEN 'BROKEN' ELSE 'AVAILABLE' END,
         created_at_ms, updated_at_ms, updated_at_ms
       FROM thread_bindings`,
      `CREATE INDEX thread_registry_session_idx
        ON thread_registry (session_id, backend, state, last_used_at_ms)`,
    ],
  },
  {
    version: 8,
    name: 'agent_project_settings',
    statements: [
      `CREATE TABLE telegram_chat_preferences (
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        selected_project_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id)
      )`,
      `CREATE TABLE agent_project_settings (
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        sandbox TEXT CHECK (sandbox IS NULL OR sandbox IN
          ('read-only', 'workspace-write', 'danger-full-access')),
        approval_policy TEXT CHECK (approval_policy IS NULL OR approval_policy IN
          ('untrusted', 'on-request', 'never')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id, project_id)
      )`,
      `CREATE INDEX agent_project_settings_updated_idx
        ON agent_project_settings (updated_at_ms)`,
    ],
  },
  {
    version: 9,
    name: 'inbound_attachments_and_codex_diagnostics',
    statements: [
      `CREATE TABLE telegram_attachments (
        id TEXT PRIMARY KEY,
        source_update_id INTEGER NOT NULL REFERENCES telegram_updates(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
        telegram_file_id TEXT NOT NULL,
        telegram_unique_id TEXT,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        declared_size INTEGER CHECK (declared_size IS NULL OR declared_size >= 0),
        state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (state IN ('PENDING', 'READY', 'REJECTED')),
        local_path TEXT,
        actual_size INTEGER CHECK (actual_size IS NULL OR actual_size >= 0),
        rejection_reason TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (source_update_id, ordinal),
        CHECK (state != 'READY' OR
          (local_path IS NOT NULL AND actual_size IS NOT NULL AND rejection_reason IS NULL)),
        CHECK (state != 'REJECTED' OR
          (local_path IS NULL AND actual_size IS NULL AND rejection_reason IS NOT NULL))
      )`,
      `CREATE INDEX telegram_attachments_state_idx
        ON telegram_attachments (state, updated_at_ms)`,
      `CREATE TABLE codex_unhandled_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        turn_id TEXT NOT NULL DEFAULT '',
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
        first_seen_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER NOT NULL,
        UNIQUE (method, thread_id, turn_id)
      )`,
      `CREATE INDEX codex_unhandled_notifications_seen_idx
        ON codex_unhandled_notifications (last_seen_at_ms)`,
    ],
  },
  {
    version: 10,
    name: 'codex_interaction_recovery_marker',
    statements: [
      'ALTER TABLE codex_interactions ADD COLUMN recovery_handled_at_ms INTEGER',
      `CREATE INDEX codex_interactions_recovery_idx
        ON codex_interactions (state, recovery_handled_at_ms, updated_at_ms)`,
    ],
  },
  {
    version: 11,
    name: 'codex_permission_approvals',
    statements: [
      'ALTER TABLE codex_interactions RENAME TO codex_interactions_v10',
      `CREATE TABLE codex_interactions (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        server_request_id_json TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('COMMAND_APPROVAL', 'FILE_APPROVAL', 'PERMISSIONS_APPROVAL', 'USER_INPUT')),
        request_json TEXT NOT NULL,
        answers_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT,
        state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (state IN ('PENDING', 'RESOLVING', 'RESOLVED', 'EXTERNALLY_RESOLVED', 'STALE', 'EXPIRED', 'FAILED')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        recovery_handled_at_ms INTEGER,
        last_error TEXT,
        UNIQUE (connection_id, server_request_id_json)
      )`,
      `INSERT INTO codex_interactions
        (id, token, connection_id, server_request_id_json, session_id, thread_id,
         turn_id, item_id, kind, request_json, answers_json, response_json, state,
         created_at_ms, updated_at_ms, expires_at_ms, resolved_at_ms,
         recovery_handled_at_ms, last_error)
       SELECT id, token, connection_id, server_request_id_json, session_id, thread_id,
         turn_id, item_id, kind, request_json, answers_json, response_json, state,
         created_at_ms, updated_at_ms, expires_at_ms, resolved_at_ms,
         recovery_handled_at_ms, last_error
       FROM codex_interactions_v10`,
      'DROP TABLE codex_interactions_v10',
      `CREATE INDEX codex_interactions_pending_idx
        ON codex_interactions (state, expires_at_ms, created_at_ms)`,
      `CREATE INDEX codex_interactions_thread_idx
        ON codex_interactions (thread_id, state, created_at_ms)`,
      `CREATE INDEX codex_interactions_recovery_idx
        ON codex_interactions (state, recovery_handled_at_ms, updated_at_ms)`,
    ],
  },
  {
    version: 12,
    name: 'codex_mcp_elicitations',
    statements: [
      'ALTER TABLE codex_interactions RENAME TO codex_interactions_v11',
      `CREATE TABLE codex_interactions (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        server_request_id_json TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('COMMAND_APPROVAL', 'FILE_APPROVAL', 'PERMISSIONS_APPROVAL', 'MCP_ELICITATION', 'USER_INPUT')),
        request_json TEXT NOT NULL,
        answers_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT,
        state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (state IN ('PENDING', 'RESOLVING', 'RESOLVED', 'EXTERNALLY_RESOLVED', 'STALE', 'EXPIRED', 'FAILED')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        recovery_handled_at_ms INTEGER,
        last_error TEXT,
        UNIQUE (connection_id, server_request_id_json)
      )`,
      `INSERT INTO codex_interactions
        (id, token, connection_id, server_request_id_json, session_id, thread_id,
         turn_id, item_id, kind, request_json, answers_json, response_json, state,
         created_at_ms, updated_at_ms, expires_at_ms, resolved_at_ms,
         recovery_handled_at_ms, last_error)
       SELECT id, token, connection_id, server_request_id_json, session_id, thread_id,
         turn_id, item_id, kind, request_json, answers_json, response_json, state,
         created_at_ms, updated_at_ms, expires_at_ms, resolved_at_ms,
         recovery_handled_at_ms, last_error
       FROM codex_interactions_v11`,
      'DROP TABLE codex_interactions_v11',
      `CREATE INDEX codex_interactions_pending_idx
        ON codex_interactions (state, expires_at_ms, created_at_ms)`,
      `CREATE INDEX codex_interactions_thread_idx
        ON codex_interactions (thread_id, state, created_at_ms)`,
      `CREATE INDEX codex_interactions_recovery_idx
        ON codex_interactions (state, recovery_handled_at_ms, updated_at_ms)`,
    ],
  },
  {
    version: 13,
    name: 'ordered_delivery_chains',
    statements: [
      `ALTER TABLE delivery_jobs ADD COLUMN depends_on_source_key TEXT
        REFERENCES delivery_jobs(source_key) ON DELETE SET NULL`,
      `CREATE INDEX delivery_jobs_dependency_idx
        ON delivery_jobs (depends_on_source_key, state, created_at_ms)`,
    ],
  },
  {
    version: 14,
    name: 'codex_turn_ux_projection',
    statements: [
      `CREATE TABLE codex_turn_ux (
        operation_key TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        root_source_key TEXT NOT NULL UNIQUE,
        tail_source_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        phase TEXT NOT NULL DEFAULT 'PREPARING'
          CHECK (phase IN ('PREPARING', 'ACTIVE', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'UNKNOWN')),
        activity TEXT NOT NULL DEFAULT 'starting'
          CHECK (activity IN ('starting', 'reasoning', 'planning', 'command', 'file_change',
            'mcp', 'web_search', 'image', 'compacting', 'working')),
        model TEXT,
        effort TEXT,
        sandbox TEXT,
        approval_policy TEXT,
        plan_completed INTEGER NOT NULL DEFAULT 0 CHECK (plan_completed >= 0),
        plan_total INTEGER NOT NULL DEFAULT 0 CHECK (plan_total >= 0),
        total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        context_window INTEGER CHECK (context_window IS NULL OR context_window >= 0),
        last_activity_at_ms INTEGER NOT NULL,
        last_heartbeat_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX codex_turn_ux_chat_idx
        ON codex_turn_ux (bot_id, chat_id, project_id, updated_at_ms)`,
      `CREATE INDEX codex_turn_ux_heartbeat_idx
        ON codex_turn_ux (phase, last_activity_at_ms, last_heartbeat_at_ms)`,
    ],
  },
  {
    version: 15,
    name: 'durable_telegram_albums',
    statements: [
      `CREATE TABLE telegram_album_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        media_group_id TEXT NOT NULL,
        leader_update_row_id INTEGER NOT NULL
          REFERENCES telegram_updates(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'COLLECTING'
          CHECK (state IN ('COLLECTING', 'PROCESSING', 'PROCESSED', 'FAILED')),
        ready_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        processed_at_ms INTEGER,
        last_error TEXT,
        UNIQUE (bot_id, chat_id, media_group_id)
      )`,
      `CREATE INDEX telegram_album_groups_ready_idx
        ON telegram_album_groups (state, ready_at_ms, leader_update_row_id)`,
      `CREATE TABLE telegram_album_fragments (
        group_id INTEGER NOT NULL REFERENCES telegram_album_groups(id) ON DELETE CASCADE,
        update_row_id INTEGER NOT NULL UNIQUE
          REFERENCES telegram_updates(id) ON DELETE CASCADE,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (group_id, update_row_id)
      )`,
      `CREATE INDEX telegram_album_fragments_group_idx
        ON telegram_album_fragments (group_id, update_row_id)`,
    ],
  },
  {
    version: 16,
    name: 'verified_audio_attachments',
    statements: [
      `CREATE TABLE telegram_attachment_proofs (
        attachment_id TEXT PRIMARY KEY,
        content_sha256 TEXT NOT NULL
          CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
        verified_at_ms INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 17,
    name: 'm65_control_plane',
    statements: [
      `CREATE TABLE guided_plan_preferences (
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id, project_id)
      )`,
      `CREATE TABLE codex_turn_diffs (
        thread_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX codex_turn_diffs_turn_idx
        ON codex_turn_diffs (turn_id, updated_at_ms)`,
      `CREATE TABLE telegram_message_routes (
        source_key TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        telegram_message_id INTEGER CHECK
          (telegram_message_id IS NULL OR telegram_message_id > 0),
        created_at_ms INTEGER NOT NULL,
        delivered_at_ms INTEGER
      )`,
      `CREATE UNIQUE INDEX telegram_message_routes_remote_idx
        ON telegram_message_routes (bot_id, chat_id, telegram_message_id)
        WHERE telegram_message_id IS NOT NULL`,
      `CREATE TABLE telegram_busy_prompts (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        source_operation_key TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        blocking_thread_id TEXT NOT NULL,
        blocking_turn_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (state IN ('PENDING', 'PROCESSING', 'STEERED', 'QUEUED',
            'REPLACED', 'CANCELLED', 'COMPLETED', 'FAILED')),
        action TEXT CHECK (action IS NULL OR action IN
          ('steer', 'queue', 'replace', 'cancel')),
        action_operation_key TEXT UNIQUE,
        response_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      )`,
      `CREATE INDEX telegram_busy_prompts_state_idx
        ON telegram_busy_prompts (state, updated_at_ms)`,
      `CREATE TABLE guided_plans (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        source_operation_key TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        planning_turn_id TEXT NOT NULL,
        plan_text TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        state TEXT NOT NULL DEFAULT 'AWAITING_CONFIRMATION'
          CHECK (state IN ('AWAITING_CONFIRMATION', 'REVISION_REQUESTED',
            'REVISING', 'EXECUTING', 'COMPLETED', 'CANCELLED', 'FAILED')),
        action_operation_key TEXT,
        result_json TEXT,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      )`,
      `CREATE INDEX guided_plans_state_idx
        ON guided_plans (state, updated_at_ms)`,
    ],
  },
  {
    version: 18,
    name: 'accurate_codex_token_usage',
    statements: [
      'ALTER TABLE codex_turn_ux ADD COLUMN cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0)',
      'ALTER TABLE codex_turn_ux ADD COLUMN thread_total_tokens INTEGER CHECK (thread_total_tokens IS NULL OR thread_total_tokens >= 0)',
      `UPDATE codex_turn_ux SET
        thread_total_tokens = total_tokens,
        total_tokens = NULL,
        input_tokens = NULL,
        output_tokens = NULL`,
    ],
  },
  {
    version: 19,
    name: 'telegram_native_status_pin',
    statements: [
      `CREATE TABLE telegram_status_pins (
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        message_id INTEGER CHECK (message_id IS NULL OR message_id > 0),
        text TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id)
      )`,
    ],
  },
  {
    version: 20,
    name: 'telegram_turn_plan_cards',
    statements: [
      `CREATE TABLE telegram_turn_plan_cards (
        operation_key TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        root_source_key TEXT NOT NULL UNIQUE,
        tail_source_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        phase TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (phase IN ('ACTIVE', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'UNKNOWN')),
        cancel_state TEXT NOT NULL DEFAULT 'AVAILABLE'
          CHECK (cancel_state IN ('AVAILABLE', 'CONFIRMING', 'REQUESTED', 'CLOSED')),
        cancel_operation_key TEXT,
        interrupt_sent_at_ms INTEGER,
        steps_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX telegram_turn_plan_cards_active_idx
        ON telegram_turn_plan_cards (phase, cancel_state, updated_at_ms)`,
      `CREATE INDEX telegram_turn_plan_cards_chat_idx
        ON telegram_turn_plan_cards (bot_id, chat_id, project_id, updated_at_ms)`,
    ],
  },
  {
    version: 21,
    name: 'registered_projects',
    statements: [
      `CREATE TABLE registered_projects (
        project_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL UNIQUE,
        sandbox_mode TEXT
          CHECK (sandbox_mode IS NULL OR sandbox_mode IN
            ('read-only', 'workspace-write', 'danger-full-access')),
        writable_roots_json TEXT NOT NULL DEFAULT '[]',
        network_access INTEGER
          CHECK (network_access IS NULL OR network_access IN (0, 1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX registered_projects_created_idx
        ON registered_projects (created_at_ms, project_id)`,
    ],
  },
  {
    version: 22,
    name: 'turn_plan_live_status',
    statements: [
      `ALTER TABLE telegram_turn_plan_cards
       ADD COLUMN status_json TEXT NOT NULL DEFAULT '{}'`,
      `CREATE INDEX telegram_turn_plan_cards_heartbeat_idx
        ON telegram_turn_plan_cards (phase, updated_at_ms)`,
    ],
  },
  {
    version: 23,
    name: 'product_decision_r1',
    statements: [
      `CREATE TABLE product_decision_flows (
        id TEXT PRIMARY KEY,
        source_operation_key TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('research', 'fix', 'change')),
        source_update_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        last_turn_id TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
        current_draft_id TEXT,
        state TEXT NOT NULL DEFAULT 'DISCUSSING'
          CHECK (state IN ('DISCUSSING', 'AWAITING_ACCEPTANCE', 'ACCEPTING',
            'ACCEPTED', 'REJECTED')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      )`,
      `CREATE INDEX product_decision_flows_open_idx
        ON product_decision_flows (bot_id, chat_id, project_id, state, updated_at_ms)`,
      `CREATE TABLE product_decision_drafts (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL REFERENCES product_decision_flows(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL CHECK (version > 0),
        turn_id TEXT NOT NULL,
        brief_json TEXT NOT NULL,
        brief_sha256 TEXT NOT NULL
          CHECK (length(brief_sha256) = 64 AND brief_sha256 NOT GLOB '*[^0-9a-f]*'),
        state TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (state IN ('ACTIVE', 'SUPERSEDED', 'ACCEPTING', 'ACCEPTED', 'REJECTED')),
        action TEXT CHECK (action IS NULL OR action IN ('edit', 'data', 'reject', 'accept')),
        action_operation_key TEXT,
        acceptance_update_id TEXT,
        acceptance_message_id TEXT,
        acceptance_callback_query_id TEXT,
        decision_id TEXT,
        git_commit TEXT,
        pushed INTEGER CHECK (pushed IS NULL OR pushed IN (0, 1)),
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        UNIQUE (flow_id, version),
        UNIQUE (flow_id, turn_id)
      )`,
      `CREATE INDEX product_decision_drafts_state_idx
        ON product_decision_drafts (state, updated_at_ms)`,
    ],
  },
]

export const LATEST_DURABLE_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0

function ensureParentDirectory(filename: string): void {
  if (filename === ':memory:' || filename.length === 0) return
  mkdirSync(dirname(filename), { recursive: true })
}

function configureConnection(database: Database): void {
  database.run('PRAGMA foreign_keys = ON')
  database.run('PRAGMA busy_timeout = 5000')
  database.run('PRAGMA synchronous = NORMAL')
  database.run('PRAGMA secure_delete = ON')
  database.run('PRAGMA journal_mode = WAL')
}

function migrate(database: Database): void {
  database.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  )`)

  const appliedRows = database
    .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
    .all()
  const applied = new Set(appliedRows.map((row) => row.version))
  const newestKnownVersion = LATEST_DURABLE_SCHEMA_VERSION
  const newestAppliedVersion = appliedRows.at(-1)?.version ?? 0
  if (newestAppliedVersion > newestKnownVersion) {
    throw new Error(
      `database schema version ${newestAppliedVersion} is newer than supported version ${newestKnownVersion}`,
    )
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue

    database.transaction(() => {
      const alreadyApplied = database
        .query<{ version: number }, [number]>(
          'SELECT version FROM schema_migrations WHERE version = ?',
        )
        .get(migration.version)
      if (alreadyApplied !== null) return

      for (const statement of migration.statements) database.run(statement)
      database.run(
        'INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)',
        [migration.version, migration.name, Date.now()],
      )
    }).immediate()
  }
}

export function openDurableDatabase(filename: string): Database {
  ensureParentDirectory(filename)
  const database = new Database(filename, { create: true, readwrite: true, strict: true })

  try {
    configureConnection(database)
    migrate(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
