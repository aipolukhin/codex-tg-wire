const MAX_FORM_FIELDS = 25
const MAX_FORM_OPTIONS = 50
const MAX_META_DEPTH = 12
const MAX_META_ITEMS = 1_000

export type McpElicitationValue = string | number | boolean | string[]

interface McpFieldBase {
  name: string
  title: string
  description: string | null
  required: boolean
}

export type McpElicitationField =
  | (McpFieldBase & {
      kind: 'string'
      minLength: number | null
      maxLength: number | null
      format: 'email' | 'uri' | 'date' | 'date-time' | null
      defaultValue: string | null
    })
  | (McpFieldBase & {
      kind: 'number' | 'integer'
      minimum: number | null
      maximum: number | null
      defaultValue: number | null
    })
  | (McpFieldBase & {
      kind: 'boolean'
      defaultValue: boolean | null
    })
  | (McpFieldBase & {
      kind: 'single'
      options: readonly McpElicitationOption[]
      defaultValue: string | null
    })
  | (McpFieldBase & {
      kind: 'multi'
      options: readonly McpElicitationOption[]
      minItems: number
      maxItems: number
      defaultValue: readonly string[] | null
    })

export interface McpElicitationOption {
  value: string
  label: string
}

interface McpElicitationBase {
  threadId: string
  turnId: string
  itemId: string
  serverName: string
  message: string
}

export type McpElicitationParams =
  | (McpElicitationBase & {
      mode: 'form'
      fields: readonly McpElicitationField[]
    })
  | (McpElicitationBase & {
      mode: 'url'
      url: string
      urlHost: string
      elicitationId: string
    })
  | (McpElicitationBase & {
      mode: 'unsupported'
      requestedMode: 'openai/form'
      reason: string
    })

export type McpContentResult =
  | { outcome: 'complete'; content: Record<string, McpElicitationValue> }
  | { outcome: 'incomplete' }
  | { outcome: 'invalid'; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): boolean {
  let remaining = MAX_META_ITEMS
  const visit = (candidate: unknown, depth: number): boolean => {
    remaining -= 1
    if (remaining < 0) return false
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return true
    }
    if (typeof candidate === 'number') return Number.isFinite(candidate)
    if (depth >= MAX_META_DEPTH) return false
    if (Array.isArray(candidate)) return candidate.every((item) => visit(item, depth + 1))
    if (!isRecord(candidate)) return false
    return Object.values(candidate).every((item) => visit(item, depth + 1))
  }
  return visit(value, 0)
}

function optionalString(value: Record<string, unknown>, key: string): string | null | undefined {
  const candidate = value[key]
  if (candidate === undefined) return null
  return typeof candidate === 'string' ? candidate : undefined
}

function optionalFiniteNumber(value: Record<string, unknown>, key: string): number | null | undefined {
  const candidate = value[key]
  if (candidate === undefined) return null
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function optionalNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
): number | null | undefined {
  const candidate = value[key]
  if (candidate === undefined) return null
  return Number.isSafeInteger(candidate) && (candidate as number) >= 0
    ? candidate as number
    : undefined
}

function optionList(values: unknown, labels?: unknown): readonly McpElicitationOption[] | null {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > MAX_FORM_OPTIONS ||
    values.some((value) => typeof value !== 'string') ||
    new Set(values).size !== values.length
  ) {
    return null
  }
  if (
    labels !== undefined &&
    (!Array.isArray(labels) ||
      labels.length !== values.length ||
      labels.some((label) => typeof label !== 'string'))
  ) {
    return null
  }
  return values.map((value, index) => ({
    value: value as string,
    label: Array.isArray(labels) ? labels[index] as string : value as string,
  }))
}

function constOptions(value: unknown): readonly McpElicitationOption[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FORM_OPTIONS) return null
  const options: McpElicitationOption[] = []
  const values = new Set<string>()
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.const !== 'string' ||
      typeof raw.title !== 'string' ||
      values.has(raw.const)
    ) {
      return null
    }
    values.add(raw.const)
    options.push({ value: raw.const, label: raw.title })
  }
  return options
}

function fieldBase(
  name: string,
  raw: Record<string, unknown>,
  required: ReadonlySet<string>,
): McpFieldBase | null {
  const title = optionalString(raw, 'title')
  const description = optionalString(raw, 'description')
  if (title === undefined || description === undefined) return null
  return {
    name,
    title: title ?? name,
    description,
    required: required.has(name),
  }
}

function parseStringField(
  base: McpFieldBase,
  raw: Record<string, unknown>,
): McpElicitationField | null {
  if (raw.oneOf !== undefined) {
    const options = constOptions(raw.oneOf)
    const defaultValue = optionalString(raw, 'default')
    if (
      options === null ||
      defaultValue === undefined ||
      (defaultValue !== null && !options.some((option) => option.value === defaultValue))
    ) {
      return null
    }
    return { ...base, kind: 'single', options, defaultValue }
  }
  if (raw.enum !== undefined) {
    const options = optionList(raw.enum, raw.enumNames)
    const defaultValue = optionalString(raw, 'default')
    if (
      options === null ||
      defaultValue === undefined ||
      (defaultValue !== null && !options.some((option) => option.value === defaultValue))
    ) {
      return null
    }
    return { ...base, kind: 'single', options, defaultValue }
  }

  const minLength = optionalNonNegativeInteger(raw, 'minLength')
  const maxLength = optionalNonNegativeInteger(raw, 'maxLength')
  const format = optionalString(raw, 'format')
  const defaultValue = optionalString(raw, 'default')
  if (
    minLength === undefined ||
    maxLength === undefined ||
    format === undefined ||
    defaultValue === undefined ||
    (format !== null && !['email', 'uri', 'date', 'date-time'].includes(format)) ||
    (minLength !== null && maxLength !== null && minLength > maxLength)
  ) {
    return null
  }
  const field: McpElicitationField = {
    ...base,
    kind: 'string',
    minLength,
    maxLength,
    format: format as 'email' | 'uri' | 'date' | 'date-time' | null,
    defaultValue,
  }
  return defaultValue === null || validateMcpTextValue(field, defaultValue).ok ? field : null
}

function parseNumberField(
  base: McpFieldBase,
  raw: Record<string, unknown>,
  kind: 'number' | 'integer',
): McpElicitationField | null {
  const minimum = optionalFiniteNumber(raw, 'minimum')
  const maximum = optionalFiniteNumber(raw, 'maximum')
  const defaultValue = optionalFiniteNumber(raw, 'default')
  if (
    minimum === undefined ||
    maximum === undefined ||
    defaultValue === undefined ||
    (minimum !== null && maximum !== null && minimum > maximum) ||
    (kind === 'integer' && defaultValue !== null && !Number.isInteger(defaultValue)) ||
    (defaultValue !== null && minimum !== null && defaultValue < minimum) ||
    (defaultValue !== null && maximum !== null && defaultValue > maximum)
  ) {
    return null
  }
  return { ...base, kind, minimum, maximum, defaultValue }
}

function parseBooleanField(
  base: McpFieldBase,
  raw: Record<string, unknown>,
): McpElicitationField | null {
  if (raw.default !== undefined && typeof raw.default !== 'boolean') return null
  return {
    ...base,
    kind: 'boolean',
    defaultValue: typeof raw.default === 'boolean' ? raw.default : null,
  }
}

function parseMultiField(
  base: McpFieldBase,
  raw: Record<string, unknown>,
): McpElicitationField | null {
  if (!isRecord(raw.items)) return null
  const options = raw.items.anyOf !== undefined
    ? constOptions(raw.items.anyOf)
    : raw.items.type === 'string' ? optionList(raw.items.enum) : null
  const minItems = optionalNonNegativeInteger(raw, 'minItems')
  const maxItems = optionalNonNegativeInteger(raw, 'maxItems')
  const actualMin = minItems ?? 0
  const actualMax = maxItems ?? options?.length ?? 0
  if (
    options === null ||
    minItems === undefined ||
    maxItems === undefined ||
    actualMin > actualMax ||
    actualMax > options.length
  ) {
    return null
  }
  let defaultValue: readonly string[] | null = null
  if (raw.default !== undefined) {
    if (
      !Array.isArray(raw.default) ||
      raw.default.some((item) => typeof item !== 'string') ||
      new Set(raw.default).size !== raw.default.length ||
      raw.default.length < actualMin ||
      raw.default.length > actualMax ||
      raw.default.some((item) => !options.some((option) => option.value === item))
    ) {
      return null
    }
    defaultValue = [...raw.default] as string[]
  }
  return { ...base, kind: 'multi', options, minItems: actualMin, maxItems: actualMax, defaultValue }
}

function parseField(
  name: string,
  value: unknown,
  required: ReadonlySet<string>,
): McpElicitationField | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  const base = fieldBase(name, value, required)
  if (base === null) return null
  if (value.type === 'string') return parseStringField(base, value)
  if (value.type === 'number' || value.type === 'integer') {
    return parseNumberField(base, value, value.type)
  }
  if (value.type === 'boolean') return parseBooleanField(base, value)
  if (value.type === 'array') return parseMultiField(base, value)
  return null
}

function parseFormSchema(value: unknown): readonly McpElicitationField[] | null {
  if (!isRecord(value) || value.type !== 'object' || !isRecord(value.properties)) return null
  if (value.$schema !== undefined && typeof value.$schema !== 'string') return null
  const properties = Object.entries(value.properties)
  if (properties.length > MAX_FORM_FIELDS) return null

  let requiredNames: string[] = []
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.some((name) => typeof name !== 'string') ||
      new Set(value.required).size !== value.required.length
    ) {
      return null
    }
    requiredNames = value.required as string[]
  }
  const propertyNames = new Set(properties.map(([name]) => name))
  if (requiredNames.some((name) => !propertyNames.has(name))) return null
  const required = new Set(requiredNames)

  const fields: McpElicitationField[] = []
  for (const [name, raw] of properties) {
    const field = parseField(name, raw, required)
    if (field === null) return null
    fields.push(field)
  }
  return fields
}

export function parseMcpElicitation(value: unknown): McpElicitationParams | null {
  if (
    !isRecord(value) ||
    typeof value.threadId !== 'string' ||
    (value.turnId !== null && typeof value.turnId !== 'string') ||
    typeof value.serverName !== 'string' ||
    value.serverName.trim().length === 0 ||
    typeof value.message !== 'string' ||
    !isJsonValue(value._meta)
  ) {
    return null
  }
  const base: McpElicitationBase = {
    threadId: value.threadId,
    turnId: value.turnId ?? '',
    itemId: 'mcp-elicitation',
    serverName: value.serverName,
    message: value.message,
  }
  if (value.mode === 'form') {
    const fields = parseFormSchema(value.requestedSchema)
    return fields === null ? null : { ...base, mode: 'form', fields }
  }
  if (value.mode === 'openai/form') {
    if (!isJsonValue(value.requestedSchema)) return null
    return {
      ...base,
      mode: 'unsupported',
      requestedMode: 'openai/form',
      reason: 'OpenAI extended forms were not negotiated for this connection',
    }
  }
  if (value.mode === 'url') {
    if (typeof value.url !== 'string' || typeof value.elicitationId !== 'string') return null
    try {
      const parsed = new URL(value.url)
      if (
        parsed.protocol !== 'https:' ||
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        value.url.length > 4_096 ||
        value.elicitationId.length === 0
      ) {
        return null
      }
      return {
        ...base,
        mode: 'url',
        url: parsed.toString(),
        urlHost: parsed.host,
        elicitationId: value.elicitationId,
      }
    } catch {
      return null
    }
  }
  return null
}

function fieldStorageSchema(field: McpElicitationField): Record<string, unknown> {
  const base = {
    title: field.title,
    ...(field.description === null ? {} : { description: field.description }),
  }
  if (field.kind === 'string') {
    return {
      ...base,
      type: 'string',
      ...(field.minLength === null ? {} : { minLength: field.minLength }),
      ...(field.maxLength === null ? {} : { maxLength: field.maxLength }),
      ...(field.format === null ? {} : { format: field.format }),
      ...(field.defaultValue === null ? {} : { default: field.defaultValue }),
    }
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    return {
      ...base,
      type: field.kind,
      ...(field.minimum === null ? {} : { minimum: field.minimum }),
      ...(field.maximum === null ? {} : { maximum: field.maximum }),
      ...(field.defaultValue === null ? {} : { default: field.defaultValue }),
    }
  }
  if (field.kind === 'boolean') {
    return {
      ...base,
      type: 'boolean',
      ...(field.defaultValue === null ? {} : { default: field.defaultValue }),
    }
  }
  if (field.kind === 'single') {
    return {
      ...base,
      type: 'string',
      oneOf: field.options.map((option) => ({ const: option.value, title: option.label })),
      ...(field.defaultValue === null ? {} : { default: field.defaultValue }),
    }
  }
  if (field.kind !== 'multi') throw new TypeError(`Unsupported MCP field kind: ${field.kind}`)
  return {
    ...base,
    type: 'array',
    minItems: field.minItems,
    maxItems: field.maxItems,
    items: {
      anyOf: field.options.map((option) => ({ const: option.value, title: option.label })),
    },
    ...(field.defaultValue === null ? {} : { default: [...field.defaultValue] }),
  }
}

export function mcpElicitationStorageValue(
  params: McpElicitationParams,
): Record<string, unknown> {
  const base = {
    threadId: params.threadId,
    turnId: params.turnId.length === 0 ? null : params.turnId,
    serverName: params.serverName,
    _meta: null,
    message: params.message,
  }
  if (params.mode === 'form') {
    return {
      ...base,
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: Object.fromEntries(
          params.fields.map((field) => [field.name, fieldStorageSchema(field)]),
        ),
        required: params.fields.filter((field) => field.required).map((field) => field.name),
      },
    }
  }
  if (params.mode === 'url') {
    return {
      ...base,
      mode: 'url',
      url: params.url,
      elicitationId: params.elicitationId,
    }
  }
  return {
    ...base,
    mode: 'openai/form',
    requestedSchema: null,
  }
}

function validDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function validateMcpTextValue(
  field: McpElicitationField,
  input: string,
): { ok: true; value: string | number } | { ok: false; error: string } {
  if (field.kind === 'string') {
    const length = [...input].length
    if (field.minLength !== null && length < field.minLength) {
      return { ok: false, error: `Минимальная длина: ${field.minLength}` }
    }
    if (field.maxLength !== null && length > field.maxLength) {
      return { ok: false, error: `Максимальная длина: ${field.maxLength}` }
    }
    if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
      return { ok: false, error: 'Нужен корректный email' }
    }
    if (field.format === 'uri') {
      try {
        const parsed = new URL(input)
        if (parsed.protocol.length === 0) throw new Error('missing protocol')
      } catch {
        return { ok: false, error: 'Нужен абсолютный URI' }
      }
    }
    if (field.format === 'date' && !validDate(input)) {
      return { ok: false, error: 'Нужна дата YYYY-MM-DD' }
    }
    if (
      field.format === 'date-time' &&
      (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(input) || !Number.isFinite(Date.parse(input)))
    ) {
      return { ok: false, error: 'Нужны дата и время RFC 3339 с часовым поясом' }
    }
    return { ok: true, value: input }
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    const trimmed = input.trim()
    const jsonNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
    const value = jsonNumber.test(trimmed) ? Number(trimmed) : Number.NaN
    if (!Number.isFinite(value) || (field.kind === 'integer' && !Number.isInteger(value))) {
      return { ok: false, error: field.kind === 'integer' ? 'Нужно целое число' : 'Нужно число' }
    }
    if (field.minimum !== null && value < field.minimum) {
      return { ok: false, error: `Минимум: ${field.minimum}` }
    }
    if (field.maximum !== null && value > field.maximum) {
      return { ok: false, error: `Максимум: ${field.maximum}` }
    }
    return { ok: true, value }
  }
  return { ok: false, error: 'Для этого поля используй кнопки' }
}

export function mcpValueKey(index: number): string {
  return `mcp:${index}:value`
}

export function mcpDoneKey(index: number): string {
  return `mcp:${index}:done`
}

export function mcpSkipKey(index: number): string {
  return `mcp:${index}:skip`
}

export function buildMcpContent(
  fields: readonly McpElicitationField[],
  answers: Readonly<Record<string, string[]>>,
): McpContentResult {
  const entries: Array<[string, McpElicitationValue]> = []
  for (const [index, field] of fields.entries()) {
    const skipped = answers[mcpSkipKey(index)] !== undefined
    const values = answers[mcpValueKey(index)]
    if (skipped) {
      if (field.required) return { outcome: 'invalid', error: `Поле ${field.title} обязательно` }
      continue
    }
    if (field.kind === 'multi') {
      if (answers[mcpDoneKey(index)] === undefined) return { outcome: 'incomplete' }
      const selected = values ?? []
      if (
        selected.length < field.minItems ||
        selected.length > field.maxItems ||
        new Set(selected).size !== selected.length ||
        selected.some((value) => !field.options.some((option) => option.value === value))
      ) {
        return { outcome: 'invalid', error: `Некорректный выбор для ${field.title}` }
      }
      entries.push([field.name, [...selected]])
      continue
    }
    if (values === undefined) return { outcome: 'incomplete' }
    if (values.length !== 1 || values[0] === undefined) {
      return { outcome: 'invalid', error: `Некорректный ответ для ${field.title}` }
    }
    const raw = values[0]
    if (field.kind === 'boolean') {
      if (raw !== 'true' && raw !== 'false') {
        return { outcome: 'invalid', error: `Некорректный ответ для ${field.title}` }
      }
      entries.push([field.name, raw === 'true'])
    } else if (field.kind === 'single') {
      if (!field.options.some((option) => option.value === raw)) {
        return { outcome: 'invalid', error: `Некорректный ответ для ${field.title}` }
      }
      entries.push([field.name, raw])
    } else {
      const parsed = validateMcpTextValue(field, raw)
      if (!parsed.ok) return { outcome: 'invalid', error: parsed.error }
      entries.push([field.name, parsed.value])
    }
  }
  return { outcome: 'complete', content: Object.fromEntries(entries) }
}
