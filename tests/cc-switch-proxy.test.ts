import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeCcSwitchOpenAiChunk,
  normalizeCcSwitchSseBlock,
  sanitizeCcSwitchChatRequest,
  startCcSwitchCompatibilityProxy,
  type CcSwitchProxyHandle,
} from '../src/cc-switch-proxy.js'

let proxy: CcSwitchProxyHandle | undefined

afterEach(async () => {
  await proxy?.dispose()
  proxy = undefined
})

describe('CC Switch SSE compatibility', () => {
  it('removes only the duplicate legacy reasoning alias', () => {
    const value = {
      choices: [{ delta: { content: '81', reasoning_content: null, reasoning: null, role: 'assistant' } }],
      timings: { predicted_per_second: 9.3 },
    }
    expect(normalizeCcSwitchOpenAiChunk(value)).toEqual({
      choices: [{ delta: { content: '81', reasoning_content: null, role: 'assistant' } }],
      timings: { predicted_per_second: 9.3 },
    })
  })

  it('preserves a non-null legacy reasoning payload and malformed SSE lines', () => {
    const input = [
      'event: chunk',
      'data: {"choices":[{"delta":{"reasoning_content":null,"reasoning":"think"}}]}',
      '',
      'data: not-json',
      '',
    ].join('\n')
    expect(normalizeCcSwitchSseBlock(input)).toContain(
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
    )
    expect(normalizeCcSwitchSseBlock(input)).toContain('data: not-json')
  })

  it('replaces agent instructions and removes tool routing without changing user text', () => {
    const result = sanitizeCcSwitchChatRequest({
      model: 'local',
      messages: [
        { role: 'system', content: 'agent prompt' },
        { role: 'developer', content: 'more agent prompt' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'working', tool_calls: [{ id: 'call-1' }] },
        { role: 'tool', content: 'private result' },
      ],
      tools: [{ type: 'function' }, { type: 'function' }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    })
    expect(result.removedTools).toBe(2)
    expect(result.replacedAgentMessages).toBe(2)
    expect(result.removedToolMessages).toBe(1)
    expect(result.value).toMatchObject({
      model: 'local',
      messages: [
        { role: 'system' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'working' },
      ],
    })
    expect(JSON.stringify(result.value)).not.toContain('agent prompt')
    expect(JSON.stringify(result.value)).not.toContain('tool_calls')
  })

  it('forwards a rewritten chat-only request with a valid body length', async () => {
    let received: unknown
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.once('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('test upstream did not bind')

    try {
      proxy = await startCcSwitchCompatibilityProxy(
        `http://127.0.0.1:${String(address.port)}/v1`,
        0,
        { info: vi.fn(), warn: vi.fn() },
        { chatOnly: true },
      )
      const response = await fetch(`${proxy.endpoint}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'local',
          messages: [{ role: 'system', content: 'agent' }, { role: 'user', content: 'hello' }],
          tools: [{ type: 'function' }],
        }),
        headers: { 'content-type': 'application/json' },
      })
      expect(response.status).toBe(200)
      expect(received).toMatchObject({
        model: 'local',
        messages: [{ role: 'system' }, { role: 'user', content: 'hello' }],
      })
      expect(JSON.stringify(received)).not.toContain('"tools"')
      expect(JSON.stringify(received)).not.toContain('agent')
    } finally {
      upstream.closeAllConnections?.()
      await new Promise<void>((resolve, reject) => upstream.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('proxies streaming responses on loopback and keeps content plus DONE', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write('data: {"choices":[{"delta":{"content":"8","reasoning_content":null,')
      response.write('"reasoning":null}}]}\n\n')
      response.end('data: [DONE]\n\n')
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('test upstream did not bind')

    try {
      proxy = await startCcSwitchCompatibilityProxy(
        `http://127.0.0.1:${String(address.port)}/v1`,
        0,
        { info: vi.fn(), warn: vi.fn() },
      )
      const response = await fetch(`${proxy.endpoint}/chat/completions`, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      })
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain('"content":"8"')
      expect(body).toContain('"reasoning_content":null')
      expect(body).not.toContain('"reasoning":null')
      expect(body).toContain('data: [DONE]')
    } finally {
      upstream.closeAllConnections?.()
      await new Promise<void>((resolve, reject) => upstream.close(error => error === undefined ? resolve() : reject(error)))
    }
  })
})
