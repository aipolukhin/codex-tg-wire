import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import { BridgeConfigFileSchema } from './service-config.js'

export interface InitializeBridgeInstallationInput {
  configDirectory: string
  stateDirectory: string
  projectPath: string
  telegramUserId: string
  telegramChatId: string
  projectId?: string
  executionProfile?: 'yolo' | 'safe'
}

export interface InitializedBridgeInstallation {
  configPath: string
  environmentPath: string
  telegramCredentialPath: string
  stateDirectory: string
  projectPath: string
}

const USER_ID = /^[1-9]\d*$/
const CHAT_ID = /^-?[1-9]\d*$/
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function safeAbsoluteDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  const normalized = resolve(path)
  if (normalized === parse(normalized).root) throw new Error(`${label} must not be a filesystem root`)
  return normalized
}

function requireDirectory(path: string, label: string): string {
  const resolved = safeAbsoluteDirectory(path, label)
  if (!existsSync(resolved)) throw new Error(`${label} does not exist`)
  const stat = lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`)
  }
  return realpathSync(resolved)
}

function writePrivate(path: string, contents: string): void {
  writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Creates a credential-free, owner-allowlisted configuration for the selected execution profile. */
export function initializeBridgeInstallation(
  input: InitializeBridgeInstallationInput,
): InitializedBridgeInstallation {
  const configDirectory = safeAbsoluteDirectory(input.configDirectory, 'configDirectory')
  const stateDirectory = safeAbsoluteDirectory(input.stateDirectory, 'stateDirectory')
  const projectPath = requireDirectory(input.projectPath, 'projectPath')
  const projectId = input.projectId?.trim() || 'main'
  const executionProfile = input.executionProfile ?? 'yolo'
  if (!PROJECT_ID.test(projectId)) throw new Error('projectId has an invalid format')
  if (!USER_ID.test(input.telegramUserId)) throw new Error('telegramUserId is invalid')
  if (!CHAT_ID.test(input.telegramChatId)) throw new Error('telegramChatId is invalid')

  const configPath = join(configDirectory, 'bridge.config.json')
  const environmentPath = join(configDirectory, 'bridge.env')
  const telegramCredentialPath = join(configDirectory, 'telegram-token')
  const targets = [configPath, environmentPath, telegramCredentialPath]
  const existing = targets.find((path) => existsSync(path))
  if (existing !== undefined) {
    throw new Error('installation target already contains bridge configuration; refusing overwrite')
  }

  const configuration = BridgeConfigFileSchema.parse({
    stateDatabase: join(stateDirectory, 'bridge.sqlite3'),
    projects: [{
      id: projectId,
      cwd: projectPath,
      sandboxMode: executionProfile === 'yolo' ? 'danger-full-access' : 'workspace-write',
      writableRoots: [],
      networkAccess: false,
    }],
    defaultProjectId: projectId,
    telegram: {
      allowedUserIds: [input.telegramUserId],
      allowedChatIds: [input.telegramChatId],
    },
    attachments: { directory: join(stateDirectory, 'attachments') },
    outboundMedia: {
      enabled: true,
      directory: join(stateDirectory, 'outbound-media'),
    },
    codex: {
      approvalPolicy: executionProfile === 'yolo' ? 'never' : 'on-request',
      sandboxMode: executionProfile === 'yolo' ? 'danger-full-access' : 'workspace-write',
      allowedSandboxModes: executionProfile === 'yolo'
        ? ['read-only', 'workspace-write', 'danger-full-access']
        : ['read-only', 'workspace-write'],
      interactionTimeoutMs: 600_000,
    },
    health: {
      enabled: true,
      host: '127.0.0.1',
      port: 8_787,
      startupGraceMs: 60_000,
      staleAfterMs: 120_000,
      maxConsecutiveErrors: 3,
    },
    retention: {
      enabled: true,
      payloadMaxAgeDays: 30,
      intervalMs: 21_600_000,
    },
  })

  mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  mkdirSync(configuration.attachments.directory, { recursive: true, mode: 0o700 })
  mkdirSync(configuration.outboundMedia.directory, { recursive: true, mode: 0o700 })

  const created: string[] = []
  try {
    writePrivate(configPath, `${JSON.stringify(configuration, null, 2)}\n`)
    created.push(configPath)
    writePrivate(
      environmentPath,
      [
        '# Optional non-secret overrides for the standalone bridge.',
        `DASHI_CODEX_BRIDGE_CONFIG=${JSON.stringify(configPath)}`,
        '',
      ].join('\n'),
    )
    created.push(environmentPath)
    writePrivate(telegramCredentialPath, '')
    created.push(telegramCredentialPath)
  } catch (error) {
    for (const path of created.reverse()) rmSync(path, { force: true })
    throw error
  }

  return {
    configPath,
    environmentPath,
    telegramCredentialPath,
    stateDirectory,
    projectPath,
  }
}
