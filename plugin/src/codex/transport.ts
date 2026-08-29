import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'

import type { OutboundMessage } from './protocol.js'

export interface TransportClose {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

export interface AppServerTransport {
  readonly closed: boolean
  send(message: OutboundMessage): Promise<void>
  onMessage(listener: (message: unknown) => void): () => void
  onClose(listener: (close: TransportClose) => void): () => void
  close(): Promise<void>
}

export interface StdioTransportOptions {
  command?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxLineBytes?: number
  shutdownTimeoutMs?: number
  onStderr?: (chunk: string) => void
}

export class AppServerTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppServerTransportError'
  }
}

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000

export class StdioAppServerTransport implements AppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly reader: ReadlineInterface
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly closeListeners = new Set<(close: TransportClose) => void>()
  private readonly maxLineBytes: number
  private readonly shutdownTimeoutMs: number
  private closeState: TransportClose | undefined
  private closePromise: Promise<void> | undefined

  constructor(options: StdioTransportOptions = {}) {
    const command = options.command ?? process.env.CODEX_BINARY_PATH ?? 'codex'
    const args = options.args ?? ['app-server', '--listen', 'stdio://']
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS

    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    })

    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.reader.on('line', (line) => this.handleLine(line))

    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      options.onStderr?.(chunk)
    })

    this.child.once('error', (error) => {
      this.settleClose({ code: null, signal: null, error })
    })
    this.child.stdin.once('error', (error) => {
      this.closeOnIoError(error)
    })
    this.child.stdout.once('error', (error) => {
      this.closeOnIoError(error)
    })
    this.child.once('exit', (code, signal) => {
      this.settleClose({ code, signal })
    })
  }

  get closed(): boolean {
    return this.closeState !== undefined
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (close: TransportClose) => void): () => void {
    const close = this.closeState
    if (close !== undefined) {
      queueMicrotask(() => listener(close))
      return () => undefined
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async send(message: OutboundMessage): Promise<void> {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new AppServerTransportError('Codex App Server stdio is closed')
    }

    const line = `${JSON.stringify(message)}\n`
    let accepted: boolean
    try {
      accepted = this.child.stdin.write(line, 'utf8')
    } catch (error) {
      throw new AppServerTransportError('failed to write to Codex App Server', {
        cause: error,
      })
    }
    if (!accepted) {
      await this.waitForDrain()
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    if (this.closed) return

    this.closePromise = this.closeChild()
    return this.closePromise
  }

  private handleLine(line: string): void {
    if (line.trim() === '') return
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      const error = new AppServerTransportError(
        `Codex App Server emitted a line larger than ${this.maxLineBytes} bytes`,
      )
      this.settleClose({ code: null, signal: null, error })
      this.child.kill('SIGTERM')
      return
    }

    let message: unknown
    try {
      message = JSON.parse(line) as unknown
    } catch (error) {
      const protocolError = new AppServerTransportError(
        'Codex App Server emitted invalid JSONL',
        { cause: error },
      )
      this.settleClose({ code: null, signal: null, error: protocolError })
      this.child.kill('SIGTERM')
      return
    }

    for (const listener of this.messageListeners) listener(message)
  }

  private settleClose(close: TransportClose): void {
    if (this.closeState !== undefined) return
    this.closeState = close
    this.reader.close()
    for (const listener of this.closeListeners) listener(close)
    this.closeListeners.clear()
    this.messageListeners.clear()
  }

  private closeOnIoError(error: Error): void {
    this.settleClose({ code: null, signal: null, error })
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM')
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup()
        resolve()
      }
      const onClose = (): void => {
        cleanup()
        reject(new AppServerTransportError('Codex App Server stdin closed before drain'))
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(
          new AppServerTransportError('Codex App Server stdin failed before drain', {
            cause: error,
          }),
        )
      }
      const cleanup = (): void => {
        this.child.stdin.off('drain', onDrain)
        this.child.stdin.off('close', onClose)
        this.child.stdin.off('error', onError)
      }

      this.child.stdin.once('drain', onDrain)
      this.child.stdin.once('close', onClose)
      this.child.stdin.once('error', onError)
    })
  }

  private async closeChild(): Promise<void> {
    if (this.closed) return

    this.child.stdin.end()
    this.child.kill('SIGTERM')

    const exited = new Promise<void>((resolve) => {
      if (this.closed) {
        resolve()
        return
      }
      const unsubscribe = this.onClose(() => {
        unsubscribe()
        resolve()
      })
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.shutdownTimeoutMs)
    })
    await Promise.race([exited, timedOut])
    if (timer !== undefined) clearTimeout(timer)

    if (!this.closed) {
      this.child.kill('SIGKILL')
      await exited
    }
  }
}
