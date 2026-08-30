import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import type { ResolvedConfig } from './config.js'

const HEALTH_POLL_MS = 250
const STOP_GRACE_MS = 5_000
const HEALTH_TIMEOUT_MS = 1_000

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
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return isHealthyPayload(body)
  } catch {
    return false
  }
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

  while (dependencies.now() < deadline) {
    if (await dependencies.isHealthy(healthUrl)) {
      logger.info(`dsh-llm-mlx: managed loopback server is healthy at ${endpoint}`)
      return {
        mode: 'spawned',
        endpoint,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        dispose: () => terminate(child, exit, dependencies.sleep),
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

  await terminate(child, exit, dependencies.sleep)
  throw new Error(`dsh-llm-mlx: ${config.serverEngine} server did not become healthy within ${String(config.startupTimeoutMs)} ms`)
}
