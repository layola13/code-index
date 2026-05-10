export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error))
}
