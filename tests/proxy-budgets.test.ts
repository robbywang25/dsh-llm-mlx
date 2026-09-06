import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpstreamBudget, DEFAULT_PROXY_LIMITS, resolveProxyLimits } from '../src/proxy-budgets.js'

afterEach(() => vi.useRealTimers())

describe('upstream phase budgets', () => {
  const limits = { connectTimeoutMs: 10, firstByteTimeoutMs: 100, idleTimeoutMs: 20, maxSseEventBytes: 64 }

  it('ends a connection attempt and clears every timer at its deadline', () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const budget = createUpstreamBudget(limits, expired)
    budget.requestFinished()
    vi.advanceTimersByTime(10)
    expect(expired).toHaveBeenCalledExactlyOnceWith('connect')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts the first body wait only after sending the request, independently of connect time', () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const budget = createUpstreamBudget(limits, expired)
    budget.connected()
    vi.advanceTimersByTime(200)
    expect(expired).not.toHaveBeenCalled()
    budget.requestFinished()
    vi.advanceTimersByTime(99)
    expect(expired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expired).toHaveBeenCalledExactlyOnceWith('first-byte')
  })

  it('allows long prefill and long active streaming, then expires only the idle phase', () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const budget = createUpstreamBudget(limits, expired)
    budget.connected()
    budget.requestFinished()
    vi.advanceTimersByTime(90)
    budget.bodyReceived()
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(10)
      budget.bodyReceived()
    }
    expect(expired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(expired).toHaveBeenCalledExactlyOnceWith('idle')
  })

  it('does not rearm after completion, cancellation, or an early response body', () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const budget = createUpstreamBudget(limits, expired)
    budget.connected()
    budget.bodyReceived()
    budget.requestFinished()
    expect(vi.getTimerCount()).toBe(1)
    budget.finish()
    budget.requestFinished()
    budget.bodyReceived()
    vi.advanceTimersByTime(1000)
    expect(expired).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects non-finite, fractional, null, zero and oversized limits before using Node timers', () => {
    expect(resolveProxyLimits()).toEqual(DEFAULT_PROXY_LIMITS)
    for (const key of Object.keys(DEFAULT_PROXY_LIMITS)) {
      for (const value of [NaN, Infinity, -1, 0, 0.5, null, '100', 2 ** 31]) {
        expect(() => resolveProxyLimits({ [key]: value })).toThrow(key)
      }
    }
    expect(() => resolveProxyLimits(null as never)).toThrow(/object/)
  })
})
