import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const DEFAULT_PORT = 18080
export const DEFAULT_STARTUP_TIMEOUT_MS = 90_000
export const DEFAULT_MAX_TOKENS = 512
export const DEFAULT_TEMPERATURE = 0.6
export const DEFAULT_TOP_P = 0.8
export const DEFAULT_TOP_K = 20

export type MlxLogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
export type MlxServerEngine = 'mlx-lm' | 'mlx-vlm'

export interface Config {
  /** Start and own an MLX server instead of reusing an already-running endpoint. */
  autoStart?: boolean
  /** Python server implementation used for managed startup. */
  serverEngine?: MlxServerEngine
  /** Absolute path to a local MLX model directory. Required when autoStart is true. */
  modelPath?: string
  /** Python executable or absolute interpreter path containing the selected server package. */
  pythonExecutable?: string
  /** Loopback TCP port used by both the server and provider profile. */
  port?: number
  /** Maximum time to wait for the server health endpoint. */
  startupTimeoutMs?: number
  /** Default generation limit passed to mlx_lm.server. */
  maxTokens?: number
  /** Optional MLX-VLM continuous-batch concurrency limit. */
  maxNumSeqs?: number
  /** Default sampling temperature passed to mlx_lm.server. */
  temperature?: number
  /** Default nucleus-sampling threshold passed to mlx_lm.server. */
  topP?: number
  /** Default top-k threshold passed to mlx_lm.server. */
  topK?: number
  /** Disable Qwen-style thinking in the server chat template. */
  disableThinking?: boolean
  /** mlx_lm.server log level. */
  logLevel?: MlxLogLevel
}

export interface ResolvedConfig {
  readonly autoStart: boolean
  readonly serverEngine: MlxServerEngine
  readonly modelPath?: string
  readonly pythonExecutable: string
  readonly host: '127.0.0.1'
  readonly port: number
  readonly startupTimeoutMs: number
  readonly maxTokens: number
  readonly maxNumSeqs?: number
  readonly temperature: number
  readonly topP: number
  readonly topK: number
  readonly disableThinking: boolean
  readonly logLevel: MlxLogLevel
}

export const Config: z<Config> = z.object({
  autoStart: z.boolean().default(false),
  serverEngine: z.union(['mlx-lm', 'mlx-vlm'] as const).default('mlx-lm'),
  modelPath: z.string(),
  pythonExecutable: z.string().default('python3'),
  port: z.number().step(1).min(1024).max(65535).default(DEFAULT_PORT),
  startupTimeoutMs: z.number().step(1).min(1000).max(300_000).default(DEFAULT_STARTUP_TIMEOUT_MS),
  maxTokens: z.number().step(1).min(1).max(32_768).default(DEFAULT_MAX_TOKENS),
  maxNumSeqs: z.number().step(1).min(1).max(64),
  temperature: z.number().min(0).max(2).default(DEFAULT_TEMPERATURE),
  topP: z.number().min(0).max(1).default(DEFAULT_TOP_P),
  topK: z.number().step(1).min(0).max(1000).default(DEFAULT_TOP_K),
  disableThinking: z.boolean().default(true),
  logLevel: z.union(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const).default('WARNING'),
})

function cleanString(value: string, field: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`dsh-llm-mlx: ${field} must be non-empty and have no surrounding whitespace`)
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`dsh-llm-mlx: ${field} must be a single plain-text value`)
  }
  return value
}

/** Resolve defaults and enforce the local-only process boundary. */
export function resolveConfig(config: Config): ResolvedConfig {
  const autoStart = config.autoStart ?? false
  const serverEngine = config.serverEngine ?? 'mlx-lm'
  const modelPath = config.modelPath === undefined ? undefined : cleanString(config.modelPath, 'modelPath')
  if (autoStart && modelPath === undefined) {
    throw new Error('dsh-llm-mlx: modelPath is required when autoStart is enabled')
  }
  if (modelPath !== undefined && !isAbsolute(modelPath)) {
    throw new Error('dsh-llm-mlx: modelPath must be an absolute local path')
  }
  if (config.maxNumSeqs !== undefined && serverEngine !== 'mlx-vlm') {
    throw new Error('dsh-llm-mlx: maxNumSeqs is supported only by mlx-vlm')
  }

  return {
    autoStart,
    serverEngine,
    ...(modelPath === undefined ? {} : { modelPath }),
    pythonExecutable: cleanString(config.pythonExecutable ?? 'python3', 'pythonExecutable'),
    host: '127.0.0.1',
    port: config.port ?? DEFAULT_PORT,
    startupTimeoutMs: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(config.maxNumSeqs === undefined ? {} : { maxNumSeqs: config.maxNumSeqs }),
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    topP: config.topP ?? DEFAULT_TOP_P,
    topK: config.topK ?? DEFAULT_TOP_K,
    disableThinking: config.disableThinking ?? true,
    logLevel: config.logLevel ?? 'WARNING',
  }
}
