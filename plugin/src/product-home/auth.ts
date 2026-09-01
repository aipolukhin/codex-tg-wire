import { createHmac, timingSafeEqual } from 'node:crypto'

export class ProductHomeAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductHomeAuthError'
  }
}

export interface VerifiedTelegramOwner {
  userId: string
  authDate: number
  queryId: string | null
}

export interface VerifyTelegramInitDataOptions {
  botToken: string
  allowedUserIds: readonly (string | number)[]
  maxAgeSeconds: number
  nowMs?: number
  futureSkewSeconds?: number
}

const MAX_INIT_DATA_BYTES = 16 * 1024

function reject(message: string): never {
  throw new ProductHomeAuthError(message)
}

function parseOwnerId(rawUser: string | null): string {
  if (rawUser === null) reject('initData has no user')
  let user: unknown
  try {
    user = JSON.parse(rawUser)
  } catch {
    reject('initData user is not valid JSON')
  }
  if (typeof user !== 'object' || user === null || Array.isArray(user)) {
    reject('initData user is not an object')
  }
  const id = (user as Record<string, unknown>).id
  if (
    (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) &&
    (typeof id !== 'string' || !/^[1-9]\d*$/.test(id))
  ) {
    reject('initData user id is invalid')
  }
  return String(id)
}

export function verifyTelegramInitData(
  rawInitData: string,
  options: VerifyTelegramInitDataOptions,
): VerifiedTelegramOwner {
  if (
    rawInitData.length === 0 ||
    Buffer.byteLength(rawInitData, 'utf8') > MAX_INIT_DATA_BYTES
  ) {
    reject('initData size is invalid')
  }
  if (!Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 1) {
    throw new TypeError('maxAgeSeconds must be a positive integer')
  }

  const params = new URLSearchParams(rawInitData)
  const values = new Map<string, string>()
  for (const [key, value] of params) {
    if (values.has(key)) reject('initData contains duplicate fields')
    values.set(key, value)
  }
  const suppliedHash = values.get('hash')
  if (suppliedHash === undefined || !/^[0-9a-f]{64}$/.test(suppliedHash)) {
    reject('initData hash is invalid')
  }
  values.delete('hash')
  const dataCheckString = [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData')
    .update(options.botToken)
    .digest()
  const expectedHash = createHmac('sha256', secret)
    .update(dataCheckString)
    .digest()
  const actualHash = Buffer.from(suppliedHash, 'hex')
  if (
    actualHash.length !== expectedHash.length ||
    !timingSafeEqual(actualHash, expectedHash)
  ) {
    reject('initData signature is invalid')
  }

  const rawAuthDate = values.get('auth_date')
  if (rawAuthDate === undefined || !/^[1-9]\d*$/.test(rawAuthDate)) {
    reject('initData auth_date is invalid')
  }
  const authDate = Number.parseInt(rawAuthDate, 10)
  if (!Number.isSafeInteger(authDate)) reject('initData auth_date is outside safe range')
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000)
  const futureSkewSeconds = options.futureSkewSeconds ?? 30
  if (authDate > nowSeconds + futureSkewSeconds) reject('initData auth_date is in the future')
  if (nowSeconds - authDate > options.maxAgeSeconds) reject('initData has expired')

  const userId = parseOwnerId(values.get('user') ?? null)
  const owners = new Set(options.allowedUserIds.map(String))
  if (!owners.has(userId)) reject('initData user is not allowed')

  return {
    userId,
    authDate,
    queryId: values.get('query_id') ?? null,
  }
}

export function telegramInitDataFromRequest(request: Request): string {
  const authorization = request.headers.get('authorization')
  if (authorization === null || !authorization.startsWith('tma ')) {
    reject('Telegram authorization is required')
  }
  const rawInitData = authorization.slice(4)
  if (rawInitData.trim() !== rawInitData) reject('Telegram authorization is malformed')
  return rawInitData
}
