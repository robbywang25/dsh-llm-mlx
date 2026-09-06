export interface CcSwitchProxyLimits {
  /** Time allowed to establish the loopback TCP connection. */
  readonly connectTimeoutMs: number
  /** Time from finishing the upstream request until its first response body byte. */
  readonly firstByteTimeoutMs: number
  /** Maximum gap between response body chunks, with no total generation deadline. */
  readonly idleTimeoutMs: number
  /** UTF-8 bytes per buffered SSE event, including its separator. */
  readonly maxSseEventBytes: number
}

export const DEFAULT_PROXY_LIMITS: CcSwitchProxyLimits = Object.freeze({
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 300_000,
  idleTimeoutMs: 300_000,
  maxSseEventBytes: 1024 * 1024,
})

export const MAX_PROXY_TIMEOUT_MS = 3_600_000
export const MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024

export function resolveProxyLimits(options: Partial<CcSwitchProxyLimits> = {}): CcSwitchProxyLimits {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('dsh-llm-mlx: proxy limits must be an object')
  }
  const limits = { ...DEFAULT_PROXY_LIMITS }
  for (const key of Object.keys(limits) as (keyof CcSwitchProxyLimits)[]) {
    const value = options[key] === undefined ? limits[key] : options[key]
    const maximum = key === 'maxSseEventBytes' ? MAX_SSE_EVENT_BYTES : MAX_PROXY_TIMEOUT_MS
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`dsh-llm-mlx: proxy ${key} must be an integer between 1 and ${String(maximum)}`)
    }
    limits[key] = value
  }
  return limits
}

type TimeoutPhase = 'connect' | 'first-byte' | 'idle'

/** Independent phases keep slow prefill separate from an idle generated stream. */
export function createUpstreamBudget(
  limits: CcSwitchProxyLimits,
  expired: (phase: TimeoutPhase) => void,
) {
  const timers = new Map<TimeoutPhase, ReturnType<typeof setTimeout>>()
  let finished = false
  let receivedBody = false

  const clear = (phase: TimeoutPhase): void => {
    clearTimeout(timers.get(phase))
    timers.delete(phase)
  }
  const finish = (): void => {
    finished = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }
  const arm = (phase: TimeoutPhase, milliseconds: number): void => {
    if (finished) return
    clear(phase)
    const timer = setTimeout(() => {
      finish()
      expired(phase)
    }, milliseconds)
    timer.unref()
    timers.set(phase, timer)
  }
  arm('connect', limits.connectTimeoutMs)

  return {
    connected: (): void => clear('connect'),
    requestFinished: (): void => {
      if (!receivedBody) arm('first-byte', limits.firstByteTimeoutMs)
    },
    bodyReceived: (): void => {
      receivedBody = true
      clear('first-byte')
      arm('idle', limits.idleTimeoutMs)
    },
    finish,
  }
}
