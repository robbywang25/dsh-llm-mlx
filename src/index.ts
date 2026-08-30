import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type Config as PluginConfig } from './config.js'
import { ensureMlxRuntime } from './runtime.js'
import { startCcSwitchCompatibilityProxy } from './cc-switch-proxy.js'

export { Config, resolveConfig } from './config.js'
export type { Config as PluginConfig, ResolvedConfig } from './config.js'
export { buildServerArgs, endpointFor, ensureMlxRuntime, healthUrlFor, isHealthyPayload } from './runtime.js'
export type { RuntimeDependencies, RuntimeHandle, RuntimeLogger } from './runtime.js'
export {
  normalizeCcSwitchOpenAiChunk,
  normalizeCcSwitchSseBlock,
  sanitizeCcSwitchChatRequest,
  startCcSwitchCompatibilityProxy,
} from './cc-switch-proxy.js'
export type { CcSwitchProxyHandle, CcSwitchProxyLogger, CcSwitchProxyOptions } from './cc-switch-proxy.js'

export const name = 'llm-mlx-runtime'

/** Mount the optional server owner; the provider route itself comes from the bundle patch. */
export function apply(ctx: Context, config: PluginConfig): void {
  const resolved = resolveConfig(config)
  ctx.effect(async () => {
    const runtime = await ensureMlxRuntime(resolved, {
      info: message => ctx.logger.info(message),
      warn: message => ctx.logger.warn(message),
    })
    let proxy
    try {
      proxy = resolved.ccSwitchProxyPort === undefined
        ? undefined
        : await startCcSwitchCompatibilityProxy(runtime.endpoint, resolved.ccSwitchProxyPort, {
            info: message => ctx.logger.info(message),
            warn: message => ctx.logger.warn(message),
          }, { chatOnly: resolved.ccSwitchChatOnly })
    } catch (error) {
      await runtime.dispose()
      throw error
    }
    return async () => {
      await proxy?.dispose()
      await runtime.dispose()
    }
  }, 'dsh-llm-mlx: local MLX runtime')
}
