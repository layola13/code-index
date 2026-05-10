import { open, readFile, stat } from 'fs/promises'

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

export type LoadedSource = {
  text: string
  byteSize: number
  truncated: boolean
}

function normalizeDecodedText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return withoutBom.replace(/\r\n?/g, '\n')
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
      text: normalizeDecodedText(utf8Decoder.decode(buffer)),
      byteSize,
      truncated: false,
    }
  }

  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return {
      text: normalizeDecodedText(
        utf8Decoder.decode(buffer.subarray(0, bytesRead)),
      ),
      byteSize,
      truncated: true,
    }
  } finally {
    await handle.close()
  }
}

