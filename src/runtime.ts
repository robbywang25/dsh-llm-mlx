import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import type { ResolvedConfig } from './config.js'

const HEALTH_POLL_MS = 250
const STOP_GRACE_MS = 5_000
const HEALTH_TIMEOUT_MS = 1_000
const MAX_IDENTITY_BYTES = 64 * 1024

export type ModelIdentityStatus = 'matched' | 'mismatched' | 'unavailable'

export interface RuntimeLogger {
  info(message: string): void
  warn(message: string): void
}

export interface RuntimeHandle {
  readonly mode: 'disabled' | 'reused' | 'spawned'
  readonly endpoint: string
  readonly pid?: number
  dispose(): Promise<void>
}

export interface RuntimeDependencies {
  readonly platform: NodeJS.Platform
  readonly arch: string
  inspectModel(modelPath: string): Promise<void>
  isHealthy(url: string): Promise<boolean>
  verifyModel(endpoint: string, modelPath: string): Promise<ModelIdentityStatus>
  isPortOpen(host: string, port: number): Promise<boolean>
  spawnProcess(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess
  sleep(milliseconds: number): Promise<void>
  now(): number
  makeCacheDirectory(path: string): Promise<void>
}

export function endpointFor(config: ResolvedConfig): string {
  return `http://${config.host}:${String(config.port)}/v1`
}

export function healthUrlFor(config: ResolvedConfig): string {
  return `http://${config.host}:${String(config.port)}/health`
}

export function buildServerArgs(config: ResolvedConfig): string[] {
  if (config.modelPath === undefined) {
    throw new Error('dsh-llm-mlx: cannot build server arguments without modelPath')
  }
  if (config.serverEngine === 'mlx-vlm') {
    const args = [
      '-m', 'mlx_vlm.server',
      '--model', config.modelPath,
      '--host', config.host,
      '--port', String(config.port),
      '--max-tokens', String(config.maxTokens),
      '--log-level', config.logLevel,
    ]
    if (config.maxNumSeqs !== undefined) {
      args.push('--max-num-seqs', String(config.maxNumSeqs))
    }
    if (!config.disableThinking) args.push('--enable-thinking')
    return args
  }
  const args = [
    '-m', 'mlx_lm', 'server',
    '--model', config.modelPath,
    '--host', config.host,
    '--port', String(config.port),
    '--max-tokens', String(config.maxTokens),
    '--temp', String(config.temperature),
    '--top-p', String(config.topP),
    '--top-k', String(config.topK),
    '--log-level', config.logLevel,
  ]
  if (config.disableThinking) {
    args.push('--chat-template-args', '{"enable_thinking":false}')
  }
  return args
}

async function inspectModel(modelPath: string): Promise<void> {
  const details = await stat(modelPath)
  if (!details.isDirectory()) {
    throw new Error('dsh-llm-mlx: modelPath must point to a local model directory')
  }
  const files = new Set(await readdir(modelPath))
  for (const required of ['config.json', 'tokenizer_config.json']) {
    if (!files.has(required)) {
      throw new Error(`dsh-llm-mlx: modelPath is missing ${required}`)
    }
    await access(join(modelPath, required))
  }
  if (![...files].some(file => file.endsWith('.safetensors'))) {
    throw new Error('dsh-llm-mlx: modelPath contains no .safetensors weights')
  }
}

async function isHealthy(url: string): Promise<boolean> {
  return isHealthyPayload(await readIdentityJson(url))
}

async function readIdentityJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    if (!response.ok || response.body === null) return undefined
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_IDENTITY_BYTES) return undefined
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

async function canonicalModelPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

function modelIds(body: unknown): string[] | undefined {
  if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) return undefined
  const ids: string[] = []
  for (const item of body.data) {
    if (typeof item !== 'object' || item === null || !('id' in item) ||
        typeof item.id !== 'string' || item.id.length === 0 || /[\0\r\n]/.test(item.id)) return undefined
    ids.push(item.id)
  }
  return ids
}

/** Check declared model identity, without generating text or loading a model. */
export async function verifyModelIdentity(endpoint: string, modelPath: string): Promise<ModelIdentityStatus> {
  let base: URL
  try {
    base = new URL(endpoint)
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' ||
        !['/v1', '/v1/'].includes(base.pathname) || base.username || base.password || base.search || base.hash ||
        !isAbsolute(modelPath)) return 'unavailable'
  } catch {
    return 'unavailable'
  }
  const [health, models, expected] = await Promise.all([
    readIdentityJson(new URL('/health', base).href),
    readIdentityJson(new URL('/v1/models', base).href),
    canonicalModelPath(modelPath),
  ])
  const ids = modelIds(models)
  if (!isHealthyPayload(health) || ids === undefined) return 'unavailable'
  const paths = new Set(await Promise.all(ids.filter(isAbsolute).map(canonicalModelPath)))
  // MLX-VLM lists cached downloads as well as loaded models. Prefer its
  // explicit active model; a downloaded alternative is not proof of reuse.
  if (typeof health === 'object' && health !== null && 'loaded_model' in health) {
    const loaded = health.loaded_model
    if (typeof loaded !== 'string' || !isAbsolute(loaded) || /[\0\r\n]/.test(loaded)) return 'unavailable'
    if (await canonicalModelPath(loaded) !== expected) return 'mismatched'
    return paths.has(expected) ? 'matched' : 'unavailable'
  }
  // MLX-LM advertises cached Hub repo IDs plus the absolute path of its
  // configured local default. Multiple local paths leave that default unknown.
  if (paths.size !== 1) return 'unavailable'
  return paths.has(expected) ? 'matched' : 'mismatched'
}

/** Accept the health payloads used by both supported local server packages. */
export function isHealthyPayload(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const status = (body as { status?: unknown }).status
  return status === 'ok' || status === 'healthy'
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    const finish = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(HEALTH_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

const defaultDependencies: RuntimeDependencies = {
  platform: process.platform,
  arch: process.arch,
  inspectModel,
  isHealthy,
  verifyModel: verifyModelIdentity,
  isPortOpen,
  spawnProcess(executable, args, env) {
    return spawn(executable, args, {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  },
  sleep: milliseconds => delay(milliseconds),
  now: () => Date.now(),
  makeCacheDirectory: path => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined),
}

interface ExitState {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error
}

function observeExit(child: ChildProcess): { promise: Promise<ExitState>, exited: () => boolean } {
  let settled = false
  const promise = new Promise<ExitState>(resolve => {
    child.once('error', error => {
      settled = true
      resolve({ code: null, signal: null, error })
    })
    child.once('exit', (code, signal) => {
      settled = true
      resolve({ code, signal })
    })
  })
  return { promise, exited: () => settled }
}

async function terminate(child: ChildProcess, exit: ReturnType<typeof observeExit>, sleep: RuntimeDependencies['sleep']): Promise<void> {
  if (exit.exited()) return
  child.kill('SIGTERM')
  await Promise.race([exit.promise, sleep(STOP_GRACE_MS)])
  if (!exit.exited()) {
    child.kill('SIGKILL')
    await Promise.race([exit.promise, sleep(1_000)])
  }
}

function exitDescription(state: ExitState): string {
  if (state.error !== undefined) return state.error.message
  if (state.signal !== null) return `signal ${state.signal}`
  return `exit code ${String(state.code)}`
}

/** Reuse a healthy loopback server or start and own one local MLX server process. */
export async function ensureMlxRuntime(
  config: ResolvedConfig,
  logger: RuntimeLogger,
  dependencies: RuntimeDependencies = defaultDependencies,
): Promise<RuntimeHandle> {
  const endpoint = endpointFor(config)
  const healthUrl = healthUrlFor(config)
  if (await dependencies.isHealthy(healthUrl)) {
    if (config.modelPath !== undefined) {
      const identity = await dependencies.verifyModel(endpoint, config.modelPath)
      if (identity !== 'matched') {
        throw new Error(identity === 'mismatched'
          ? `dsh-llm-mlx: healthy server at ${endpoint} reports a different model; existing process was not changed`
          : `dsh-llm-mlx: cannot verify configured modelPath at ${endpoint}; existing process was not changed`)
      }
    }
    logger.info(`dsh-llm-mlx: reusing healthy loopback server at ${endpoint}`)
    return { mode: 'reused', endpoint, dispose: async () => undefined }
  }

  if (!config.autoStart) {
    logger.warn(`dsh-llm-mlx: no healthy server at ${endpoint}; configure one or enable managed startup`)
    return { mode: 'disabled', endpoint, dispose: async () => undefined }
  }
  if (dependencies.platform !== 'darwin' || dependencies.arch !== 'arm64') {
    throw new Error('dsh-llm-mlx: managed MLX startup requires Apple-silicon macOS')
  }
  if (config.modelPath === undefined) {
    throw new Error('dsh-llm-mlx: modelPath is required for managed startup')
  }
  if (await dependencies.isPortOpen(config.host, config.port)) {
    throw new Error(`dsh-llm-mlx: loopback port ${String(config.port)} is occupied by a non-healthy service`)
  }

  await dependencies.inspectModel(config.modelPath)
  const cacheDirectory = join(tmpdir(), 'dsh-llm-mlx-hf-cache')
  await dependencies.makeCacheDirectory(cacheDirectory)
  const child = dependencies.spawnProcess(config.pythonExecutable, buildServerArgs(config), {
    ...process.env,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE ?? cacheDirectory,
  })
  child.stderr?.resume()
  const exit = observeExit(child)
  const deadline = dependencies.now() + config.startupTimeoutMs

  try {
    while (dependencies.now() < deadline) {
      if (await dependencies.isHealthy(healthUrl)) {
        const identity = await dependencies.verifyModel(endpoint, config.modelPath)
        if (exit.exited()) {
          throw new Error(`dsh-llm-mlx: ${config.serverEngine} server stopped during startup (${exitDescription(await exit.promise)})`)
        }
        if (identity === 'mismatched') {
          throw new Error(`dsh-llm-mlx: server at ${endpoint} reports a different model during managed startup`)
        }
        if (identity === 'matched') {
          logger.info(`dsh-llm-mlx: managed loopback server is healthy with the configured model at ${endpoint}`)
          return {
            mode: 'spawned',
            endpoint,
            ...(child.pid === undefined ? {} : { pid: child.pid }),
            dispose: () => terminate(child, exit, dependencies.sleep),
          }
        }
      }
      const state = await Promise.race([
        exit.promise.then(value => ({ kind: 'exit' as const, value })),
        dependencies.sleep(HEALTH_POLL_MS).then(() => ({ kind: 'tick' as const })),
      ])
      if (state.kind === 'exit') {
        throw new Error(`dsh-llm-mlx: ${config.serverEngine} server stopped during startup (${exitDescription(state.value)})`)
      }
    }
    throw new Error(`dsh-llm-mlx: ${config.serverEngine} server did not become healthy with the configured model within ${String(config.startupTimeoutMs)} ms`)
  } catch (error) {
    await terminate(child, exit, dependencies.sleep)
    throw error
  }
}
