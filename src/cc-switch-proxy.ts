import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import { Transform, type TransformCallback } from 'node:stream'
import { createUpstreamBudget, resolveProxyLimits, type CcSwitchProxyLimits } from './proxy-budgets.js'

const LOOPBACK_HOST = '127.0.0.1'

export interface CcSwitchProxyLogger {
  info(message: string): void
  warn(message: string): void
}

export interface CcSwitchProxyHandle {
  readonly endpoint: string
  dispose(): Promise<void>
}

export interface CcSwitchProxyOptions {
  /** Replace agent instructions and remove tool traffic, keeping Claude Desktop chat-only. */
  readonly chatOnly?: boolean
  /** Log only request shape and timing; never message text, headers, or credentials. */
  readonly diagnostics?: boolean
  /** Bounded upstream waits and per-event buffering; partial overrides retain generous defaults. */
  readonly limits?: Partial<CcSwitchProxyLimits>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * CC Switch 3.20.x aliases `reasoning_content` to `reasoning` while decoding
 * OpenAI SSE chunks. Some MLX-VLM releases emit both keys, which serde treats
 * as a duplicate field and drops. Keep the preferred key and preserve a
 * non-null legacy value if that is the only reasoning payload.
 */
export function normalizeCcSwitchOpenAiChunk(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.choices)) return value
  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue
    const delta = choice.delta
    const hasPreferred = Object.prototype.hasOwnProperty.call(delta, 'reasoning_content')
    const hasLegacy = Object.prototype.hasOwnProperty.call(delta, 'reasoning')
    if (!hasPreferred || !hasLegacy) continue
    if (delta.reasoning_content == null && delta.reasoning != null) {
      delta.reasoning_content = delta.reasoning
    }
    delete delta.reasoning
  }
  return value
}

/** Replace agent instructions while preserving user and ordinary assistant message text. */
export interface ChatSanitizationResult {
  readonly value: unknown
  readonly removedTools: number
  readonly replacedAgentMessages: number
  readonly removedToolMessages: number
}

const CHAT_ONLY_SYSTEM_PROMPT = [
  'You are a local chat assistant.',
  "Answer the user's message directly and concisely in the same language.",
  'Do not use tools, access files, or claim actions you did not perform.',
].join(' ')

export function sanitizeCcSwitchChatRequest(value: unknown): ChatSanitizationResult {
  if (!isRecord(value)) {
    return { value, removedTools: 0, replacedAgentMessages: 0, removedToolMessages: 0 }
  }
  const removedTools = Array.isArray(value.tools) ? value.tools.length : 0
  delete value.tools
  delete value.tool_choice
  delete value.parallel_tool_calls

  let replacedAgentMessages = 0
  let removedToolMessages = 0
  if (Array.isArray(value.messages)) {
    const conversation: Record<string, unknown>[] = []
    for (const message of value.messages) {
      if (!isRecord(message)) continue
      if (message.role === 'system' || message.role === 'developer') {
        replacedAgentMessages += 1
        continue
      }
      if (message.role === 'tool') {
        removedToolMessages += 1
        continue
      }
      const cleanMessage = { ...message }
      delete cleanMessage.tool_calls
      delete cleanMessage.function_call
      conversation.push(cleanMessage)
    }
    value.messages = [{ role: 'system', content: CHAT_ONLY_SYSTEM_PROMPT }, ...conversation]
  }
  return { value, removedTools, replacedAgentMessages, removedToolMessages }
}

function normalizeDataLine(line: string): string {
  const match = /^(data:\s*)(.*)$/.exec(line)
  if (match === null || match[2] === '[DONE]') return line
  try {
    const parsed: unknown = JSON.parse(match[2])
    return `${match[1]}${JSON.stringify(normalizeCcSwitchOpenAiChunk(parsed))}`
  } catch {
    return line
  }
}

/** Normalize complete SSE text while preserving its newline convention. */
export function normalizeCcSwitchSseBlock(block: string): string {
  const newline = block.includes('\r\n') ? '\r\n' : '\n'
  return block.split(/\r?\n/).map(normalizeDataLine).join(newline)
}

function takeSseBlock(buffer: string): { block: string, rest: string } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer)
  if (match === null) return undefined
  const end = match.index + match[0].length
  return { block: buffer.slice(0, end), rest: buffer.slice(end) }
}

class CcSwitchSseNormalizer extends Transform {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  constructor(private readonly maxEventBytes: number) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.buffer += this.decoder.write(chunk)
      this.flushCompleteBlocks()
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.buffer += this.decoder.end()
      this.flushCompleteBlocks()
      if (this.buffer.length > 0) this.push(normalizeCcSwitchSseBlock(this.buffer))
      this.buffer = ''
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  private flushCompleteBlocks(): void {
    while (true) {
      const next = takeSseBlock(this.buffer)
      if (Buffer.byteLength(next?.block ?? this.buffer, 'utf8') > this.maxEventBytes) {
        throw new Error('local MLX upstream SSE event too large')
      }
      if (next === undefined) return
      this.push(normalizeCcSwitchSseBlock(next.block))
      this.buffer = next.rest
    }
  }
}

function responseHeaders(headers: IncomingHttpHeaders, transformed: boolean): IncomingHttpHeaders {
  const result = { ...headers }
  if (transformed) {
    delete result['content-length']
    delete result['transfer-encoding']
  }
  return result
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
    server.closeAllConnections?.()
  })
}

/**
 * Start a loopback-only reverse proxy that makes MLX-VLM OpenAI SSE compatible
 * with CC Switch without changing the model server or the signed desktop app.
 */
export async function startCcSwitchCompatibilityProxy(
  upstreamEndpoint: string,
  listenPort: number,
  logger: CcSwitchProxyLogger,
  options: CcSwitchProxyOptions = {},
): Promise<CcSwitchProxyHandle> {
  const upstream = new URL(upstreamEndpoint)
  if (upstream.protocol !== 'http:' || upstream.hostname !== LOOPBACK_HOST) {
    throw new Error('dsh-llm-mlx: CC Switch compatibility proxy requires a 127.0.0.1 HTTP upstream')
  }
  const limits = resolveProxyLimits(options.limits)
  const activeRequests = new Set<() => void>()

  const server = createServer((clientRequest, clientResponse) => {
    const requestStartedAt = Date.now()
    let requested: URL
    try {
      requested = new URL(clientRequest.url ?? '/', 'http://loopback.invalid')
    } catch {
      clientRequest.once('error', () => clientResponse.destroy())
      clientRequest.resume()
      clientResponse.writeHead(400, { 'content-type': 'application/json', connection: 'close' })
      clientResponse.end(JSON.stringify({ error: 'invalid local compatibility request URL' }))
      return
    }
    const sanitizeChatRequest = options.chatOnly === true
      && clientRequest.method === 'POST'
      && requested.pathname.endsWith('/chat/completions')
    const forwardedHeaders: IncomingHttpHeaders = {
      ...clientRequest.headers,
      host: `${LOOPBACK_HOST}:${upstream.port}`,
    }
    if (sanitizeChatRequest) {
      delete forwardedHeaders['content-length']
      delete forwardedHeaders['transfer-encoding']
    }
    let upstreamResponseStream: import('node:http').IncomingMessage | undefined
    let normalizer: CcSwitchSseNormalizer | undefined
    let settled = false
    const cancelUpstream = (): void => {
      if (settled) return
      settled = true
      budget.finish()
      activeRequests.delete(cancelUpstream)
      clientRequest.unpipe(upstreamRequest)
      upstreamResponseStream?.unpipe()
      normalizer?.unpipe()
      normalizer?.destroy()
      upstreamRequest.destroy()
      upstreamResponseStream?.destroy()
    }
    const fail = (status: number, message: string): void => {
      if (settled) return
      cancelUpstream()
      logger.warn(`dsh-llm-mlx: CC Switch compatibility ${message}`)
      if (clientResponse.destroyed) return
      if (clientResponse.headersSent) {
        // A partial SSE/JSON response cannot safely be replaced or appended to.
        clientResponse.destroy()
        return
      }
      for (const name of clientResponse.getHeaderNames()) clientResponse.removeHeader(name)
      clientResponse.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
      clientResponse.end(JSON.stringify({ error: message }))
    }
    const budget = createUpstreamBudget(limits, phase => {
      fail(504, `local MLX upstream ${phase} timeout`)
    })
    activeRequests.add(cancelUpstream)
    const upstreamRequest = httpRequest({
      hostname: LOOPBACK_HOST,
      port: upstream.port,
      method: clientRequest.method,
      path: `${requested.pathname}${requested.search}`,
      headers: forwardedHeaders,
    }, upstreamResponse => {
      if (settled) {
        upstreamResponse.destroy()
        return
      }
      upstreamResponseStream = upstreamResponse
      upstreamResponse.on('data', () => budget.bodyReceived())
      upstreamResponse.once('end', () => budget.finish())
      upstreamResponse.once('aborted', () => fail(502, 'local MLX upstream response interrupted'))
      upstreamResponse.once('error', () => fail(502, 'local MLX upstream response unavailable'))
      if (options.diagnostics === true) {
        logger.info(`dsh-llm-mlx: CC Switch diagnostic upstream headers status=${String(upstreamResponse.statusCode ?? 0)} elapsedMs=${String(Date.now() - requestStartedAt)}`)
        upstreamResponse.once('data', chunk => {
          logger.info(`dsh-llm-mlx: CC Switch diagnostic first upstream body bytes=${String(chunk.length)} elapsedMs=${String(Date.now() - requestStartedAt)}`)
        })
      }
      const transformed = upstreamResponse.headers['content-type']?.toLowerCase().startsWith('text/event-stream') ?? false
      // Defer sending headers until data/end, so pre-body failures still get a valid JSON error.
      clientResponse.statusCode = upstreamResponse.statusCode ?? 502
      for (const [name, value] of Object.entries(responseHeaders(upstreamResponse.headers, transformed))) {
        if (value !== undefined) clientResponse.setHeader(name, value)
      }
      if (transformed) {
        normalizer = new CcSwitchSseNormalizer(limits.maxSseEventBytes)
        normalizer.once('error', () => fail(502, 'local MLX upstream SSE event too large'))
        upstreamResponse.pipe(normalizer).pipe(clientResponse)
      } else {
        upstreamResponse.pipe(clientResponse)
      }
    })

    upstreamRequest.once('socket', socket => {
      if (socket.connecting) socket.once('connect', () => budget.connected())
      else budget.connected()
    })
    upstreamRequest.once('finish', () => budget.requestFinished())
    upstreamRequest.once('error', () => fail(502, 'local MLX upstream unavailable'))
    clientRequest.once('aborted', cancelUpstream)
    clientRequest.once('error', () => {
      cancelUpstream()
      clientResponse.destroy()
    })
    clientResponse.once('finish', cancelUpstream)
    clientResponse.once('close', cancelUpstream)

    if (!sanitizeChatRequest) {
      clientRequest.pipe(upstreamRequest)
      return
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    const maxBodyBytes = 16 * 1024 * 1024
    clientRequest.on('data', (chunk: Buffer) => {
      if (settled) return
      totalBytes += chunk.length
      if (totalBytes > maxBodyBytes) {
        chunks.length = 0
        fail(413, 'local compatibility request too large')
      } else {
        chunks.push(chunk)
      }
    })
    clientRequest.once('end', () => {
      if (settled) return
      const body = Buffer.concat(chunks)
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'))
        if (options.diagnostics === true && isRecord(parsed)) {
          logger.info([
            'dsh-llm-mlx: CC Switch diagnostic request',
            `model=${typeof parsed.model === 'string' ? parsed.model : 'unknown'}`,
            `stream=${String(parsed.stream === true)}`,
            `maxTokens=${typeof parsed.max_tokens === 'number' ? String(parsed.max_tokens) : 'unset'}`,
            `messages=${Array.isArray(parsed.messages) ? String(parsed.messages.length) : '0'}`,
            `tools=${Array.isArray(parsed.tools) ? String(parsed.tools.length) : '0'}`,
          ].join(' '))
        }
        const sanitized = sanitizeCcSwitchChatRequest(parsed)
        const payload = Buffer.from(JSON.stringify(sanitized.value))
        upstreamRequest.setHeader('content-length', String(payload.length))
        if (sanitized.removedTools > 0) {
          logger.info(`dsh-llm-mlx: CC Switch chat-only mode removed ${String(sanitized.removedTools)} tool declarations`)
        }
        if (sanitized.replacedAgentMessages > 0 || sanitized.removedToolMessages > 0) {
          logger.info(`dsh-llm-mlx: CC Switch chat-only mode replaced ${String(sanitized.replacedAgentMessages)} agent messages and removed ${String(sanitized.removedToolMessages)} tool messages`)
        }
        upstreamRequest.end(payload)
      } catch {
        upstreamRequest.setHeader('content-length', String(body.length))
        upstreamRequest.end(body)
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(listenPort, LOOPBACK_HOST, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('dsh-llm-mlx: CC Switch compatibility proxy did not bind a TCP port')
  }
  const endpoint = `http://${LOOPBACK_HOST}:${String(address.port)}/v1`
  logger.info(`dsh-llm-mlx: CC Switch SSE compatibility proxy is listening at ${endpoint}`)
  return {
    endpoint,
    dispose: async () => {
      for (const cancel of activeRequests) cancel()
      await closeServer(server)
    },
  }
}
