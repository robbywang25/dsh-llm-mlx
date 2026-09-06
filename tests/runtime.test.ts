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
    verifyModel: vi.fn(async () => 'matched' as const),
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
    expect(deps.verifyModel).not.toHaveBeenCalled()
  })

  it('verifies the configured model before reusing a healthy service', async () => {
    const deps = dependencies({ isHealthy: vi.fn(async () => true) })
    const handle = await ensureMlxRuntime(resolveConfig({ modelPath: '/models/qwen' }), logger, deps)
    expect(handle.mode).toBe('reused')
    expect(deps.verifyModel).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:18080/v1', '/models/qwen')
    await handle.dispose()
    expect(deps.spawnProcess).not.toHaveBeenCalled()
    expect(deps.inspectModel).not.toHaveBeenCalled()
  })

  it.each(['mismatched', 'unavailable'] as const)('refuses %s identity without taking over a healthy process', async identity => {
    const deps = dependencies({
      isHealthy: vi.fn(async () => true),
      verifyModel: vi.fn(async () => identity),
    })
    await expect(ensureMlxRuntime(
      resolveConfig({ autoStart: true, modelPath: '/models/qwen' }), logger, deps,
    )).rejects.toThrow(/existing process was not changed/)
    expect(deps.spawnProcess).not.toHaveBeenCalled()
    expect(deps.makeCacheDirectory).not.toHaveBeenCalled()
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

  it('waits for identity to become available during managed startup', async () => {
    const deps = dependencies({
      isHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      verifyModel: vi.fn().mockResolvedValueOnce('unavailable').mockResolvedValueOnce('matched'),
    })
    const handle = await ensureMlxRuntime(resolveConfig({ autoStart: true, modelPath: '/models/qwen' }), logger, deps)
    expect(handle.mode).toBe('spawned')
    expect(deps.verifyModel).toHaveBeenCalledTimes(2)
    await handle.dispose()
  })

  it.each(['mismatched', 'unavailable'] as const)('cleans up its own child when startup identity is %s', async identity => {
    const child = childProcess()
    const deps = dependencies({
      isHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      verifyModel: vi.fn(async () => identity),
      spawnProcess: vi.fn(() => child),
    })
    await expect(ensureMlxRuntime(
      resolveConfig({ autoStart: true, modelPath: '/models/qwen', startupTimeoutMs: 1000 }), logger, deps,
    )).rejects.toThrow(identity === 'mismatched' ? /different model/ : /configured model within/)
    expect(deps.spawnProcess).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it('cleans up its own child if the identity probe throws unexpectedly', async () => {
    const child = childProcess()
    const deps = dependencies({
      isHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      verifyModel: vi.fn(async () => { throw new Error('synthetic probe failure') }),
      spawnProcess: vi.fn(() => child),
    })
    await expect(ensureMlxRuntime(
      resolveConfig({ autoStart: true, modelPath: '/models/qwen' }), logger, deps,
    )).rejects.toThrow('synthetic probe failure')
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it('does not mark a child ready if it exits during model verification', async () => {
    const child = childProcess()
    const deps = dependencies({
      isHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      verifyModel: vi.fn(async () => { child.emit('exit', 1, null); return 'matched' as const }),
      spawnProcess: vi.fn(() => child),
    })
    await expect(ensureMlxRuntime(
      resolveConfig({ autoStart: true, modelPath: '/models/qwen' }), logger, deps,
    )).rejects.toThrow(/stopped during startup/)
    expect(child.kill).not.toHaveBeenCalled()
  })
})
