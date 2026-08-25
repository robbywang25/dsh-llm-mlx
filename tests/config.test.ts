import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_PORT,
  DEFAULT_STARTUP_TIMEOUT_MS,
  resolveConfig,
} from '../src/config.js'

describe('resolveConfig', () => {
  it('keeps managed startup off and fixes the host to loopback by default', () => {
    expect(resolveConfig({})).toEqual({
      autoStart: false,
      pythonExecutable: 'python3',
      host: '127.0.0.1',
      port: DEFAULT_PORT,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: 0.6,
      topP: 0.8,
      topK: 20,
      disableThinking: true,
      logLevel: 'WARNING',
    })
  })

  it('requires an absolute local model directory for managed startup', () => {
    expect(() => resolveConfig({ autoStart: true })).toThrow(/modelPath is required/)
    expect(() => resolveConfig({ autoStart: true, modelPath: 'models/qwen' })).toThrow(/absolute local path/)
  })

  it('rejects control characters and surrounding whitespace in process inputs', () => {
    expect(() => resolveConfig({ pythonExecutable: ' python3' })).toThrow(/surrounding whitespace/)
    expect(() => resolveConfig({ pythonExecutable: 'python3\n--version' })).toThrow(/plain-text/)
    expect(() => resolveConfig({ modelPath: '/models/ok\0bad' })).toThrow(/plain-text/)
  })
})
