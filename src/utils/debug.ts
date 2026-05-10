export function logForDebugging(
  message: string,
  options?: {
    level?: 'debug' | 'info' | 'warn' | 'error'
  },
): void {
  const prefix = options?.level ? `[${options.level}] ` : '[debug] '
  console.error(`${prefix}${message}`)
}
