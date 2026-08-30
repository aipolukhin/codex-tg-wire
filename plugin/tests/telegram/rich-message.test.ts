import { describe, expect, test } from 'bun:test'

import { normalizeTelegramRichMessage } from '../../src/telegram/rich-message.js'

describe('normalizeTelegramRichMessage', () => {
  test('preserves structured text, lists, tables, quotations and details', () => {
    const normalized = normalizeTelegramRichMessage({
      blocks: [
        { type: 'heading', size: 1, text: ['Report ', { type: 'bold', text: 'Q1' }] },
        {
          type: 'paragraph',
          text: [
            'See ', { type: 'url', text: 'source', url: 'https://example.com' },
            ' and ', { type: 'mathematical_expression', expression: 'x^2' }, '.',
          ],
        },
        {
          type: 'list',
          items: [
            { label: '-', has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: 'done' }] },
            { label: '-', has_checkbox: true, blocks: [{ type: 'paragraph', text: 'todo' }] },
          ],
        },
        {
          type: 'table',
          caption: 'Metrics',
          cells: [
            [{ text: 'Name', is_header: true }, { text: 'Value', is_header: true }],
            [{ text: 'speed' }, { text: { type: 'code', text: '42ms' } }],
          ],
        },
        {
          type: 'blockquote',
          blocks: [{ type: 'paragraph', text: 'Ship it' }],
          credit: 'Ada',
        },
        {
          type: 'details',
          summary: { type: 'italic', text: 'More' },
          blocks: [{ type: 'paragraph', text: { type: 'underline', text: 'Hidden' } }],
        },
      ],
    })

    expect(normalized?.text).toContain('# Report **Q1**')
    expect(normalized?.text).toContain('See source (https://example.com) and $x^2$.')
    expect(normalized?.text).toContain('- [x] done\n- [ ] todo')
    expect(normalized?.text).toContain('| Name | Value |\n| --- | --- |\n| speed | `42ms` |')
    expect(normalized?.text).toContain('> Ship it\n> — Ada')
    expect(normalized?.text).toContain('Details: *More*\n<u>Hidden</u>')
    expect(normalized?.attachments).toEqual([])
  })

  test('extracts inline media, selects the largest photo and deduplicates files', () => {
    const normalized = normalizeTelegramRichMessage({
      blocks: [
        {
          type: 'photo',
          photo: [
            { file_id: 'small', file_unique_id: 'same-photo', width: 10, height: 10 },
            { file_id: 'large', file_unique_id: 'same-photo', width: 100, height: 80, file_size: 99 },
          ],
          caption: { text: 'Diagram', credit: 'Owner' },
        },
        {
          type: 'photo',
          photo: [{ file_id: 'duplicate', file_unique_id: 'same-photo', width: 20, height: 20 }],
        },
        {
          type: 'voice_note',
          voice_note: {
            file_id: 'voice-1', file_unique_id: 'voice-u1', mime_type: 'audio/ogg', file_size: 12,
          },
        },
      ],
    })

    expect(normalized?.text).toContain('[Inline photo attachment #1]\nDiagram\n— Owner')
    expect(normalized?.text).toContain('[Inline voice_note attachment #2]')
    expect(normalized?.attachments).toEqual([
      {
        kind: 'image', fileId: 'large', uniqueId: 'same-photo', fileName: 'photo.jpg',
        mimeType: 'image/jpeg', declaredSize: 99,
      },
      {
        kind: 'audio', fileId: 'voice-1', uniqueId: 'voice-u1', fileName: 'voice.ogg',
        mimeType: 'audio/ogg', declaredSize: 12, transcribe: true,
      },
    ])
  })

  test('rejects malformed roots and bounds pathological nesting', () => {
    expect(normalizeTelegramRichMessage(null)).toBeNull()
    expect(normalizeTelegramRichMessage({ blocks: 'not-an-array' })).toBeNull()

    let text: unknown = 'leaf'
    for (let index = 0; index < 100; index += 1) text = { type: 'bold', text }
    const normalized = normalizeTelegramRichMessage({
      blocks: [{ type: 'paragraph', text }],
    })
    expect(normalized?.text).toContain('[Rich message truncated at the bridge safety limit.]')
    expect(normalized?.text.length).toBeLessThan(66_000)
  })
})
