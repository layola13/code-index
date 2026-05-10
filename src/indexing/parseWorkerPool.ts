import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Worker } from 'node:worker_threads'
import type { DiscoveredSourceFile } from './discovery.js'
import type { ModuleIR } from './ir.js'
import type { BuiltinParseRequest } from './parseBuiltin.js'
import { parseModuleWithBuiltinParsers } from './parseBuiltin.js'
import type { LoadedSource } from './source.js'

type ParseWorkerResponse =
  | {
      ok: true
      module: ModuleIR
    }
  | {
      ok: false
      error: string
    }

type PendingRequest = {
  reject: (error: Error) => void
  resolve: (module: ModuleIR) => void
}

const WORKER_ENTRY_ENV = 'CLAUDE_CODE_INDEX_PARSE_WORKER_ENTRY'

function resolveWorkerEntry(): URL {
  const envOverride = process.env[WORKER_ENTRY_ENV]
  if (envOverride) {
    const resolvedOverride = resolve(process.cwd(), envOverride)
    if (existsSync(resolvedOverride)) {
      return pathToFileURL(resolvedOverride)
    }
  }

  const candidates = [
    resolve(process.cwd(), 'src/commands/index/parseWorker.bundle.mjs'),
    resolve(dirname(process.execPath), '../src/commands/index/parseWorker.bundle.mjs'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../commands/index/parseWorker.bundle.mjs'),
    resolve(process.cwd(), 'src/indexing/parseWorker.ts'),
    resolve(dirname(process.execPath), '../src/indexing/parseWorker.ts'),
    resolve(dirname(fileURLToPath(import.meta.url)), 'parseWorker.ts'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return pathToFileURL(candidate)
    }
  }

  throw new Error('unable to resolve index parse worker entry')
}

class ParseWorkerClient {
  private readonly worker: Worker
  private closed = false
  private pending: PendingRequest | null = null

  constructor() {
    this.worker = new Worker(resolveWorkerEntry())
    this.worker.on('message', this.handleMessage)
    this.worker.on('error', this.handleError)
    this.worker.on('exit', this.handleExit)
  }

  parse(request: BuiltinParseRequest): Promise<ModuleIR> {
    if (this.closed) {
      return Promise.reject(new Error('parse worker is closed'))
    }
    if (this.pending) {
      return Promise.reject(new Error('parse worker received overlapping request'))
    }

    return new Promise<ModuleIR>((resolve, reject) => {
      this.pending = { resolve, reject }
      this.worker.postMessage(request)
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.worker.off('message', this.handleMessage)
    this.worker.off('error', this.handleError)
    this.worker.off('exit', this.handleExit)

    const pending = this.pending
    this.pending = null
    pending?.reject(new Error('parse worker closed before request completed'))

    await this.worker.terminate()
  }

  private readonly handleMessage = (message: ParseWorkerResponse): void => {
    const pending = this.pending
    this.pending = null
    if (!pending) {
      return
    }

    if (message.ok) {
      pending.resolve(message.module)
      return
    }

    pending.reject(new Error(message.error))
  }

  private readonly handleError = (error: Error): void => {
    const pending = this.pending
    this.pending = null
    pending?.reject(error)
  }

  private readonly handleExit = (code: number): void => {
    if (this.closed || code === 0) {
      return
    }

    const pending = this.pending
    this.pending = null
    pending?.reject(new Error(`parse worker exited with code ${code}`))
  }
}

export async function parseModulesWithWorkerPool(args: {
  files: readonly DiscoveredSourceFile[]
  maxFileBytes: number
  sources?: ReadonlyMap<string, LoadedSource | undefined>
  onParsed?: () => void | Promise<void>
  workerCount: number
}): Promise<ModuleIR[]> {
  if (args.files.length === 0) {
    return []
  }

  if (typeof process.versions.bun === 'string') {
    const modules: ModuleIR[] = []
    for (const file of args.files) {
      const source = args.sources?.get(file.relativePath)
      modules.push(
        await parseModuleWithBuiltinParsers({
          file,
          source,
          maxFileBytes: args.maxFileBytes,
        }),
      )
      await args.onParsed?.()
    }
    return modules
  }

  const workerCount = Math.max(1, Math.min(args.workerCount, args.files.length))
  const results = new Array<ModuleIR>(args.files.length)
  const workers = Array.from({ length: workerCount }, () => new ParseWorkerClient())
  let nextIndex = 0

  try {
    await Promise.all(
      workers.map(async worker => {
        while (true) {
          const currentIndex = nextIndex
          nextIndex++
          if (currentIndex >= args.files.length) {
            break
          }

          results[currentIndex] = await worker.parse({
            file: args.files[currentIndex]!,
            source: args.sources?.get(args.files[currentIndex]!.relativePath),
            maxFileBytes: args.maxFileBytes,
          })
          await args.onParsed?.()
        }
      }),
    )
    return results
  } finally {
    await Promise.all(workers.map(worker => worker.close()))
  }
}
