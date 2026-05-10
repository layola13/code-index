import type { CodeIndexConfig } from '../config.js'
import type { DiscoveredSourceFile } from '../discovery.js'
import type { ModuleIR } from '../ir.js'
import type { LoadedSource } from '../source.js'

export type ParseContext = {
  config: CodeIndexConfig
  file: DiscoveredSourceFile
  source: LoadedSource
}

export type ModuleParser = (context: ParseContext) => ModuleIR

