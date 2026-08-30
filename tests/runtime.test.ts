import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import {
  buildServerArgs,
  ensureMlxRuntime,
  isHealthyPayload,
  type RuntimeDependencies,
  type RuntimeLogger,
} from '../src/runtime.js'

function childProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.defineProperty(child, 'pid', { value: 4242 })
  Object.defineProperty(child, 'stderr', { value: new PassThrough() })
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  })
  return child
}

function dependencies(overrides: Partial<RuntimeDependencies> = {}): RuntimeDependencies {
  let clock = 0
  return {
    platform: 'darwin',
    arch: 'arm64',
    inspectModel: vi.fn(async () => undefined),
    isHealthy: vi.fn(async () => false),
    isPortOpen: vi.fn(async () => false),
    spawnProcess: vi.fn(() => childProcess()),
    sleep: vi.fn(async milliseconds => { clock += milliseconds }),
    now: vi.fn(() => clock),
    makeCacheDirectory: vi.fn(async () => undefined),
    ...overrides,
  }
}

const logger: RuntimeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
}

describe('buildServerArgs', () => {
  it('passes the model path as one argument and binds only to loopback', () => {
    const config = resolveConfig({ autoStart: true, modelPath: '/Models/Qwen 3' })
    const args = buildServerArgs(config)
    expect(args).toContain('/Models/Qwen 3')
    expect(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2)).toEqual(['--host', '127.0.0.1'])
    expect(args).toContain('{"enable_thinking":false}')
  })

  it('starts mlx-vlm through its module without mlx-lm-only sampling flags', () => {
    const config = resolveConfig({
      autoStart: true,
      serverEngine: 'mlx-vlm',
      modelPath: '/Models/Qwen VL',
      maxNumSeqs: 1,
      disableThinking: false,
    })
    const args = buildServerArgs(config)
    expect(args.slice(0, 2)).toEqual(['-m', 'mlx_vlm.server'])
    expect(args).toContain('/Models/Qwen VL')
    expect(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2)).toEqual(['--host', '127.0.0.1'])
    expect(args).toContain('--max-tokens')
    expect(args.slice(args.indexOf('--max-num-seqs'), args.indexOf('--max-num-seqs') + 2)).toEqual([
      '--max-num-seqs', '1',
    ])
    expect(args).toContain('--enable-thinking')
    expect(args).not.toContain('--temp')
    expect(args).not.toContain('--chat-template-args')
  })
})

describe('isHealthyPayload', () => {
  it('accepts MLX-LM and MLX-VLM health shapes', () => {
    expect(isHealthyPayload({ status: 'ok' })).toBe(true)
    expect(isHealthyPayload({ status: 'healthy', loaded_model: null })).toBe(true)
  })

  it('rejects unrelated or malformed payloads', () => {
    expect(isHealthyPayload({ status: 'starting' })).toBe(false)
    expect(isHealthyPayload('ok')).toBe(false)
  })
})

describe('ensureMlxRuntime', () => {
  it('reuses an already healthy endpoint without owning its process', async () => {
    const deps = dependencies({ isHealthy: vi.fn(async () => true) })
    const handle = await ensureMlxRuntime(resolveConfig({}), logger, deps)
    expect(handle.mode).toBe('reused')
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  it('leaves the route visible but does not spawn when auto-start is disabled', async () => {
    const deps = dependencies()
    const handle = await ensureMlxRuntime(resolveConfig({}), logger, deps)
    expect(handle.mode).toBe('disabled')
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  it('refuses managed startup outside Apple-silicon macOS', async () => {
    const deps = dependencies({ platform: 'linux' })
    await expect(ensureMlxRuntime(
      resolveConfig({ autoStart: true, modelPath: '/models/qwen' }),
      logger,
      deps,
    )).rejects.toThrow(/Apple-silicon macOS/)
  })

  it('refuses to take over an occupied unhealthy port', async () => {
    const deps = dependencies({ isPortOpen: vi.fn(async () => true) })
    await expect(ensureMlxRuntime(
      resolveConfig({ autoStart: true, modelPath: '/models/qwen' }),
      logger,
      deps,
    )).rejects.toThrow(/occupied by a non-healthy service/)
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  it('starts one validated process and terminates only that process on dispose', async () => {
    const child = childProcess()
    const health = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const deps = dependencies({
      isHealthy: health,
      spawnProcess: vi.fn(() => child),
    })
    const handle = await ensureMlxRuntime(
      resolveConfig({ autoStart: true, modelPath: '/models/qwen' }),
      logger,
      deps,
    )
    expect(handle).toMatchObject({ mode: 'spawned', pid: 4242 })
    expect(deps.inspectModel).toHaveBeenCalledWith('/models/qwen')
    expect(deps.spawnProcess).toHaveBeenCalledOnce()
    await handle.dispose()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
