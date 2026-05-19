import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { searchHistoryEntries } from './historySearch.js'

async function createTempCodexHome(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'code-index-history-search-'))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
  }
  return root
}

describe('history search', () => {
  it('prefers the current session and returns immediately when it matches', async () => {
    const currentSession = '019e3f73-30d8-7b52-b0b4-a0a0ea73bc1e'
    const codexHome = await createTempCodexHome({
      'sessions/2026/05/19/rollout-2026-05-19T16-00-00-019e3f73-30d8-7b52-b0b4-a0a0ea73bc1e.jsonl': [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: currentSession, timestamp: '2026-05-19T08:56:14.312Z' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'target phrase current session',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'assistant reply current session' }],
          },
        }),
        '',
      ].join('\n'),
      'sessions/2025/09/29/rollout-2025-09-29T23-31-08-01999619-5b1e-7f40-8ad9-f058fc6cf7f6.jsonl': [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: '01999619-5b1e-7f40-8ad9-f058fc6cf7f6', timestamp: '2025-09-29T15:31:08.190Z' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'target phrase older session',
          },
        }),
        '',
      ].join('\n'),
    })

    const result = await searchHistoryEntries({
      query: 'target phrase current session',
      codexHome,
      currentSessionId: currentSession,
    })

    expect(result.count).toBe(1)
    expect(result.totalCount).toBe(1)
    expect(result.items[0]?.sessionId).toBe(currentSession)
    expect(result.items[0]?.hits.map(hit => hit.text)).toEqual([
      'target phrase current session',
    ])
  })

  it('falls back to older sessions when the current session has no hits', async () => {
    const currentSession = '019e3f73-30d8-7b52-b0b4-a0a0ea73bc1e'
    const codexHome = await createTempCodexHome({
      'sessions/2026/05/19/rollout-2026-05-19T16-00-00-019e3f73-30d8-7b52-b0b4-a0a0ea73bc1e.jsonl': [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: currentSession, timestamp: '2026-05-19T08:56:14.312Z' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'no relevant terms here',
          },
        }),
        '',
      ].join('\n'),
      'sessions/2025/09/29/rollout-2025-09-29T23-31-08-01999619-5b1e-7f40-8ad9-f058fc6cf7f6.jsonl': [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: '01999619-5b1e-7f40-8ad9-f058fc6cf7f6', timestamp: '2025-09-29T15:31:08.190Z' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'target phrase older session',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'assistant reply older session' }],
          },
        }),
        '',
      ].join('\n'),
    })

    const result = await searchHistoryEntries({
      query: 'target phrase older session',
      codexHome,
      currentSessionId: currentSession,
    })

    expect(result.count).toBe(1)
    expect(result.items[0]?.sessionId).toBe('01999619-5b1e-7f40-8ad9-f058fc6cf7f6')
    expect(result.items[0]?.hits.map(hit => hit.text)).toEqual([
      'target phrase older session',
    ])
  })

  it('ignores malformed lines and noise events', async () => {
    const codexHome = await createTempCodexHome({
      'sessions/2025/09/29/rollout-2025-09-29T23-31-08-01999619-5b1e-7f40-8ad9-f058fc6cf7f6.jsonl': [
        'not-json',
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 1 } },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'target phrase noise test',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'assistant noise reply' }],
          },
        }),
        '',
      ].join('\n'),
    })

    const result = await searchHistoryEntries({
      query: 'target phrase noise test',
      codexHome,
      currentSessionId: '01999619-5b1e-7f40-8ad9-f058fc6cf7f6',
    })

    expect(result.count).toBe(1)
    expect(result.items[0]?.hits.map(hit => hit.text)).toEqual([
      'target phrase noise test',
    ])
  })

  it('dedupes mirrored event and response records', async () => {
    const codexHome = await createTempCodexHome({
      'sessions/2025/09/29/rollout-2025-09-29T23-31-08-01999619-5b1e-7f40-8ad9-f058fc6cf7f6.jsonl': [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: '01999619-5b1e-7f40-8ad9-f058fc6cf7f6', timestamp: '2025-09-29T15:31:08.190Z' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'target phrase mirrored text',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'target phrase mirrored text' }],
          },
        }),
        '',
      ].join('\n'),
    })

    const result = await searchHistoryEntries({
      query: 'target phrase mirrored text',
      codexHome,
      currentSessionId: '01999619-5b1e-7f40-8ad9-f058fc6cf7f6',
    })

    expect(result.count).toBe(1)
    expect(result.items[0]?.hits).toHaveLength(1)
    expect(result.items[0]?.hits[0]?.text).toBe('target phrase mirrored text')
  })
})
