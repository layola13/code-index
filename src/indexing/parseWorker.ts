import { parentPort } from 'node:worker_threads'
import {
  parseModuleWithBuiltinParsers,
  type BuiltinParseRequest,
} from './parseBuiltin.js'
import type { ModuleIR } from './ir.js'

type ParseWorkerResponse =
  | {
      ok: true
      module: ModuleIR
    }
  | {
      ok: false
      error: string
    }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (!parentPort) {
  throw new Error('index parse worker requires a parent port')
}

parentPort.on('message', async (request: BuiltinParseRequest) => {
  let response: ParseWorkerResponse
  try {
    response = {
      ok: true,
      module: await parseModuleWithBuiltinParsers(request),
    }
  } catch (error) {
    response = {
      ok: false,
      error: describeError(error),
    }
  }

  parentPort.postMessage(response)
})
