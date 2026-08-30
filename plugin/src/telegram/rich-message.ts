import type { IncomingTelegramAttachment } from '../bridge/contracts.js'

const MAX_RICH_NODES = 8_192
const MAX_RICH_DEPTH = 32
const MAX_RICH_TEXT_UNITS = 65_536
const MAX_RICH_ATTACHMENTS = 32

interface NormalizationState {
  nodes: number
  attachments: IncomingTelegramAttachment[]
  truncated: boolean
}

export interface NormalizedTelegramRichMessage {
  text: string
  attachments: readonly IncomingTelegramAttachment[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clipped(value: string, state: NormalizationState): string {
  if (value.length <= MAX_RICH_TEXT_UNITS) return value
  state.truncated = true
  return value.slice(0, MAX_RICH_TEXT_UNITS)
}

function enter(state: NormalizationState, depth: number): boolean {
  state.nodes += 1
  if (state.nodes > MAX_RICH_NODES || depth > MAX_RICH_DEPTH) {
    state.truncated = true
    return false
  }
  return true
}

function renderRichText(value: unknown, state: NormalizationState, depth = 0): string {
  if (!enter(state, depth)) return ''
  if (typeof value === 'string') return clipped(value, state)
  if (Array.isArray(value)) {
    let out = ''
    for (const child of value) {
      out += renderRichText(child, state, depth + 1)
      if (out.length >= MAX_RICH_TEXT_UNITS) return clipped(out, state)
    }
    return out
  }
  if (!isRecord(value)) return ''

  const type = typeof value.type === 'string' ? value.type : ''
  if (type === 'custom_emoji') {
    return typeof value.alternative_text === 'string' ? clipped(value.alternative_text, state) : ''
  }
  if (type === 'mathematical_expression') {
    return typeof value.expression === 'string' ? `$${clipped(value.expression, state)}$` : ''
  }
  if (type === 'anchor') return ''

  const body = renderRichText(value.text, state, depth + 1)
  switch (type) {
    case 'bold': return `**${body}**`
    case 'italic': return `*${body}*`
    case 'underline': return `<u>${body}</u>`
    case 'strikethrough': return `~~${body}~~`
    case 'spoiler': return `[spoiler: ${body}]`
    case 'subscript': return `<sub>${body}</sub>`
    case 'superscript': return `<sup>${body}</sup>`
    case 'code': return `\`${body.replaceAll('`', '\\`')}\``
    case 'marked': return `==${body}==`
    case 'url': {
      const url = typeof value.url === 'string' ? value.url : ''
      return url.length === 0 ? body : `${body} (${url})`
    }
    default: return body
  }
}

function mediaSize(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function mediaMime(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  return value.toLowerCase().split(';', 1)[0]?.trim() || fallback
}

function addAttachment(
  state: NormalizationState,
  attachment: IncomingTelegramAttachment | null,
): number | null {
  if (attachment === null) return null
  const key = attachment.uniqueId ?? attachment.fileId
  const existing = state.attachments.findIndex((item) => (item.uniqueId ?? item.fileId) === key)
  if (existing >= 0) return existing + 1
  if (state.attachments.length >= MAX_RICH_ATTACHMENTS) {
    state.truncated = true
    return null
  }
  state.attachments.push(attachment)
  return state.attachments.length
}

function fileAttachment(
  value: unknown,
  defaults: {
    kind: IncomingTelegramAttachment['kind']
    fileName: string
    mimeType: string
    transcribe?: boolean
  },
): IncomingTelegramAttachment | null {
  if (!isRecord(value) || typeof value.file_id !== 'string' || value.file_id.length === 0) return null
  const mimeType = mediaMime(value.mime_type, defaults.mimeType)
  return {
    kind: defaults.kind === 'file' && mimeType.startsWith('image/') ? 'image' : defaults.kind,
    fileId: value.file_id,
    uniqueId: typeof value.file_unique_id === 'string' ? value.file_unique_id : null,
    fileName: typeof value.file_name === 'string' ? value.file_name : defaults.fileName,
    mimeType,
    declaredSize: mediaSize(value.file_size),
    ...(defaults.transcribe === true ? { transcribe: true } : {}),
  }
}

function photoAttachment(value: unknown): IncomingTelegramAttachment | null {
  if (!Array.isArray(value)) return null
  const photos = value.filter(isRecord).filter((photo) =>
    typeof photo.file_id === 'string' && photo.file_id.length > 0
  )
  const photo = photos.sort((left, right) =>
    (((right.width as number | undefined) ?? 0) * ((right.height as number | undefined) ?? 0)) -
    (((left.width as number | undefined) ?? 0) * ((left.height as number | undefined) ?? 0))
  )[0]
  if (photo === undefined || typeof photo.file_id !== 'string') return null
  return {
    kind: 'image',
    fileId: photo.file_id,
    uniqueId: typeof photo.file_unique_id === 'string' ? photo.file_unique_id : null,
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    declaredSize: mediaSize(photo.file_size),
  }
}

function renderCaption(value: unknown, state: NormalizationState, depth: number): string {
  if (!isRecord(value)) return ''
  const text = renderRichText(value.text, state, depth + 1).trim()
  const credit = renderRichText(value.credit, state, depth + 1).trim()
  return [text, credit.length === 0 ? '' : `— ${credit}`].filter(Boolean).join('\n')
}

function quoteLines(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n')
}

function renderMediaBlock(
  block: Record<string, unknown>,
  state: NormalizationState,
  depth: number,
): string {
  const type = typeof block.type === 'string' ? block.type : 'media'
  let attachment: IncomingTelegramAttachment | null = null
  switch (type) {
    case 'photo': attachment = photoAttachment(block.photo); break
    case 'video':
      attachment = fileAttachment(block.video, { kind: 'file', fileName: 'video.mp4', mimeType: 'video/mp4' })
      break
    case 'animation':
      attachment = fileAttachment(block.animation, { kind: 'file', fileName: 'animation.mp4', mimeType: 'video/mp4' })
      break
    case 'audio':
      attachment = fileAttachment(block.audio, { kind: 'audio', fileName: 'audio.mp3', mimeType: 'audio/mpeg' })
      break
    case 'voice_note':
      attachment = fileAttachment(block.voice_note, {
        kind: 'audio', fileName: 'voice.ogg', mimeType: 'audio/ogg', transcribe: true,
      })
      break
    case 'document':
      attachment = fileAttachment(block.document, {
        kind: 'file', fileName: 'document.bin', mimeType: 'application/octet-stream',
      })
      break
  }
  const ordinal = addAttachment(state, attachment)
  const label = ordinal === null ? `[Inline ${type}]` : `[Inline ${type} attachment #${ordinal}]`
  const caption = renderCaption(block.caption, state, depth + 1)
  return caption.length === 0 ? label : `${label}\n${caption}`
}

function renderTable(block: Record<string, unknown>, state: NormalizationState, depth: number): string {
  if (!Array.isArray(block.cells)) return ''
  const rows = block.cells.filter(Array.isArray).map((row) => row.map((cell) => {
    if (!isRecord(cell)) return ''
    return renderRichText(cell.text, state, depth + 1).replaceAll('|', '\\|').replaceAll('\n', ' ')
  }))
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => [...row, ...new Array<string>(Math.max(0, width - row.length)).fill('')])
  const caption = renderRichText(block.caption, state, depth + 1).trim()
  const lines = normalized.map((row) => `| ${row.join(' | ')} |`)
  const firstRow = (block.cells[0] as unknown[] | undefined) ?? []
  if (firstRow.some((cell) => isRecord(cell) && cell.is_header === true)) {
    lines.splice(1, 0, `| ${new Array<string>(width).fill('---').join(' | ')} |`)
  }
  return [caption, ...lines].filter(Boolean).join('\n')
}

function renderBlocks(value: unknown, state: NormalizationState, depth = 0): string {
  if (!enter(state, depth) || !Array.isArray(value)) return ''
  const parts: string[] = []
  for (const raw of value) {
    if (!enter(state, depth + 1) || !isRecord(raw)) continue
    const type = typeof raw.type === 'string' ? raw.type : ''
    let rendered = ''
    switch (type) {
      case 'paragraph': rendered = renderRichText(raw.text, state, depth + 2); break
      case 'heading': {
        const size = Number.isSafeInteger(raw.size) ? Math.max(1, Math.min(6, raw.size as number)) : 2
        rendered = `${'#'.repeat(size)} ${renderRichText(raw.text, state, depth + 2)}`
        break
      }
      case 'pre': {
        const language = typeof raw.language === 'string' ? raw.language.replace(/[^A-Za-z0-9_+-]/g, '') : ''
        rendered = `\`\`\`${language}\n${renderRichText(raw.text, state, depth + 2)}\n\`\`\``
        break
      }
      case 'footer': rendered = renderRichText(raw.text, state, depth + 2); break
      case 'divider': rendered = '---'; break
      case 'mathematical_expression':
        rendered = typeof raw.expression === 'string' ? `$$\n${raw.expression}\n$$` : ''
        break
      case 'anchor': rendered = ''; break
      case 'list': {
        if (!Array.isArray(raw.items)) break
        rendered = raw.items.map((item, index) => {
          if (!isRecord(item)) return ''
          const body = renderBlocks(item.blocks, state, depth + 2).replaceAll('\n', '\n  ')
          const checkbox = item.has_checkbox === true ? item.is_checked === true ? '[x] ' : '[ ] ' : ''
          const label = typeof item.label === 'string' && item.label.length > 0 ? item.label : `${index + 1}.`
          return `${label} ${checkbox}${body}`.trimEnd()
        }).filter(Boolean).join('\n')
        break
      }
      case 'blockquote':
      case 'expandable_blockquote': {
        const body = renderBlocks(raw.blocks, state, depth + 2)
        const credit = renderRichText(raw.credit, state, depth + 2).trim()
        rendered = quoteLines([body, credit.length === 0 ? '' : `— ${credit}`].filter(Boolean).join('\n'))
        break
      }
      case 'pullquote': {
        const body = renderRichText(raw.text, state, depth + 2)
        const credit = renderRichText(raw.credit, state, depth + 2).trim()
        rendered = quoteLines([body, credit.length === 0 ? '' : `— ${credit}`].filter(Boolean).join('\n'))
        break
      }
      case 'collage':
      case 'slideshow': {
        const body = renderBlocks(raw.blocks, state, depth + 2)
        const caption = renderCaption(raw.caption, state, depth + 2)
        rendered = [body, caption].filter(Boolean).join('\n')
        break
      }
      case 'table': rendered = renderTable(raw, state, depth + 2); break
      case 'details': {
        const summary = renderRichText(raw.summary, state, depth + 2)
        const body = renderBlocks(raw.blocks, state, depth + 2)
        rendered = [`Details: ${summary}`, body].filter(Boolean).join('\n')
        break
      }
      case 'map': {
        const location = isRecord(raw.location) ? raw.location : {}
        const latitude = typeof location.latitude === 'number' ? location.latitude : '?'
        const longitude = typeof location.longitude === 'number' ? location.longitude : '?'
        const caption = renderCaption(raw.caption, state, depth + 2)
        rendered = [`[Map: ${latitude}, ${longitude}]`, caption].filter(Boolean).join('\n')
        break
      }
      case 'photo':
      case 'video':
      case 'animation':
      case 'audio':
      case 'voice_note':
      case 'document':
        rendered = renderMediaBlock(raw, state, depth + 2)
        break
      case 'thinking': rendered = renderRichText(raw.text, state, depth + 2); break
      default:
        rendered = Array.isArray(raw.blocks)
          ? renderBlocks(raw.blocks, state, depth + 2)
          : renderRichText(raw.text, state, depth + 2)
    }
    if (rendered.trim().length > 0) parts.push(rendered)
    if (parts.join('\n\n').length >= MAX_RICH_TEXT_UNITS) {
      state.truncated = true
      break
    }
  }
  return clipped(parts.join('\n\n'), state)
}

/** Convert Telegram's recursive RichMessage tree into bounded agent input and attachments. */
export function normalizeTelegramRichMessage(value: unknown): NormalizedTelegramRichMessage | null {
  if (!isRecord(value) || !Array.isArray(value.blocks)) return null
  const state: NormalizationState = {
    nodes: 0,
    attachments: [],
    truncated: false,
  }
  let text = renderBlocks(value.blocks, state).trim()
  if (state.truncated) text = `${text}\n\n[Rich message truncated at the bridge safety limit.]`.trim()
  return { text, attachments: state.attachments }
}
