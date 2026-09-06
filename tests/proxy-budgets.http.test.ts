import { createServer, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCcSwitchCompatibilityProxy, type CcSwitchProxyHandle, type CcSwitchProxyOptions } from '../src/cc-switch-proxy.js'

const proxies: CcSwitchProxyHandle[] = []
const upstreams: Server[] = []
const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

function later(milliseconds: number, callback: () => void): void {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer)
    callback()
  }, milliseconds)
  pendingTimers.add(timer)
}

afterEach(async () => {
  for (const timer of pendingTimers) clearTimeout(timer)
  pendingTimers.clear()
  for (const proxy of proxies.splice(0)) await proxy.dispose()
  for (const upstream of upstreams.splice(0)) {
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})

async function serve(handler: RequestListener, options: CcSwitchProxyOptions = {}) {
  const upstream = createServer(handler)
  upstreams.push(upstream)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('test upstream did not bind')
  const logger = { info: vi.fn(), warn: vi.fn() }
  const proxy = await startCcSwitchCompatibilityProxy(
    `http://127.0.0.1:${String(address.port)}/v1`, 0, logger,
    { ...options, limits: { connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, ...options.limits } },
  )
  proxies.push(proxy)
  return { proxy, logger }
}

function fetchReply(proxy: CcSwitchProxyHandle, signal = AbortSignal.timeout(3000)) {
  return fetch(`${proxy.endpoint}/chat/completions`, {
    method: 'POST', body: '{}', signal,
  })
}

describe('bounded proxy with real loopback HTTP streams', () => {
  it.each([false, true])('returns 504 for a silent response body (headers sent: %s) and closes upstream', async headersSent => {
    let upstreamClosed = false
    const { proxy, logger } = await serve((request, response) => {
      request.resume()
      response.once('close', () => { upstreamClosed = true })
      if (headersSent) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '999' })
        response.flushHeaders()
      }
    }, { limits: { firstByteTimeoutMs: 80 } })
    const response = await fetchReply(proxy)
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'local MLX upstream first-byte timeout' })
    expect(response.headers.get('content-length')).not.toBe('999')
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('does not apply the shorter idle budget during prefill, including after response headers', async () => {
    const { proxy } = await serve((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      later(120, () => response.end('data: [DONE]\n\n'))
    }, { limits: { firstByteTimeoutMs: 1000, idleTimeoutMs: 40 } })
    const response = await fetchReply(proxy)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: [DONE]\n\n')
  })

  it('keeps progressing streams alive beyond the first-body budget', async () => {
    const { proxy } = await serve((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let sent = 0
      const send = (): void => {
        response.write(`data: ${String(sent)}\n\n`)
        if (++sent === 8) response.end('data: [DONE]\n\n')
        else later(40, send)
      }
      send()
    }, { limits: { firstByteTimeoutMs: 150, idleTimeoutMs: 200 } })
    const response = await fetchReply(proxy)
    expect(await response.text()).toBe(Array.from({ length: 8 }, (_, i) => `data: ${String(i)}\n\n`).join('') + 'data: [DONE]\n\n')
  })

  it('terminates an idle partial response without appending an error to SSE', async () => {
    let upstreamClosed = false
    const firstEvent = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
    const { proxy, logger } = await serve((request, response) => {
      request.resume()
      response.once('close', () => { upstreamClosed = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(firstEvent)
    }, { limits: { idleTimeoutMs: 80 } })
    const response = await fetchReply(proxy)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    let received = ''
    let interrupted = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += Buffer.from(value).toString('utf8')
      }
    } catch {
      interrupted = true
    }
    expect(interrupted).toBe(true)
    expect(received).toBe(firstEvent)
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('idle timeout'))
  })

  it.each(['\n\n', ''])('rejects an oversized first SSE event with separator %j and closes upstream', async separator => {
    let upstreamClosed = false
    const { proxy } = await serve((request, response) => {
      request.resume()
      response.once('close', () => { upstreamClosed = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + 'x'.repeat(70) + separator)
    }, { limits: { maxSseEventBytes: 64 } })
    const response = await fetchReply(proxy)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'local MLX upstream SSE event too large' })
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
  })

  it('counts UTF-8 bytes per event and preserves split characters, CRLF and multiple events', async () => {
    const event = 'data: {"choices":[{"delta":{"content":"世界","reasoning_content":null,"reasoning":null}}]}\r\n\r\n'
    const bytes = Buffer.from(event)
    const split = bytes.indexOf(Buffer.from('世界')) + 1
    const { proxy } = await serve((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(bytes.subarray(0, split))
      later(20, () => response.end(Buffer.concat([bytes.subarray(split), bytes, Buffer.from('data: [DONE]\r\n\r\n')])))
    }, { limits: { maxSseEventBytes: bytes.length } })
    const response = await fetchReply(proxy)
    expect(await response.text()).toBe(event.replace(',"reasoning":null', '').repeat(2) + 'data: [DONE]\r\n\r\n')
  })

  it('rejects multibyte input by bytes even when its character count fits', async () => {
    const event = 'data: 世界世界世界\n\n'
    const { proxy } = await serve((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(event)
    }, { limits: { maxSseEventBytes: event.length } })
    const response = await fetchReply(proxy)
    expect(response.status).toBe(502)
  })

  it('bounds an unfinished event across chunks after a valid event, preserving the valid prefix on failure', async () => {
    const firstEvent = 'data: valid\n\n'
    let upstreamClosed = false
    const { proxy } = await serve((request, response) => {
      request.resume()
      response.once('close', () => { upstreamClosed = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(firstEvent + 'data: ' + 'x'.repeat(40))
      later(20, () => response.write('x'.repeat(40)))
    }, { limits: { maxSseEventBytes: 64 } })
    const response = await fetchReply(proxy)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    let received = ''
    await expect((async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        received += Buffer.from(value).toString('utf8')
      }
    })()).rejects.toThrow()
    expect(received).toBe(firstEvent)
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
  })

  it('forwards non-SSE responses without an aggregate body buffer or SSE event cap', async () => {
    const body = JSON.stringify({ text: 'x'.repeat(8192) })
    const { proxy } = await serve((request, response) => {
      request.resume()
      response.writeHead(201, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
      response.end(body)
    }, { limits: { maxSseEventBytes: 16 } })
    const response = await fetchReply(proxy)
    expect(response.status).toBe(201)
    expect(await response.text()).toBe(body)
  })

  it('handles an interrupted upstream without an unhandled stream error', async () => {
    const { proxy, logger } = await serve((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: incomplete')
      later(20, () => response.destroy())
    })
    const response = await fetchReply(proxy)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'local MLX upstream response interrupted' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it.each(['client-abort', 'proxy-dispose'])('releases upstream on %s without waiting for a deadline', async action => {
    let started!: () => void
    const upstreamStarted = new Promise<void>(resolve => { started = resolve })
    let upstreamClosed = false
    const { proxy, logger } = await serve((request, response) => {
      request.resume()
      response.once('close', () => { upstreamClosed = true })
      started()
    })
    const abort = new AbortController()
    const pending = fetchReply(proxy, abort.signal).then(() => false, () => true)
    await upstreamStarted
    if (action === 'client-abort') abort.abort()
    else await proxy.dispose()
    expect(await pending).toBe(true)
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
    expect(logger.warn).not.toHaveBeenCalled()
    if (action === 'proxy-dispose') proxies.splice(proxies.indexOf(proxy), 1)
  })

  it('returns 413 immediately for a rewritten request over the existing 16 MiB input cap', async () => {
    const { proxy } = await serve((request, response) => {
      request.resume()
      request.once('end', () => response.end('should not run'))
    }, { chatOnly: true })
    const response = await fetch(`${proxy.endpoint}/chat/completions`, {
      method: 'POST', body: 'x'.repeat(16 * 1024 * 1024 + 1), signal: AbortSignal.timeout(3000),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'local compatibility request too large' })
  })
})
