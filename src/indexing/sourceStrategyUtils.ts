export function isGeneratedBundlePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase()
  return /(?:^|\/)(?:bundle-out|dist|build|out|coverage)(?:\/|$)/.test(normalized)
}
