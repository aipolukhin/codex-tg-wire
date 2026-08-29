import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DurableOutboundMediaStore } from '../../src/telegram/durable-outbound-media.js'

let root: string
let workspace: string
let spool: string
let store: DurableOutboundMediaStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-outbound-media-'))
  workspace = join(root, 'workspace')
  spool = join(root, 'spool')
  mkdirSync(workspace, { recursive: true })
  store = new DurableOutboundMediaStore({
    directory: spool,
    allowedRoots: [workspace],
    maxBytes: 1_024,
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('DurableOutboundMediaStore', () => {
  test('copies an allowed source into a private content-addressed spool', async () => {
    const source = join(workspace, 'report.pdf')
    writeFileSync(source, '%PDF-test')
    const reference = await store.register({
      path: source,
      fileName: '../unsafe/report.pdf',
      mimeType: 'application/pdf',
      kind: 'document',
    })

    expect(reference.path).toStartWith(spool)
    expect(reference.fileName).toBe('report.pdf')
    expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(statSync(reference.path).mode & 0o777).toBe(0o600)
    expect(await store.prepare(reference, 'document')).toMatchObject(reference)
  })

  test('rejects root escapes, symlinks, oversize files and incompatible MIME', async () => {
    const outside = join(root, 'outside.pdf')
    writeFileSync(outside, '%PDF-outside')
    await expect(store.register({
      path: outside, mimeType: 'application/pdf', kind: 'document',
    })).rejects.toThrow('outside allowed roots')

    const link = join(workspace, 'link.pdf')
    symlinkSync(outside, link)
    await expect(store.register({
      path: link, mimeType: 'application/pdf', kind: 'document',
    })).rejects.toThrow('outside allowed roots')

    const huge = join(workspace, 'huge.pdf')
    writeFileSync(huge, new Uint8Array(1_025))
    await expect(store.register({
      path: huge, mimeType: 'application/pdf', kind: 'document',
    })).rejects.toThrow('size is not allowed')

    const wrong = join(workspace, 'wrong.pdf')
    writeFileSync(wrong, '%PDF-wrong')
    await expect(store.register({
      path: wrong, mimeType: 'application/pdf', kind: 'photo',
    })).rejects.toThrow('incompatible with photo')
  })

  test('revalidates digest on every attempt and refuses a changed spool file', async () => {
    const source = join(workspace, 'stable.txt')
    writeFileSync(source, 'stable bytes')
    const reference = await store.register({
      path: source, mimeType: 'text/plain', kind: 'document',
    })
    writeFileSync(reference.path, 'tamper bytes')
    chmodSync(reference.path, 0o600)

    await expect(store.prepare(reference, 'document')).rejects.toThrow('digest changed')
  })
})
