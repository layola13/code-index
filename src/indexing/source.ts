import { open, readFile, stat } from 'fs/promises'

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

export type LoadedSource = {
  text: string
  byteSize: number
  truncated: boolean
  originPath?: string
  originStartLine?: number
  originStartCharacter?: number
}

export type SourceTextSample = {
  headText: string
  tailText: string
}

export function normalizeSourceText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return withoutBom.replace(/\r\n?/g, '\n')
}

export function createLoadedSource(
  text: string,
  metadata: Pick<
    LoadedSource,
    'originPath' | 'originStartLine' | 'originStartCharacter'
  > = {},
): LoadedSource {
  const normalized = normalizeSourceText(text)
  return {
    text: normalized,
    byteSize: Buffer.byteLength(normalized, 'utf8'),
    truncated: false,
    ...metadata,
  }
}

export async function readSourceText(
  filePath: string,
  maxBytes: number,
): Promise<LoadedSource> {
  const fileStat = await stat(filePath)
  const byteSize = fileStat.size

  if (byteSize <= maxBytes) {
    const buffer = await readFile(filePath)
    return {
      text: normalizeSourceText(utf8Decoder.decode(buffer)),
      byteSize,
      truncated: false,
    }
  }

  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return {
      text: normalizeSourceText(
        utf8Decoder.decode(buffer.subarray(0, bytesRead)),
      ),
      byteSize,
      truncated: true,
    }
  } finally {
    await handle.close()
  }
}

export async function readSourceTextForSearch(
  filePath: string,
): Promise<string> {
  const text = await readFile(filePath, 'utf8')
  return normalizeSourceText(text)
}

export async function readSourceTextSampleParts(
  filePath: string,
  headBytes: number,
  tailBytes: number = headBytes,
): Promise<SourceTextSample> {
  const fileStat = await stat(filePath)
  const byteSize = fileStat.size
  const sampleBytes = Math.max(1, headBytes + tailBytes)

  if (byteSize <= sampleBytes) {
    return {
      headText: await readSourceTextForSearch(filePath),
      tailText: '',
    }
  }

  const handle = await open(filePath, 'r')
  try {
    const headBuffer = Buffer.alloc(headBytes)
    const tailBuffer = Buffer.alloc(tailBytes)

    const headRead = await handle.read(headBuffer, 0, headBytes, 0)
    const tailStart = Math.max(0, byteSize - tailBytes)
    const tailRead = await handle.read(tailBuffer, 0, tailBytes, tailStart)

    const headText = normalizeSourceText(
      utf8Decoder.decode(headBuffer.subarray(0, headRead.bytesRead)),
    )
    const tailText = normalizeSourceText(
      utf8Decoder.decode(tailBuffer.subarray(0, tailRead.bytesRead)),
    )

    return { headText, tailText }
  } finally {
    await handle.close()
  }
}

export async function readSourceTextSample(
  filePath: string,
  headBytes: number,
  tailBytes: number = headBytes,
): Promise<string> {
  const sample = await readSourceTextSampleParts(filePath, headBytes, tailBytes)
  if (!sample.headText) {
    return sample.tailText
  }
  if (!sample.tailText) {
    return sample.headText
  }

  return `${sample.headText}\n${sample.tailText}`
}
