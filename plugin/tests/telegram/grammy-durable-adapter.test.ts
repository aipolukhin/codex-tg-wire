import { describe, expect, test } from 'bun:test'
import type { Api } from 'grammy'

import { GrammyDurableAdapter } from '../../src/telegram/grammy-durable-adapter.js'
import { AttachmentDownloadLimitError } from '../../src/telegram/durable-attachment-store.js'

describe('GrammyDurableAdapter', () => {
  test('forwards polling cursor, allowlist and abort signal to grammY', async () => {
    const calls: unknown[][] = []
    const api = {
      async getUpdates(...args: unknown[]): Promise<unknown[]> {
        calls.push(args)
        return [{ update_id: 10 }]
      },
      async sendMessage(...args: unknown[]): Promise<{ message_id: number }> {
        calls.push(args)
        return { message_id: 99 }
      },
    } as unknown as Api
    const adapter = new GrammyDurableAdapter(api)
    const signal = new AbortController().signal

    expect(
      await adapter.getUpdates(
        { offset: 10, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        signal,
      ),
    ).toEqual([{ update_id: 10 }])
    expect(await adapter.sendMessage('7001', 'hello', {})).toEqual({ message_id: 99 })
    expect(calls).toEqual([
      [
        { offset: 10, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        signal,
      ],
      ['7001', 'hello', {}],
    ])
  })

  test('downloads Telegram files with a hard streaming byte limit', async () => {
    const api = {
      async getFile(): Promise<{
        file_path: string
        file_size: number
        file_unique_id: string
      }> {
        return { file_path: 'documents/file.bin', file_size: 4, file_unique_id: 'u1' }
      },
    } as unknown as Api
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(new Uint8Array([1, 2, 3, 4]))
    }) as typeof fetch
    try {
      const adapter = new GrammyDurableAdapter(api, 'test-token', 'https://telegram.example')
      expect(await adapter.downloadAttachment('file-1', 4)).toEqual({
        bytes: new Uint8Array([1, 2, 3, 4]),
        fileSize: 4,
        uniqueId: 'u1',
      })
      expect(urls).toEqual([
        'https://telegram.example/file/bottest-token/documents/file.bin',
      ])
      await expect(adapter.downloadAttachment('file-1', 3)).rejects.toBeInstanceOf(
        AttachmentDownloadLimitError,
      )
      expect(urls).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
