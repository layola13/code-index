export type CodeIndexBuildPhase =
  | 'discover'
  | 'parse'
  | 'emit'
  | 'edges'
  | 'write'
  | 'skills'
  | 'complete'

export type CodeIndexBuildProgress = {
  phase: CodeIndexBuildPhase
  message: string
  completed?: number
  total?: number
}

export type CodeIndexProgressCallback = (
  progress: CodeIndexBuildProgress,
) => void | Promise<void>
