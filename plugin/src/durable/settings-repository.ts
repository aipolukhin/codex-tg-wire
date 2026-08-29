import type { Database } from 'bun:sqlite'

import type {
  AgentApprovalPolicy,
  AgentSandboxMode,
  AgentSettingsProvider,
  AgentTurnSettings,
} from '../bridge/contracts.js'

export interface AgentProjectSettingsRecord {
  botId: string
  chatId: string
  projectId: string
  model: string | null
  effort: string | null
  sandbox: AgentSandboxMode | null
  approvalPolicy: AgentApprovalPolicy | null
  guidedPlanEnabled: boolean
  createdAtMs: number
  updatedAtMs: number
}

export interface AgentProjectSettingsPatch {
  model?: string | null
  effort?: string | null
  sandbox?: AgentSandboxMode | null
  approvalPolicy?: AgentApprovalPolicy | null
  guidedPlanEnabled?: boolean
}

interface SettingsRow {
  bot_id: string
  chat_id: string
  project_id: string
  model: string | null
  effort: string | null
  sandbox: AgentSandboxMode | null
  approval_policy: AgentApprovalPolicy | null
  created_at_ms: number
  updated_at_ms: number
}

interface PreferenceRow {
  selected_project_id: string
}

function settingsFromRow(row: SettingsRow): AgentProjectSettingsRecord {
  return {
    botId: row.bot_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    model: row.model,
    effort: row.effort,
    sandbox: row.sandbox,
    approvalPolicy: row.approval_policy,
    guidedPlanEnabled: false,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function requireKey(name: string, value: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`)
}

export class SqliteAgentSettingsRepository implements AgentSettingsProvider {
  constructor(private readonly database: Database) {}

  getSelectedProject(botId: string, chatId: string): string | null {
    const row = this.database
      .query<PreferenceRow, [string, string]>(
        `SELECT selected_project_id FROM telegram_chat_preferences
         WHERE bot_id = ? AND chat_id = ?`,
      )
      .get(botId, chatId)
    return row?.selected_project_id ?? null
  }

  selectProject(
    botId: string,
    chatId: string,
    projectId: string,
    nowMs: number,
  ): string {
    requireKey('botId', botId)
    requireKey('chatId', chatId)
    requireKey('projectId', projectId)
    if (!Number.isSafeInteger(nowMs)) throw new TypeError('nowMs must be a safe integer')
    this.database.run(
      `INSERT INTO telegram_chat_preferences
        (bot_id, chat_id, selected_project_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, chat_id) DO UPDATE SET
         selected_project_id = excluded.selected_project_id,
         updated_at_ms = excluded.updated_at_ms`,
      [botId, chatId, projectId, nowMs, nowMs],
    )
    return projectId
  }

  getProjectSettings(
    botId: string,
    chatId: string,
    projectId: string,
  ): AgentProjectSettingsRecord | null {
    const row = this.database
      .query<SettingsRow, [string, string, string]>(
        `SELECT * FROM agent_project_settings
         WHERE bot_id = ? AND chat_id = ? AND project_id = ?`,
      )
      .get(botId, chatId, projectId)
    if (row === null) return null
    return {
      ...settingsFromRow(row),
      guidedPlanEnabled: this.isGuidedPlanEnabled(botId, chatId, projectId),
    }
  }

  updateProjectSettings(
    botId: string,
    chatId: string,
    projectId: string,
    patch: AgentProjectSettingsPatch,
    nowMs: number,
  ): AgentProjectSettingsRecord {
    requireKey('botId', botId)
    requireKey('chatId', chatId)
    requireKey('projectId', projectId)
    if (!Number.isSafeInteger(nowMs)) throw new TypeError('nowMs must be a safe integer')
    const current = this.getProjectSettings(botId, chatId, projectId)
    const model = patch.model === undefined ? current?.model ?? null : patch.model
    const effort = patch.effort === undefined ? current?.effort ?? null : patch.effort
    const sandbox = patch.sandbox === undefined ? current?.sandbox ?? null : patch.sandbox
    const approvalPolicy = patch.approvalPolicy === undefined
      ? current?.approvalPolicy ?? null
      : patch.approvalPolicy
    if (model !== null) requireKey('model', model)
    if (effort !== null) requireKey('effort', effort)
    this.database.run(
      `INSERT INTO agent_project_settings
        (bot_id, chat_id, project_id, model, effort, sandbox, approval_policy,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, chat_id, project_id) DO UPDATE SET
         model = excluded.model,
         effort = excluded.effort,
         sandbox = excluded.sandbox,
         approval_policy = excluded.approval_policy,
         updated_at_ms = excluded.updated_at_ms`,
      [
        botId,
        chatId,
        projectId,
        model,
        effort,
        sandbox,
        approvalPolicy,
        current?.createdAtMs ?? nowMs,
        nowMs,
      ],
    )
    if (patch.guidedPlanEnabled !== undefined) {
      this.database.run(
        `INSERT INTO guided_plan_preferences
          (bot_id, chat_id, project_id, enabled, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, chat_id, project_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at_ms = excluded.updated_at_ms`,
        [
          botId,
          chatId,
          projectId,
          patch.guidedPlanEnabled ? 1 : 0,
          nowMs,
          nowMs,
        ],
      )
    }
    const updated = this.getProjectSettings(botId, chatId, projectId)
    if (updated === null) throw new Error('agent project settings update did not produce a row')
    return updated
  }

  getTurnSettings(botId: string, chatId: string, projectId: string): AgentTurnSettings {
    const settings = this.getProjectSettings(botId, chatId, projectId)
    if (settings === null) return {}
    return {
      ...(settings.model === null ? {} : { model: settings.model }),
      ...(settings.effort === null ? {} : { effort: settings.effort }),
      ...(settings.sandbox === null ? {} : { sandbox: settings.sandbox }),
      ...(settings.approvalPolicy === null
        ? {}
        : { approvalPolicy: settings.approvalPolicy }),
    }
  }

  private isGuidedPlanEnabled(botId: string, chatId: string, projectId: string): boolean {
    const row = this.database
      .query<{ enabled: number }, [string, string, string]>(
        `SELECT enabled FROM guided_plan_preferences
         WHERE bot_id = ? AND chat_id = ? AND project_id = ?`,
      )
      .get(botId, chatId, projectId)
    return row?.enabled === 1
  }
}
